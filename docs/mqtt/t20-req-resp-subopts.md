# 请求 / 响应、订阅选项与订阅标识符

> 专题 20 · 模块四 · ☆ 高频重点 · 第二遍 · 简述
> 云端实测：Mosquitto 2.0.18 + paho-mqtt 2.1.0；均为 MQTT 5.0 功能

**这一章解决什么**：5.0 在"订阅"这一步加的几个开关和订阅编号，每个都对应前面遇到过的实际问题。讲清每个管什么、什么时候用。

## 1. 核心概念

### 1.1 请求/响应（回顾，专题 39 已用）

MQTT 只有发布和订阅，5.0 用两个属性补上"一问一答"：
- **Response Topic**：回复发到哪个主题。
- **Correlation Data**：请求方的编号，响应方原样带回，用于配对。

### 1.2 三个订阅选项（每个订阅单独设置）

**Retain Handling：订阅时要不要推送旧的保留消息**

| 值 | 含义 | 什么时候用 |
|---|---|---|
| 0（默认） | 每次订阅都推送 | 普通情况 |
| 1 | 只在首次订阅时推送，重复订阅不推 | 订阅写在连接回调里、每次重连都订阅时（43），避免会话还在时又收一遍 |
| 2 | 从不推送，只收以后的新消息 | 只处理新事件、不该被历史状态触发的服务（47 现场 D）；需要启动同步状态的服务不能用，应"启动只同步不执行" |

**No Local：不收自己发的消息**——既写又读同一主题的服务（影子服务、双向同步）打开，防止自己触发自己的循环；双向桥接防环路同理（33）。

**Retain As Published：实时转发时保留"保留标志"**——默认只有订阅那一刻推送的旧保留消息带 retain=1，实时转发一律 retain=0，订阅者借此区分"历史状态"和"刚发生"。主要给**桥接**用（33），让转发方知道原消息是保留消息。

### 1.3 订阅标识符

订阅时给每个订阅编号，broker 投递时带上，客户端知道"这条是因为哪个订阅来的"。用途：按订阅分发处理逻辑（订阅 1 给入库、订阅 2 给告警）；处理重叠订阅的重复（27）。协议允许 broker 合并重叠订阅为一份并带多个标识符，Mosquitto 2.0.18 实测分开投递两份，换 broker 要确认（规范原文未逐字核实）。

### 1.4 对方案的建议

| 场景 | 设置 |
|---|---|
| 电表订阅自己的命令、期望值（每次重连回调里重订） | Retain Handling = 1 |
| 只处理新事件的服务 | Retain Handling = 2 |
| 启动需同步状态的服务（如影子服务） | Retain Handling = 0，启动只同步不执行 |
| 既发布又订阅同一主题 | No Local = 是 |
| 桥接、转发 | Retain As Published = 是 |
| 一个客户端多个重叠订阅 | 加订阅标识符，按标识符分发 |

只能用 3.1.1 的设备或服务，这些行为要在应用层自己处理。

## 2. 易混淆 / 易错点

| 错误理解 | 正确理解 |
|---|---|
| 订阅时一定会收到保留消息 | 5.0 可用 Retain Handling 控制，2 为从不推送 |
| 重连重订阅不会重复收保留消息 | 默认（0）每次订阅都推送；用 1 避免 |
| 实时转发的保留消息也带 retain=1 | 默认 retain=0；要保留需 Retain As Published |
| 自己发的消息不会推给自己 | 默认会；要 No Local |
| 重叠订阅分不清来源 | 订阅标识符标明来源 |
| 这些选项全局生效 | 每个订阅单独设置 |

## 3. 与其他章节的关联

| 本篇内容 | 相关专题 |
|---|---|
| 保留消息 | 14（回顾） |
| 属性机制 | 17（回顾） |
| 重叠订阅投递两份 | 27（回顾） |
| 命令回执用的请求/响应 | 39（回顾） |
| 重连后重新订阅 | 43（回顾） |
| 过时保留消息误动作 | 47 现场 D（回顾） |
| 桥接防环路 | 33 |

## 4. 诊断实践

### 4.1 实验（云端真实输出）

```
Retain Handling=0：首次订阅收到 ['旧期望值(retain=1)']；重复订阅后新增 ['旧期望值(retain=1)']
Retain Handling=1：首次订阅收到 ['旧期望值(retain=1)']；重复订阅后新增 []
Retain Handling=2：首次订阅收到 []；重复订阅后新增 []
No Local=False：自己订阅、自己发布，收到 ['自己发的(retain=0)']
No Local=True：自己订阅、自己发布，收到 []
Retain As Published=False：订阅之后才发布的保留消息，到达时 ['online(retain=0)']
Retain As Published=True：订阅之后才发布的保留消息，到达时 ['online(retain=1)']
订阅标识符：订阅1=em/+/up/telemetry，订阅2=em/m1/#，发布一条，收到 ['旧期望值(retain=1, 订阅标识符=[2])', '一条遥测(retain=0, 订阅标识符=[2])', '一条遥测(retain=0, 订阅标识符=[1])']
```

