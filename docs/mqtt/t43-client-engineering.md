# 客户端工程：重连、退避、离线缓冲与幂等

> 专题 43 · 模块十 · ★ 核心必会 · 中等深度
> 云端实测：Mosquitto 2.0.18 + paho-mqtt 2.1.0（源码已读）；MQTT.js 默认值引自官方 README
> 贯穿场景：一万块电表，broker 重启或网络抖动时一起断开

**这一章解决什么**：电表上的程序，在断网又恢复的整个过程里，每一步该做什么。做不好，影响的不只一块电表——一万块电表一起做错，能把平台打垮。

## 1. 核心概念

### 1.1 电表程序里的三层

- **应用层**（自己写）：采样、编号、决定发什么、处理命令。
- **本地持久缓存**（断电不丢）：存"还没确认送达的数据"（专题 41）和"执行过的命令编号"（专题 39）。
- **MQTT 客户端库**（Paho、MQTT.js 等）：连接、心跳、自动重连、按 QoS 重发。**它的队列只在内存里**，断电或重启就没了。

```
 ┌──────────────────── 电表程序 ────────────────────┐
 │  ┌──────────── 应用层（自己写）──────────────┐       │
 │  │ 采样、编号、决定发什么、处理命令            │       │
 │  └──────┬───────────────────────▲───────────┘       │
 │  ┌──────▼──────────────┐        │                   │
 │  │ 本地持久缓存（断电不丢）│        │                   │
 │  │ · 未确认送达的数据     │        │                   │
 │  │ · 执行过的命令编号     │        │                   │
 │  └──────┬──────────────┘        │                   │
 │  ┌──────▼───────────────────────┴───────────┐       │
 │  │       MQTT 客户端库（Paho / MQTT.js）      │       │
 │  │ · 连接、心跳、自动重连                      │       │
 │  │ · 内存里的发送队列（重启就没了）              │       │
 │  └─────────────────────┬────────────────────┘       │
 └────────────────────────┼────────────────────────────┘
                          │ TCP / TLS
                       broker
```

库替你做了一部分事，不是全部。分清哪些库做、哪些自己做，是本章重点。

### 1.2 一次断线到恢复的过程

```
① 正常收发
② 发现断线           ← 怎么发现？
③ 等一会儿           ← 等多久？
④ 重新连接           ← 用什么 Client ID？
⑤ 恢复订阅           ← 会话没了怎么办？
⑥ 补发断线期间的数据   ← 存在哪？会不会重复？
```

### 1.3 第 ② 步：发现断线

broker 主动关闭或进程挂掉，电表立刻知道。麻烦的是**网络中间断了**（基站切换、路由器重启），两边都收不到关闭通知，连接看起来还在——叫**半开连接**。只能靠**心跳**发现（专题 7）：Keep Alive 决定最晚多久发现（60 秒的设置最坏约 90 秒）；太短费电费流量。这一步库会做，设好间隔即可。

### 1.4 第 ③ 步：等多久再重连（最重要）

道理：断线很少是一块电表单独断，常见的是 broker 重启、机房抖动，**一万块电表同一秒一起断**。如果都"断了马上连"：broker 没起来时疯狂白连，耗电耗流量（4G 流量要钱）；broker 一起来，一万个连接同时涌入，每个都要 TLS 握手（专题 32：明文 9 倍）、认证、恢复会话，刚起来的 broker 可能再被压垮，如此循环。叫**重连风暴**。

一步步改进：
- **每失败一次多等一会儿**：0.5、1、2、4、8 秒……设上限。专业上叫**指数退避**。但一万块电表规则相同，会整齐地一波波一起冲——风暴没消失，只是变成一波一波。
- **等待时间加随机数**：在"0 到当前上限"间随机挑，把人群打散。专业上叫**随机抖动**（jitter），完全随机的做法叫 full jitter。

代价要诚实看：实验里 jitter 恢复反而最慢（8 秒 vs 1 秒），因为只有 1000 台、无 TLS、本机 broker，扛得住冲击。真实环境 10 万台 + TLS + 数据库认证，同一瞬间就是数万连接。真正的取舍是：**用"每台慢几秒恢复"换"平台不被压垮"**，规模越大越划算。

常用库默认都不防风暴：

| 库 | 默认重连 | 来源 |
|---|---|---|
| paho-mqtt（Python）2.1.0 | 从 1 秒起每次翻倍，上限 120 秒，**不加随机**（= 实验 expo） | 已读源码核实 |
| MQTT.js | **固定每 1000 毫秒**（= 实验 fixed） | 官方 README 核实 |

上生产要改：关掉库的自动重连自己写 jitter 循环，或至少首次重连前随机等一段。

