# QoS 2：四步握手、状态机与"恰好一次"的边界

> 专题 11 · 模块三 · ★ 核心必会 · 侧重两者兼顾
> 版本基线：MQTT 5.0，3.1.1 差异单独标注
> 贯穿场景：电表上报告警事件 alarm，告警服务按条数派工单（重复 = 多派单，丢失 = 漏处理）

**对应全景图的哪一块**：一跳之内，协议如何消除 QoS 1 的重复，以及它的边界。

**交互图解**：<a href="/xbb-notes/mqtt-qos2-state-machine.html" target="_blank">QoS 2 状态机（7 种故障点 × 3 种重连方式 × 2 种转发时机，含全部分支结果矩阵）</a>

## 1. 核心概念

### 1.1 推演：为什么是四步

QoS 1 重复的根源：broker 回完 PUBACK 就忘了包 ID，补发来时分不清新旧。

| 尝试 | 做法 | 问题 |
|---|---|---|
| 两步 + 接收方记 ID | broker 记 ID，回确认 | **什么时候忘？** 回完就忘 → 确认丢了又重复；永远记着 → 内存膨胀，且**包 ID 会复用**，新消息被误判为重复而丢弃 |
| 加第三步 PUBREL | 发送方告诉接收方"不会再发了，可以忘" | 发送方又不知道何时能复用这个包 ID |
| 加第四步 PUBCOMP | 接收方告知"已经忘了" | ✔ |

结论：**送达靠"存副本 + 补发"（QoS 1 已有）；后两步是为了安全地删除去重状态。**

> 类比：挂号信 + 销号。① 寄出 7 号信；② 收件方签收登记；③ 寄件方："回执收到，7 号了结，可以销号"；④ 收件方："已销号"，寄件方把 7 号用于下一封。

| 步骤 | 含义 |
|---|---|
| ① PUBLISH | 发送方存副本；接收方登记 ID |
| ② PUBREC | "已登记，以后再发我也认得" → 发送方删副本、**从此不再发 PUBLISH** |
| ③ PUBREL | 发送方**承诺**不再发 PUBLISH → 接收方可安全删登记 |
| ④ PUBCOMP | 接收方告知"已删" → 发送方释放包 ID |

### 1.2 两端状态

```
电表（发送方）                                    broker（接收方）
存：消息副本
 │ ① PUBLISH#7 ───────────────────────────────> │ 存：7 号登记（做法 A 还存整条消息）
 │ <──────────────────────────────── ② PUBREC#7 │
删：副本；存：7 号"等待完成"                       │
 │ ③ PUBREL#7 ────────────────────────────────> │ 删：7 号登记
 │ <─────────────────────────────── ④ PUBCOMP#7 │
删：7 号，可复用
```

**发送方何时确定不再重发 PUBLISH：收到 PUBREC（第②步）那一刻。**

```
              ①发PUBLISH   ②收到PUBREC        ③发PUBREL     ④收到PUBCOMP
持有副本       ████████████│删除
可能重发PUBLISH ████████████│✘ 不再发
可能重发PUBREL                ████████████████████████████│结束
占用 7 号      █████████████████████████████████████████████│释放
```

规范要点：

- 发出 PUBREL 后不得再发该 PUBLISH。
- 接收方收到 PUBREL 前，对同一包 ID 的 PUBLISH 只回 PUBREC，不得重复投递。
- 5.0：PUBREC 带失败原因码（≥0x80）时流程结束，不发 PUBREL。

### 1.3 接收方何时转发

| 做法 | PUBLISH 到达时 | PUBREL 到达时 | 特点 |
|---|---|---|---|
| A 先存后转 | 存消息 + ID，回 PUBREC | **转发**，删记录 | 多 1 个往返才转发；发送方在②③之间消失且无会话 → 消息被扣着然后丢弃 |
| B 先转后记 | **立即转发**，只记 ID | 删 ID | 转发快；只存 ID |

3.1.1 规范的非规范性说明列出了这两种方法。**Mosquitto 2.0.18 实测为做法 A。**

### 1.4 断线恢复（会话在的前提下）

| 断在哪 | 重连后发送方 | 接收方 |
|---|---|---|
| 没收到 PUBREC | 补发 PUBLISH（DUP=1） | 认出包 ID，只回 PUBREC，不再转发 |
| 发出 PUBREL、没收到 PUBCOMP | **只补发 PUBREL** | 回 PUBCOMP（记录已删也照回） |

### 1.5 每一跳独立

