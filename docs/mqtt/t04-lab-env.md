# 实验环境与工具

> 专题 4 · 模块一 · ☆ 高频重点 · 侧重两者兼顾（概念版，不含实验过程）

**对应全景图的哪一块**：把"设备 → broker → 后端"落到具体软件上，知道每个工具在后续学习里的角色。

## 1. 核心概念

### 1.1 工具与角色

```
 客户端（模拟设备/后端）            broker                    观察
 mosquitto_pub / sub  ──┐      ┌─ Mosquitto（学协议）      Wireshark / tshark / tcpdump
 MQTTX（图形界面）     ──┼────> ┤                           （看线上真实字节）
                        ┘      └─ EMQX（学集群与运维）
```

| 工具 | 是什么 | 后续主要用在 |
|---|---|---|
| Mosquitto | 轻量 C 语言 broker，行为贴近规范，日志直观；开源版无集群 | 模块二、三：协议与可靠性 |
| EMQX | Erlang broker，有集群、管理后台、规则引擎 | 模块六、七、十一：内部、集群、运维 |
| `mosquitto_pub` / `mosquitto_sub` | 命令行客户端，可写脚本、可复现 | 几乎所有实验 |
| MQTTX | EMQX 出品的图形客户端 | 手动验证、查看 5.0 属性 |
| Wireshark / tshark / tcpdump | 抓包与解码；tshark 是 Wireshark 的命令行版，tcpdump 只负责抓 | 专题 5、6、11、49 |

**为什么两个 broker**：协议和实现是两回事（专题 3），同一现象在两边对照，才能分清"规范规定"和"这个 broker 的做法"。

### 1.2 版本基线（2026-10 核实）

| 软件 | 版本 |
|---|---|
| Mosquitto | 上游 2.1.2；Docker 镜像 `eclipse-mosquitto:2.1.2-alpine`；云端实验用 apt 的 2.0.18 |
| EMQX | 文档最新 6.3.1；5.9.0 起 BSL 1.1，开发测试可用，生产集群需许可 |
| tshark | 云端实验用 4.2.2 |

### 1.3 一次发布在线上长什么样（云端实测）

`mosquitto_pub -V 5 -i meter3 -q 1` 发一条消息，抓到 5 个报文：

```
CONNECT → CONNACK → PUBLISH(id=1) → PUBACK(id=1) → DISCONNECT
```

CONNECT 共 24 字节，专题 5、6 逐字节拆：

```
10 16 | 00 04 4D 51 54 54 | 05 | 02 | 00 3C | 03 21 00 14 | 00 06 6D 65 74 65 72 33
固定头 |   "MQTT"           | 版本5| 标志 | 保活60s| 属性:Receive Max=20 | Client ID "meter3"
```

命令行工具每次"连—发—断"；真实设备是一条长连接上持续收发。

## 2. 易混淆 / 易错点

| 错误理解 | 正确理解 |
|---|---|
| broker 容器起来就能从外面连 | Mosquitto 2.0+ 没配置监听器时只接受本机连接，且默认不允许匿名 |
| 实验里的 `allow_anonymous true` 可以带到生产 | 只限实验，生产必须认证 + 授权（专题 23、24） |
| Wireshark 能自动解所有 MQTT | 只认默认端口 1883，其他端口要 Decode As；8883 的 TLS 内容看不到 |
| 解码器字段名就是规范术语 | tshark 显示的 `Clean Session Flag` 是 3.1.1 叫法，5.0 叫 Clean Start；Connect Flags 里的 `QoS Level` 是**遗嘱 QoS**，MQTT 没有"连接级 QoS" |
| 两个 broker 能同时用 1883 | 同一台主机端口冲突，需映射到不同端口 |

## 3. 与其他章节的关联

| 本篇内容 | 后续专题 |
|---|---|
| CONNECT 字节布局 | 5 报文结构、6 连接建立 |
| 保活 60 秒 | 7 Keep Alive |
| Receive Maximum 属性 | 13 流控、17 属性 |
| Clean Start | 12 会话状态 |
| PUBACK | 10 QoS 1 |
| 匿名访问的风险 | 23 认证、24 授权 |
| EMQX 集群、管理后台 | 31 集群、46 监控 |
| 抓包排查 | 49 协议级抓包 |

## 4. 复习 checklist

- [ ] 能说出 Mosquitto 和 EMQX 各自在学习中的角色
- [ ] 能说出命令行客户端、MQTTX、抓包工具各自用来干什么
- [ ] 能说出一次 QoS 1 发布产生的 5 个报文
- [ ] 知道 Mosquitto 2.0+ 默认只接受本机连接
- [ ] 能指出抓包解码器里两个与规范不一致的字段名
