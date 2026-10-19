# 共享订阅

> 专题 19 · 模块四 · ★ 核心必会 · 侧重通用学习
> 版本基线：MQTT 5.0（Mosquitto、EMQX 对 3.1.1 客户端也支持）
> 贯穿场景：入库服务扩成 3 个实例分摊每秒 1 万条读数

**对应全景图的哪一块**：broker → 后端这一段，专题 2"组间发布订阅、组内队列"在 MQTT 中的实现。

## 1. 核心概念

### 1.1 问题：后端如何横向扩容

| 尝试 | 结果 |
|---|---|
| 3 实例各自普通订阅 | 每条写 3 遍，数据库压力乘 3 |
| 3 实例共用 Client ID | 互踢（专题 6） |
| **共享订阅** | 组对外像一个订阅者，组内每条只给一个成员 |

> 类比：普通订阅像广播，共享订阅像银行叫号。

### 1.2 语法与规则

```
$share/ingest/em/+/up/telemetry/energy
 └─┬─┘ └─┬──┘ └──────────┬───────────┘
  标志   组名          原来的过滤器
```

| 规则 | 说明 |
|---|---|
| 同组名 + 同过滤器 = 一个共享组 | 组内每条只投递一个成员 |
| 不同组之间、与普通订阅之间 | 互不影响，各收完整一份 |
| 组名 | 不能含 `/`、`+`、`#` |
| 选哪个成员 | 规范不规定，由 broker 实现 |
| 发布方 | 完全不知情，无需改动 |
| 保留消息 | 订阅时**不推送**给共享订阅 |
| No Local | 不能与共享订阅同用 |
| 能力声明 | CONNACK `Shared Subscription Available`；不支持时 SUBACK 0x9E |

```
                       ┌──> 大屏（普通订阅）              每条都收
 电表 ──> broker ──────┼──> 告警组 [alarm-1]              每条都收
                       └──> 入库组 [ingest-1 / ingest-2]   组内二选一
```

### 1.3 三个新问题

**① 顺序没了**：成员处理速度不同，最终处理顺序乱。

| 数据 | 乱序影响 |
|---|---|
| 表底值按（设备号, 时间戳）幂等入库 | 无影响 |
| 最新状态类 | 旧值覆盖新值 |
| 依赖相邻两条计算 | 有影响 |

对策：数据带时间戳/序号、处理不依赖到达顺序（41）；或按设备哈希的分配策略（代价：负载不均、成员数变化时重新洗牌）。

**② 成员掉线时手上未确认的消息**：规范（4.8.2）要求会话结束时 broker **应该**（SHOULD）转给其他成员。**Mosquitto 2.0.18 实测不转，直接丢**；EMQX 文档：会话过期时未确认的 QoS 1/2 消息重新分派给同组其他会话。

**③ 离线但会话持久的成员仍被分配份额**：消息困在它的离线队列（Mosquitto 实测；EMQX 文档同样如此，并建议共享订阅用 Clean Session / 短 Session Expiry）。K8s 缩容时，被缩掉的持久会话成员会占住一份数据。

| 问题 | 对策 |
|---|---|
| 顺序乱 | 时间戳 + 幂等；或哈希类策略 |
| 成员崩溃丢未确认消息 | 选会重新分派的 broker；先处理后确认；补传兜底 |
| 离线成员占份额 | 成员用**短会话过期**；缩容前正常断开；监控各成员积压 |

**普通订阅的入库服务适合持久会话；共享订阅成员适合短会话。**

### 1.4 分配策略

| broker | 策略 |
|---|---|
| Mosquitto 2.0.18 | 实测轮询 |
| EMQX（默认 `round_robin`） | `random`、`round_robin`（按发布者连接分别轮询）、`round_robin_per_group`、`sticky`、`local`、`hash_clientid`、`hash_topic` |

| 需求 | 策略 |
|---|---|
| 负载最均匀 | round_robin / random |
| 同一电表顺序处理 | hash_clientid / hash_topic |
| 集群减少跨节点 | local（31） |

EMQX 的 `$queue/` 前缀已弃用。

### 1.5 局限

- 分配、掉线处理、离线份额都是实现细节，换 broker 须逐项核实。
- 只解决组内分摊，不解决失败重试和死信；需要时桥接 Kafka / RabbitMQ（42）。
- 集群中更复杂（31）。

