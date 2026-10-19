# 设备身份、证书生命周期与常见攻击

> 专题 25 · 模块五 · ★ 核心必会 · 侧重设备接入
> 版本基线：MQTT 5.0
> 贯穿场景：一台电表从出厂到报废（10 年以上）的身份管理，以及攻击者的下手点

**对应全景图的哪一块**：把专题 22～24 串成完整的设备身份方案；前三篇管"连接那一刻怎么验"，本篇管"身份全生命周期"与攻击面。

## 1. 核心概念

### 1.1 生命周期

```
 出厂 ──> 激活/注册 ──> 运行 ──> 轮换（到期前换新）──> 吊销 / 退役
```

> 类比：员工工牌。最容易出问题的是后两步：没人记得换，丢了没人作废。

### 1.2 出厂：身份从哪来

| 方式 | 优点 | 风险 |
|---|---|---|
| **产线逐台签发**：设备自己生成密钥，只交 CSR，CA 签好写回 | 私钥不离开设备；一机一证 | 产线需安全接入 CA |
| 产线生成密钥与证书一起烧录 | 简单 | 私钥在产线出现过，可能批量泄露 |
| **引导凭证 + 首次注册**：出厂放批次引导证书，首次联网换取专属证书 | 产线简单，注册时可校验序列号 | 引导凭证泄露可批量注册假设备，注册接口须严校验并限流 |
| 一机一密（密码） | 芯片要求最低 | 泄露与吊销管理难 |

私钥存放：普通 flash 可被读出；高价值场景用**安全芯片**（私钥不可读出，只能代为签名）。

### 1.3 证书轮换

原因：到期（实测过期即连不上）、算法升级、CA 更换、怀疑泄露。计量设备运行 10 年以上，**轮换必然发生**。

```
① 到期前（如剩 30 天）设备生成新密钥与 CSR
② 经 MQTT 发 em/{id}/up/cert/csr（用当前有效证书连接）
③ 平台签发，下发 em/{id}/down/cert/new
④ 设备用新证书重连，成功后再删旧证书
⑤ 失败继续用旧证书，下次再试
```

- **先换后删**，避免变砖。
- **信任锚可远程更新**：broker 换 CA 期间设备同时信任新旧 CA。
- 设备时钟要准（22）。

### 1.4 吊销

| 方式 | 优点 | 问题 |
|---|---|---|
| CRL（证书吊销列表） | 不依赖在线服务 | 需定期更新并重载；设备多则列表大；已有连接需另行踢掉（TLS 只在握手时校验，推断，未实测） |
| OCSP（在线状态查询） | 实时 | 每次连接多一次查询；查询服务可用性取舍 |
| broker 侧黑名单 / 设备注册表 | 最直接，可立即禁用并踢下线 | 依赖平台认证扩展 |

常见组合：注册表负责立即禁用，CRL/OCSP 负责证书层面作废。Mosquitto 日志对吊销与过期都只写 `certificate verify failed`，具体原因用 `openssl verify -crl_check` 查。

### 1.5 常见攻击与防护

| 攻击 | 后果 | 防护 | 相关 |
|---|---|---|---|
| 窃听 | 凭证、数据泄露 | TLS；生产关闭 1883 | 22 |
| 中间人 | 设备被控制 | 设备校验证书，禁止跳过校验 | 22 |
| 降级攻击（诱导明文） | 回到窃听 | 不开明文端口，固件只允许 TLS | — |
| 凭证泄露 / 固件提取 | 冒充该设备 | 一机一证、安全芯片、及时吊销 | 23、本篇 |
| 共用凭证 | 批量冒充 | 杜绝共用 | 23 |
| Client ID 劫持 | 踢掉正主、触发遗嘱、互踢 | ID 与身份绑定 | 24 |
| 通配订阅窃听 | 看到全部数据 | ACL 只读自己 | 24 |
| 伪造数据或指令 | 计费错误、误动作 | ACL；指令来源校验 | 24 |
| 保留消息 / 遗嘱投毒 | 在线状态长期错误 | ACL 覆盖 status 与遗嘱主题；状态带时间戳 | 14、15 |
| 重放旧指令 | 执行旧指令 | 时间戳、随机数校验 | 12、39 |
| 连接洪水 / 重连风暴 | broker 资源耗尽 | 连接数与速率上限；客户端指数退避 | 本篇、43 |
| 大报文 / 消息洪水 | 内存带宽占满 | 报文大小上限；消息速率上限 | 本篇 |