```
   0.0ms  第1跳  电表 → broker      PUBLISH  包ID=1
   0.1ms  第1跳  电表 ← broker      PUBREC   包ID=1
   0.2ms  第1跳  电表 → broker      PUBREL   包ID=1
   0.2ms  第2跳  broker → 告警服务   PUBLISH  包ID=1   ← 做法 A：PUBREL 后才转发
   0.2ms  第1跳  电表 ← broker      PUBCOMP  包ID=1   ← 第 1 跳已结束
   0.3ms  第2跳  broker ← 告警服务   PUBREC   包ID=1
   0.3ms  第2跳  broker → 告警服务   PUBREL   包ID=1
   0.3ms  第2跳  broker ← 告警服务   PUBCOMP  包ID=1
```

- broker → 应用服务那一跳是**对称的另一次四步握手**：broker 当发送方，应用服务里的 MQTT 客户端库当接收方。
- 两跳包 ID 各自编号（这里都是 1 是巧合）。
- 两跳互不保证：电表收到 PUBCOMP 时，第 2 跳才开始。

第 2 跳恰好一次的条件：订阅 QoS 2；订阅端会话持久；订阅端进程不丢状态。客户端库之后到业务代码、工单系统那一段，协议管不到，只能靠应用层幂等。

### 1.6 恰好一次的全部前提

| 前提 | 不满足时 |
|---|---|
| 两跳都是 QoS 2 | 按较低的降级 |
| 两端会话都保住 | 重复（会话丢、应用重发），或丢失（做法 A 暂存消息随会话丢弃） |
| 客户端进程未重启 / 状态持久化 | 同上 |
| broker 重启时持久化状态 | 同上 |
| 业务代码在"收到"与"处理"之间不崩溃 | 协议管不到 |

**QoS 2 = 一跳之内、两端状态都在时，协议替你做去重。** 端到端仍需应用层幂等，因此很多场景 **QoS 1 + 幂等** 就够。

### 1.7 成本与平台支持

| | QoS 0 | QoS 1 | QoS 2 |
|---|---|---|---|
| 一跳报文数 | 1 | 2 | 4 |
| 发送方释放前等待往返 | 0 | 1 | 2 |
| 转发延迟（做法 A） | 无 | 无 | +1 往返 |
| 两端状态 | 无 | 发送方副本 | 两端都存，四步走完才删 |

- EMQX 文章估计 QoS 2 吞吐约为 QoS 0/1 的一半（未给测试条件）。
- **AWS IoT Core 不支持 QoS 2**（官方文档：只支持 0、1；请求 QoS 2 时不回确认）。

值得用 QoS 2：不能重复、接收方难以幂等（如无法修改的老系统）、消息量小、延迟不敏感、两端会话可持久、平台支持。

| 电表消息 | 建议 |
|---|---|
| 告警事件 | QoS 1 + 事件 ID 幂等；工单系统无法去重且平台支持时可考虑 QoS 2 |
| 计费表底值 | QoS 1（表底值天然幂等） |
| 指令下发 | QoS 1 + 指令 ID + 回执 |

## 2. 易混淆 / 易错点

| 错误理解 | 正确理解 |
|---|---|
| QoS 2 = 端到端恰好一次 | 只管一跳，依赖两端会话状态 |
| 四步是为了更可靠地送到 | 送到靠副本 + 补发；后两步是为了安全删除去重状态 |
| 接收方一直记着 ID 就能去重 | 包 ID 会复用，会误判新消息为重复 |
| QoS 2 不会丢 | 做法 A 下发送方在②③之间消失且无会话，消息被丢弃 |
| PUBREL 丢了要重发 PUBLISH | 发出 PUBREL 后只补发 PUBREL |
| 发送方到第④步才停止重发 PUBLISH | 第②步收到 PUBREC 就不再发 PUBLISH |
| 发布 QoS 2 就够了 | 订阅也须 QoS 2 |
| 两跳共用一个包 ID | 每跳各自编号 |
| 电表收到 PUBCOMP = 订阅者收到了 | 只说明第 1 跳结束 |
| 各平台都支持 QoS 2 | AWS IoT Core 不支持 |

## 3. 与其他章节的关联

| 本篇内容 | 相关专题 |
|---|---|
| 去重、确认时机、幂等 | 2（回顾） |
| QoS 1 重复、补发规则、降级 | 10（回顾） |
| 会话保存与过期决定 QoS 2 上限 | 12 会话状态 |
| PUBREC 失败原因码 | 17 原因码 |
| 各 broker 转发时机与持久化 | 28、29 |
| 指令去重与回执 | 39 |
| 应用层幂等入库 | 41、43 |
| 云平台 QoS 支持 | 45 |

## 4. 诊断实践

