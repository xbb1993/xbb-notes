# 持久化、内存管理与背压

> 专题 28 · 模块六 · ★ 核心必会 · 中等深度
> 版本基线：Mosquitto 2.0.18（云端实测）；上游 2.1 的 SQLite 持久化插件引自官方文档，未实测；EMQX 相关为概念描述，未实测
> 贯穿场景：svc 用持久会话订阅 `em/#`；meter3 持续上报；broker 可能崩溃、内存可能吃紧、svc 可能变慢

**对应全景图的哪一块**：专题 26 流水线第 ⑤ 步"入队"背后的存储——存哪、满了怎么办、下游慢了怎么办。

## 1. 核心概念

### 1.1 三个问题

| 问题 | 机制 |
|---|---|
| broker 崩溃重启后，队列里的东西还在吗？ | 持久化：把内存状态写到磁盘 |
| 大量会话堆消息，内存撑不住？ | 内存管理：设上限、选丢弃策略 |
| 订阅者处理慢，消息越积越多？ | 背压：下游慢时压力往哪传 |

> 类比：broker 是中转仓库。持久化 = 着火后账本还在不在；内存管理 = 仓库满了先扔哪批货；背压 = 收货方签收慢时要不要让发货方停一停。

### 1.2 持久化：存什么

| 状态 | 丢了的后果 | 专题 |
|---|---|---|
| 持久会话（Client ID、订阅、过期时间） | 重连后订阅没了，收不到下行命令 | 12 |
| 离线队列中的 QoS 1/2 消息 | 离线期间的命令丢失 | 12 |
| inflight 状态 | QoS 1 不重发、QoS 2 状态机断裂 | 10、11 |
| 保留消息 | 新订阅者拿不到最后状态 | 14 |
| 在线 QoS 0 消息流 | 本就不保证，不存 | 10 |

### 1.3 两种写盘思路（对照 Redis）

| | 快照 | 增量 / 日志 |
|---|---|---|
| 做法 | 定期把整个内存状态写成一个文件 | 变化即追加，或小批量写 |
| Redis 对应 | RDB | AOF |
| Mosquitto 对应 | 内置 `persistence true` → `mosquitto.db` | 2.1 起的 SQLite 持久化插件 |
| 崩溃最多丢 | 一个快照间隔 | 一个刷盘批次（插件默认 5 秒） |
| 代价 | 遍历全部状态，单线程 broker 写快照时卡事件循环 | 持续磁盘 IO |

官方资料（已核实）：`persistence` 默认 false；`autosave_interval` 默认 1800 秒；官方现推荐插件持久化；SQLite 插件 2.1 起提供，"在变化发生时保存"，`plugin_opt_flush_period` 默认 5 秒，`plugin_opt_sync` 默认 normal。

### 1.4 关键结论：PUBACK ≠ 落盘

```
时间轴 ─────────────────────────────────────────────→
        p1..p5      [快照写盘]     p6 p7 p8      💥kill -9
        PUBACK ✓       ↑           PUBACK ✓ ✓ ✓
                    这之前活下来     这一段全丢（实验 A4）
```

QoS 1 的"至少一次"保证的是每一跳的传递，不保证 broker 进程崩溃不丢。端到端不丢 = broker 落盘足够频繁 + 设备侧保留与补传（专题 41）。

### 1.5 内存管理

```
broker 内存 ≈ 连接数 × 每连接开销（专题 26）
           + 主题树节点数 × 每节点开销（专题 27）
           + Σ 各会话队列 × 消息大小   ← 最易失控
           + 保留消息总量
```

Mosquitto 的闸（官方默认值）：

| 参数 | 作用 | 默认 |
|---|---|---|
| `max_inflight_messages` | 每客户端在途 QoS 1/2 条数 | 20 |
| `max_inflight_bytes` | 在途字节 | 0（不限） |
| `max_queued_messages` | 在途之外每客户端排队条数 | 1000 |
| `max_queued_bytes` | 排队字节 | 0（不限） |
| `queue_qos0_messages` | 持久会话离线时是否排队 QoS 0 | false |
| `memory_limit` | 全局堆内存上限 | 不限 |

两层防线：会话队列上限防"一个慢客户端拖垮全局"；全局上限是最后的保险丝（撞上后踢客户端自保，实验 C）。

丢弃策略：

