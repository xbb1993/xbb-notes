# 遗嘱消息（LWT）与在线状态管理

> 专题 15 · 模块三 · ★ 核心必会 · 侧重设备接入
> 版本基线：MQTT 5.0，3.1.1 差异单独标注
> 贯穿场景：电表 meter3 断电、断网、闪断时，大屏要准确显示在线/离线

**对应全景图的哪一块**：把专题 7（broker 发现掉线）和专题 14（保留消息给出当前状态）接起来——掉线时谁来通知大家。设备接入最常用的"在线状态"方案。

## 1. 核心概念

### 1.1 遗嘱是什么

掉线的电表没法替自己说话；broker 知道掉线，但不知道该说什么、告诉谁。解法：**电表在还能说话时，把"掉线时要说的话"预先交给 broker，由 broker 代发。**

> 类比：出远门前留给前台的信封。正常退房（打过招呼）前台把信封还你；不告而别，前台替你寄出。

### 1.2 遗嘱写在 CONNECT 里

```
┌──────────────── CONNECT（带遗嘱）────────────────┐
│ 连接标志：有遗嘱？是  遗嘱 QoS 1  遗嘱保留？是       │
│ 载荷：Client ID：meter3                            │
│       遗嘱属性（5.0）：Will Delay Interval = 30 秒   │
│       遗嘱主题：em/meter3/status                   │
│       遗嘱内容：offline                            │
└───────────────────────────────────────────────────┘
```

- broker 把遗嘱存进该客户端的**会话**。
- 遗嘱是一条完整消息（主题、内容、QoS、保留、5.0 属性），**连接时定好，之后不变**。

### 1.3 触发规则

**正常告别（DISCONNECT 原因码 0x00）不发，其余一律发。**

| 断开方式 | 场景 | 遗嘱 |
|---|---|---|
| DISCONNECT 0x00 | 正常关机、程序正常退出 | **不发** |
| DISCONNECT 0x04（5.0） | 正常断开但希望发遗嘱 | 发 |
| TCP 直接断开 | 断电、崩溃、被 kill | 发 |
| Keep Alive 超时 | 信号丢失、NAT 回收、半开连接 | 发（1.5×KA 后） |
| 被同 ID 新连接接管 | 闪断重连、共用 ID 互踢 | 发 |
| 协议违规被 broker 断开 | 客户端 bug | 按规范应发；Mosquitto 2.0.18 在"重复 CONNECT"时实测未发 |

### 1.4 Will Delay Interval（5.0）

问题：4G 闪断 + 接管立刻触发遗嘱 → 大屏闪烁、告警风暴。

解法：异常断开后**等 N 秒再发**；期间同一会话重连则**取消**。

```
             断开                 N 秒
              │◄──────────────────────────────►│
 情况一：      ✂ ──── 2 秒后重连 ✔ ─────────────  → 遗嘱取消
 情况二：      ✂ ────────────────────────────── ▶ 发遗嘱
```

- 遗嘱在 **min（Will Delay，会话过期）** 时刻发出。
- **Session Expiry 必须 ≥ Will Delay**，否则延迟无效（Expiry=0 时会话一断就结束，遗嘱立即发出）。
- 3.1.1 没有 Will Delay。

### 1.5 在线状态方案：保留消息 + 遗嘱

| 时机 | 电表做什么 |
|---|---|
| 连接时 | 遗嘱：`em/meter3/status` = `offline`，**保留**，QoS 1，Will Delay 30 秒；Session Expiry ≥ 30 秒 |
| 收到 CONNACK 后 | 发布 `em/meter3/status` = `online`，**保留**，QoS 1 |
| 异常掉线 | broker 延迟到期后发遗嘱，公告栏变 offline |
| 正常关机 | **先**发保留的 offline，**再** DISCONNECT 0x00；或 DISCONNECT 0x04 |
| 大屏 | 订阅 `em/+/status`，一连上拿到全部当前状态 |

发现掉线总延迟 ≈ 1.5 × Keep Alive + Will Delay（例：KA 60、Delay 30 → 最长约 2 分钟）；TCP 能立刻感知的断开（断电、崩溃）只需 Will Delay。

