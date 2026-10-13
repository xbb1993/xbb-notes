# 协议 vs 实现：MQTT 的选型定位与版本演进

> 专题 3 · 模块一 · ☆ 高频重点 · 侧重通用学习
> 版本基线：MQTT 5.0，3.1.1 差异单独标注
> 贯穿场景：电表 meter3 上报 `m/meter3/power`，后端入库组用共享订阅分摊

**对应全景图的哪一块**：全景图中间的 broker 具体是哪个软件、支持到哪个版本；决定"规范上有"和"手里的 broker 真能用"之间的差距。

## 1. 核心概念

### 1.1 协议 vs 实现

> 类比：SQL 标准 vs MySQL / PostgreSQL。

```
 OASIS MQTT 5.0 规范（一份文档）
        │  各家按它实现
        ├── Mosquitto   （C，单进程，轻量）
        ├── EMQX        （Erlang，集群）
        ├── HiveMQ      （Java，企业级）
        └── NanoMQ 等   （边缘侧）
```

规范措辞三档：**MUST**（必须）/ **SHOULD**（建议）/ **MAY**（可选）。实现差异集中在：

| 差异点 | 例子 |
|---|---|
| 可选特性 | broker 可以不支持共享订阅、保留消息，在 CONNACK 里声明即可 |
| 限制与默认值 | 最大报文、离线队列长度、Keep Alive 上限 |
| 规范之外的扩展 | **集群、规则引擎、`$SYS` 监控主题都不在规范里** |
| 实现细节与 bug | 边界情况行为 |

### 1.2 版本演进

| 版本 | 时间 | 要点 | CONNECT 协议级别 |
|---|---|---|---|
| 3.1 | IBM 公开 | 最早公开版 | 3 |
| **3.1.1** | **2014-10-29** OASIS 标准；ISO/IEC 20922:2016 | 修订澄清 3.1，至今大量设备在用 | 4 |
| **5.0** | **2019-03-07** OASIS 标准 | 大版本升级 | 5 |

- **没有 MQTT 4**：3.1.1 的协议级别字节已是 4，下一版直接叫 5.0 避免混淆。
- **3.1.1 与 5.0 可共存**：broker 按每条连接的协议级别分别处理；3.1.1 连接用不了 5.0 特性。

5.0 主要新增：

| 新增 | 解决的问题 | 专题 |
|---|---|---|
| 原因码、属性、用户属性 | 3.1.1 失败时几乎不说原因 | 17 |
| 会话过期、消息过期 | 3.1.1 会话要么永久要么断开即清 | 12、18 |
| 共享订阅 | 3.1.1 无标准"组内三选一" | 19 |
| 请求/响应、流控、Topic Alias | 指令应答、慢消费者、省带宽 | 13、18、20 |

**5.0 之后**：没有 MQTT 6 在推进；OASIS 在推进 **MQTT-SN** 标准化，2025-11 子委员会宣布准备把建议提交 TC，尚未成为正式标准。

### 1.3 主流 broker 现状（2026-10 核实）

| Broker | 现状 | 选型影响 |
|---|---|---|
| Mosquitto | 最新 **2.1.2（2026-02-09）**，2.1.0 于 2026-01-29 发布；开源版**无集群** | 学协议、边缘 broker；Ubuntu apt 仍为 2.0.18 |
| EMQX | **5.9.0 起改为 BSL 1.1**，开源版与企业版合并；**单节点生产免费，多节点集群需商业许可**；每个版本发布 4 年后转 Apache 2.0；5.9.0 之前的 Apache 2.0 版本仍可用 | 自建集群要么购买许可，要么停在 5.8.x 及以前 |
| HiveMQ / NanoMQ / VerneMQ | 未核实 | 专题 29 |

> 许可解读以官方 FAQ 与 BSL 原文为准，必要时请法务确认。

### 1.4 适用边界（只讲边界）

| 协议 | 定位 | 选它而不选 MQTT 的场景 |
|---|---|---|
| HTTP | 一问一答，生态最全 | 低频上报、大文件（OTA 固件）、对外 API |
| CoAP | 受限设备的轻量"类 HTTP"，基于 UDP | 电池设备长期休眠，不维持长连接 |
| AMQP | 企业消息协议，路由与队列语义丰富 | 后端系统间复杂路由、事务性消息 |
| **MQTT** | 长连接 + 发布订阅 + 分级可靠性 | **海量设备遥测上报、下发指令、在线状态** |

常见组合：设备侧 MQTT 接入，broker 桥接到后端 Kafka 或数据库（专题 42）。

### 1.5 局限

- 规范只管"线上传什么字节"，不管集群、持久化、鉴权做法、载荷格式。
- 选 broker 时，许可、集群能力、运维生态往往比协议特性更关键。

## 2. 易混淆 / 易错点