broker 也会喊停：5.0 CONNACK 0x89（服务器忙）、0x9F（连接太频繁）（专题 17），收到应等更久。MQTT.js README：默认收到 CONNACK 拒绝不自动重连，需设 `reconnectOnConnackError`。

### 1.5 第 ④⑤ 步：身份与订阅

- **Client ID 固定**（专题 6）：每次随机会留下无人认领的旧会话占内存，排队消息永远拿不到。
- **会话没了，订阅跟着没了**：Clean Start、会话过期、broker 重启无持久化（28）、节点宕机（31）都会导致。**库不会替你重新订阅，也不报错。**
- **写法规则：订阅写在"连接成功"回调里**，每次连上都执行，而不是启动时只做一次。

### 1.6 第 ⑥ 步：断线期间的数据

库会存一点但靠不住（paho-mqtt 2.1.0 实测）：断线时 publish 返回"未连接"，但 QoS 1 实际进了内存队列、重连后发出；QoS 0 直接丢；程序重启全丢。其他库不同（MQTT.js README：`queueQoSZero` 默认 true，QoS 0 也排队），换库换版本要重新确认。

所以重要数据**应用层自己存进断电不丢的缓存**，收到 PUBACK 再删（PUBACK 只代表 broker 收到，专题 10、28）。删早可能丢，删晚会重发，重发产生的重复由入库服务按唯一键去掉（专题 41）。

**分工：客户端保证"不少"（宁可重发），服务端保证"不多"（按唯一键去重）。**

别让两层缓存打架：数据先进持久缓存，**只在连接正常时**交给库发送；断线期间不调用 publish，让库队列保持空。

## 2. 易混淆 / 易错点

| 错误理解 | 正确理解 |
|---|---|
| 库会处理好一切 | 库只管连接、心跳、重连、内存重发；持久缓存、重新订阅、幂等要自己做 |
| 断了马上重连恢复最快、最好 | 规模大时造成重连风暴 |
| 指数退避就够了 | 不加随机会一波波同步冲击（实验 expo） |
| 库的默认重连参数可直接上生产 | paho 无随机，MQTT.js 固定 1 秒 |
| jitter 恢复更快 | 单台恢复更慢，换的是平台稳定 |
| Client ID 每次随机也无妨 | 留下孤儿会话，排队消息拿不到 |
| 自动重连后订阅自动恢复 | 会话没了订阅就没了，且不报错 |
| publish 返回失败就是没发 | paho 的 QoS 1 返回"未连接"却在重连后发出 |
| 库的队列能扛断电 | 只在内存，重启即丢 |
| 客户端要保证不重复 | 客户端保证不少，服务端去重保证不多 |

## 3. 与其他章节的关联

| 本篇内容 | 相关专题 |
|---|---|
| Client ID 固定、同 ID 接管 | 6（回顾） |
| 心跳发现半开连接 | 7（回顾） |
| PUBACK 只管一段路 | 10（回顾） |
| 会话与订阅随会话消失 | 12（回顾） |
| 0x89、0x9F 原因码 | 17（回顾） |
| broker 重启丢会话 | 28（回顾） |
| 节点宕机丢会话 | 31（回顾） |
| TLS 握手开销、长连接不回流 | 32（回顾） |
| 命令幂等 | 39（回顾） |
| 本地缓存、补传、服务端去重 | 41（回顾） |
| 受限设备的内存与存储 | 44 |
| 连接数、重连速率监控 | 46 |
| 重连风暴故障 | 47 |

## 4. 诊断实践

### 4.1 实验（云端真实输出）

**A 重连风暴**：1000 台在线，broker 停 5 秒后恢复；fixed = 每 0.2 秒重试，expo = 0.5/1/2/4/8 秒不加随机，jitter = 退避加随机。

```
== fixed
  宕机 5 秒内的连接尝试：23287 次（全部失败）
  恢复后第 1 秒涌入的连接尝试：1047 次；之后每秒：[0, 0, 0, 0, 0, 0, 0]
  broker 恢复后，每秒末在线设备数：[1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000]
  恢复后最挤的 0.1 秒内：713 次连接尝试
  全部 1000 台恢复用时：1 秒（从 broker 恢复算起）
== expo
  宕机 5 秒内的连接尝试：3000 次（全部失败）
  恢复后第 1 秒涌入的连接尝试：0 次；之后每秒：[0, 1000, 0, 0, 0, 0, 0]
  broker 恢复后，每秒末在线设备数：[0, 0, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000]
  恢复后最挤的 0.1 秒内：652 次连接尝试
  全部 1000 台恢复用时：3 秒（从 broker 恢复算起）
== jitter
  宕机 5 秒内的连接尝试：3994 次（全部失败）
  恢复后第 1 秒涌入的连接尝试：273 次；之后每秒：[159, 116, 125, 124, 107, 74, 22]
  broker 恢复后，每秒末在线设备数：[277, 433, 550, 675, 798, 906, 979, 1000, 1000, 1000, 1000, 1000, 1000, 1000]
  恢复后最挤的 0.1 秒内：36 次连接尝试
  全部 1000 台恢复用时：8 秒（从 broker 恢复算起）
```

