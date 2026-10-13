# Keep Alive、心跳与 Client take-over

> 专题 7 · 模块二 · ★ 核心必会 · 侧重两者兼顾
> 版本基线：MQTT 5.0，3.1.1 差异单独标注
> 贯穿场景：电表 meter3 经 4G 和运营商 NAT 连接 broker，Keep Alive = 60 秒，每 10 秒上报一次

**对应全景图的哪一块**：连接建好之后，双方怎么确认对方还活着。决定 broker 多久发现电表掉线、遗嘱多久触发，并回答专题 1 留下的 NAT 问题。

**交互图解**：<a href="/xbb-notes/mqtt-keepalive-timeline.html" target="_blank">Keep Alive 时间线（四个场景，可调 Keep Alive 与 NAT 超时）</a>

## 1. 核心概念

### 1.1 半开连接

**TCP 只在发数据时才可能发现对方不在了**；没有数据要发时，一条早已不通的连接可以在双方记录里"活"很久。

```
   电表 ─── 4G 基站 ─── 运营商 NAT ─── 互联网 ─── broker
                ✂ 信号丢了 / NAT 回收了映射
   电表：连接还在        broker：连接还在        实际：早就不通了
```

一端或两端以为连接还在、实际已不通 = **半开连接**。

> 类比：打电话时对方手机没电了，你这边没有挂断音。你不问一句"喂，还在吗"，就永远不知道。

危害：遗嘱迟迟不触发（平台一直显示在线）、指令发进黑洞、死连接占用 broker 内存。

TCP 自带手段不够用：

| 手段 | 问题 |
|---|---|
| 发送超时重传 | 要有数据可发；Linux 默认重传多次，可能十几分钟以上才放弃 |
| TCP keepalive | Linux 默认空闲 2 小时才探测；系统级设置，很多设备改不了；发现不了应用卡死 |

### 1.2 Keep Alive 机制

CONNECT 里 `Keep Alive = 60`，含义是："我保证每 60 秒内至少发一个报文；没事可说就发心跳。"

```
电表 ── PINGREQ（2 字节）──> broker
电表 <── PINGRESP（2 字节）── broker
```

| 谁 | 判定规则 | 来源 |
|---|---|---|
| broker | 超过 **1.5 倍** Keep Alive 没收到**任何报文** → 必须断开 | 规范 MUST |
| 客户端 | 发了 PINGREQ，合理时间内没收到 PINGRESP → 应断开并重连 | 规范 SHOULD，时间由客户端库决定 |

- **1.5 倍**：给网络抖动留余量，避免误判。
- **任何报文都算**：电表每 10 秒上报，就**不需要发心跳**；心跳只在空闲时出现。
- broker 从**最后一次收到报文**开始计时，不是从断网那一刻。
- 心跳是**双向探活**：PINGREQ 让 broker 知道电表活着，PINGRESP 让电表知道 broker 活着。

```
时间(秒)  0        10       20 ...                    100 (=10 + 1.5×60)
电表      PUBLISH  PUBLISH  ✂
broker    收到     收到     ……一直没收到……             └─> 断开，发布遗嘱
```

### 1.3 Client take-over 的作用

```
断网 → broker 仍挂着旧连接（半开）
电表发现后重连（新连接）
  若拒绝新连接：要等 broker 自己超时才能恢复
  实际：新连接接管旧连接 → 立刻恢复
```

Keep Alive 越长，接管机制越重要。互踢（专题 6）是它被误用的副作用。接管是否误报遗嘱，看 5.0 的 Will Delay Interval（专题 15）。

### 1.4 NAT 与 Keep Alive

NAT 为每条连接维护映射，**空闲太久就悄悄删除**，不通知任何一方，连接随即变成半开。

| 来源 | NAT 空闲超时 |
|---|---|
| RFC 5382（REQ-5） | 已建立的 TCP 连接，**不得少于 2 小时 4 分钟** |
| 移动运营商实测（一篇实测文章） | 某运营商不到 7 分钟就回收，作者把心跳设为 270 秒 |

标准很宽松，但实际可能只有几分钟。Keep Alive 的第二个作用是**定期给 NAT 映射"续命"**：