## 2. 易混淆 / 易错点

| 错误理解 | 正确理解 |
|---|---|
| 多开实例普通订阅就能分担 | 各收一份，负载翻倍 |
| 共用 Client ID 就能共享 | 互踢 |
| 需要发布方配合 | 发布方不知情 |
| 会影响其他订阅者 | 不同组、普通订阅各收一份 |
| 共享订阅保证顺序 | 不保证 |
| 成员崩溃 broker 一定转给别人 | 规范只是 SHOULD；Mosquitto 实测丢 |
| 离线成员不再分到消息 | 会话在就照样分 |
| 成员也该用持久会话 | 应用短会话 |
| 订阅时会收到保留消息 | 不推送 |
| 分配策略是规范定的 | 各 broker 不同 |

## 3. 与其他章节的关联

| 本篇内容 | 相关专题 |
|---|---|
| 组间发布订阅、组内队列；先处理后确认 | 2（回顾） |
| 共用 Client ID 互踢 | 6（回顾） |
| `$` 前缀不被通配符匹配 | 8（回顾） |
| 持久会话、离线队列 | 12（回顾） |
| 保留消息 | 14（回顾） |
| 0x9E、能力声明 | 17（回顾） |
| 顺序保证 | 13 |
| No Local | 20 |
| 集群中的共享订阅 | 31 |
| 桥接 Kafka / RabbitMQ | 42 |
| 时间戳与幂等入库 | 41 |
| 后端客户端工程 | 43 |

## 4. 诊断实践

### 4.1 实验（云端真实输出，Mosquitto 2.0.18 + paho-mqtt 2.1.0）

**S1 组内分摊**（3 成员，9 条）：

```
  ingest-1: ['e1', 'e4', 'e7']
  ingest-2: ['e2', 'e5', 'e8']
  ingest-3: ['e3', 'e6', 'e9']
```

**S2 组间各收一份**：

```
  ingest-1: ['e1', 'e3', 'e5']
  ingest-2: ['e2', 'e4', 'e6']
  alarm-1 : ['e1', 'e2', 'e3', 'e4', 'e5', 'e6']
  dashboard: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6']
```

**S3 顺序**（ingest-2 每条多花 0.3 秒）：

```
  写库顺序： e1(1) → e3(1) → e2(2) → e5(1) → e4(2) → e6(2)
```

**S4 成员未确认即掉线**（会话 Expiry=0）：

```
  ingest-3 收到但不确认： ['e3', 'e6']
  ingest-1: ['e1', 'e4']
  ingest-2: ['e2', 'e5']
  ingest-3 那几条后来去了哪： ['e3', 'e6'] 没有被转给其他成员
```

**S5 离线持久成员仍分份额**（Expiry=300）：

```
  ingest-3 离线期间：ingest-1: ['e1', 'e4', 'e7']   ingest-2: ['e2', 'e5', 'e8']
  ingest-3 回来后收到： ['e3', 'e6', 'e9']
```

**S6 保留消息不推给共享订阅**：

```
  共享订阅者订阅后收到： []    普通订阅者订阅后收到： ['r1']
```

**S7 3.1.1 客户端用 $share**：

```
  old-1: ['e1', 'e3']   old-2: ['e2', 'e4']
```

**EMQX 分配策略对比（本地运行，未实测）**：

```bash
for i in 1 2 3; do mosquitto_sub -h <虚拟机IP> -p 2883 -V 5 -q 1 -i ingest-$i \
  -t '$share/ingest/em/+/up/telemetry/energy' -F "ingest-$i %p" & done
sleep 1; for i in $(seq 1 9); do mosquitto_pub -h <虚拟机IP> -p 2883 -V 5 -q 1 -i meter3 \
  -t em/meter3/up/telemetry/energy -m e$i; done
# 改为 hash_clientid（mqtt.shared_subscription_strategy）后让 meter3、meter4 各发 6 条
```

预期（按 EMQX 文档推断）：round_robin 下三成员各约 3 条（因 mosquitto_pub 每次新连接，分布可能不如 Mosquitto 整齐）；hash_clientid 下同一电表的消息全落在同一成员。

<details>
<summary>lab.py</summary>

