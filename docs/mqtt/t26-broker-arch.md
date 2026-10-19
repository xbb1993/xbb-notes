# Broker 架构与并发模型

> 专题 26 · 模块六 · ★ 核心必会 · 中等深度
> 版本基线：Mosquitto 2.0.18（云端实测，上游最新 2.1.2）；EMQX、HiveMQ 只讲模型，不做实测
> 贯穿场景：10 万块电表连同一个 broker，每块每 5 秒上报一次功率

**对应全景图的哪一块**：前面 25 个专题讲的都是"协议规定 broker 要做什么"；本篇讲"broker 内部怎么把这些事同时做给几十万条连接"。

## 1. 核心概念

### 1.1 问题：连接多、消息小、大多数时间在发呆

10 万块电表、每 5 秒一条：

```
连接数      100,000      ← 大
消息速率    20,000 条/秒  ← 中
单条大小    ~40 字节      ← 小
单连接活跃度 每 5 秒醒一次 ← 绝大多数时间空闲
```

所以 broker 的核心矛盾不是"算得快"，而是 **"同时挂着大量几乎不说话的连接，还要有人说话时立刻响应"**。

> 类比：一个前台要同时盯着 10 万部电话，每部电话 5 秒响一下、说一句话就挂起。

### 1.2 一条消息在 broker 内部的流水线

```
 电表 meter3                                         订阅者 svc
     │                                                   ▲
     ▼                                                   │
 ① 接收  socket 可读 → 读进缓冲区                     ⑥ 发送  写 socket
     │                                                   ▲
 ② 解码  按表格视图拆出 PUBLISH 各栏（专题 5）            │
     │                                                   │
 ③ 校验/鉴权  报文合法？有权发这个主题？（专题 24）       │
     │                                                   │
 ④ 路由  在主题树里找出所有匹配的订阅（专题 27）          │
     │                                                   │
 ⑤ 入队  放进每个匹配会话的投递队列（专题 12）────────────┘
          （QoS 1/2 还要记 inflight，持久化时写盘，专题 28）
```

每一步都是 CPU 活，但都很短；真正的"等待"只发生在 ① 和 ⑥（等网络）。

### 1.3 朴素方案：一个连接一个线程

```
连接1 ── 线程1 ── read() 阻塞等数据
连接2 ── 线程2 ── read() 阻塞等数据
...
连接10万 ── 线程10万
```

| 维度 | 问题 |
|---|---|
| 内存 | 每线程栈通常预留 MB 级虚拟空间（实际占用几十 KB 起），10 万线程压力大 |
| CPU | 线程切换（上下文切换）开销随线程数上升 |
| 共享状态 | 路由表、会话表要加锁，锁竞争严重 |

结论：**"阻塞等待"必须从"线程"里拿出来**，交给操作系统统一盯。

### 1.4 三种主流并发模型

**术语**：
- **epoll**（Linux）/ kqueue（BSD/macOS）：操作系统提供的"批量盯 socket"机制，一次调用告诉你"这几千个连接里哪几个有数据了"。
- **事件循环（event loop）**：一个线程反复执行"问 epoll 谁就绪了 → 逐个处理 → 再问"。

#### 模型 A：单线程事件循环（Mosquitto）

```
          ┌────────────── 唯一的主线程 ──────────────┐
          │  loop:                                   │
 10万连接 ─┤    就绪列表 = epoll_wait()               │
          │    for 每个就绪连接: ①②③④⑤⑥            │
          └──────────────────────────────────────────┘
```

- 优点：无锁、实现简单、内存极省、行为确定，单核效率很高。
- 局限：**只能用满一个核**；任何一步慢（大扇出、慢插件、同步写盘）都会卡住所有连接。
- 适用：边缘网关、中小规模（万到十万级连接）、资源受限设备。

#### 模型 B：Erlang 轻量进程（EMQX）

**术语**：Erlang/BEAM 是一种为电信系统设计的语言与虚拟机；它的"进程"不是操作系统进程，而是虚拟机里几百字节起步的轻量执行单元，由虚拟机按核数调度。

```
 BEAM 虚拟机（每个 CPU 核一个调度器）
   ├─ 连接进程 meter1 ─┐
   ├─ 连接进程 meter2 ─┼─ 消息传递（不共享内存）─→ 会话/路由
   ├─ ... 10 万个      ─┘
   └─ 调度器在多核上抢占式轮转
```

