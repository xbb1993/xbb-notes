# 错误处理与异常场景

> 专题 16 · 模块三 · ☆ 高频重点 · 第二遍（与 9、13、42、49 合讲，本篇展开）
> 云端实测：Mosquitto 2.0.18（`max_packet_size 1024`），客户端用原始 5.0 报文

**这一章解决什么**：出错时 broker 怎么回、客户端该怎么办——排查问题时天天遇到。

## 1. 核心概念

### 1.1 错误分三类

| 类型 | broker 怎么做 | 客户端看到 | 例子 |
|---|---|---|---|
| 单条消息被拒 | 回执带失败原因码，连接保持 | PUBACK/SUBACK 原因码 ≥ 0x80 | 无权限发布 0x87（17、24） |
| 整条连接被断 | 先发 DISCONNECT 带原因码再断 | 连接断，5.0 能看到原因码 | 报文太大、格式错误 |
| 直接关闭 | 什么都不说就断 | 只知道断了 | 部分协议违规；3.1.1 下大多数错误 |

分清的意义：第一类只影响一条，记录后继续；后两类断连接，若客户端不看原因就立刻重连并重发同一条，会陷入"连上—发送—被断—再连"的死循环。

### 1.2 实测（见 4.1）

- 0x81 报文格式错误：往含通配符的主题发布（通配符只能用于订阅，27）。
- 0x95 报文太大：超过 broker 上限（与 44 的 Maximum Packet Size 方向相反）。
- 订阅中一个过滤器非法：Mosquitto 断开整条连接（0x81），另两个合法订阅也没生效；协议也允许只对该过滤器回 0x8F，换 broker 要确认。
- 重复 CONNECT：不发任何报文直接关闭，只有 broker 日志说明原因。
- 0x82 协议错误：发了不存在的报文类型。

### 1.3 客户端怎么应对

| 收到的原因 | 该做 | 不该做 |
|---|---|---|
| 单条被拒（权限、主题非法） | 记录告警，丢弃这一条，继续发后面 | 无限重试同一条 |
| 被断：报文太大、格式错误 | 属程序/配置错误，重连后不再发那条，上报告警 | 重连后接着发，死循环 |
| 被断：0x89 服务器忙、0x9F 连接太频繁 | 等更久再连（43） | 立刻重连 |
| 被断：0x8E 会话被接管 | 可能 ID 冲突，久等再连并告警（47 现场 A） | 立刻抢回来互踢 |
| 无原因断开 | 看 broker 日志；用 5.0 拿更多信息 | 只看客户端日志猜 |

**核心原则**：重连后把"导致断开的那条消息"从待发队列拿出来单独处理，否则一条坏消息会卡住后面所有好消息——电表补传时尤其重要（41、43）。

## 2. 易混淆 / 易错点

| 错误理解 | 正确理解 |
|---|---|
| 断开了重连就好 | 先看原因；程序/配置错误重连也没用 |
| 所有错误都有原因码 | 有的直接关闭，3.1.1 尤甚 |
| 订阅失败只影响那个过滤器 | Mosquitto 会断开整条连接 |
| 坏消息重试几次总会成功 | 格式、大小错误永远不会成功，要隔离 |

## 3. 与其他章节的关联

原因码与属性（17）、主题与通配符规则（27）、报文大小上限（28、44）、重连退避（43）、ID 冲突（47）、抓包看原因码（49）。

## 4. 诊断实践

### 4.1 实验（云端真实输出）

```
  发布到含通配符的主题 em/+/up                 → DISCONNECT，原因码 0x81
  发布 2000 字节（broker 上限 1024）         → DISCONNECT，原因码 0x95
  一次订阅 3 个过滤器，中间一个非法                 → DISCONNECT，原因码 0x81
  同一连接上再发一次 CONNECT                  → 连接被关闭（未收到任何报文）
  发一个不存在的报文类型（0xF0）                  → DISCONNECT，原因码 0x82
```

broker 日志：

```
Client c1 disconnected due to malformed packet.
Client c2 disconnected due to oversize packet.
Invalid subscription string from 127.0.0.1, disconnecting.
Client c3 disconnected due to malformed packet.
Bad client c4 sending multiple CONNECT messages.
```

broker 配置：

```
listener 1883
allow_anonymous true
max_packet_size 1024
log_dest file /tmp/t16/b.log
```

`errs.py`（同时包含专题 13 的 Receive Maximum 实验）：