| 错误理解 | 正确理解 |
|---|---|
| MQTT 支持集群 | 规范完全不涉及集群，那是 broker 的能力 |
| 换个 broker 行为完全一样 | 协议层基本一致，限制、默认值、扩展各不相同 |
| 版本是 3 → 4 → 5 | 是 3.1 → 3.1.1 → 5.0；"4" 只是 3.1.1 的协议级别字节 |
| 升级 broker 到 5.0，老设备就得改 | 同一 broker 可同时接 3.1.1 和 5.0 连接 |
| 客户端库支持 5.0 就一定在用 5.0 | 要显式按 5.0 连接，否则可能仍是 3.1.1 |
| EMQX 还是 Apache 2.0 开源 | 5.9.0 起为 BSL 1.1，集群受限 |

## 3. 与其他章节的关联

| 本篇内容 | 后续专题 |
|---|---|
| 5.0 新特性总览 | 模块四：17–21 |
| 保留消息、共享订阅、消息过期、QoS 2（实验已见） | 14、19、18、11 |
| broker 实现差异、许可 | 26 架构、29 Broker 对比 |
| 集群不在规范里 | 31 集群 |
| CONNECT 协议级别 | 5 报文结构、6 连接建立 |
| MQTT-SN、CoAP | 36 |
| 与 Kafka/数据库组合 | 42 规则引擎与数据集成 |

## 4. 实验：Mosquitto 2.0.18 特性探测（云端真实输出）

```
== 1. 保留消息 ==
m/meter3/power 12.3
== 2. 共享订阅 ==
subA 收到: e1 e3 e5
subB 收到: e2 e4 e6
== 3. 消息过期（5.0）==
3 秒后订阅: (没收到)
== 4. QoS 2 握手 ==
... sending PUBLISH (d0, q2, r0, m1, 'm/meter3/power', ... (4 bytes))
... received PUBREC (Mid: 1)
... sending PUBREL (m1)
... received PUBCOMP (Mid: 1, RC:0)
```

- 保留消息：先发后订，订阅即收到。
- 共享订阅：两个订阅者轮流分到（Mosquitto 默认轮询）。
- 消息过期：2 秒过期的保留指令，3 秒后订阅收不到（5.0 特性）。
- QoS 2：可见四步握手。

本地复现：

```bash
mosquitto_pub -V 5 -t m/meter3/power -m 12.3 -r
mosquitto_sub -V 5 -t m/meter3/power -v -W 1

mosquitto_sub -V 5 -t '$share/ingest/m/+/energy' -i subA &
mosquitto_sub -V 5 -t '$share/ingest/m/+/energy' -i subB &
for i in 1 2 3 4 5 6; do mosquitto_pub -V 5 -t m/meter3/energy -m "e$i"; done

mosquitto_pub -V 5 -t m/meter3/cmd -m 'set-period 30' -r -D publish message-expiry-interval 2
sleep 3; mosquitto_sub -V 5 -t m/meter3/cmd -v -W 1

mosquitto_pub -V 5 -q 2 -t m/meter3/power -m 12.4 -d
```

EMQX 对比（本地验证）：**预期** 4 项均支持，差异在共享订阅分配策略与默认限制——尚未实测。

### 出问题时从哪里看

| 现象 | 怀疑 | 观察点 |
|---|---|---|
| 5.0 特性不生效 | 客户端实际按 3.1.1 连接 | 抓包看 CONNECT 协议级别；broker 连接日志 |
| 换 broker 后行为变了 | 默认值或限制不同 | 对比最大报文、队列长度、Keep Alive 配置 |
| 共享订阅不分摊 | 不支持或前缀写错 | SUBACK 返回码；确认 `$share/组名/主题` |

## 5. 复习 checklist

- [ ] 能用 SQL 标准 vs 数据库的类比解释协议与实现
- [ ] 能说出实现差异集中的四个地方
- [ ] 能说出 3.1.1、5.0 的标准化时间，以及为什么没有 MQTT 4
- [ ] 能说出 5.0 的四类主要新增及各自解决的问题
- [ ] 知道 3.1.1 与 5.0 可在同一 broker 共存
- [ ] 能说清 EMQX 5.9.0 起的许可变化对集群的影响
- [ ] 能用一张表说出 HTTP / CoAP / AMQP / MQTT 的适用边界
- [ ] 能复述四项特性探测的结果

---

参考：[Mosquitto 2026 releases](https://mosquitto.org/2026/)、[EMQX Licensing FAQ](https://www.emqx.com/en/content/license-faq)、[EMQX adopts BSL](https://www.emqx.com/en/blog/adopting-business-source-license-to-accelerate-mqtt-and-ai-innovation)、[OASIS MQTT TC milestone](https://groups.oasis-open.org/discussion/we-have-reached-an-important-mqtt-technical-committee-milestone)、[MQTT – Wikipedia](https://en.wikipedia.org/wiki/MQTT)