解读：
- Retain Handling：0 每次订阅都推；1 只首次推；2 从不推。
- No Local：打开后自己发的不再推回。
- Retain As Published：订阅后才发布的保留消息，默认到达 retain=0，打开后 retain=1。
- 订阅标识符：第一条是订阅 2（`em/m1/#`）匹配到的旧保留消息；那条遥测同时匹配两个订阅，收到两份，分别标 1 和 2。

### 4.2 脚本（本地：Mosquitto + paho-mqtt 2.x）

`subopts.py`：

```python
# 5.0 订阅选项与订阅标识符逐个对比（paho-mqtt 2.1.0 + Mosquitto 2.0.18）
import paho.mqtt.client as mqtt, time
from paho.mqtt.subscribeoptions import SubscribeOptions
from paho.mqtt.properties import Properties
from paho.mqtt.packettypes import PacketTypes
V2=mqtt.CallbackAPIVersion.VERSION2
def cl(cid, got):
    c=mqtt.Client(V2, client_id=cid, protocol=mqtt.MQTTv5)
    def on_m(c,u,m):
        ids=getattr(m.properties,"SubscriptionIdentifier",None)
        got.append(f"{m.payload.decode()}(retain={int(m.retain)}{', 订阅标识符='+str(ids) if ids else ''})")
    c.on_message=on_m; c.connect("127.0.0.1",1883); c.loop_start(); time.sleep(0.3); return c
pub=cl("pub",[])
# 1. Retain Handling
pub.publish("em/m1/shadow/desired","旧期望值",qos=1,retain=True).wait_for_publish()
for rh in (0,1,2):
    got=[]; c=cl(f"rh{rh}",got)
    c.subscribe("em/m1/shadow/desired", options=SubscribeOptions(qos=1, retainHandling=rh)); time.sleep(0.4)
    first=list(got)
    c.subscribe("em/m1/shadow/desired", options=SubscribeOptions(qos=1, retainHandling=rh)); time.sleep(0.4)   # 再订阅一次（订阅已存在）
    print(f"Retain Handling={rh}：首次订阅收到 {first}；重复订阅后新增 {got[len(first):]}"); c.disconnect()
# 2. No Local
for nl in (False,True):
    got=[]; c=cl(f"nl{int(nl)}",got)
    c.subscribe("em/m1/up/telemetry", options=SubscribeOptions(qos=1, noLocal=nl)); time.sleep(0.3)
    c.publish("em/m1/up/telemetry","自己发的",qos=1); time.sleep(0.4)
    print(f"No Local={nl}：自己订阅、自己发布，收到 {got}"); c.disconnect()
# 3. Retain As Published（实时转发的消息是否保留 retain 标志）
for rap in (False,True):
    got=[]; c=cl(f"rap{int(rap)}",got)
    c.subscribe("em/m2/up/status", options=SubscribeOptions(qos=1, retainAsPublished=rap)); time.sleep(0.3)
    pub.publish("em/m2/up/status","online",qos=1,retain=True).wait_for_publish(); time.sleep(0.4)
    print(f"Retain As Published={rap}：订阅之后才发布的保留消息，到达时 {got}"); c.disconnect()
    pub.publish("em/m2/up/status","",qos=1,retain=True).wait_for_publish()
# 4. 订阅标识符：同一客户端两个重叠订阅
got=[]; c=cl("sid",got)
p1=Properties(PacketTypes.SUBSCRIBE); p1.SubscriptionIdentifier=1
p2=Properties(PacketTypes.SUBSCRIBE); p2.SubscriptionIdentifier=2
c.subscribe("em/+/up/telemetry", options=SubscribeOptions(qos=1), properties=p1)
c.subscribe("em/m1/#", options=SubscribeOptions(qos=1), properties=p2); time.sleep(0.4)
pub.publish("em/m1/up/telemetry","一条遥测",qos=1).wait_for_publish(); time.sleep(0.4)
print(f"订阅标识符：订阅1=em/+/up/telemetry，订阅2=em/m1/#，发布一条，收到 {got}")
pub.publish("em/m1/shadow/desired","",qos=1,retain=True).wait_for_publish()
```

### 4.3 现象 → 怀疑 → 观察点

| 现象 | 优先怀疑 | 观察点 |
|---|---|---|
| 每次重连都重复处理同一条保留消息 | Retain Handling = 0 | 订阅选项 |
| 服务启动被历史状态触发 | 未用 Retain Handling = 2 或未做"只同步不执行" | 订阅选项、启动逻辑 |
| 服务处理到自己发的消息形成循环 | 未开 No Local | 订阅选项 |
| 桥接后对端没有保留消息 | 未开 Retain As Published | 桥接订阅选项 |
| 同一消息被处理两次 | 重叠订阅 | 订阅标识符；订阅列表 |

## 5. 复习 checklist

- [ ] 能说出 Response Topic 与 Correlation Data 的作用
- [ ] 能说出 Retain Handling 三个值及各自适用场景
- [ ] 能说出 No Local、Retain As Published 的用途
- [ ] 能解释订阅标识符如何区分重叠订阅
- [ ] 能把六条方案建议对应到具体场景