| 坑 | 对策 |
|---|---|
| 新旧状态乱序（旧遗嘱晚于新 online 到达） | 载荷带时间戳/连接序号，订阅方只接受更新的状态 |
| 遗嘱内容是"死的"，写不进掉线时间 | 以收到时间为准；或用 broker 上下线事件 |
| 共用 Client ID 互踢反复触发 | ID 唯一（6）；Will Delay 缓解 |
| 正常关机不发遗嘱 | 关机前自发 offline 或用 0x04 |
| 设备报废状态永远停在 offline | 注销时清除保留消息 |
| 遗嘱主题无发布权限被静默丢弃 | 授权覆盖遗嘱主题（24） |
| Will Delay 不生效 | Session Expiry ≥ Will Delay |

另一种做法：多数商用 broker 提供客户端上下线事件（系统主题、WebHook、规则引擎），时间更准但与具体 broker 绑定（42、46）。常见组合：遗嘱管业务状态，broker 事件做运维监控。Sparkplug 的 NBIRTH/NDEATH（37）是同一思路的标准化。

### 1.6 局限

- 只能表达"连接断了"，不区分断电、网络故障、被接管。
- 时效受 Keep Alive 制约，做不到秒级。
- 依赖 broker 正常工作；集群中的遗嘱处理见 31。
- 遗嘱发布同样走授权检查。

## 2. 易混淆 / 易错点

| 错误理解 | 正确理解 |
|---|---|
| 遗嘱是设备掉线时自己发的 | 连接时预交 broker，由 broker 代发 |
| 一断开就发遗嘱 | 正常 DISCONNECT 0x00 不发 |
| 正常关机 broker 会替我更新 offline | 要自己发，或用 0x04 |
| 遗嘱能立刻反映掉线 | 半开连接需 1.5×KA，再加 Will Delay |
| 闪断重连不触发遗嘱 | 接管也触发，除非设 Will Delay 并在期限内重连 |
| 设了 Will Delay 就一定延迟 | 会话先过期就先发；Expiry=0 时无效 |
| 遗嘱不用设保留 | 不设保留，新大屏看不到 offline |
| 以最后收到的状态为准 | 可能乱序，需时间戳判断 |
| 遗嘱内容可连接后修改 | 连接时定好，改需重连 |

## 3. 与其他章节的关联

| 本篇内容 | 相关专题 |
|---|---|
| CONNECT 遗嘱栏、Client ID 互踢 | 6（回顾） |
| Keep Alive 发现半开连接 | 7（回顾） |
| 遗嘱存在会话里、Session Expiry | 12（回顾） |
| 保留消息做"当前状态" | 14（回顾） |
| DISCONNECT 原因码 0x04、0x81、0x82 | 17 |
| 遗嘱的 Message Expiry | 18 |
| 遗嘱主题授权 | 24 |
| 集群中的遗嘱 | 31 |
| Sparkplug 出生/死亡消息 | 37 |
| broker 上下线事件 | 42、46 |
| 故障诊断 | 47 |

## 4. 诊断实践

### 4.1 实验（云端真实输出，Mosquitto 2.0.18，原始 socket 控制断开方式）

**触发规则**（Will Delay 未设置）：

```
  ① 正常发 DISCONNECT（原因码 0x00） → 没有收到遗嘱
  ② 发 DISCONNECT 但原因码 0x04 Disconnect with Will Message → 收到遗嘱 'offline'（0.00s）
  ③ 直接关闭 TCP，不发 DISCONNECT（进程崩溃、被杀） → 收到遗嘱 'offline'（0.00s）
  ④ 协议违规（连接上再发一次 CONNECT），broker 断开 → 没有收到遗嘱
  ⑤ 保持连接但什么都不发，Keep Alive=2 秒超时 → 收到遗嘱 'offline'（3.41s）
  ⑥ 同一 Client ID 新连接接管旧连接 → 收到遗嘱 'offline'（0.20s）
  补测：QoS=3 的非法 PUBLISH（broker 回 DISCONNECT 0x81）→ 收到遗嘱
  补测：保留报文类型 0（broker 回 DISCONNECT 0x82）→ 收到遗嘱
```

④ 与规范不符，broker 日志为 `Bad client meter3 sending multiple CONNECT messages.`，属 Mosquitto 2.0.18 的实现行为。