解读：fixed 宕机期间白连 2.3 万次，恢复瞬间 0.1 秒涌入 713 个；expo 白连次数降到 3000（1000 台 × 3 轮），但 1000 个连接全挤在同一秒，峰值 652，几乎没改善；jitter 峰值 36，是 fixed 的二十分之一，8 秒内匀速爬升。

**B 重连后订阅与库的内存队列**（paho-mqtt 2.1.0；电表断线期间 publish QoS 0 和 QoS 1 各一条）：

```
== 订阅方重连后不重新订阅
  断线期间 publish QoS0：返回码 rc=4（The client is not currently connected.）
  断线期间 publish QoS1：返回码 rc=4（The client is not currently connected.）
  客户端事件：['连上', '断开(Unspecified error)', '连上']
  订阅方事件：['连上(Session Present=False)', '订阅', '连上(Session Present=False)']
  订阅方最终收到：[]
== 订阅方在 on_connect 里重新订阅
  断线期间 publish QoS0：返回码 rc=4（The client is not currently connected.）
  断线期间 publish QoS1：返回码 rc=4（The client is not currently connected.）
  客户端事件：['连上', '断开(Unspecified error)', '连上']
  订阅方事件：['连上(Session Present=False)', '订阅', '连上(Session Present=False)', '订阅']
  订阅方最终收到：['断线期间发的 QoS1']
```

解读：两种写法都"连上"了，第一种没重新订阅，什么都收不到也不报错；第二种在连接回调里订阅，收到了。两次 publish 都返回"未连接"，但 QoS 1 实际被库存在内存、重连后发出，QoS 0 丢了。

### 4.2 脚本（本地：Mosquitto + `pip install paho-mqtt`）

broker 配置 `b.conf`：

```
listener 1883
allow_anonymous true
max_keepalive 65535
```

`storm.py`（参数：fixed / expo / jitter；脚本会自己启停 mosquitto）：

```python
# 重连风暴：1000 台设备在线 → broker 宕机 5 秒 → 恢复；比较三种重连写法
import asyncio, struct, sys, time, random, subprocess, collections
N=1000; DOWN=5; RUN=25; MODE=sys.argv[1]
def s(x): x=x.encode(); return struct.pack(">H",len(x))+x
def pkt(c): b=s("MQTT")+bytes([5,2])+struct.pack(">H",600)+b"\x00"+s(c); return b"\x10"+bytes([len(b)])+b
attempts=[]; ok_at={}; T0=None
def wait_time(fail):                     # fail = 连续失败次数
    if MODE=="fixed":  return 0.2                                   # 立刻（每 0.2 秒）重试
    base=min(8, 0.5*2**fail)                                        # 指数退避：0.5,1,2,4,8,8…
    if MODE=="expo":   return base                                  # 只退避，不加随机
    return random.uniform(0, base)                                  # 退避 + 随机（full jitter）
async def dev(i):
    fail=0
    while True:
        attempts.append(time.time())
        try:
            r,w=await asyncio.open_connection("127.0.0.1",1883); w.write(pkt(f"m{i}")); await w.drain()
            h=await r.readexactly(2); await r.readexactly(h[1]); fail=0
            ok_at[i]=time.time()
            await r.read()                                          # 一直等到连接断开
            ok_at.pop(i,None)
        except Exception: pass
        await asyncio.sleep(wait_time(fail)); fail+=1
async def main():
    global T0
    subprocess.run(["mosquitto","-c","b.conf","-d"]); await asyncio.sleep(0.5)
    for i in range(N): asyncio.create_task(dev(i))
    while len(ok_at)<N: await asyncio.sleep(0.2)
    attempts.clear(); T0=time.time()
    subprocess.run(["pkill","-x","mosquitto"]); await asyncio.sleep(DOWN)
    subprocess.run(["mosquitto","-c","b.conf","-d"])
    timeline=[]
    while time.time()-T0<RUN:
        await asyncio.sleep(1); timeline.append(len(ok_at))
    sec=collections.Counter(int(t-T0) for t in attempts)
    full=next((k+1 for k,v in enumerate(timeline) if v==N), None)
    print(f"== {MODE}")
    print(f"  宕机 {DOWN} 秒内的连接尝试：{sum(v for k,v in sec.items() if k<DOWN)} 次（全部失败）")
    print(f"  恢复后第 1 秒涌入的连接尝试：{sec.get(DOWN,0)} 次；之后每秒：{[sec.get(k,0) for k in range(DOWN+1,DOWN+8)]}")
    print(f"  broker 恢复后，每秒末在线设备数：{timeline[:14]}")
    after=[t-T0-DOWN for t in attempts if t-T0>=DOWN]
    peak=max(collections.Counter(int(x*10) for x in after).values()) if after else 0
    print(f"  恢复后最挤的 0.1 秒内：{peak} 次连接尝试")
    print(f"  全部 {N} 台恢复用时：{'%d 秒（从 broker 恢复算起）'%full if full else '未全部恢复'}")
    subprocess.run(["pkill","-x","mosquitto"])
    import os; os._exit(0)
asyncio.run(main())
```

