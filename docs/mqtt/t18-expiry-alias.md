# 过期机制与 Topic Alias

> 专题 18 · 模块四 · ☆ 高频重点 · 第二遍 · 简述
> 云端实测：Mosquitto 2.0.18 + paho-mqtt 2.1.0；均为 MQTT 5.0 功能
> 保留消息的过期行为依据 5.0 设计，未单独实验

**这一章解决什么**：两件和"省"有关的小事——过期让 broker 不无限期保存东西（省内存、防旧命令被执行）；主题别名让每条消息少发几十字节（省流量）。

## 1. 核心概念

### 1.1 两种过期

| | 会话过期 Session Expiry | 消息过期 Message Expiry |
|---|---|---|
| 管什么 | 整个会话：订阅、排队消息、未确认消息 | 单条消息 |
| 谁设 | 客户端连接时（12） | 发布者发布时（39） |
| 何时开始计时 | 连接断开时 | broker 收到这条消息时 |
| 到期后 | 整个会话删除，排队消息一起没了 | 这条不再投递 |
| 解决 | 离线太久的设备别一直占内存（28） | 太旧的命令别再执行（39） |

两者叠加：会话还在，排队消息也可能因自己过期被丢；会话过期，所有消息一起没了。

**剩余时间递减**：broker 转发时扣掉已等待时间，告诉接收方还剩多少秒（实验：设 10 秒、等 5 秒，收到剩余 5 秒；设 3 秒的直接没投递）。这只算了在 broker 里等的时间，电表处理时长要自己把握——载荷里再放业务截止时间由电表二次检查（39）。

**保留消息也可设过期**，到期后不再推给新订阅者，防止很久以前的保留消息误导新服务（47 现场 D）。

### 1.2 Topic Alias（主题别名）

道理：`em/v1/t01/AE12345678/up/telemetry` 33 个字符，每条都完整带一遍，载荷本身才几十字节。同一条连接上，首次发送时把长主题与短数字绑定，之后主题留空只带数字，broker 换回完整主题再转发。

实验结果：broker 允许上限 10 个（Mosquitto 2.0.18 默认）；不用别名每条 86 字节；首条（主题 + 绑定）89 字节，多 3 字节；之后每条 56 字节，**省 35%**；订阅方收到的仍是完整主题，对后端透明。

要点：
- **只在一条连接内有效**，重连后全部失效，重连后首条必须重新带完整主题。
- **两个方向各算各的**，编号独立。
- **数量有上限**，由对方连接时告知；只给常用上报主题绑定即可。
- **只有 5.0 才有**。

值不值得：每分钟一条每月约省 1.2 MB，对比每表每月约 7 MB 遥测（50），约省 15%–20%。4G 按流量计费、表多时值得；但要求库/模组支持 5.0 和别名（44），固件要处理重连重绑。可与二进制载荷、缩短主题一起权衡。

## 2. 易混淆 / 易错点

| 错误理解 | 正确理解 |
|---|---|
| 会话过期和消息过期是一回事 | 一个管整个会话、从断开计时；一个管单条、从 broker 收到计时 |
| 会话还在消息就一定还在 | 消息可能因自身过期被丢 |
| 接收方看到的过期时间等于发布时设的 | 转发时扣掉已等待时间 |
| 剩余过期时间能保证电表及时处理 | 只算 broker 内等待；电表要用业务截止时间二次检查 |
| 用了别名后端收到的也是数字 | 后端收到完整主题，别名只在一段连接内 |
| 别名绑一次永久有效 | 只在当前连接，重连要重绑 |
| 首条消息也省字节 | 首条反而多 3 字节 |

## 3. 与其他章节的关联

| 本篇内容 | 相关专题 |
|---|---|
| 会话过期 | 12（回顾） |
| 属性、Topic Alias Maximum | 17（回顾） |
| 内存积压 | 28（回顾） |
| 命令过期 | 39（回顾） |
| 受限设备库支持 | 44（回顾） |
| 过时保留消息 | 47 现场 D（回顾） |
| 流量估算 | 50（回顾） |

## 4. 诊断实践

### 4.1 实验（云端真实输出）

```
== 实验 1：消息过期（Message Expiry）的剩余时间
  电表离线时发出两条命令：过期 10 秒、过期 3 秒；电表 5 秒后上线
  电表收到 命令(过期10s)，消息里剩余过期时间 = 5 秒
  共收到 1 条
== 实验 2：Topic Alias 每条 PUBLISH 的字节数
  broker 在 CONNACK 里允许的主题别名上限 Topic Alias Maximum = 10
  不用别名                   每条 86 字节
  首条：主题 + 绑定别名 1         每条 89 字节
  之后：空主题 + 别名 1          每条 56 字节
  订阅方收到的主题：['em/v1/t01/AE12345678/up/telemetry', 'em/v1/t01/AE12345678/up/telemetry', 'em/v1/t01/AE12345678/up/telemetry']
  每条省 30 字节（35%）；每分钟一条，一个月约省 1266 KB
```