### 4.1 实验（云端真实输出，Mosquitto 2.0.18，原始 socket 逐步驱动）

| 实验 | 操作 | 结果 |
|---|---|---|
| E1 转发时机 | PUBREC 后故意晚 2 秒发 PUBREL | 订阅者在 PUBREL 到达后才收到 → 做法 A |
| E2 PUBREC 后断线 | 会话在，重连补发 PUBLISH(DUP=1) | broker 只回 PUBREC，订阅者收到 **1** 次 |
| E4 包 ID 复用 | PUBCOMP 后用同一 ID 发新消息 | 被正确当作新消息，收到 1 次 |
| E5 PUBREL 后断线 | 会话在，重连只补发 PUBREL | PUBCOMP，订阅者收到 **1** 次 |
| E6 PUBREL 后断线 | Clean Start=1，应用把消息当新消息重发 | 订阅者收到 **2** 次 → QoS 2 也重复 |

E1 原始输出：

```
 0.50s 电表 → PUBLISH(id=1, 'alarm-A')
 0.50s 电表 ← PUBREC(id=1)
 2.50s 电表 → PUBREL(id=1)（故意晚 2 秒才发）
 2.50s 电表 ← PUBCOMP(id=1)
 2.51s [订阅者] 收到 alarm-A
```

E6 原始输出：

```
 1.31s 电表 → PUBLISH(id=6, 'alarm-F')  ← PUBREC(id=6)
 1.31s 电表 → PUBREL(id=6)
 1.31s [订阅者] 收到 alarm-F
 1.61s ✂ 连接断开（没收到 PUBCOMP）
 1.61s 电表重连，Clean Start=1，Session Present=0
 1.61s 电表 → PUBLISH(id=1, 'alarm-F')（当作新消息）  ← PUBREC(id=1)
 1.61s 电表 → PUBREL(id=1)  ← PUBCOMP(id=1)
 1.61s [订阅者] 收到 alarm-F
 订阅者收到 alarm-F 共 2 次
```

### 4.2 全部分支结果（与交互图解中的矩阵一致，由状态机推演得出）

| 故障点 | A·会话保留 | A·丢会话重发 | A·丢会话放弃 | B·会话保留 | B·丢会话重发 | B·丢会话放弃 |
|---|---|---|---|---|---|---|
| 无故障 | 恰好一次 | 恰好一次 | 恰好一次 | 恰好一次 | 恰好一次 | 恰好一次 |
| ① PUBLISH 丢失 | 恰好一次 | 恰好一次 | **丢失** | 恰好一次 | 恰好一次 | **丢失** |
| ① broker 拒绝 | 被拒绝 | 被拒绝 | 被拒绝 | 被拒绝 | 被拒绝 | 被拒绝 |
| ① broker 登记后崩溃（未持久化） | **丢失** | 恰好一次 | **丢失** | 恰好一次 | **重复** | 恰好一次 |
| ② PUBREC 丢失 | 恰好一次 | 恰好一次 | **丢失** | 恰好一次 | **重复** | 恰好一次 |
| ③ PUBREL 丢失 | 恰好一次 | 恰好一次 | **丢失** | 恰好一次 | **重复** | 恰好一次 |
| ④ PUBCOMP 丢失 | 恰好一次 | **重复** | 恰好一次 | 恰好一次 | **重复** | 恰好一次 |

读法：

- **会话保留时，除 broker 崩溃外全部恰好一次**，这正是 QoS 2 的价值。
- 会话一丢：做法 A 倾向于**丢**（暂存的消息随会话丢弃），做法 B 倾向于**重**（已转发的又被重发）。
- broker 拒绝时消息未投递，但发送方通过原因码明确知道失败。
- broker 崩溃且未持久化时，即使客户端请求保留会话，Session Present 也为 0，规范要求客户端丢弃本地会话状态。

本地复现（原始 socket 驱动，需本机 1883 有 broker、paho-mqtt 2.x）：

<details>
<summary>qos2_lab.py（E1～E4）</summary>