**Will Delay**：

```
   0.00s 电表连接（Will Delay=5 秒，会话保留 300 秒）
   0.00s ✂ 异常断开
   2.00s 2 秒后重连成功
    闪断 2 秒后重连 → 没有收到遗嘱
   0.00s ✂ 异常断开，之后不再重连
    一直不回来 → 收到遗嘱 'offline'（5.22s）
   0.00s ✂ 异常断开（Will Delay=30 秒，但会话只保留 3 秒）
    取两者中较早到期的 → 收到遗嘱 'offline'（3.21s）
```

**在线状态方案**：

```
   0.50s 电表上线：遗嘱=保留的 offline；连上后发布保留的 online
   0.50s 新打开的大屏看到：['em/meter3/status=online']
   2.32s ✂ 电表断电（不发 DISCONNECT）
   2.32s 新打开的大屏看到：['em/meter3/status=offline']
```

本地复现：`python3 will_lab.py triggers | delay | status`（需本机 1883 有 broker、paho-mqtt 2.x）

<details>
<summary>will_lab.py</summary>

```python
"""专题 15 实验：用原始 socket 精确控制"电表"怎么断开，观察遗嘱是否触发、何时触发。"""
import socket, struct, time, sys
import paho.mqtt.client as mqtt
H, P = "127.0.0.1", 1883
def vbi(n):
    out = b""
    while True:
        b = n % 128; n //= 128; out += bytes([b | 0x80 if n else b])
        if not n: return out
def s(x): x = x.encode() if isinstance(x, str) else x; return struct.pack(">H", len(x)) + x
def connect(cid="meter3", keepalive=60, will_delay=None, session_expiry=0, clean=True, will=True):
    props = b"\x11" + struct.pack(">I", session_expiry)
    flags = (0x02 if clean else 0) | (0x04 | 0x08 | 0x20 if will else 0)   # Will Flag, Will QoS1, Will Retain
    payload = s(cid)
    if will:
        wp = (b"\x18" + struct.pack(">I", will_delay)) if will_delay is not None else b""
        payload += vbi(len(wp)) + wp + s(f"em/{cid}/status") + s("offline")
    body = s("MQTT") + bytes([5, flags]) + struct.pack(">H", keepalive) + vbi(len(props)) + props + payload
    sk = socket.create_connection((H, P)); sk.sendall(b"\x10" + vbi(len(body)) + body); sk.recv(64)
    return sk
def publish_online(sk, cid="meter3"):
    body = s(f"em/{cid}/status") + b"\x00" + b"online"           # QoS0 retained, no props
    sk.sendall(bytes([0x31]) + vbi(len(body)) + body)

T0 = [time.time()]
def ts(): return f"{time.time()-T0[0]:5.2f}s"
got = []
w = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="svc-status", protocol=mqtt.MQTTv5)
w.on_message = lambda c,u,m: (got.append((round(time.time()-T0[0],2), m.payload.decode(), m.retain)))
w.connect(H, P); w.subscribe("em/+/status", qos=1); w.loop_start(); time.sleep(0.5)
def watch(sec):
    end = time.time() + sec
    while time.time() < end: time.sleep(0.05)
def report(label):
    offl = [g for g in got if g[1] == "offline"]
    print(f"  {label} → " + (f"收到遗嘱 'offline'（{offl[0][0]:.2f}s）" if offl else "没有收到遗嘱"))
def reset(): got.clear(); T0[0] = time.time()

case = sys.argv[1]
if case == "triggers":
    print("=== 什么情况触发遗嘱（Will Delay 未设置 = 0）===")
    reset(); sk = connect(); sk.sendall(b"\xe0\x00"); sk.close(); watch(1.5); report("① 正常发 DISCONNECT（原因码 0x00）")
    reset(); sk = connect(); sk.sendall(b"\xe0\x01\x04"); sk.close(); watch(1.5); report("② 发 DISCONNECT 但原因码 0x04 Disconnect with Will Message")
    reset(); sk = connect(); sk.close(); watch(1.5); report("③ 直接关闭 TCP，不发 DISCONNECT（进程崩溃、被杀）")
    reset(); sk = connect(); sk.sendall(b"\x10\x00"); time.sleep(0.3); sk.close(); watch(1.5); report("④ 协议违规（连接上再发一次 CONNECT），broker 断开")
    reset(); sk = connect(keepalive=2); watch(5); report("⑤ 保持连接但什么都不发，Keep Alive=2 秒超时"); sk.close()
    reset(); sk = connect(); time.sleep(0.2); sk2 = connect(will=False); watch(1.5); report("⑥ 同一 Client ID 新连接接管旧连接"); sk2.sendall(b"\xe0\x00"); sk2.close()
elif case == "delay":
    print("=== Will Delay Interval（遗嘱延迟）===")
    reset(); sk = connect(will_delay=5, session_expiry=300); print(f"  {ts()} 电表连接（Will Delay=5 秒，会话保留 300 秒）")
    sk.close(); print(f"  {ts()} ✂ 异常断开"); time.sleep(2)
    sk = connect(will_delay=5, session_expiry=300, clean=False); print(f"  {ts()} 2 秒后重连成功")
    watch(5); report("  闪断 2 秒后重连")
    sk.sendall(b"\xe0\x00"); sk.close(); time.sleep(0.5)
    reset(); sk = connect(will_delay=5, session_expiry=300); sk.close(); print(f"  {ts()} ✂ 异常断开，之后不再重连")
    watch(7); report("  一直不回来")
    reset(); sk = connect(will_delay=30, session_expiry=3); sk.close(); print(f"  {ts()} ✂ 异常断开（Will Delay=30 秒，但会话只保留 3 秒）")
    watch(6); report("  取两者中较早到期的")
elif case == "status":
    print("=== 保留消息 + 遗嘱 = 在线状态 ===")
    mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, protocol=mqtt.MQTTv5)
    reset(); sk = connect(); publish_online(sk); time.sleep(0.5); print(f"  {ts()} 电表上线：遗嘱=保留的 offline；连上后发布保留的 online")
    def peek():
        r = []
        c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, protocol=mqtt.MQTTv5)
        c.on_message = lambda cl,u,m: r.append(f"{m.topic}={m.payload.decode()}")
        c.connect(H, P); c.subscribe("em/meter3/status"); c.loop_start(); time.sleep(0.6); c.loop_stop(); c.disconnect()
        return r
    print(f"  {ts()} 新打开的大屏看到：{peek()}")
    sk.close(); time.sleep(0.8); print(f"  {ts()} ✂ 电表断电（不发 DISCONNECT）")
    print(f"  {ts()} 新打开的大屏看到：{peek()}")
w.loop_stop()
```
</details>