| 策略 | 谁吃亏 | 例子 |
|---|---|---|
| 丢最新 | 最新数据 | Mosquitto 队列满（专题 12） |
| 丢最旧 | 最旧数据，保住最新状态 | 部分 broker 可配，需查文档 |
| 断开客户端 | 该客户端 | Mosquitto 撞 memory_limit；EMQX 有按单连接限制强制关闭的机制（未核实） |
| 阻塞发布方 | 发布方 | RabbitMQ 内存告警；MQTT broker 一般不这么做 |

业务取舍：遥测宁丢旧保新；命令不能静默丢，靠回执确认（专题 39）。

### 1.6 背压

```
发布者 ──→ broker ──[会话队列]──→ 内核发送缓冲 ══TCP══→ 内核接收缓冲 ──→ 慢消费者
                       ③满了丢弃     ②写不进去                ①不读，缓冲满
```

压力在 broker 截断，**不传给发布者**，发布者照样拿到 PUBACK 0。

| 维度 | 传给发布者（阻塞） | 在 broker 截断（丢弃） |
|---|---|---|
| 隔离性 | ✗ 一个慢消费者拖慢所有人 | ✓ 只影响自己 |
| 设备体验 | ✗ 小内存设备被阻塞撑不住 | ✓ 照常上报 |
| 可靠性 | ✓ 不丢 | ✗ 静默丢 |
| 代表 | RabbitMQ 内存告警、Kafka 落盘拉取 | MQTT broker |

"消息通道"而非"消息池"：后端需要慢消费不丢时，应桥接进 Kafka 等消息池（专题 42）。

## 2. 易混淆 / 易错点

| 错误理解 | 正确理解 |
|---|---|
| PUBACK = 已落盘 | 只是内存收下；内置持久化下崩溃仍丢 |
| persistence true 就万无一失 | 默认 30 分钟一次快照 |
| 正常停机也会丢 | SIGTERM 会先写快照（A3）；kill -9 才丢 |
| 写快照越频繁越好 | 单线程 broker 写快照会卡事件循环 |
| 消费慢时 broker 让发布者等 | 在 broker 截断，表现为丢弃，发布者无感 |
| QoS 1 订阅者一定收到每一条 | 队列满一样丢，日志有 dropped |
| 内存不够 broker 会崩 | 配了 memory_limit 会踢客户端自保 |
| 撞内存上限时客户端会收到原因码 | 只是被断开，PUBACK 里看不出 |
| 队列上限越大越安全 | 内存风险更大，重连后积压集中推送 |
| 在线 QoS 0 不受队列上限约束 | 2.0.18 实测也受 max_queued_messages 约束（文档原文只写 QoS 1/2） |

## 3. 与其他章节的关联

| 本篇内容 | 相关专题 |
|---|---|
| QoS 两跳、PUBACK 语义 | 10、11（回顾） |
| 会话队列、丢最新 | 12（回顾） |
| 保留消息持久化 | 14（回顾） |
| Receive Maximum 节流 | 17（回顾） |
| 单线程事件循环被写快照阻塞 | 26（回顾） |
| 主题树内存 | 27（回顾） |
| 集群中会话与消息的复制 | 31 |
| 指令回执、可靠下发 | 39 |
| 断网补传、端到端不丢 | 41 |
| 桥接到 Kafka / 数据库 | 42 |
| 丢弃计数、队列深度监控 | 46 |
| 会话积压类故障 | 47 |

## 4. 诊断实践

### 4.1 实验（云端真实输出，Mosquitto 2.0.18）

**A 持久化 vs 崩溃**（`persistence true`、`autosave_interval 10`；svc 持久会话离线；发 5 条 QoS 1 + 1 条保留）：

```
== A1 kill -9，写快照前崩溃
  svc 重连收到: 0 条排队消息 []
  保留消息: []
  mosquitto.db: 不存在 字节
== A2 kill -9，等 12 秒（已过 autosave）后崩溃
  svc 重连收到: 5 条排队消息 [p1 p2 p3 p4 p5 ]
  保留消息: [online]
  mosquitto.db: 945 字节
== A3 SIGTERM 正常停止（立即）
  svc 重连收到: 5 条排队消息 [p1 p2 p3 p4 p5 ]
  保留消息: [online]
  mosquitto.db: 945 字节
```

A4：快照后再发 p6–p8，都拿到 PUBACK，随即 kill -9：

```
Client auto-08F5... received PUBACK (Mid: 1, RC:0)
Client auto-AF99... received PUBACK (Mid: 1, RC:0)
Client auto-282D... received PUBACK (Mid: 1, RC:0)
== A4 快照后又发 3 条（都拿到 PUBACK），随即 kill -9
  svc 重连收到: p1 p2 p3 p4 p5
```