```python
import socket, time, struct
import paho.mqtt.client as mqtt

H, P = "127.0.0.1", 1883
T0 = time.time()
def ts(): return f"{time.time()-T0:5.2f}s"
def vbi(n):
    out = b""
    while True:
        b = n % 128; n //= 128
        out += bytes([b | 0x80 if n else b])
        if not n: return out
def pkt(first, body): return bytes([first]) + vbi(len(body)) + body
def s(x): x = x.encode(); return struct.pack(">H", len(x)) + x
def connect(clean, expiry=300):
    sk = socket.create_connection((H, P)); sk.settimeout(2)
    props = b"\x11" + struct.pack(">I", expiry)
    body = s("MQTT") + bytes([5, 0x02 if clean else 0x00]) + struct.pack(">H", 60) + vbi(len(props)) + props + s("meter3")
    sk.sendall(pkt(0x10, body)); r = sk.recv(64)
    return sk, r[2] & 1
def publish(sk, pid, payload, dup=False):
    body = s("em/meter3/up/event") + struct.pack(">H", pid) + b"\x00" + payload.encode()
    sk.sendall(pkt(0x34 | (0x08 if dup else 0), body))
def pubrel(sk, pid): sk.sendall(pkt(0x62, struct.pack(">H", pid)))
NAMES = {5: "PUBREC", 7: "PUBCOMP"}
def recv(sk):
    r = sk.recv(64); t = r[0] >> 4; pid = struct.unpack(">H", r[2:4])[0]
    return f"{NAMES.get(t, t)}(id={pid})"

got = []
sub = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="svc-alarm", protocol=mqtt.MQTTv5)
sub.on_message = lambda c, u, m: (got.append(m.payload.decode()), print(f"  {ts()} [订阅者] 收到 {m.payload.decode()}"))
sub.connect(H, P); sub.subscribe("em/meter3/up/event", qos=2); sub.loop_start(); time.sleep(0.5)

print("E1 转发时机")
sk, sp = connect(clean=True)
publish(sk, 1, "alarm-A"); print(f"  {ts()} → PUBLISH(1)  ← {recv(sk)}")
time.sleep(2); pubrel(sk, 1); print(f"  {ts()} → PUBREL(1)  ← {recv(sk)}"); sk.close(); time.sleep(0.5)

print("E2 PUBREC 后断线，会话在，补发 PUBLISH(DUP=1)")
sk, sp = connect(clean=False)
publish(sk, 2, "alarm-B"); print(f"  {ts()} → PUBLISH(2)  ← {recv(sk)}"); sk.close(); time.sleep(0.5)
sk, sp = connect(clean=False); print(f"  {ts()} 重连 Session Present={sp}")
publish(sk, 2, "alarm-B", dup=True); print(f"  {ts()} → PUBLISH(2, DUP=1)  ← {recv(sk)}")
pubrel(sk, 2); print(f"  {ts()} → PUBREL(2)  ← {recv(sk)}"); time.sleep(0.5)
print(f"  alarm-B 收到 {got.count('alarm-B')} 次")
sk.close(); sub.loop_stop()
```
</details>

### 4.3 现象 → 怀疑 → 观察点

| 现象 | 优先怀疑 | 观察点 |
|---|---|---|
| 用了 QoS 2 仍有重复 | 会话没保住；订阅端降级 | Session Present；订阅 QoS；重复是否集中在重连时刻 |
| QoS 2 延迟明显高于 QoS 1 | 做法 A 等 PUBREL 才转发，4G 往返长 | 抓包看 PUBLISH 到 PUBREL 的间隔 |
| QoS 2 偶尔丢 | PUBREC 后断线且无会话（做法 A） | broker 未完成 QoS 2 记录；会话配置 |
| 某客户端大量 QoS 2 状态挂起 | 对端不发 PUBREL/PUBCOMP（bug 或频繁断线） | broker 上该客户端未完成消息数 |
| 对接云平台 QoS 2 无确认 | 平台不支持 | 平台文档；改 QoS 1 + 幂等 |

## 5. 复习 checklist

- [ ] 能从"接收方何时忘掉 ID"推演出四步握手
- [ ] 能说出每一步的含义，以及两端在各阶段存什么
- [ ] 能回答发送方在哪一步确定不再重发 PUBLISH（②）
- [ ] 能说出断在②前、③后分别补发什么
- [ ] 能区分做法 A / B，说出 Mosquitto 是哪种及其影响
- [ ] 能说明第 2 跳是对称的另一次握手，两跳包 ID 独立、互不保证
- [ ] 能列出恰好一次的五个前提
- [ ] 能读懂全部分支矩阵：会话保留几乎都对，会话丢失时 A 倾向丢、B 倾向重
- [ ] 能说出 QoS 2 的成本，以及 AWS IoT Core 不支持 QoS 2
- [ ] 能为电表各类消息选择 QoS

---

参考：[AWS IoT · MQTT](https://docs.amazonaws.cn/en_us/iot/latest/developerguide/mqtt.md)、[EMQX · Introduction to MQTT QoS](https://www.emqx.com/en/blog/introduction-to-mqtt-qos)、[OASIS MQTT TC 邮件列表 · QoS 2 接收方两种方法](https://lists-archive.oasis-open.org/archives/mqtt/201607/msg00084.html)