- 优点：写法像"一连接一线程"，但成本极低；天然多核；一个连接进程崩溃不影响别人；为集群设计。
- 局限：单条消息的绝对开销比 C 实现高；调优要懂 BEAM；5.9.0 起许可证为 BSL（需核对商用条款）。
- 适用：大规模、多核、集群部署。

#### 模型 C：线程池 + 多个事件循环（HiveMQ 等 JVM 实现）

```
 少量 I/O 线程（每核 1 个事件循环，常基于 Netty）
     │ 解码后的报文
     ▼
 工作线程池（鉴权、路由、持久化）
```

- 优点：多核，I/O 与业务逻辑分离，Java 生态插件多。
- 局限：共享状态需并发数据结构；JVM 内存与 GC（垃圾回收）停顿要调优。

#### 对比

| 维度 | 单线程事件循环 | Erlang 轻量进程 | 线程池+事件循环 |
|---|---|---|---|
| 代表 | Mosquitto | EMQX | HiveMQ |
| 多核 | ✗ 单核 | ✓ | ✓ |
| 每连接内存 | 最低（实测 ~0.8 KB 空闲） | 较低（KB 级） | 中等 |
| 实现复杂度 | 低 | 中（靠虚拟机） | 高（锁/并发结构） |
| 慢操作影响 | 卡住全部连接 | 只卡该进程 | 卡一个工作线程 |
| 集群 | 无（桥接） | 原生 | 原生（商业版） |

> 纠正直觉：**"单线程 = 慢"是错的**。在单核内，没有锁和切换的单线程往往比多线程更快；它的问题是"上限 = 一个核"，以及"一处慢，处处慢"。

### 1.5 每条连接到底花多少钱

| 成本项 | 说明 | 由谁决定 |
|---|---|---|
| socket + 内核收发缓冲 | 内核内存，不算进 broker 进程 RSS | 内核参数（tcp_rmem/wmem） |
| 连接/会话结构体 | Client ID、Keep Alive、遗嘱、属性 | broker 实现 |
| 订阅条目 | 每个过滤器挂在主题树上 | 订阅数量（专题 27） |
| 投递队列/inflight | 离线或慢消费时堆积 | 队列上限配置（专题 12） |
| TLS 状态 | 每连接几十 KB 级（会话缓冲、密钥） | 是否开 TLS（专题 22） |
| 文件描述符（fd） | 每连接 1 个 | ulimit / systemd LimitNOFILE |

**fd**：file descriptor，Linux 里每打开一个文件或 socket 就占一个编号；进程有上限，到顶后新连接直接失败。

> 关键结论：空闲连接很便宜，**贵的是"连接 × 订阅 × 堆积 × TLS"的乘积**。容量规划要按这个乘积算，不能只按连接数。

## 2. 易混淆 / 易错点

| 错误理解 | 正确理解 |
|---|---|
| 单线程 broker 一定慢 | 单核内很快；瓶颈在"只用一核"和"一处慢处处慢" |
| 连接数上不去就是 broker 不行 | 先查 fd 上限、内核端口/缓冲、TLS 内存 |
| 每连接内存是固定值 | 取决于订阅数、队列堆积、TLS；空闲 vs 繁忙差几个数量级 |
| broker 进程 RSS 就是全部内存成本 | 内核 socket 缓冲不在 RSS 里 |
| Erlang 进程 = 操作系统进程 | 是虚拟机内轻量单元，几百字节起 |
| 加 CPU 核就能让 Mosquitto 变快 | 单实例只用一核；要扩展需多实例 + 分流或换集群 broker |
| 吞吐测试 = 每秒收到多少条 | 还要看扇出（1 进 N 出）、QoS、持久化，任一项都能把数字砍一个量级 |
| CPU 100% 说明机器满载 | 2 核机器上 Mosquitto 满载只显示约 50% 整机，要看单核 |

## 3. 与其他章节的关联