```python
import sys, time, socket, struct, threading
import paho.mqtt.client as mqtt
from paho.mqtt.properties import Properties
from paho.mqtt.packettypes import PacketTypes
V2 = mqtt.CallbackAPIVersion.VERSION2
T = "em/+/up/telemetry/energy"
def member(cid, filt, proto=mqtt.MQTTv5, delay=0.0, clean=True, expiry=0, log=None):
    got = []
    c = mqtt.Client(V2, client_id=cid, protocol=proto)
    def on(cl, u, m):
        if delay: time.sleep(delay)
        got.append(m.payload.decode())
        if log is not None: log.append((time.time(), cid, m.payload.decode()))
    c.on_message = on
    if proto == mqtt.MQTTv5:
        pr = Properties(PacketTypes.CONNECT); pr.SessionExpiryInterval = expiry
        c.connect("127.0.0.1", 1883, 30, clean_start=clean, properties=pr)
    else:
        c.connect("127.0.0.1", 1883, 30)
    c.subscribe(filt, qos=1); c.loop_start(); time.sleep(0.3)
    return c, got
def pub(msgs, retain=False, gap=0.0):
    p = mqtt.Client(V2, client_id="meter3", protocol=mqtt.MQTTv5); p.connect("127.0.0.1"); p.loop_start()
    for m in msgs:
        p.publish("em/meter3/up/telemetry/energy", m, qos=1, retain=retain).wait_for_publish(2)
        if gap: time.sleep(gap)
    time.sleep(0.5); p.disconnect(); p.loop_stop()
def stop(*cs):
    for c in cs: c.disconnect(); c.loop_stop()
```
</details>

<details>
<summary>s1.py（S1、S2、S3、S6、S7）</summary>

```python
from lab import *
print("=== S1 组内分摊：ingest 组 3 个成员 ===")
a,ga=member("svc-ingest-1","$share/ingest/"+T); b,gb=member("svc-ingest-2","$share/ingest/"+T); c,gc=member("svc-ingest-3","$share/ingest/"+T)
pub([f"e{i}" for i in range(1,10)])
print("  ingest-1:",ga,"\n  ingest-2:",gb,"\n  ingest-3:",gc); stop(a,b,c)
print("=== S2 组间各收一份：ingest 组 2 人 + alarm 组 1 人 + 普通订阅（大屏）===")
a,ga=member("svc-ingest-1","$share/ingest/"+T); b,gb=member("svc-ingest-2","$share/ingest/"+T)
x,gx=member("svc-alarm-1","$share/alarm/"+T); d,gd=member("dashboard",T)
pub([f"e{i}" for i in range(1,7)])
print("  ingest-1:",ga,"\n  ingest-2:",gb,"\n  alarm-1 :",gx,"\n  dashboard:",gd); stop(a,b,x,d)
print("=== S3 顺序：电表按 e1..e6 依次上报，ingest-2 处理每条要多花 0.3 秒 ===")
log=[]
a,ga=member("svc-ingest-1","$share/ingest/"+T, log=log); b,gb=member("svc-ingest-2","$share/ingest/"+T, delay=0.3, log=log)
pub([f"e{i}" for i in range(1,7)], gap=0.1); time.sleep(1.5)
print("  写库顺序：", " → ".join(f"{m}({c[-1]})" for _,c,m in sorted(log)))
stop(a,b)
print("=== S6 保留消息不会推给共享订阅 ===")
pub(["r1"], retain=True)
a,ga=member("svc-ingest-1","$share/ingest/"+T); d,gd=member("dashboard",T); time.sleep(0.5)
print("  共享订阅者订阅后收到：",ga,"   普通订阅者订阅后收到：",gd); stop(a,d)
pub([""], retain=True)
print("=== S7 3.1.1 客户端用 $share ===")
a,ga=member("old-1","$share/legacy/"+T, proto=mqtt.MQTTv311); b,gb=member("old-2","$share/legacy/"+T, proto=mqtt.MQTTv311)
pub([f"e{i}" for i in range(1,5)])
print("  old-1:",ga,"  old-2:",gb); stop(a,b)
```
</details>

<details>
<summary>s4.py（S4、S5）</summary>