### 4.2 脚本（本地：Mosquitto + paho-mqtt 2.x）

`expiry_alias.py`：

```python
# 实验 1：消息过期的剩余时间会递减；实验 2：Topic Alias 每条能省多少字节
import paho.mqtt.client as mqtt, time, socket, struct
from paho.mqtt.properties import Properties
from paho.mqtt.packettypes import PacketTypes
V2=mqtt.CallbackAPIVersion.VERSION2
def cl(cid, clean=True, expiry=0, got=None):
    c=mqtt.Client(V2, client_id=cid, protocol=mqtt.MQTTv5)
    if got is not None: c.on_message=lambda c,u,m: got.append((m.payload.decode(), getattr(m.properties,"MessageExpiryInterval",None)))
    p=Properties(PacketTypes.CONNECT); p.SessionExpiryInterval=expiry
    c.connect("127.0.0.1",1883,clean_start=clean,properties=p); c.loop_start(); time.sleep(0.3); return c
print("== 实验 1：消息过期（Message Expiry）的剩余时间")
d=cl("meterE", clean=True, expiry=3600); d.subscribe("em/AE1/down/cmd",1); time.sleep(0.3); d.disconnect(); d.loop_stop()
pub=cl("svc")
for exp in (10,3):
    p=Properties(PacketTypes.PUBLISH); p.MessageExpiryInterval=exp
    pub.publish("em/AE1/down/cmd", f"命令(过期{exp}s)", qos=1, properties=p).wait_for_publish()
print("  电表离线时发出两条命令：过期 10 秒、过期 3 秒；电表 5 秒后上线")
time.sleep(5)
got=[]; d=cl("meterE", clean=False, expiry=3600, got=got); time.sleep(0.8)
for pl,rem in got: print(f"  电表收到 {pl}，消息里剩余过期时间 = {rem} 秒")
print(f"  共收到 {len(got)} 条")
d.disconnect(); pub.disconnect()

print("== 实验 2：Topic Alias 每条 PUBLISH 的字节数")
def s(x): x=x.encode(); return struct.pack(">H",len(x))+x
k=socket.create_connection(("127.0.0.1",1883))
b=s("MQTT")+bytes([5,2])+struct.pack(">H",60)+b"\x00"+s("AE12345678"); k.sendall(b"\x10"+bytes([len(b)])+b)
ca=k.recv(64); props=ca[5:]
i=0; tam=None
while i<len(props):
    pid=props[i]
    if pid==0x22: tam=struct.unpack(">H",props[i+1:i+3])[0]; break
    i+= {0x21:3,0x22:3,0x24:2,0x25:2,0x27:5,0x28:2,0x29:2,0x2A:2,0x13:3,0x12:3+0}.get(pid,1)
print(f"  broker 在 CONNACK 里允许的主题别名上限 Topic Alias Maximum = {tam}")
got=[]; sub=cl("sub", got=[]) ; sub.on_message=lambda c,u,m: got.append(m.topic); sub.subscribe("em/v1/#",0); time.sleep(0.3)
topic="em/v1/t01/AE12345678/up/telemetry"; payload=b'{"seq":1,"ts":1760000000,"kwh":1234.56,"p":1.23}'
def pub_pkt(tp, alias=None):
    props=(b"\x23"+struct.pack(">H",alias)) if alias else b""
    body=s(tp)+bytes([len(props)])+props+payload; return b"\x30"+bytes([len(body)])+body   # QoS 0
pkts=[("不用别名",pub_pkt(topic)),("首条：主题 + 绑定别名 1",pub_pkt(topic,1)),("之后：空主题 + 别名 1",pub_pkt("",1))]
for name,p in pkts: k.sendall(p); print(f"  {name:<22} 每条 {len(p)} 字节")
time.sleep(0.5); print(f"  订阅方收到的主题：{got}")
full=len(pkts[0][1]); alias=len(pkts[2][1])
print(f"  每条省 {full-alias} 字节（{(full-alias)/full:.0%}）；每分钟一条，一个月约省 {(full-alias)*60*24*30/1024:.0f} KB")
```

### 4.3 现象 → 怀疑 → 观察点

| 现象 | 优先怀疑 | 观察点 |
|---|---|---|
| 电表上线收不到离线期间的命令 | 会话已过期，或消息已过期 | Session Present；命令的 Message Expiry |
| 电表执行了很旧的命令 | 未设消息过期，也无业务截止时间 | 发布属性；载荷字段 |
| 用别名后重连，broker 报协议错误或主题错乱 | 重连后未重新绑定别名 | 重连后首条是否带完整主题 |
| 别名不生效 | broker 的 Topic Alias Maximum 为 0 或协议版本为 3.1.1 | CONNACK 属性；协议版本 |

## 5. 复习 checklist

- [ ] 能用表格区分会话过期与消息过期
- [ ] 能解释剩余过期时间递减及其局限
- [ ] 能说出主题别名的原理、实测节省比例与四个要点
- [ ] 能判断方案里是否值得启用主题别名