### 4.2 现象 → 怀疑 → 观察点

| 现象 | 优先怀疑 | 观察点 |
|---|---|---|
| 断电后大屏仍显示在线 | 没配遗嘱 / 遗嘱未保留 / 未到 1.5×KA + Delay | CONNECT 遗嘱字段（日志 `Will message specified`）；保留消息内容 |
| 设备在线大屏显示离线 | 乱序；正常关机后重连没发 online | status 时间戳；上线流程 |
| 状态频繁跳动 | 闪断且无 Will Delay；Client ID 互踢 | `already connected`；Will Delay 配置 |
| 大量设备同时变 offline | 网络或 broker 故障 | 时间是否集中；broker 节点状态 |
| 正常关机设备一直显示 online | 关机流程没发 offline | 关机代码 |
| 遗嘱从不发出 | 遗嘱主题无权限；实现问题 | 授权日志；对照实验 |

## 5. 复习 checklist

- [ ] 能用"留给前台的信封"解释遗嘱，说明它存在会话里、连接时定好
- [ ] 能说出触发原则及六种断开方式的结果
- [ ] 能解释 Will Delay 解决的问题、取消条件、与 Session Expiry 取较早者
- [ ] 能完整描述"保留 + 遗嘱"在线状态方案的五个时机
- [ ] 能估算发现掉线的总延迟
- [ ] 能说出方案的七个坑与对策，尤其乱序与正常关机
- [ ] 能说明遗嘱与 broker 上下线事件的取舍

---

参考：[OASIS MQTT 5.0 规范](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html)、[HiveMQ · Last Will and Testament](https://www.hivemq.com/blog/mqtt-essentials-part-9-last-will-and-testament/)
