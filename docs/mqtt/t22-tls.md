# 威胁模型与传输安全：TLS 与双向 TLS

> 专题 22 · 模块五 · ★ 核心必会 · 侧重通用学习
> 版本基线：MQTT 5.0；TLS 1.3（实测协商结果）
> 贯穿场景：电表经 4G + 公网连接 broker，路上每一跳都可能被窃听或篡改

**对应全景图的哪一块**：电表到 broker 之间的那段路。讲法为概念层，不展开 TLS 字节细节。

## 1. 核心概念

### 1.1 威胁模型

| 威胁 | 电表场景 | 主要防线 |
|---|---|---|
| 窃听 | 抓包读出密码、用电数据 | TLS 加密 |
| 篡改 | 改小读数；把指令改成"拉闸" | TLS 完整性校验 |
| 冒充 broker | 伪基站/劫持 DNS 让电表连到攻击者 | TLS + **设备校验服务端证书** |
| 冒充设备 | 往平台发假数据 | 认证：客户端证书（本篇）、密码/令牌（23） |
| 越权 | 冒充成功后访问别人的主题 | 授权（24） |
| 网络层重放 | 录下密文原样重发 | TLS 自带防护 |
| 应用层旧指令重放 | 重复执行旧"拉闸" | 指令时间戳/随机数（39） |

明文 1883 实测：抓包直接读出 `用户名=meter3 密码=S3cret-Pass`、载荷 `{"kwh":12345.6}`。

### 1.2 TLS 原理（概念层）

```
 MQTT 报文      ← 内容不变，端口 1883 → 8883
 ──── TLS ────  ← 加密、完整性、证明对方身份
 TCP
```

> 类比：证书 = 身份证；CA = 发证的公安局（在证书上签名）；信任锚 = 设备里预置的、你认可的 CA。

校验三件事：**签名来自可信 CA、证书名字与所连地址一致、在有效期内**。

```
电表                                         broker
 │ ① Client Hello：我支持这些加密方式            │
 │ ② Server Hello + 证书                        │
 │ ③ 电表校验证书，不对立即断开                   │
 │ ④ 双方算出本次连接专用的会话密钥               │
 │ ⑤ 之后所有 MQTT 报文加密 + 完整性校验          │
```

- 公钥只用于验身份、协商密钥；数据用对称会话密钥加密。
- TLS 1.3 握手 1 个往返，TLS 1.2 为 2 个。实测协商：`TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384`。

### 1.3 设备必须校验服务端证书

**不校验证书的 TLS 只防窃听，不防冒充**（中间人攻击：照样把密码交给攻击者、执行攻击者的指令）。常见坑：证书报错后关掉校验（`--insecure`、`verify=none`）。

| 前提 | 坑 |
|---|---|
| 预置正确 CA（信任锚） | CA 到期或更换后需远程更新（25） |
| 用证书上的主机名连接 | 证书写域名却用 IP 连 |
| **设备时间正确** | 上电未校时为 1970 年，证书"尚未生效"；先 NTP/蜂窝校时或固件写入最早合理时间 |

### 1.4 双向 TLS（mTLS）

broker 也验设备证书。私钥不离开设备，握手只证明"持有私钥"。

- 无证书：握手阶段即被拒，连 CONNECT 都发不出。
- Mosquitto `use_identity_as_username`：证书 CN 作为用户名，设备无需密码。
- 可信度来自签发的 CA，不是证书上的名字（同 CN 的冒牌证书被拒）。
- **还需加"Client ID = 证书 CN"校验**（24、25），否则 Client ID 仍可乱填（实测 Client ID `meter3` 与 CN 不一致也放行）。

| | 用户名密码（走 TLS） | 客户端证书 |
|---|---|---|
| 设备存 | 密码 | 私钥 + 证书 |
| 泄露风险 | 密码要发给 broker | 私钥不离开设备 |
| 一机一密 | 需逐台生成下发 | 天然一机一证 |
| 吊销 | 改密码/删账号 | CRL / OCSP（25） |
| 成本 | 低 | 建 CA、产线烧录、到期轮换 |

### 1.5 开销（实测）

| 项目 | 1883 | 8883 |
|---|---|---|
| 一次 连接→发布→断开（含 TCP/IP 头） | 13 包，988 字节 | 20 包，4713 字节 |
| 连接建立后每条 QoS 1 上报（PUBLISH+PUBACK） | 56 字节 | 100 字节 |

每个 TLS 1.3 记录多 22 字节（5 头 + 1 类型 + 16 认证标签），小消息开销比例高。MCU 上握手计算可达数百毫秒到数秒，TLS 库与缓冲区占几十 KB（44）。

| 降低开销 | 效果 |
|---|---|
| 保持长连接 | 握手只做一次 |
| TLS 1.3 | 少一个往返 |
| 会话恢复 | 重连跳过完整握手 |
| ECC 证书 | 证书更小、计算更快 |
| 短证书链、批量上报 | 少传证书、摊薄封装 |

### 1.6 TLS 终结位置

broker 直接终结，或负载均衡器终结后再转发（证书集中管理、broker 省 CPU；需保护后段网络、mTLS 身份需透传，32）。

### 1.7 局限

- 只保护传输段；broker 被攻破、合法设备被攻破发假数据都挡不住。
- 难点在证书管理（出厂、轮换、吊销，25）。
- 受限设备上可能是最大资源消耗（44）。

## 2. 易混淆 / 易错点