`libbuf.py`（参数：once / resub）：

```python
# 客户端库自己会不会替你缓存断线期间发布的消息？（paho-mqtt 2.1.0）
import paho.mqtt.client as mqtt, subprocess, time, json
V2=mqtt.CallbackAPIVersion.VERSION2
subprocess.run(["mosquitto","-c","b.conf","-d"]); time.sleep(0.5)
got=[]
sink=mqtt.Client(V2, client_id="sink", protocol=mqtt.MQTTv5); sink.on_message=lambda c,u,m: got.append(m.payload.decode())
RESUB = __import__("sys").argv[1]=="resub"
sub_events=[]
def on_sink_conn(c,u,f,rc,p):
    sub_events.append(f"连上(Session Present={f.session_present})")
    if RESUB or len(sub_events)==1: c.subscribe("em/meter3/up",1); sub_events.append("订阅")
sink.on_connect=on_sink_conn
sink.reconnect_delay_set(min_delay=1, max_delay=4)
sink.connect("127.0.0.1",1883); sink.loop_start(); time.sleep(0.5)
dev=mqtt.Client(V2, client_id="meter3", protocol=mqtt.MQTTv5)
dev.reconnect_delay_set(min_delay=1, max_delay=4)
events=[]; dev.on_connect=lambda c,u,f,rc,p: events.append("连上"); dev.on_disconnect=lambda c,u,f,rc,p: events.append(f"断开({rc})")
dev.connect("127.0.0.1",1883); dev.loop_start(); time.sleep(0.5)
subprocess.run(["pkill","-x","mosquitto"]); time.sleep(1)
for q in (0,1):
    info=dev.publish("em/meter3/up", f"断线期间发的 QoS{q}", qos=q)
    print(f"  断线期间 publish QoS{q}：返回码 rc={info.rc}（{mqtt.error_string(info.rc)}）")
time.sleep(2); subprocess.run(["mosquitto","-c","b.conf","-d"]); time.sleep(6)
print(f"  客户端事件：{events}")
print(f"  订阅方事件：{sub_events}")
print(f"  订阅方最终收到：{got}")
subprocess.run(["pkill","-x","mosquitto"])
```

### 4.3 现象 → 怀疑 → 观察点

| 现象 | 优先怀疑 | 观察点 |
|---|---|---|
| broker 重启后又被压垮、反复宕机 | 重连风暴 | 恢复瞬间的连接速率；客户端重连策略 |
| 恢复后连接数一波一波整齐跳升 | 只退避不随机 | 连接速率曲线是否呈周期尖峰 |
| 断网期间 4G 流量费异常 | 固定间隔狂连 | 设备侧重连次数 |
| 设备在线但收不到下行 | 重连后没重新订阅 | Session Present；订阅是否在连接回调里 |
| broker 会话数持续上涨 | Client ID 随机，孤儿会话 | 会话数 vs 设备数 |
| 设备重启后丢了一批数据 | 只依赖库的内存队列 | 应用层是否有持久缓存 |
| 同一条数据入库两份 | 正常重发 | 入库唯一键（专题 41） |
| 半天才发现设备掉线 | Keep Alive 太长 | 心跳设置 |

## 5. 复习 checklist

- [ ] 能画出电表程序三层，说出库做什么、不做什么
- [ ] 能按 ①–⑥ 讲清断线到恢复的过程
- [ ] 能说明半开连接为什么只能靠心跳发现
- [ ] 能一步步推出"退避 + 随机"，并用实验 A 三组数据解释
- [ ] 能诚实说出 jitter 的代价与取舍
- [ ] 能说出 paho、MQTT.js 默认重连行为及为什么不能直接上生产
- [ ] 能说明为什么订阅要写在连接成功回调里
- [ ] 能用实验 B 说明库的内存队列和返回值为什么靠不住
- [ ] 能说出"客户端保证不少、服务端保证不多"的分工

---

参考：[MQTT.js README](https://github.com/mqttjs/MQTT.js)
