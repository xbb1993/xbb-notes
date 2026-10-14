# 会话状态：Clean Start、Session Expiry 与离线排队

> 专题 12 · 模块三 · ★ 核心必会 · 侧重两者兼顾
> 版本基线：MQTT 5.0，3.1.1 差异单独标注
> 贯穿场景：入库服务每周发版重启 2 分钟，期间电表照常上报；电表离线期间平台下发指令

**对应全景图的哪一块**：broker 为每个客户端保存的"档案"。QoS 1 能否补发、QoS 2 能否恰好一次、离线期间消息是否保留，都取决于它；专题 2 的"时间解耦"在 MQTT 中靠它实现。

## 1. 核心概念

### 1.1 会话是谁和谁之间的

**每个连到 broker 的客户端都有一份自己的会话**，按 Client ID 保存。MQTT 协议里没有"生产者/消费者"身份，只有"客户端"：电表、入库服务、大屏对 broker 来说一样。

```
                        broker
              ┌───────────────────────────────────┐
  电表 ───────┤ 会话[meter3]                       │
              │   订阅：em/meter3/down/#            │
              │   离线队列：电表断网期间到达的指令     │
入库服务 ─────┤ 会话[svc-ingest]                   │
              │   订阅：em/+/up/telemetry/#         │
              │   离线队列：入库服务重启期间到达的读数 │
  大屏 ───────┤ 会话[dashboard]（非持久，断开即删）   │
              └───────────────────────────────────┘
```

> 类比：酒店给常客保留的房间。退房时约定"帮我留着"，期间寄来的包裹前台代收；报上名字（Client ID）即可接着住。

### 1.2 会话里存了什么

| 存在哪 | 内容 |
|---|---|
| broker | 会话是否存在（即使无订阅） |
| | **订阅列表**（过滤器 + QoS） |
| | 已发给客户端、未确认完的 QoS 1/2 消息 |
| | 客户端离线期间到达的 QoS 1/2 消息（**离线队列**） |
| | 客户端发来、未完成四步握手的 QoS 2 消息 |
| | 遗嘱与遗嘱延迟（5.0，专题 15）；会话过期时间 |
| 客户端 | 发给 broker、未确认完的 QoS 1/2 消息 |
| | broker 发来、未完成四步握手的 QoS 2 消息 |

- **订阅也在会话里**：会话在，重连无需重订；会话没了，订阅也没了。
- **QoS 0 不进离线队列**（规范允许 broker 自行决定，主流不存；Mosquitto 非标准选项 `queue_qos0_messages` 默认 false）。

### 1.3 消息属于接收方的会话

```
电表发布 e1
   ▼
broker：哪些会话的订阅匹配？
   ├─ 会话[svc-ingest] 离线、持久 → 复制一份进它的离线队列
   ├─ 会话[svc-alarm]  在线       → 立即投递
   ├─ 会话[dashboard]  已删除     → 这份没了
   └─ 无任何匹配                   → 直接丢弃（保留消息除外）
```

- 电表收到 PUBACK 后，消息与电表的会话无关。
- 消息去留取决于**每个订阅者自己的会话**。
- broker 不为"将来可能出现的订阅者"存消息。

### 1.4 与 RabbitMQ 的对比

| | MQTT | RabbitMQ |
|---|---|---|
| 消息存在哪 | 每个订阅者的会话（每人一份副本） | 队列（一份，多个消费者取） |
| 存储单元来源 | 客户端连上并订阅时自动产生，跟 Client ID 走 | 显式声明，有独立名字与生命周期 |
| 订阅者离线 | 会话持久才存；会话过期则消息与订阅一起没 | 持久队列一直存，与连接无关 |
| 无接收方 | 丢弃 | 交换机无绑定队列时也丢弃 |

RabbitMQ 官方 MQTT 插件的实现正好印证：每个订阅者一个专属队列 `mqtt-subscription-<ClientID>qos1`；会话随连接结束 → 独占队列；会话保留 N 秒 → 队列 TTL = min（客户端请求值，服务端上限，默认 1 天）；会话结束 → 队列、消息、绑定一起删。

**持久会话 ≈ 按 Client ID 自动创建、自动绑定、会过期的专属队列。** MQTT 这样设计适合海量、动态上下线的设备，代价是会话没了消息就没了。

### 1.5 从一个开关到两个开关

3.1.1 **Clean Session** 一个开关管两件事：