| 错误理解 | 正确理解 |
|---|---|
| 设了用户名密码就安全 | 明文下密码裸奔 |
| 用了 TLS 就防住冒充 | 设备须校验 CA + 主机名 + 有效期 |
| 校验报错就关掉先跑 | 等于向中间人敞开 |
| 证书名字对就可信 | 可信来自签发 CA |
| 双向 TLS 就绑定了 Client ID | 还需 Client ID = CN 校验 |
| TLS 开销可忽略 | 握手约多 4 KB；小消息每条多 22 字节；MCU 负担真实 |
| TLS 防一切重放 | 只防网络层，应用层靠时间戳 |
| TLS 保护全程 | 只保护传输段 |
| 设备时间不重要 | 时间错证书校验失败 |

## 3. 与其他章节的关联

| 本篇内容 | 相关专题 |
|---|---|
| 8883、长连接摊薄握手 | 1、7（回顾） |
| Client ID 与身份绑定 | 6（回顾）、24、25 |
| 过期指令 / 应用层重放 | 12（回顾）、39 |
| 认证方式对比 | 23 |
| 授权、CN 校验 | 24 |
| 证书生命周期、吊销 | 25 |
| TLS 终结与负载均衡 | 32 |
| WebSocket 上的 TLS | 34 |
| 受限设备 TLS 开销 | 44 |

## 4. 诊断实践

### 4.1 实验（云端真实输出，Mosquitto 2.0.18 + tshark 4.2.2 + openssl，自建实验 CA）

**明文 vs TLS 抓包**：

```
=== 1883 明文：从抓包里能直接读出 ===
  CONNECT  用户名=meter3  密码=S3cret-Pass
  PUBLISH  主题=em/meter3/up/telemetry/energy  载荷(hex)=7b226b7768223a31323334352e367d
=== 8883 TLS：抓包里只看到 ===
      1 22	Client Hello (SNI=localhost)
      1 22,20	Server Hello, Change Cipher Spec, Application Data, ...
      1 20	Change Cipher Spec, Application Data
      9 	Application Data
  在 8883 的原始字节里搜索 'S3cret' 与 '12345'：都找不到
```

**服务端证书校验**：

| 实验 | 结果 | openssl 给出的原因 |
|---|---|---|
| V1 信任正确 CA | 发布成功 | — |
| V2 只信任冒牌 CA | `Error: Protocol error` | `num=19: self-signed certificate in certificate chain` |
| V3 主机名不符 | `Error: Protocol error` | `num=62: hostname mismatch` |
| V4 同 V3 加 `--insecure` | **发布成功**（危险） | — |

**双向 TLS（8884，require_certificate + use_identity_as_username）**：

| 实验 | 结果 | broker 日志 |
|---|---|---|
| M1 不带客户端证书 | 连接断开 | `peer did not return a certificate` |
| M2 带 meter3 设备证书 | 发布成功 | `as meter3 (p5, c1, k60, u'dev-em300-SN20260001')` |
| M3 同 CN、冒牌 CA 签发 | 连接断开 | `certificate verify failed` |

本地复现：

```bash
# 实验 CA 与证书
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -days 365 -subj "/CN=EM-Lab-Root-CA"
openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj "/CN=broker.em.local"
printf "subjectAltName=DNS:broker.em.local,DNS:localhost,IP:127.0.0.1\n" > san.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 365 -extfile san.ext
openssl req -newkey rsa:2048 -nodes -keyout meter3.key -out meter3.csr -subj "/CN=dev-em300-SN20260001"
openssl x509 -req -in meter3.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out meter3.crt -days 365
# mosquitto.conf 片段
# listener 8883            listener 8884
# cafile ca.crt            cafile/certfile/keyfile 同左
# certfile server.crt      require_certificate true
# keyfile server.key       use_identity_as_username true
mosquitto_pub -V 5 -p 8883 -h localhost --cafile ca.crt -t t -m x
mosquitto_pub -V 5 -p 8884 -h localhost --cafile ca.crt --cert meter3.crt --key meter3.key -t t -m x
echo | openssl s_client -connect localhost:8883 -CAfile ca.crt     # 排查时看 Verify return code
```

### 4.2 现象 → 怀疑 → 观察点

| 现象 | 优先怀疑 | 观察点 |
|---|---|---|
| 连 8883 失败、报错笼统 | CA、主机名、有效期 | `openssl s_client` 的 verify error 编号 |
| **刚上电连不上，过一会好了** | 设备未校时 | 设备时间、NTP 流程 |
| 某天所有设备集体连不上 | broker 证书或 CA 过期 | 证书有效期监控 |
| mTLS 下个别设备被拒 | 设备证书过期/吊销/非可信 CA | broker 日志 OpenSSL Error |
| 流量费偏高 | 频繁重连做完整握手 | 每日连接次数、会话恢复 |
| 抓包见明文 | 走了 1883 或 TLS 被关 | 端口与监听配置 |
| 审计发现不校验证书 | 固件关闭校验 | 固件 TLS 配置 |

## 5. 复习 checklist

- [ ] 能列出四类威胁及各自防线，区分网络层与应用层重放
- [ ] 能用"身份证、公安局"解释证书、CA、信任锚与三项校验
- [ ] 能描述 TLS 握手五步，说出 1.2 与 1.3 往返数差异
- [ ] 能解释不校验证书为什么挡不住中间人，说出设备侧三个前提
- [ ] 能说明双向 TLS 的作用、use_identity_as_username，及为何还需 CN 校验
- [ ] 能对比用户名密码与客户端证书
- [ ] 能说出实测的握手与每条消息开销，以及降开销手段
- [ ] 能用 openssl s_client 排查证书问题

---

参考：[Mosquitto · mosquitto.conf](https://mosquitto.org/man/mosquitto-conf-5.html)、[OASIS MQTT 5.0 规范 第 5 章](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html)、[RFC 8446 · TLS 1.3](https://www.rfc-editor.org/rfc/rfc8446)