```python
from lab import *
def vbi(n):
    out=b""
    while True:
        b=n%128; n//=128; out+=bytes([b|0x80 if n else b])
        if not n: return out
def s(x): x=x.encode(); return struct.pack(">H",len(x))+x
def raw_member(cid, expiry):
    sk=socket.create_connection(("127.0.0.1",1883))
    props=b"\x11"+struct.pack(">I",expiry)
    body=s("MQTT")+bytes([5,0x02])+struct.pack(">H",60)+vbi(len(props))+props+s(cid)
    sk.sendall(b"\x10"+vbi(len(body))+body); sk.recv(64)
    sb=struct.pack(">H",1)+b"\x00"+s("$share/ingest/"+T)+b"\x01"
    sk.sendall(b"\x82"+vbi(len(sb))+sb); sk.recv(64); return sk
print("=== S4 成员收到消息但没来得及确认就掉线 ===")
a,ga=member("svc-ingest-1","$share/ingest/"+T); b,gb=member("svc-ingest-2","$share/ingest/"+T)
sk=raw_member("svc-ingest-3", 0); sk.settimeout(0.5)
pub([f"e{i}" for i in range(1,7)])
got3=[]
try:
    data=sk.recv(4096)
    i=0
    while i < len(data):
        rl=data[i+1]; pkt=data[i:i+2+rl]; tl=struct.unpack(">H",pkt[2:4])[0]
        got3.append(pkt[4+tl+2+1:].decode()); i+=2+rl
except Exception: pass
print("  ingest-3 收到但不确认：",got3)
sk.close(); print("  ingest-3 掉线（会话 Expiry=0，随即结束）"); time.sleep(1.5)
print("  ingest-1:",ga,"\n  ingest-2:",gb)
lost=[m for m in got3 if m not in ga+gb]
print("  ingest-3 那几条后来去了哪：", "被转给其他成员" if not lost else f"{lost} 没有被转给其他成员")
stop(a,b)
print("=== S5 成员离线但会话持久（Expiry=300）期间，消息还分给它吗 ===")
a,ga=member("svc-ingest-1","$share/ingest/"+T); b,gb=member("svc-ingest-2","$share/ingest/"+T)
c,gc=member("svc-ingest-3","$share/ingest/"+T, clean=False, expiry=300); stop(c)
pub([f"e{i}" for i in range(1,10)])
print("  ingest-3 离线期间：ingest-1:",ga,"  ingest-2:",gb)
c,gc=member("svc-ingest-3","$share/ingest/"+T, clean=False, expiry=300); time.sleep(1)
print("  ingest-3 回来后收到：",gc); stop(a,b,c)
```
</details>

### 4.2 现象 → 怀疑 → 观察点

| 现象 | 优先怀疑 | 观察点 |
|---|---|---|
| 扩容后写库量翻倍 | 新实例用普通订阅 | 过滤器是否带 `$share/` |
| 实例互相断开、日志刷屏 | 共用 Client ID | `already connected` |
| 缩容后部分数据迟迟不入库 | 被缩成员会话仍在占份额 | 组成员列表、离线成员积压 |
| 实例崩溃后丢一批数据 | broker 不重新分派 | broker 行为；对账补传 |
| 状态显示错乱 | 分摊后乱序 | 时间戳比较；分配策略 |
| 某成员负载偏高 | 哈希或 sticky 策略 | 策略配置；各成员速率 |
| 订阅返回 0x9E | 不支持或已关闭 | CONNACK 能力属性 |

## 5. 复习 checklist

- [ ] 能说明普通订阅、共用 Client ID 为什么不能扩容
- [ ] 能写出 `$share` 语法，说出组内、组间、普通订阅的投递关系
- [ ] 能说出共享订阅带来的三个问题及对策
- [ ] 能说出 Mosquitto 与 EMQX 在成员掉线、离线份额上的行为差异
- [ ] 能解释为什么共享订阅成员应使用短会话
- [ ] 能按需求选择 EMQX 分配策略
- [ ] 知道保留消息不推给共享订阅、No Local 不能同用、3.1.1 客户端也可用

---

参考：[EMQX · Shared Subscription](https://docs.emqx.com/en/emqx/latest/messaging/mqtt-shared-subscription.html)、[OASIS MQTT 5.0 规范 4.8.2](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html)