| Clean Session | 连接时 | 断开后 |
|---|---|---|
| 1 | 丢旧会话 | 立即删除 |
| 0 | 接着用 | **永久保留**（报废设备成僵尸会话；无法"保留 1 天"） |

5.0 拆成两个独立开关：

| 开关 | 问题 | 位置 |
|---|---|---|
| **Clean Start** | 连接开始时丢不丢旧会话 | CONNECT 连接标志 |
| **Session Expiry Interval** | 断开后保留多少秒 | CONNECT 属性 |

| | Expiry = 0 | Expiry > 0 |
|---|---|---|
| Clean Start = 1 | 完全临时（大屏、调试） | 仅对下次以 Clean Start=0 连接有意义；常用于"首次用 1、之后用 0"（paho `FIRST_ONLY`） |
| Clean Start = 0 | 有旧会话就接上，断开即删 | **持久会话**（入库服务、收离线指令的电表） |

| Expiry 值 | 含义 |
|---|---|
| 0 或不带 | 连接一断立即删 |
| N 秒 | 保留 N 秒 |
| 0xFFFFFFFF | 永不过期（约 136 年） |

- 客户端可在 DISCONNECT 时修改过期时间；CONNECT 时为 0 则不能改成非 0。
- broker 可设上限并在 CONNACK 中告知实际值。

| 3.1.1 | 5.0 等价 |
|---|---|
| Clean Session=1 | Clean Start=1 + Expiry=0 |
| Clean Session=0 | Clean Start=0 + Expiry=0xFFFFFFFF |

### 1.6 离线队列的限制（Mosquitto 官方文档默认值）

| 限制 | 默认 |
|---|---|
| `max_queued_messages`（每客户端条数） | 1000 |
| `max_queued_bytes`（每客户端字节） | 0（不限） |
| `persistent_client_expiration`（非标准，清理持久会话） | 不设则永不过期 |
| `persistence`（落盘） | **false** |
| `autosave_interval`（开启落盘时的自动保存间隔） | 1800 秒 |

队列满了丢哪条规范未规定；**Mosquitto 实测保留最早的、丢最新的**。

### 1.7 持久会话的成本与风险

| 风险 | 后果 | 对策 |
|---|---|---|
| 内存/磁盘膨胀 | 10 万设备 × 队列上限可达上亿条 | 限条数与字节（28） |
| 僵尸会话 | 永不过期、队列一直涨 | 合理 Expiry；broker 上限 |
| 重连风暴 | 积压消息瞬间涌入压垮设备与后端 | Receive Maximum（13）；限队列 |
| **过期指令** | 离线 3 天的电表重连执行 3 天前的"拉闸" | 指令设 Message Expiry（18）+ 时间戳校验（39） |
| 重启丢失 | 未持久化或崩溃未落盘 | 开持久化；集群（31）；应用层补传（41） |
| 悄悄丢订阅 | 会话过期后不报错但收不到数据 | Session Present=否时一律重订 |

### 1.8 电表场景谁用持久会话

| 客户端 | 建议 |
|---|---|
| 入库服务 | Clean Start=0 + Expiry（如 1 小时）+ QoS 1 订阅；多实例用共享订阅（19） |
| 电表（收指令） | Clean Start=0 + Expiry（如 1 天）；**指令必须带过期时间** |
| 告警服务 | 持久会话 + QoS 1 |
| 大屏、调试工具 | Clean Start=1 + Expiry=0 |

电表上报侧：会话只保住"已发出未确认"的消息；断网期间未发出的数据需设备 flash 缓存补传（41、43）。

### 1.9 局限

- 会话保存在一个节点上，集群漂移见专题 31。
- 会话只覆盖已交给 MQTT 的消息。
- 规范不要求会话挺过 broker 重启；持久化范围和时机是实现细节。

## 2. 易混淆 / 易错点

| 错误理解 | 正确理解 |
|---|---|
| 会话只在设备和 broker 之间 | 每个客户端（包括入库服务）各有一份 |
| 消息属于发送方的会话 | 复制进每个匹配订阅者的会话 |
| 持久会话保存所有消息 | QoS 0 不排队；订阅 QoS 0 也不排队 |
| Clean Start=0 就是持久会话 | 还需 Expiry > 0 |
| Clean Start 只是 Clean Session 改名 | 一个开关拆成两个 |
| 3.1.1 持久会话会自动过期 | 永不过期 |
| 会话在，订阅就一直在 | 会话过期订阅一起没 |
| 开了持久会话就不怕 broker 重启 | Mosquitto 默认不落盘；落盘也只在正常关闭或定时保存时 |
| 离线队列可无限排 | 有上限，满了丢哪条各家不同 |
| 离线补发总是好事 | 过期指令可能造成事故 |
| MQTT 和 RabbitMQ 存消息方式一样 | MQTT 无显式队列，存储随会话自动产生和过期 |