```
Keep Alive < NAT 超时  → 连接稳定
Keep Alive > NAT 超时  → 空闲时映射被删 → 周期性掉线重连
```

### 1.5 Keep Alive 取值

| 取值 | 好处 | 代价 |
|---|---|---|
| 短 | 掉线发现快；NAT 不易回收 | 空闲时心跳多，耗电耗流量，增加 broker 负载 |
| 长 | 省电省流量 | 掉线发现慢；可能超过 NAT 超时 |

推导顺序：

1. 上限：低于运营商 NAT 超时（4G 按"几分钟"估）。
2. 业务能容忍多久发现掉线（约 1.5 × Keep Alive）。
3. 上报间隔比 Keep Alive 短时，心跳几乎不发，取值对流量影响很小。

电表示例：10 秒上报、Keep Alive 60 秒 → 正常时零心跳，掉线约 90 秒被发现。

**隐藏的坑**：规范只要求客户端"发"报文；一直用 QoS 0 上报的设备可能长期收不到 broker 的任何回应，数据一直发进半开连接而不自知。应使用 QoS 1，或确认客户端库会检查"最近是否收到过东西"（专题 43）。

| 规则 | 含义 |
|---|---|
| Keep Alive = 0 | 关闭机制，死连接永不清理，设备上不要用 |
| 最大 65535 秒 | 约 18 小时 |
| Server Keep Alive（5.0） | broker 在 CONNACK 中改写客户端的值，客户端必须服从；平台可统一管控 |

### 1.6 MQTT Keep Alive vs TCP keepalive

| | MQTT Keep Alive | TCP keepalive |
|---|---|---|
| 层 | 应用层 | 内核传输层 |
| 配置 | 客户端在 CONNECT 里填 | 系统参数，Linux 默认空闲 2 小时 |
| 能证明 | 对方**应用**活着 | 只证明对方操作系统活着 |

### 1.7 局限

- 只能做到"1.5 倍时间内发现"，做不到立刻发现；秒级感知需业务层配合。
- 长期休眠的电池设备无法维持心跳，不适合长连接（专题 36）。
- 判定的精确时刻是实现细节，不同 broker 不同。

## 2. 易混淆 / 易错点

| 错误理解 | 正确理解 |
|---|---|
| 网络断了 TCP 马上报错 | 不发数据就发现不了，形成半开连接 |
| 心跳每个 Keep Alive 固定发一次 | 只在空闲时发 |
| broker 在 1 倍 Keep Alive 时判定 | 1.5 倍，从最后收到报文算起 |
| Keep Alive 越短越可靠 | 越短越耗电耗流量、加重 broker；要在 NAT 超时与发现速度间取舍 |
| 有 TCP keepalive 就够了 | 默认 2 小时，且发现不了应用卡死 |
| 设备一直在发，连接肯定正常 | QoS 0 可能一直发进半开连接 |
| Keep Alive = 0 最省 | 0 是关闭探活 |
| 运营商 NAT 都遵守 2 小时标准 | 实测有几分钟就回收的 |

## 3. 与其他章节的关联

| 本篇内容 | 后续专题 |
|---|---|
| Keep Alive 栏、接管 | 6 连接建立 |
| QoS 0 发进半开连接、PUBACK 作为回应 | 10 QoS 0/1 |
| 掉线后的会话与离线消息 | 12 会话状态 |
| 判定掉线 → 遗嘱；Will Delay Interval | 15 遗嘱与在线状态 |
| Server Keep Alive 属性 | 17 原因码与属性 |
| 心跳对 broker 的负载、百万连接 | 26、32 |
| 客户端重连与退避、检测半开 | 43 客户端工程 |
| 周期性掉线的排查 | 47 故障诊断 |
| 休眠设备的替代方案 | 36 MQTT-SN、CoAP |

## 4. 诊断实践

### 4.1 实验：两种"半开"，broker 多久发现（云端真实输出，Mosquitto 2.0.18）

Keep Alive = 5 秒，理论判定 7.5 秒；观察者订阅遗嘱主题，以收到遗嘱的时刻代表 broker 判定时刻。

