# 认证：用户名密码、证书、JWT 与增强认证

> 专题 23 · 模块五 · ★ 核心必会 · 侧重两者兼顾
> 版本基线：MQTT 5.0
> 贯穿场景：broker 收到 CONNECT 时，凭什么相信它就是 dev-em300-SN20260001

**对应全景图的哪一块**：TLS 保证路上安全之后，broker 对"你是谁"的判断。认证（你是谁）与授权（你能做什么，24）是两件事。

## 1. 核心概念

### 1.1 认证的本质：信任来源

| 方式 | broker 凭什么信 | 类比 |
|---|---|---|
| 用户名密码 | 自己存的"账号 + 密码哈希"名册 | 门卫的住户名册 |
| 客户端证书 | 可信 CA 签发 + 证明持有私钥 | 公安局签发的身份证 |
| JWT 令牌 | 可信签发方签名 + 未过期 | 物业开的有期限通行证 |
| 外部认证 / 增强认证 | 交给另一系统判断，或来回问答 | 门卫打电话问物业 |

### 1.2 用户名密码

- 名册存**加盐哈希**，不存明文。Mosquitto 2.0.18 `mosquitto_passwd` 生成 `$7$101$盐$哈希`（PBKDF2-SHA512，101 次迭代）；文件权限过宽会被警告，未来版本将拒绝加载。
- **Mosquitto 对密码错误、用户不存在、匿名一律返回"无权限"**（3.1.1 返回码 5，5.0 0x87），而非专门的 0x86。好处是无法借此枚举账号，代价是排查只能看日志。
- **吊销**：Mosquitto 重新加载（SIGHUP）后会踢掉已不合法的连接；各 broker 行为不同，须核实（若只在 CONNECT 时检查，长连接设备可数月不受影响）。
- 问题：一机一密需逐台生成下发，共用密码等于没有；密码要发给 broker，**必须走 TLS**；海量设备名册应放数据库。

### 1.3 客户端证书

信任来源为 CA 签名 + 私钥；私钥不离开设备；吊销靠 CRL / OCSP（25）；成本在出厂烧录与到期轮换。**长期部署、出厂即确定身份的计量设备通常首选。**

### 1.4 JWT

`头部.内容.签名` 三段：内容**只编码不加密**（人人可读，不放秘密）；签名保证未被篡改；`exp` 过期自动失效。

```
① 设备向业务平台证明身份，平台签发 JWT（如 24 小时）
② 连接时把 JWT 放进密码栏
③ broker 用平台公钥/共享密钥验签与有效期
④ 快过期时找平台换新
```

| broker | 支持 |
|---|---|
| EMQX（官方文档） | 原生：密码或用户名栏携带；HMAC、RSA/ECDSA、JWKS；校验 iat/nbf/exp；`${clientid}`/`${username}` 占位符绑定；令牌可带 `acl`；**过期默认断开** |
| Mosquitto | 不内置，需第三方插件 |

EMQX 提醒：broker 只验签名，令牌不能证明客户端身份，签发环节须把关。

| 适合 | 不适合 |
|---|---|
| 浏览器、App 等用户身份客户端 | 无法联网换令牌的简单设备 |
| 短期、可动态调整权限的接入 | 对每次 CONNECT 流量敏感（示例令牌 329 字节） |
| 复用统一身份平台 | 不能接受"过期即掉线"且无法续签的长连接设备 |

### 1.5 外部认证与增强认证

- **外部认证（HTTP / 数据库）**：复用设备档案方便；外部服务变慢会放大重连风暴（47）。
- **增强认证（5.0 AUTH 报文）**：CONNECT 与 CONNACK 间多轮挑战—应答（SCRAM、Kerberos 等），设备场景少用（21）。

### 1.6 电表场景选型

| 客户端 | 推荐 |
|---|---|
| 电表 | **双向 TLS 客户端证书** |
| 跑不动 mTLS 的电表 | 单向 TLS + 出厂一机一密 |
| 后端服务 | 用户名密码或证书，存于密钥管理系统 |
| 运维 App、浏览器 | 平台签发的短期 JWT |
| 已有设备档案系统 | 外部认证，注意性能 |

通过认证只说明"你是 X"，还需授权（24）与 Client ID 绑定（6、25）。

### 1.7 局限

- 认证主要发生在连接时；连接期间凭证被盗靠吊销与监控（25、46）。
- 插件、失败码、吊销是否踢人各 broker 不同。
- 认证链路越长可用性风险越大，认证服务挂了等于全体设备连不上。

## 2. 易混淆 / 易错点

