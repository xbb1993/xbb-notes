# 原因码、属性与用户属性

> 专题 17 · 模块四 · ★ 核心必会 · 侧重通用学习
> 版本基线：MQTT 5.0，3.1.1 差异单独标注
> 贯穿场景：电表 meter3 只被授权发布 `em/meter3/up/#`；后端需要追踪 ID、型号等元数据

**对应全景图的哪一块**：每个报文表格里的"处理结果"（原因码）与"附加条款"（属性）两栏。它们让 5.0 能说清失败原因、扩展新功能而不改报文格式。

## 1. 核心概念

### 1.1 问题：3.1.1 不会说"不"

无权限发布（QoS 1）：

```
-- MQTT 311:  received PUBACK (Mid: 1, RC:0)      ← 回"成功"，消息被静默丢弃
-- MQTT 5:    received PUBACK (Mid: 1, RC:135)    ← 0x87 Not authorized
```

3.1.1 的 PUBACK 根本没有一栏能写"失败"。

> 类比：3.1.1 的回执只有"收到"两字；5.0 多了一栏"处理结果"。

### 1.2 原因码

- 一个字节，出现在 CONNACK、PUBACK、PUBREC、PUBREL、PUBCOMP、SUBACK、UNSUBACK、DISCONNECT、AUTH。
- **< 0x80 成功/正常，≥ 0x80 失败**，看最高位即可。
- SUBACK / UNSUBACK **每个过滤器一个**原因码。
- 5.0 中 **broker 也能发 DISCONNECT** 说明断开原因。
- **Reason String** 属性：给人看的说明，只写日志，不供程序解析。

| 场景 | 常用原因码 |
|---|---|
| 连接（CONNACK） | 0x84 协议版本不支持、0x85 Client ID 不合法、0x86 用户名密码错、0x87 无权限、0x88/0x89 服务不可用/忙、0x8A 被封禁、0x9F 连接频率超限 |
| 发布（PUBACK/PUBREC） | **0x10 无匹配订阅者（成功）**、0x87 无权限、0x90 主题名不合法、0x95 报文过大、0x97 超配额、0x99 载荷格式不符 |
| 订阅（SUBACK） | 0x00/0x01/0x02 授予 QoS、0x87 无权限、0x8F 过滤器不合法、0x9E 不支持共享订阅、0xA2 不支持通配订阅 |
| 断开（DISCONNECT） | 0x00 正常、0x04 带遗嘱断开、0x81 畸形报文、0x82 协议错误、0x8B 服务器关闭、0x8D Keep Alive 超时、0x8E 会话被接管、0x98 管理员操作、0x9C/0x9D 换服务器 |

### 1.3 属性：通用扩展机制

3.1.1 报文表格写死，加新功能就得改格式；5.0 在可变头加"附加条款区"（属性长度 + 若干"ID + 值"），新功能只需新属性 ID。

> 类比：合同正文格式固定，新约定写进附加条款。

| 类别 | 主要属性 | 专题 |
|---|---|---|
| 会话与连接 | Session Expiry、Receive Maximum、Maximum Packet Size、Topic Alias Maximum、Server Keep Alive、Assigned Client ID | 6、7、12、13 |
| 能力声明（CONNACK） | Maximum QoS、Retain Available、Wildcard / Shared Subscription Available、Subscription Identifiers Available | 3、14、19 |
| 消息 | Message Expiry、Content Type、Payload Format Indicator、Topic Alias | 18 |
| 请求/响应 | Response Topic、Correlation Data | 20 |
| 订阅 | Subscription Identifier | 20 |
| 遗嘱 | Will Delay Interval 等 | 15 |
| 诊断 | Reason String、User Property | 本篇 |
| 认证 | Authentication Method / Data | 21、23 |

**能力声明**是专题 3"协议 vs 实现"在协议里的答案。Mosquitto 2.0.18 实测 CONNACK：

```
CONNACK 属性: [ReceiveMaximum : 20, TopicAliasMaximum : 10]
```

未出现的能力属性取默认值（多数为"支持"）：保留消息、QoS 2、共享订阅均支持。

### 1.4 用户属性

- UTF-8 键值对，几乎所有报文可带（心跳除外）；同键可多次出现。
- broker 转发 PUBLISH 时原样转发并保持顺序。

> 类比：HTTP 请求头。

| 适合 | 不适合 |
|---|---|
| 追踪 ID（全链路追踪） | 业务数据本身（读数、时间戳放载荷） |
| 载荷格式版本（新旧格式并存） | 大量或很长的键值对（每条都带，抵消省流量） |
| 设备型号、固件版本（后端分流） | 敏感信息（不加密、无单独权限） |
| | 订阅方有 3.1.1 客户端时必须送达的信息 |

流量账：3 个用户属性约 40 字节，载荷才 10 字节；适合低频消息或调试、灰度期临时开启。

### 1.5 局限

- 只在两端都用 5.0 时才有；老设备群只能部分受益。
- 原因码是一跳的（专题 10 两跳框架）。
- 各 broker 使用习惯不同（如订阅时是否检查权限），需结合日志。

## 2. 易混淆 / 易错点