资源类防护：Mosquitto 有 `max_connections`、`max_packet_size` 等上限；EMQX 文档另有监听器级 `max_conn_rate`（每秒新建连接）与按客户端 `messages_rate`、`bytes_rate`，节点级超限时丢 QoS 0、对 QoS 1/2 返回 **0x97 Quota exceeded**。

### 1.6 电表场景方案汇总

| 环节 | 方案 |
|---|---|
| 出厂 | 设备自生成密钥，CA 一机一证；有条件用安全芯片 |
| 连接 | 只开 8883；双向 TLS；Client ID = 证书 CN |
| 授权 | 设备模板只写自己的 up/status、只读自己的 down |
| 运行 | 开机先校时；监控证书剩余有效期 |
| 轮换 | 到期前 30 天经 MQTT 自动轮换，先换后删；信任锚可更新 |
| 吊销 | 注册表禁用并踢下线 + CRL |
| 防资源攻击 | 连接数、连接速率、报文大小、消息速率上限；客户端退避 |
| 审计 | 认证失败、Denied、接管（0x8E）进监控（46） |

### 1.7 局限

- 物理拆机读芯片只能靠硬件手段缓解。
- 证书体系运维成本高（CA 安全、产线对接、轮换失败处理）。
- 资源防护配置与超限行为各 broker 差异大。

## 2. 易混淆 / 易错点

| 错误理解 | 正确理解 |
|---|---|
| 证书烧进去一劳永逸 | 会到期、CA 会换，须设计轮换 |
| 轮换先删旧再装新 | 先换后删 |
| 吊销后设备马上断开 | CRL 只影响新握手，已有连接需另踢 |
| broker 日志写明吊销还是过期 | Mosquitto 只写校验失败 |
| 产线生成密钥再烧录一样安全 | 私钥在产线出现过，有批量泄露风险 |
| 设报文上限后客户端会报错 | 实测客户端库静默丢弃 |
| 连接数上限能挡住重连风暴 | 被拒客户端不断重试，还需退避与速率限制 |
| 安全只靠 TLS | TLS + 认证 + 授权 + 生命周期 + 资源限制 |

## 3. 与其他章节的关联

| 本篇内容 | 相关专题 |
|---|---|
| 过期指令、重放 | 12（回顾）、39 |
| 保留消息、遗嘱投毒 | 14、15（回顾） |
| Maximum Packet Size、0x97 | 17（回顾） |
| TLS、双向 TLS、设备时钟 | 22（回顾） |
| 认证方式、外部认证 | 23（回顾） |
| ACL、Client ID 绑定 | 24（回顾） |
| 内存与背压 | 28 |
| 接入层限流 | 32 |
| 客户端退避 | 43 |
| 监控与故障诊断 | 46、47 |

## 4. 诊断实践

### 4.1 实验（云端真实输出，Mosquitto 2.0.18 + openssl CA）

签发记录（V 有效，R 已吊销）：

```
V	271019020400Z		/CN=dev-em300-SN20260001
R	271019020400Z	261019020401Z	/CN=dev-em300-SN20260002
V	250201000000Z		/CN=dev-em300-SN20260003
```

双向 TLS + `crlfile`：

```
R1 正常证书（SN20260001）：发布成功
R2 已吊销证书（SN20260002）：Error: The connection was lost.
R3 已过期证书（SN20260003）：Error: The connection was lost.
--- broker 日志：
  New client connected ... as dev-em300-SN20260001 (..., u'dev-em300-SN20260001').
  OpenSSL Error[0]: error:0A000086:SSL routines::certificate verify failed
  OpenSSL Error[0]: error:0A000086:SSL routines::certificate verify failed
--- openssl verify -crl_check：
error 23 at 0 depth lookup: certificate revoked
error 10 at 0 depth lookup: certificate has expired
```