**B 慢消费者**（svc 在线订阅后 6 秒不读 socket；期间发 20000 条 1 KB）：

```
max_queued=1000 QoS1: 收到 1040 条；broker 内存 4560 kB；drop 日志 1
max_queued=1000 QoS0: 收到 4766 条；broker 内存 4268 kB；drop 日志 1
max_queued=100  QoS1: 收到 140 条；broker 内存 3360 kB；drop 日志 1
max_queued=100  QoS0: 收到 3866 条；broker 内存 3228 kB；drop 日志 1
broker 日志：Outgoing messages are being dropped for client slow.
```

- QoS 1 ≈ 队列上限 + 少量在途。
- QoS 0 多出约 3700 条：已写进内核 TCP 缓冲（本机回环下有数 MB）。
- 两种 QoS 都随 max_queued 变化，差值正好 900。
- broker 内存始终 3–5 MB，发布方不受影响。

**C 全局内存上限**（`max_queued_messages 0`、`memory_limit 20000000`；svc 离线；持续发 1 KB QoS 1）：

```
PUBACK 原因码统计: {'0x00': 15301, '异常:broker 断开连接': 1}
broker 内存 23448 kB；进程仍在: 是
1792387082: Client pub disconnected due to out of memory.
svc 上线后收到条数: 15302
```

### 4.2 脚本（本地复现：Linux + Mosquitto + Python 3，无第三方库）

实验 A：

```bash
cat > p.conf <<'EOF'
listener 1883
allow_anonymous true
persistence true
persistence_location /tmp/t28/data/
autosave_interval 10
EOF
mosquitto -c p.conf -d
mosquitto_sub -V 5 -c -i svc -q 1 -x 3600 -t 'em/#' -E
for i in 1 2 3 4 5; do mosquitto_pub -V 5 -q 1 -t em/meter3/up -m "p$i"; done
mosquitto_pub -V 5 -q 1 -r -t em/meter3/status -m online
sleep 1; pkill -9 -x mosquitto          # 改 sleep 12 或 pkill -15 对比
mosquitto -c p.conf -d
timeout 2 mosquitto_sub -V 5 -c -i svc -q 1 -x 3600 -t 'em/#' -F '%t=%p' > got.txt; cat got.txt
```

`slow.py`（实验 B 慢消费者，参数：QoS、装死秒数）：

```python
# 慢消费者：订阅后先"装死"不读 socket，N 秒后开始读并回 PUBACK，统计实际收到多少条
import socket, struct, sys, time
def s(x): x=x.encode(); return struct.pack(">H",len(x))+x
qos=int(sys.argv[1]); dead=float(sys.argv[2])
sk=socket.create_connection(("127.0.0.1",1883))
body=s("MQTT")+bytes([5,0x02])+struct.pack(">H",600)+b"\x00"+s("slow"); sk.sendall(b"\x10"+bytes([len(body)])+body); sk.recv(16)
sb=struct.pack(">H",1)+b"\x00"+s("em/#")+bytes([qos]); sk.sendall(b"\x82"+bytes([len(sb)])+sb); sk.recv(16)
print("订阅完成，开始装死", flush=True); time.sleep(dead)
buf=b""; n=0; sk.settimeout(2); end=time.time()+10
while time.time()<end:
    try: d=sk.recv(1<<16)
    except socket.timeout: break
    if not d: break
    buf+=d
    while len(buf)>=2:
        mul,ln,i=1,0,1
        while True:
            b=buf[i]; ln+=(b&127)*mul; mul*=128; i+=1
            if b<128: break
        if len(buf)<i+ln: break
        h=buf[0]; pkt=buf[i:i+ln]; buf=buf[i+ln:]
        if h>>4==3:
            n+=1
            if (h>>1)&3==1:
                tl=struct.unpack(">H",pkt[:2])[0]; pid=pkt[2+tl:4+tl]
                sk.sendall(b"\x40\x02"+pid)
print("慢消费者最终收到", n, "条 PUBLISH，剩余未解析字节", len(buf))
```

`pubq.py`（实验 B 发布方，参数：条数、QoS）：