| 错误理解 | 正确理解 |
|---|---|
| 3.1.1 PUBACK 成功即消息被接受 | 无权限也可能被静默丢弃 |
| PUBACK 0x10 是错误 | < 0x80，是成功，只是没人订阅 |
| 要记住每个码才能判成败 | 看是否 ≥ 0x80 |
| 只有客户端能发 DISCONNECT | 5.0 broker 也能发并说明原因 |
| Reason String 可做程序判断 | 只适合日志 |
| 属性只是多几个字段 | 是通用扩展机制 |
| CONNACK 没声明就是不支持 | 不出现取默认值，多为支持 |
| 用户属性会传到所有订阅者 | 3.1.1 订阅者收不到 |
| 用户属性多放点无妨 | 每条都带，增加流量，且不加密 |
| SUBACK 成功就能收到全部匹配消息 | 有的 broker 投递时才按权限过滤 |

## 3. 与其他章节的关联

| 本篇内容 | 相关专题 |
|---|---|
| 属性区的位置（表格视图） | 5（回顾） |
| CONNACK 原因码、Assigned Client ID | 6（回顾） |
| Server Keep Alive、0x8D | 7（回顾） |
| 0x10 发现主题拼错 | 8（回顾） |
| SUBACK 授予 QoS 与降级 | 10（回顾） |
| Session Expiry | 12（回顾） |
| 0x00 / 0x04 与遗嘱 | 15（回顾） |
| Message Expiry、Topic Alias | 18 |
| 0x9E、共享订阅能力 | 19 |
| Response Topic、订阅标识符 | 20 |
| AUTH、0x9C/0x9D 重定向 | 21 |
| 0x86、0x87 与认证授权 | 23、24 |
| 0x89、0x9F 与退避重连 | 43、47 |

## 4. 诊断实践

### 4.1 实验（云端真实输出，Mosquitto 2.0.18 + paho-mqtt 2.1.0）

**A 无权限发布**（acl：`topic readwrite em/meter3/up/#`，发到 `em/meter4/up/telemetry/power`）：

```
-- MQTT 311:  Client meter3 received PUBACK (Mid: 1, RC:0)
-- MQTT 5:    Client meter3 received PUBACK (Mid: 1, RC:135)
```

**C 有权限但无人订阅**：

```
-- MQTT 311:  received PUBACK (Mid: 1, RC:0)
-- MQTT 5:    received PUBACK (Mid: 1, RC:16)
```

**D 用户属性：5.0 vs 3.1.1 订阅者**：

```
[svc-v5]   payload={"p":12.3}  UserProperty=[('trace-id', 'a1b2c3'), ('model', 'EM300'), ('fw', '2.4.1')]
           ContentType=application/json  MessageExpiry剩余=60
[svc-v311] payload={"p":12.3}  （3.1.1 连接，没有属性）
```

**实测发现**：订阅 `em/+/up/#`、`other/#`、`#` 均被授予 QoS 1。Mosquitto 订阅时一律接受、**投递时才按权限过滤**，SUBACK 成功不代表能收到全部匹配消息（专题 24）。

本地复现：

```bash
mosquitto_pub -V 311 -q 1 -i meter3 -t em/meter4/up/telemetry/power -m 1 -d | grep PUBACK
mosquitto_pub -V 5   -q 1 -i meter3 -t em/meter4/up/telemetry/power -m 1 -d | grep PUBACK
mosquitto_pub -V 5 -q 1 -t em/meter3/up/x -m 1 -D publish user-property trace-id a1b2c3 -d
```

### 4.2 现象 → 怀疑 → 观察点

| 现象 | 优先怀疑 | 观察点 |
|---|---|---|
| 设备说发了、后端没收到、PUBACK 成功 | 3.1.1 下无权限被静默丢弃；主题拼错 | 改 5.0 看 PUBACK（0x87 / 0x10）；授权日志 |
| 设备被断开原因不明 | — | broker 发来的 DISCONNECT 原因码与 Reason String |
| 连接失败 | 版本、凭证、ID、限流 | CONNACK：0x84 / 0x86 / 0x85 / 0x9F |
| 订阅成功却缺消息 | 投递时被权限过滤 | 授权日志，不只看 SUBACK |
| 后端拿不到用户属性 | 某一跳是 3.1.1 | 各客户端协议版本 |
| 某功能不工作 | broker 不支持 | CONNACK 能力属性 |

## 5. 复习 checklist

- [ ] 能用实验 A 说明 3.1.1 为什么"不会说不"
- [ ] 能说出原因码出现在哪些报文、成败分界规则
- [ ] 能按连接、发布、订阅、断开各说出 3 个常用码，知道 0x10 是成功
- [ ] 能解释属性为什么是"通用扩展机制"，说出 5 类属性及对应专题
- [ ] 能读懂 CONNACK 能力声明，知道"不出现取默认值"
- [ ] 能说出用户属性的适用与不适用场景，以及 3.1.1 订阅者收不到
- [ ] 能说出 Mosquitto 订阅授权的实测行为

---

参考：[EMQX · MQTT 5.0 Reason Code and ACK](https://www.emqx.com/en/blog/mqtt5-new-features-reason-code-and-ack)、[HiveMQ · MQTT 5 User Properties](https://www.hivemq.com/blog/mqtt5-essentials-part6-user-properties/)、[Mosquitto · mosquitto.conf](https://mosquitto.org/man/mosquitto-conf-5.html)