**F1 连接数上限**（`max_connections 3`，依次连 5 个）：

```
  Client connection from 127.0.0.1 denied: max_connections exceeded.
  ……（第 4、5 个客户端不断重试，不断被拒）
```

**F2 报文大小上限**（`max_packet_size 1024`，发 5000 字节）：

```
CONNACK 属性: [ReceiveMaximum : 20, TopicAliasMaximum : 10, MaximumPacketSize : 1024]
paho publish 返回码: 0 No error.
订阅者收到：5 字节          ← 只收到后一条小消息，5000 字节那条被客户端静默丢弃
```

本地复现：

<details>
<summary>ca.cnf（openssl ca 配置）</summary>

```ini
[ca]
default_ca = lab
[lab]
dir = /tmp/t25/ca
database = $dir/index.txt
new_certs_dir = $dir/newcerts
serial = $dir/serial
crlnumber = $dir/crlnumber
certificate = $dir/ca.crt
private_key = $dir/ca.key
default_md = sha256
default_crl_days = 30
policy = any
copy_extensions = none
[any]
commonName = supplied
```
</details>

```bash
mkdir newcerts; touch index.txt; echo 1000 > serial; echo 1000 > crlnumber
openssl req -newkey rsa:2048 -nodes -keyout d.key -out d.csr -subj "/CN=dev-em300-SN20260002"
openssl ca -batch -config ca.cnf -in d.csr -out d.crt -days 365
openssl ca -batch -config ca.cnf -in e.csr -out e.crt -startdate 20250101000000Z -enddate 20250201000000Z  # 已过期
openssl ca -config ca.cnf -revoke d.crt && openssl ca -config ca.cnf -gencrl -out ca.crl
cat ca.crt ca.crl > ca+crl.pem && openssl verify -crl_check -CAfile ca+crl.pem d.crt
# mosquitto.conf（8884）：crlfile ca.crl + 专题 22 的双向 TLS 配置；另设 max_connections 3、max_packet_size 1024
```

### 4.2 现象 → 怀疑 → 观察点

| 现象 | 优先怀疑 | 观察点 |
|---|---|---|
| 一批设备同一天集体连不上 | 证书同时到期；CA 更换 | 有效期分布；CA 变更记录 |
| 单台设备 mTLS 握手失败 | 过期、吊销、非可信 CA | `openssl verify -crl_check` |
| 吊销后设备仍在发数据 | 已有连接未踢；CRL 未重载 | 连接列表；CRL 加载时间 |
| 注册接口涌入大量请求 | 引导凭证泄露 | 来源分布；序列号合法性 |
| 新连接大量被拒、日志刷屏 | 连接上限触发、重连风暴 | `max_connections exceeded`；退避逻辑 |
| 大消息从未到达 | 超报文上限被客户端静默丢弃 | CONNACK Maximum Packet Size |
| 消息被拒返回 0x97 | 触发速率限制 | 限流配置与客户端速率 |

## 5. 复习 checklist

- [ ] 能画出设备身份生命周期五个阶段
- [ ] 能对比四种出厂身份方式，说明私钥为何不应离开设备
- [ ] 能描述基于 MQTT 的证书轮换流程，说出"先换后删"与信任锚更新
- [ ] 能对比 CRL、OCSP、注册表三种吊销方式
- [ ] 能列出至少 8 种攻击及防护，并对应到前面的实验
- [ ] 能说出资源类防护的实测坑（重试、静默丢弃）
- [ ] 能给出电表场景完整身份方案

---

参考：[Mosquitto · mosquitto.conf](https://mosquitto.org/man/mosquitto-conf-5.html)、[EMQX · Rate Limit](https://docs.emqx.com/en/emqx/latest/rate-limit/rate-limit.html)