| 本篇内容 | 相关专题 |
|---|---|
| ② 解码 | 5 报文结构（回顾） |
| Keep Alive 定时器挂在事件循环上 | 7（回顾） |
| ③ 鉴权、慢插件拖垮事件循环 | 23、24（回顾） |
| ⑤ 会话队列与堆积成本 | 12（回顾） |
| TLS 的 CPU 与内存成本 | 22（回顾） |
| ④ 路由：主题树匹配 | 27 |
| ⑤ 持久化写盘对事件循环的影响 | 28 |
| 多实例与集群 | 31、32 |
| 容量规划与压测 | 43、46 |
| 连接风暴、退避重连 | 47 |

## 4. 诊断实践

### 4.1 实验（云端真实输出，Mosquitto 2.0.18，2 核，fd 上限 20000）

配置 `m.conf`：

```
listener 1883
allow_anonymous true
max_keepalive 65535
```

**实验 A：空闲连接的内存与线程数**（`idle.py`，用 asyncio 发原始 CONNECT，读 `/proc/<pid>/status` 的 VmRSS 与 `/proc/<pid>/task` 线程数）

```
  0 条连接：mosquitto 内存 7.1 MB，线程数 1
   1000 条空闲连接：内存 7.9 MB，线程数 1
   3000 条空闲连接：内存 9.4 MB，线程数 1
   6000 条空闲连接：内存 11.6 MB，线程数 1
   9000 条空闲连接：内存 13.9 MB，线程数 1
```

观察：
- 每条空闲连接约 **0.8 KB**（进程内；内核 socket 缓冲另算）。
- 9000 条连接，**线程数始终为 1**，就是单线程事件循环。
- 受云端 fd 上限 20000 限制（测试端和 broker 各占一份），只测到 9000。

**实验 B：单线程吞吐上限**（2 个 `blast.py` 各灌 5 秒 QoS 0 PUBLISH，1 个 `sink.py` 订阅 `em/#`）

```
blast1 发送: 686000 条
blast2 发送: 688000 条
sink  收到: 59082000 字节  ≈ 1,374,000 条（每条转发约 43 字节）
mosquitto CPU: 约 97%（即 1 个核被吃满；2 核机器整机约 50%）
```

观察：
- 约 **27 万条/秒**（QoS 0、1 进 1 出、无持久化、本机回环），这是最理想的上限，不能直接当生产容量。
- CPU 停在一个核满载，另一核闲着——单线程模型的天花板。

脚本（本地复现需 Linux + Mosquitto + Python 3，无第三方库）：

`idle.py`：

```python
import asyncio, struct, sys, os

N=int(sys.argv[1]); PID=sys.argv[2]
def s(x): x=x.encode(); return struct.pack(">H",len(x))+x
def pkt(cid):
    body=s("MQTT")+bytes([5,0x02])+struct.pack(">H",3600)+b"\x00"+s(cid)
    return b"\x10"+bytes([len(body)])+body
def rss():
    for l in open(f"/proc/{PID}/status"):
        if l.startswith("VmRSS"): return int(l.split()[1])
def threads():
    return len(os.listdir(f"/proc/{PID}/task"))
conns=[]
async def one(i):
    r,w=await asyncio.open_connection("127.0.0.1",1883)
    w.write(pkt(f"dev-{i:06d}")); await w.drain(); await r.readexactly(5); conns.append(w)
async def main():
    base=rss(); print(f"  0 条连接：mosquitto 内存 {base/1024:.1f} MB，线程数 {threads()}")
    done=0
    for target in [1000,3000,6000,N]:
        if target<=done: continue
        await asyncio.gather(*[one(i) for i in range(done,target)]); done=target
        await asyncio.sleep(1)
        m=rss(); print(f"  {target:>5} 条空闲连接：内存 {m/1024:.1f} MB（每条约 {(m-base)/target:.1f} KB），线程数 {threads()}")
asyncio.run(main())
```

`blast.py`：

```python
import socket, struct, time, sys
def s(x): x=x.encode(); return struct.pack(">H",len(x))+x
sk=socket.create_connection(("127.0.0.1",1883)); sk.settimeout(2)
body=s("MQTT")+bytes([5,0x02])+struct.pack(">H",60)+b"\x00"+s(sys.argv[1])
sk.sendall(b"\x10"+bytes([len(body)])+body); sk.recv(16)
pb=s("em/meter3/up/telemetry/power")+b"\x00"+b'{"p":12.3}'; pkt=b"\x30"+bytes([len(pb)])+pb
chunk=pkt*2000; end=time.time()+float(sys.argv[2]); n=0
while time.time()<end:
    try: sk.sendall(chunk); n+=2000
    except Exception: break
print(n)
```