## 3. 与其他章节的关联

| 本篇内容 | 相关专题 |
|---|---|
| 时间解耦 | 2（回顾） |
| Session Present、Client ID | 6（回顾） |
| 补发未确认的 QoS 1 | 10（回顾） |
| QoS 2 状态与会话 | 11（回顾） |
| Receive Maximum、重连风暴 | 13 |
| 保留消息（每主题一条，与会话无关） | 14 |
| 遗嘱存在会话里 | 15 |
| Message Expiry | 18 |
| 共享订阅 | 19 |
| 持久化与背压 | 28 |
| 集群中的会话迁移 | 31 |
| 指令过期与校验 | 39 |
| 设备侧补传 | 41、43 |

## 4. 诊断实践

### 4.1 实验（云端真实输出，Mosquitto 2.0.18 + paho-mqtt 2.1.0）

**E1 持久 vs 非持久会话**（入库服务重连后不重新订阅）：

```
--- 持久会话（Clean Start=0，Expiry=300 秒）
  离线期间电表发送：e1(q1) e2(q0) e3(q1) e4(q0) e5(q1)
  入库服务重连：Session Present=True，收到 → e1(q1) e3(q1) e5(q1)
--- 非持久会话（Clean Start=1，Expiry=0）
  入库服务重连：Session Present=False，收到 → (什么都没收到)
```

**E2 会话过期**（Expiry=3 秒，等待 5 秒）：

```
  入库服务重连：Session Present=False，收到 → (什么都没收到)
  电表再发 e2(q1)，没重新订阅的入库服务收到 → (什么都没收到：订阅也随会话没了)
```

**E3 离线队列上限**（`max_queued_messages 5`，离线期间发 10 条）：

```
  重连收到 5 条 → e1(q1) e2(q1) e3(q1) e4(q1) e5(q1)      ← 丢的是最新的 e6～e10
```

**E4 broker 重启**：

```
A 不开持久化，正常重启：   Session Present=False，收到 → (什么都没收到)
B 开持久化，正常重启：     Session Present=True，收到 → e1(q1) e2(q1)
C 开持久化，kill -9 崩溃：  Session Present=False，收到 → (什么都没收到)
```

**实测发现**：Mosquitto 2.0.18 中，**只有最后一次以 Clean Start=0 连接的会话才写入持久化文件**（以 Clean Start=1 + Expiry=300 建立的会话，重启后未恢复；直接检查落盘文件确认只含 Clean Start=0 的客户端）。规范不要求会话挺过重启，属实现细节；工程上需要持久会话的客户端一律用 Clean Start=0。其他 broker 未核实。

本地复现（`python3 e1.py <端口> <queue|expiry|overflow|prep|after>`；overflow 需 broker 配 `max_queued_messages 5`；重启实验先 `prep`，重启 broker，再 `after`）：

<details>
<summary>lab.py</summary>

```python
import sys, time
import paho.mqtt.client as mqtt
from paho.mqtt.properties import Properties
from paho.mqtt.packettypes import PacketTypes
V2 = mqtt.CallbackAPIVersion.VERSION2
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 1883
T = "em/+/up/telemetry/energy"

def client(cid, clean, expiry):
    got = []; info = {}
    c = mqtt.Client(V2, client_id=cid, protocol=mqtt.MQTTv5)
    c.on_message = lambda cl, u, m: got.append(f"{m.payload.decode()}(q{m.qos})")
    c.on_connect = lambda cl, u, f, rc, p: info.update(sp=f.session_present, rc=str(rc))
    pr = Properties(PacketTypes.CONNECT)
    if expiry is not None: pr.SessionExpiryInterval = expiry
    c.connect("127.0.0.1", PORT, 30, clean_start=clean, properties=pr); c.loop_start()
    for _ in range(50):
        if info: break
        time.sleep(0.05)
    return c, got, info
def close(c): c.disconnect(); time.sleep(0.2); c.loop_stop()
def meter_send(msgs):
    m = mqtt.Client(V2, client_id="meter3", protocol=mqtt.MQTTv5)
    m.connect("127.0.0.1", PORT); m.loop_start()
    for payload, q in msgs: m.publish("em/meter3/up/telemetry/energy", payload, qos=q).wait_for_publish(2)
    time.sleep(0.3); m.disconnect(); m.loop_stop()
```
</details>