| 错误理解 | 正确理解 |
|---|---|
| 认证通过就能随便发订 | 认证管身份，授权管能做什么 |
| 全体设备共用账号省事 | 一台泄露全部沦陷，无法单独吊销 |
| 密码文件存密码 | 存加盐哈希，并限制权限 |
| 密码错误一定 0x86 | 看 broker；Mosquitto 一律 0x87 |
| 删账号已连设备立即失效 | 看 broker；Mosquitto 重载后会踢 |
| JWT 是加密的 | 编码 + 签名，内容可读 |
| JWT 能证明设备身份 | 只证明签发方签过 |
| 外部认证随便接 | 慢了会放大重连风暴 |

## 3. 与其他章节的关联

| 本篇内容 | 相关专题 |
|---|---|
| CONNECT 用户名密码栏、Client ID 绑定 | 6（回顾） |
| 原因码 0x86 / 0x87 | 17（回顾） |
| TLS、双向 TLS | 22（回顾） |
| AUTH 报文 | 21 |
| 授权、JWT 中的 acl | 24 |
| 证书吊销与轮换 | 25 |
| 认证与重连风暴 | 43、47 |
| 监控认证失败 | 46 |

## 4. 诊断实践

### 4.1 实验（云端真实输出，Mosquitto 2.0.18，`allow_anonymous false` + `password_file`）

```
--- 密码文件内容（截断显示）：
dev-em300-SN20260001:$7$101$g5YiET…$jzhJ/CpZEA…
svc-ingest:$7$101$wgNekv…$ARFEcHjb3K…
A 正确的用户名密码：    v311: 发布成功        v5: 发布成功
B 密码错误：           v311: Connection Refused: not authorised.   v5: Not authorized
C 用户不存在：         v311: Connection Refused: not authorised.   v5: Not authorized
D 不带用户名（匿名）：  v311: Connection Refused: not authorised.   v5: Not authorized
```

**吊销**（删除 svc-ingest 并 SIGHUP 重载）：

```
已连着的 svc-ingest 收到：before-revoke Connection error: Not authorized
svc-ingest 重新连接：Connection error: Not authorized
broker 日志：Client svc-ingest disconnected.
            Client svc-ingest disconnected, not authorised.
```

**JWT 示例**（演示密钥）：

```
令牌长度: 329 字节
第 1 段解码: {"alg": "HS256", "typ": "JWT"}
第 2 段解码: {"sub": "dev-em300-SN20260001", "clientid": "dev-em300-SN20260001",
             "iat": 1792040000, "exp": 1792126400,
             "acl": {"pub": ["em/dev-em300-SN20260001/up/#"], "sub": ["em/dev-em300-SN20260001/down/#"]}}
```

本地复现：

```bash
mosquitto_passwd -c -b pw dev-em300-SN20260001 'S3cret-Pass'; chmod 0700 pw
# mosquitto.conf: allow_anonymous false / password_file <路径>/pw
mosquitto_pub -V 5 -u dev-em300-SN20260001 -P 'wrong' -t em/x -m 1      # Not authorized
mosquitto_passwd -D pw dev-em300-SN20260001 && kill -HUP <mosquitto进程号>  # 吊销并重载
```

### 4.2 现象 → 怀疑 → 观察点

| 现象 | 优先怀疑 | 观察点 |
|---|---|---|
| 设备连不上（0x86/0x87/返回码 4、5） | 凭证错、账号不存在、证书无效 | broker 日志具体原因 |
| 大量设备同时认证失败 | 认证服务故障；CA 或签发密钥更换 | 认证服务状态；密钥变更记录 |
| 删了账号设备仍能收发 | broker 不复查已有连接 | broker 行为；主动踢下线 |
| App 定时掉线 | JWT 过期 | `exp`；续签逻辑 |
| 连接高峰认证超时 | 外部认证服务瓶颈 | 接口耗时与错误率；缓存与限流 |

## 5. 复习 checklist

- [ ] 能区分认证与授权，说出四种方式的信任来源
- [ ] 能说出密码文件的存储方式与权限要求
- [ ] 能说出 Mosquitto 的失败返回码行为及其安全考量
- [ ] 能说明吊销时"已连接设备"的问题，及 Mosquitto 实测行为
- [ ] 能解释 JWT 结构、工作流程，以及"只编码不加密""不能证明身份"
- [ ] 能为电表场景各类客户端选择认证方式

---

参考：[Mosquitto · mosquitto.conf](https://mosquitto.org/man/mosquitto-conf-5.html)、[EMQX · JWT Authentication](https://docs.emqx.com/en/emqx/latest/access-control/authn/jwt.html)