`sink.py`：

```python
import socket, struct, time, sys
def s(x): x=x.encode(); return struct.pack(">H",len(x))+x
sk=socket.create_connection(("127.0.0.1",1883)); sk.settimeout(1)
body=s("MQTT")+bytes([5,0x02])+struct.pack(">H",60)+b"\x00"+s("sink")
sk.sendall(b"\x10"+bytes([len(body)])+body); sk.recv(16)
sb=struct.pack(">H",1)+b"\x00"+s("em/#")+b"\x00"; sk.sendall(b"\x82"+bytes([len(sb)])+sb); sk.recv(16)
tot=0; end=time.time()+float(sys.argv[1])
while time.time()<end:
    try: tot+=len(sk.recv(1<<20))
    except Exception: pass
print(tot)
```

运行：

```bash
ulimit -n 20000
mosquitto -c m.conf -d
PID=$(pgrep -nx mosquitto)
python3 idle.py 9000 $PID          # 实验 A（结束后重启 broker）
python3 sink.py 7 > sink.out &
sleep 1
python3 blast.py b1 5 > b1.out & python3 blast.py b2 5 > b2.out &
top -b -n 3 -d 2 -p $PID           # 观察 CPU
wait; cat b1.out b2.out sink.out
```

> 注意：结束进程用 `pkill -x python3` / `pkill -x mosquitto`，不要用 `pkill -f 脚本名`，会误杀当前 shell。

预期（未实测）：EMQX 同样实验下线程数等于调度器数（约等于核数），CPU 可铺满多核，每连接内存更高。

### 4.2 现象 → 怀疑 → 观察点

| 现象 | 优先怀疑 | 观察点 |
|---|---|---|
| 新连接到某个数就连不上 | fd 上限 | broker 日志 "Too many open files"；`cat /proc/<pid>/limits`；`ls /proc/<pid>/fd \| wc -l` |
| 所有客户端同时变慢、心跳超时 | 单线程被某一步卡住（大扇出、慢鉴权插件、同步写盘） | 单核 CPU 是否 100%；`top -H` 看线程；插件耗时 |
| 多核机器 CPU 只到 1/N | 单线程模型天花板 | `top` 按核看（按 1）；考虑多实例或集群 broker |
| 内存随时间持续涨 | 离线队列堆积、慢消费者 | 会话队列长度、`$SYS` 指标（专题 46） |
| 开 TLS 后连接数掉一大截 | TLS 每连接内存与握手 CPU | 对比开关 TLS 的 RSS 与 CPU；握手速率 |
| 压测数字很好、上线不行 | 压测是 QoS 0 / 1 对 1 / 无持久化 / 本机 | 按真实 QoS、扇出、持久化、网络重测 |

## 5. 复习 checklist

- [ ] 能用"10 万电表"说明 broker 的核心矛盾是"连接多、大多空闲"
- [ ] 能画出 ①接收 → ②解码 → ③鉴权 → ④路由 → ⑤入队 → ⑥发送 流水线，并说出各步对应专题
- [ ] 能说明"一连接一线程"为什么不行
- [ ] 能解释 epoll 和事件循环在解决什么问题
- [ ] 能对比三种并发模型的多核、内存、慢操作影响、集群能力
- [ ] 能纠正"单线程一定慢"的直觉
- [ ] 能列出每条连接的成本项，知道"连接 × 订阅 × 堆积 × TLS"
- [ ] 能复述实验 A、B 的数字与结论，并说出它们的局限
- [ ] 遇到"连不上""全体变慢""多核用不满"时知道先看哪里

---

参考：[Mosquitto · mosquitto.conf](https://mosquitto.org/man/mosquitto-conf-5.html)、[EMQX 文档 · 架构](https://docs.emqx.com/en/emqx/latest/)、[HiveMQ · Architecture](https://www.hivemq.com/docs/)（EMQX/HiveMQ 内部模型为概念层描述，未在本环境实测）