```python
# 逐一制造异常，看 broker 怎么回（MQTT 5.0 原始报文，便于看到原因码）
import socket, struct, time
def s(x): x=x.encode(); return struct.pack(">H",len(x))+x
def rl(n):
    o=b""
    while True:
        b=n%128; n//=128; o+=bytes([b|0x80 if n else b])
        if not n: return o
def connect(cid, recv_max=None):
    k=socket.create_connection(("127.0.0.1",1883)); k.settimeout(2)
    props=(b"\x21"+struct.pack(">H",recv_max)) if recv_max else b""
    b=s("MQTT")+bytes([5,2])+struct.pack(">H",60)+bytes([len(props)])+props+s(cid); k.sendall(b"\x10"+rl(len(b))+b)
    h=k.recv(2); k.recv(h[1]); return k
NAMES={0x30:"PUBLISH",0x40:"PUBACK",0x90:"SUBACK",0xe0:"DISCONNECT"}
def read_reply(k):
    try:
        d=k.recv(4096)
        if not d: return "连接被关闭（未收到任何报文）"
        t=d[0]&0xf0
        if t==0xe0: return f"DISCONNECT，原因码 0x{d[2]:02X}" if len(d)>2 else "DISCONNECT"
        if t==0x40: return f"PUBACK，原因码 0x{d[4]:02X}" if len(d)>4 else "PUBACK 成功"
        if t==0x90: return "SUBACK，各过滤器原因码 " + " ".join(f"0x{x:02X}" for x in d[5:])
        return f"报文类型 0x{t:02X}"
    except socket.timeout: return "超时，没有任何回复"
    except ConnectionResetError: return "连接被重置"
def case(name, pkt, cid):
    k=connect(cid); k.sendall(pkt); print(f"  {name:<34} → {read_reply(k)}"); k.close()
pub=lambda tp,pl,q=1: (lambda body: bytes([0x30|(q<<1)])+rl(len(body))+body)(s(tp)+(struct.pack(">H",1) if q else b"")+b"\x00"+pl)
case("发布到含通配符的主题 em/+/up",        pub("em/+/up",b"x"), "c1")
case("发布 2000 字节（broker 上限 1024）",  pub("em/a/up",b"x"*2000), "c2")
sb=struct.pack(">H",1)+b"\x00"+s("em/a/#")+b"\x01"+s("em/#/x")+b"\x01"+s("em/b/+")+b"\x02"
case("一次订阅 3 个过滤器，中间一个非法",       b"\x82"+rl(len(sb))+sb, "c3")
b=s("MQTT")+bytes([5,2])+struct.pack(">H",60)+b"\x00"+s("c4")
case("同一连接上再发一次 CONNECT",            b"\x10"+rl(len(b))+b, "c4")
case("发一个不存在的报文类型（0xF0）",        b"\xf0\x00", "c5")
print("== Receive Maximum：订阅方声明最多 2 条未确认，且一直不回 PUBACK")
r=connect("slow", recv_max=2); sb=struct.pack(">H",1)+b"\x00"+s("em/q")+b"\x01"; r.sendall(b"\x82"+rl(len(sb))+sb); r.recv(16)
p=connect("p"); 
for i in range(10): p.sendall(pub("em/q",str(i).encode())); time.sleep(0.05)
time.sleep(0.5); r.settimeout(1); data=b""
try:
    while True: data+=r.recv(4096)
except socket.timeout: pass
n=0; i=0
while i<len(data):
    ln=data[i+1]; n+= (data[i]&0xf0)==0x30; i+=2+ln
print(f"  发布方发了 10 条 QoS 1；订阅方不确认时，broker 只推来 {n} 条")
```

### 4.2 现象 → 怀疑 → 观察点

| 现象 | 优先怀疑 | 观察点 |
|---|---|---|
| 设备反复"连上即被断" | 每次重连都重发同一条坏消息 | DISCONNECT 原因码；待发队列首条 |
| 订阅后什么都收不到且连接断了 | 某个过滤器非法导致整条连接被断 | broker 日志 "Invalid subscription" |
| 大消息发不出去 | 超过 broker 上限 | 0x95；`max_packet_size` |
| 客户端看不到断开原因 | 3.1.1 或直接关闭类错误 | broker 日志；抓包（49） |

## 5. 复习 checklist

- [ ] 能区分三类错误及各自现象
- [ ] 能说出 0x81、0x82、0x95 的含义与触发方式
- [ ] 能说出 Mosquitto 对非法订阅的实测行为
- [ ] 能按原因码给出客户端应对，说明"隔离坏消息"原则