<details>
<summary>e1.py</summary>

```python
from lab import *
case = sys.argv[2]
if case == "queue":
    for clean, exp, label in [(False, 300, "持久会话"), (True, 0, "非持久会话")]:
        c, got, info = client("svc-ingest", True, exp if not clean else 0)
        c.subscribe(T, qos=1); time.sleep(0.3); close(c)
        if not clean:
            c, got, info = client("svc-ingest", False, exp); c.subscribe(T, qos=1); time.sleep(0.3); close(c)
        meter_send([("e1",1),("e2",0),("e3",1),("e4",0),("e5",1)])
        c, got, info = client("svc-ingest", clean, exp); time.sleep(1)
        print(label, "Session Present=", info['sp'], "收到", got); close(c)
elif case == "expiry":
    c, got, info = client("svc-ingest", True, 3); c.subscribe(T, qos=1); time.sleep(0.3); close(c)
    meter_send([("e1",1)]); time.sleep(5)
    c, got, info = client("svc-ingest", False, 3); time.sleep(1)
    print("Session Present=", info['sp'], "收到", got)
    meter_send([("e2",1)]); time.sleep(0.5); print("再发 e2 后收到", got); close(c)
elif case == "overflow":
    c, got, info = client("svc-ingest", True, 300); c.subscribe(T, qos=1); time.sleep(0.3); close(c)
    meter_send([(f"e{i}",1) for i in range(1,11)])
    c, got, info = client("svc-ingest", False, 300); time.sleep(1)
    print(len(got), got); close(c)
elif case == "prep":
    c, got, info = client("svc-ingest", False, 300); c.subscribe(T, qos=1); time.sleep(0.3); close(c)
    meter_send([("e1",1),("e2",1)])
elif case == "after":
    c, got, info = client("svc-ingest", False, 300); time.sleep(1)
    print("Session Present=", info['sp'], "收到", got); close(c)
```
</details>

### 4.2 现象 → 怀疑 → 观察点

| 现象 | 优先怀疑 | 观察点 |
|---|---|---|
| 后端重启后丢一段数据 | 非持久会话；订阅或发布用 QoS 0 | 后端 Clean Start 与 Expiry；SUBACK 授予 QoS |
| 后端重连后静默收不到数据 | 会话过期未重订 | Session Present；broker 上订阅列表 |
| broker 重启后设备收不到离线指令 | 未开持久化或崩溃前未落盘 | 持久化配置、落盘间隔、重启方式 |
| broker 内存持续上涨 | 僵尸会话、队列积压 | 持久会话数、离线客户端数、队列长度 |
| 设备上线瞬间卡死 | 积压消息集中涌入 | 重连下发量；Receive Maximum |
| 设备执行了很久以前的指令 | 指令排队且没设过期 | Message Expiry、时间戳校验 |
| 离线队列丢了最新消息 | 队列满，broker 丢最新 | 队列上限与丢弃策略 |

## 5. 复习 checklist

- [ ] 能说明会话是"每个客户端和 broker 之间"各一份，包括后端服务
- [ ] 能列出 broker 与客户端各自在会话中存什么
- [ ] 能解释消息为什么属于接收方的会话，以及无订阅时消息去向
- [ ] 能对比 MQTT 会话与 RabbitMQ 队列，说出"持久会话 ≈ 自动管理的专属队列"
- [ ] 能说出 3.1.1 Clean Session 的两个问题，以及 5.0 两个开关各管什么
- [ ] 能写出 Clean Start × Expiry 四种组合的用途和与 3.1.1 的对应
- [ ] 能说出 QoS 0 为什么不排队
- [ ] 能说出 Mosquitto 关于队列、持久化的默认值，以及实测的丢弃与落盘行为
- [ ] 能列出持久会话的六类风险及对策，尤其是过期指令
- [ ] 能为电表场景各类客户端选择会话配置

---

参考：[Mosquitto · mosquitto.conf](https://mosquitto.org/man/mosquitto-conf-5.html)、[HiveMQ · MQTT 5 Session and Message Expiry](https://www.hivemq.com/blog/mqtt5-essentials-part4-session-and-message-expiry/)、[HiveMQ · Persistent Session and Queuing Messages](https://www.hivemq.com/blog/mqtt-essentials-part-7-persistent-session-queuing-messages/)、[RabbitMQ · MQTT Plugin](https://www.rabbitmq.com/docs/mqtt)