**A. 应用卡死**（冻结客户端进程，TCP 完好）：

```
09:14:51.728 冻结 meter3
09:15:00.652 观察者收到遗嘱：m/meter3/status offline  （冻结后 8.92 秒）
broker 日志：Client meter3 has exceeded timeout, disconnecting.
```

**B. 网络静默丢包**（防火墙丢弃该连接所有包）：

```
09:17:31.866 Subscribed                ← broker 最后一次收到电表报文
09:17:33.091 （开始丢包）
09:17:36.861 电表 sending PINGREQ      ← 空闲 5 秒，发心跳，石沉大海
09:17:41.500 观察者收到遗嘱             ← broker 判定（断网后 8.40 秒）
09:17:42.871 电表 sending CONNECT      ← 约 6 秒没等到 PINGRESP，主动重连
09:17:42.874 电表 received CONNACK (0)
```

| | 理论 | 实测 |
|---|---|---|
| broker 判定 | 最后收到报文后 7.5 秒 | A 约 8.9 秒；B 约 9.6 秒（断网后 8.4 秒） |
| 客户端判定 | 未规定 | 发心跳后约 6 秒 |

- broker 两次都比理论晚约 2 秒；推测来自 Mosquitto 定期检查超时的间隔（未核实），属实现细节。
- 两端各自独立发现：broker 靠"收不到报文"，客户端靠"等不到 PINGRESP"。
- 实验 A 说明 Keep Alive 能发现应用卡死，TCP keepalive 不能。

本地复现：

```bash
mosquitto_sub -V 5 -t 'm/+/status' -F '%t %p' &                       # 观察者
mosquitto_sub -V 5 -i meter3 -k 5 -d -t m/meter3/cmd \
  --will-topic m/meter3/status --will-payload offline &               # 电表
sleep 1; date; kill -STOP %2                                           # A：冻结
# B：iptables -A INPUT -p tcp --sport <客户端端口> -j DROP（再加 --dport 一条）
```

### 4.2 现象 → 怀疑 → 观察点

| 现象 | 优先怀疑 | 观察点 |
|---|---|---|
| 设备每隔固定几分钟掉线重连 | Keep Alive 大于运营商 NAT 超时 | 掉线间隔是否恒定；是否只在某运营商下出现；日志 `exceeded timeout` |
| 设备断网很久平台仍显示在线 | Keep Alive 太长或为 0 | CONNECT 中的 Keep Alive；是否用 Server Keep Alive 限制 |
| 设备在发数据，平台收不到 | QoS 0 发进半开连接 | 设备最后一次收到 broker 回应的时间 |
| 大量设备同时掉线 | 网络或 broker 故障，非 Keep Alive 问题 | 掉线时间是否集中；broker 节点状态 |
| 日志大量 `exceeded timeout` | 网络普遍差或 Keep Alive 普遍偏短 | 按运营商、地区分组统计 |

## 5. 复习 checklist

- [ ] 能解释什么是半开连接，以及为什么 TCP 自己发现不了
- [ ] 能说出 broker 与客户端各自的判定规则
- [ ] 能解释 1.5 倍的原因，以及计时起点
- [ ] 能说明为什么频繁上报的设备不需要心跳
- [ ] 能说出 take-over 与半开连接的关系
- [ ] 能解释 NAT 回收与 Keep Alive 的关系，说出 RFC 5382 的 2 小时 4 分钟与实测的差距
- [ ] 能按三步推导一个 Keep Alive 取值
- [ ] 能说出 QoS 0 发进半开连接的风险
- [ ] 能说出 Keep Alive = 0、最大值、Server Keep Alive 的含义
- [ ] 能对比 MQTT Keep Alive 与 TCP keepalive
- [ ] 能复述两个实验的理论值与实测值

---

参考：[RFC 5382](https://www.rfc-editor.org/rfc/rfc5382)、[Carrier Grade NAT Timeouts](https://blog.wirelessmoves.com/2020/09/carrier-grade-nat-timeouts-and-how-to-configure-your-xmpp-server.html)、[OASIS MQTT 5.0 规范](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html)