```python
# 发布 N 条带 1KB 载荷的消息，QoS 由参数决定；QoS1 时后台吃掉 PUBACK
import socket, struct, sys, threading
def s(x): x=x.encode(); return struct.pack(">H",len(x))+x
def rl(n):
    o=b""
    while True:
        b=n%128; n//=128; o+=bytes([b|0x80 if n else b])
        if not n: return o
N=int(sys.argv[1]); qos=int(sys.argv[2])
sk=socket.create_connection(("127.0.0.1",1883))
body=s("MQTT")+bytes([5,0x02])+struct.pack(">H",600)+b"\x00"+s("pub"); sk.sendall(b"\x10"+bytes([len(body)])+body); sk.recv(16)
threading.Thread(target=lambda: [sk.recv(1<<16) for _ in iter(int,1)], daemon=True).start()
pay=b"x"*1024
for i in range(N):
    vh=s("em/m3/up")+(struct.pack(">H",i%65535+1) if qos else b"")+b"\x00"
    b=vh+pay; sk.sendall(bytes([0x30|(qos<<1)])+rl(len(b))+b)
print("发布完成", N)
```

`pubq2.py`（实验 C，统计 PUBACK 原因码）：

```python
# QoS1 逐条发布并统计 PUBACK 原因码（5.0）
import socket, struct, sys, collections
def s(x): x=x.encode(); return struct.pack(">H",len(x))+x
def rl(n):
    o=b""
    while True:
        b=n%128; n//=128; o+=bytes([b|0x80 if n else b])
        if not n: return o
N=int(sys.argv[1]); sk=socket.create_connection(("127.0.0.1",1883)); sk.settimeout(3)
body=s("MQTT")+bytes([5,0x02])+struct.pack(">H",600)+b"\x00"+s("pub"); sk.sendall(b"\x10"+bytes([len(body)])+body); sk.recv(64)
rc=collections.Counter(); pay=b"x"*1024; buf=b""
try:
  for i in range(N):
    vh=s("em/m3/up")+struct.pack(">H",i%65535+1)+b"\x00"; b=vh+pay; sk.sendall(b"\x32"+rl(len(b))+b)
    while len(buf)<4:
        d=sk.recv(4096)
        if not d: raise EOFError("broker 断开连接")
        buf+=d
    h,l=buf[0],buf[1]
    if h>>4!=4: rc[f"非PUBACK报文 0x{h:02x}"]+=1; buf=buf[2+l:]; continue
    code=buf[4] if l>=3 else 0; rc[f"0x{code:02x}"]+=1; buf=buf[2+l:]
except Exception as e: rc[f"异常:{e}"]+=1
print("PUBACK 原因码统计:", dict(rc))
```

实验 C 配置：

```
listener 1883
allow_anonymous true
max_queued_messages 0
memory_limit 20000000
```

### 4.3 现象 → 怀疑 → 观察点

| 现象 | 优先怀疑 | 观察点 |
|---|---|---|
| 重启后设备收不到下行命令 | 未开持久化，或快照间隔内的会话丢失 | `persistence`、`autosave_interval`；db 文件修改时间；停机方式 |
| PUBACK 全成功，后端缺数据 | 慢消费者队列满被丢弃 | 日志 "Outgoing messages are being dropped"；`$SYS` 丢弃计数 |
| 客户端无规律断开、broker 没崩 | 撞 memory_limit | 日志 "disconnected due to out of memory"；RSS 曲线 |
| 内存缓慢上涨 | 离线持久会话越积越多、过期时间过长 | 会话数、队列深度 |
| 批量重连后 CPU、带宽尖峰 | 积压队列集中推送 | 重连速率 × 队列深度 |
| 写快照时设备集体心跳超时 | 大快照阻塞事件循环 | 超时时间点与快照对齐；db 大小 |

## 5. 复习 checklist

- [ ] 能列出 broker 需要持久化的状态，以及在线 QoS 0 为什么不存
- [ ] 能用 RDB / AOF 类比 Mosquitto 内置持久化与 SQLite 插件，说出默认值
- [ ] 能用实验 A4 说明"PUBACK ≠ 落盘"
- [ ] 能区分 kill -9 与 SIGTERM 对持久化的影响
- [ ] 能写出 broker 内存估算式，指出最易失控的一项
- [ ] 能说出 Mosquitto 六个限制参数及默认值，两层防线的作用
- [ ] 能比较四种丢弃策略，并按遥测与命令做取舍
- [ ] 能画出背压链路，解释为什么 MQTT 在 broker 截断而不阻塞发布者
- [ ] 能读懂实验 B、C 的数字

---

参考：[Mosquitto · mosquitto.conf](https://mosquitto.org/man/mosquitto-conf-5.html)、[Mosquitto · SQLite persistence](https://mosquitto.org/documentation/persistence/sqlite/)、[Eclipse Mosquitto 2.1 Release Review](https://projects.eclipse.org/projects/iot.mosquitto/releases/2.1/review)
