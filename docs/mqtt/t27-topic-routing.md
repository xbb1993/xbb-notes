# 订阅路由：主题树与匹配算法

> 专题 27 · 模块六 · ★ 核心必会 · 中等深度
> 版本基线：Mosquitto 2.0.18（云端实测）；EMQX 内部结构引自早期设计文档，未在本环境实测
> 贯穿场景：10 万块电表，约 10 万条订阅；meter3 发布 `em/meter3/up/telemetry/power`

**对应全景图的哪一块**：专题 26 流水线的第 ④ 步"路由"——一条消息进来，找出所有匹配的订阅。

## 1. 核心概念

### 1.1 先厘清三个对象

| 对象 | 谁定义 | 是否预先存在 | broker 存不存 |
|---|---|---|---|
| 主题（topic name） | 发布者在 PUBLISH 里写 | 否，发布时才出现 | 不存（保留消息例外，专题 14） |
| 主题过滤器（topic filter） | 订阅者在 SUBSCRIBE 里写，可带通配符 | 订阅时出现 | 存，挂在主题树上 |
| 订阅者列表 | broker 维护 | — | 挂在过滤器结尾的节点上 |

- 没有"创建主题"这个操作；能否发布/订阅由 ACL 决定（专题 24）。
- 订阅一个没人发布的主题完全合法，只是收不到。

### 1.2 问题：逐条比对扛不住

```
for 每个过滤器 f in 10万条:
    if match(f, 主题): 加入结果
```

每秒 2 万条消息 × 10 万条过滤器 = 每秒 20 亿次比对。

| 方案 | 精确订阅 | 通配订阅 | 局限 |
|---|---|---|---|
| 逐条比对 | O(N) | O(N) | 订阅越多越慢 |
| 哈希表（按 key 直接查） | O(1) | ✗ 查不到 | 通配符不是具体 key |
| 哈希 + 通配逐条 | O(1) | O(通配数) | 通配一多又退化 |

### 1.3 主题树（Topic Trie）

> 类比：快递分拣中心，按"省 → 市 → 区"逐层分拣；`+` 是"本层任意地址都走我"的出口，`#` 是"从这层往下全归我"的出口。

**Trie**（前缀树）：按 `/` 把**过滤器**切层，共同前缀共用路径。

```
                       (根)
                        │
                       em ──────────────── #  ← [em/#]
                        │
          ┌─────────────┼──────────────────┐
       meter3        meter4 ...            +
          │                                │
     ┌────┴────┐                          up
   down        up ← [em/meter3/up]         │
     │      ┌──┴───┐                   telemetry
    cmd     #   telemetry                  │
 [meter3] [m3/up/#]  │                     +  ← [em/+/up/telemetry/+]
                   power ← [svc-a]
```

三处常见误解：

| 错误理解 | 正确理解 |
|---|---|
| 树里存的是主题 | 存的是**过滤器**；发布的主题只是来"走树"的钥匙，走完就丢 |
| 订阅必须是完整路径 | 可以带 `+`、`#` |
| 订阅者只挂在叶子 | 挂在"某个过滤器结尾"的节点上，可以是中间节点（如上图 `up`） |

### 1.4 匹配算法：每层最多三个分支

到每个节点：

1. 有 `#` 子节点 → 收下它的订阅者
2. 有同名子节点 → 往下走
3. 有 `+` 子节点 → 也往下走

主题层级走完时，收下当前节点的订阅者。

```
em/meter3/up/telemetry/power
层1 em：    收 [em/#]；走 meter3；走 +
层2 meter3→up            │ + → up
层3 up：    收 [m3/up/#]；走 telemetry │ up → telemetry
层4 telemetry → power    │ telemetry → +
层5 收 power 的订阅者      │ 收 [em/+/up/telemetry/+]
```

耗时 ≈ **主题层数 × 每层通配分支数**，与订阅总数基本无关；其余 99,999 块表的分支一次都不进。

### 1.5 匹配规则（实测验证）

切层后逐层对齐：普通层必须完全相同；`+` 匹配恰好一层；`#` 匹配本层及以下零到多层。

| 主题 ↓ ／ 过滤器 → | `em/#` | `em/+` | `em/meter3/up/#` | `em/+/up/telemetry/+` | `+/meter3/#` | `#` | `em/meter3/up` | `/em/#` | `Em/#` |
|---|---|---|---|---|---|---|---|---|---|
| `em` | ✅ | ✗ | ✗ | ✗ | ✗ | ✅ | ✗ | ✗ | ✗ |
| `em/meter3` | ✅ | ✅ | ✗ | ✗ | ✅ | ✅ | ✗ | ✗ | ✗ |
| `em/meter3/up` | ✅ | ✗ | ✅ | ✗ | ✅ | ✅ | ✅ | ✗ | ✗ |
| `em/meter3/up/telemetry/power` | ✅ | ✗ | ✅ | ✅ | ✅ | ✅ | ✗ | ✗ | ✗ |
| `em/meter3/up/telemetry/power/extra` | ✅ | ✗ | ✅ | ✗ | ✅ | ✅ | ✗ | ✗ | ✗ |
| `/em/meter3` | ✗ | ✗ | ✗ | ✗ | ✗ | ✅ | ✗ | ✅ | ✗ |
| `em//up/telemetry/x` | ✅ | ✗ | ✗ | ✅ | ✗ | ✅ | ✗ | ✗ | ✗ |
| `$SYS/test` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

| # | 规则 | 例子 |
|---|---|---|
| 1 | `+` 恰好一层 | `em/+` 不匹配 `em`，也不匹配 `em/meter3/up` |
| 2 | `#` 匹配零到多层，含父级本身 | `em/#` 匹配 `em` |
| 3 | 无通配即精确，层数须相同 | `em/meter3/up` 不收子级 |
| 4 | 区分大小写 | `Em/#` ≠ `em/#` |
| 5 | 空层也是一层 | 开头 `/` 和中间 `//` 都产生空层，`+` 能匹配空层 |
| 6 | `$` 开头的主题不被首层 `#`/`+` 匹配 | 要收 `$SYS` 须订阅 `$SYS/#` |
| 7 | 通配符须独占一层，`#` 只能在末尾 | `em/me+`、`em/#/up`、`em#` 非法 |
| 8 | 通配符只用于订阅 | 发布到 `em/+/up` 是协议错误 |

主题设计推论：不以 `/` 开头、无空层、统一小写。

**重叠订阅**：同一客户端订阅 `em/#` 与 `em/meter3/up/#`，Mosquitto 实测**投递 2 份**。协议允许合并或分别投递（未逐字核实规范原文）；建议避免重叠，或业务层去重，5.0 可用订阅标识符区分（专题 20）。

**共享订阅** `$share/g/em/#`：树里按 `em/#` 存，节点上记组 g，命中后从组里挑一个成员（专题 19）。

### 1.6 推送，不是拉取

```
svc ── CONNECT（svc 主动建 TCP）──→ broker
svc ── SUBSCRIBE em/# ───────────→ broker
          ……svc 什么都不用做……
svc ←────────── PUBLISH ────────── broker（沿 svc 建的连接主动推）
```

- MQTT 只有推送，没有拉取动作；离线时先入会话队列，重连后再推（专题 12）。
- 推送有节流：Receive Maximum（未确认上限）、Maximum Packet Size、TCP 背压。订阅者控速靠"慢回 ACK、慢读 socket"。

| | MQTT | Kafka | RabbitMQ |
|---|---|---|---|
| 模式 | 只推送 | 消费者拉取（poll） | 主要推送 + prefetch，也可 basic.get 拉 |
| 控速 | Receive Maximum | 消费者自定节奏 | prefetch |
| 设计取向 | 消息通道：低延迟、省电、不轮询 | 消息池：批量、可回放 | 兼顾 |

### 1.7 局限：匹配快 ≠ 投递快

| 情况 | 后果 |
|---|---|
| 大扇出：1 万个后端订阅 `em/#` | 匹配仍是微秒级，但第 ⑤ 步要复制进 1 万个队列 |
| 大量多层 `+` 过滤器 | 每层 `+` 分支都要走，分支相乘，最坏接近遍历 |
| 订阅高频增删 | 树不停插删，占用（单线程）事件循环 |
| 集群 | 还要知道哪个节点有订阅者（专题 31/32） |

EMQX（早期设计文档）：通配过滤器存主题树 emqx_trie；路由表 emqx_route 记"主题 → 集群中哪些节点有订阅"；目标节点再用本地订阅表分发。官方文档提醒避免大量客户端使用通配订阅。

## 2. 易混淆 / 易错点

| 错误理解 | 正确理解 |
|---|---|
| 主题需要预先创建 | 发布时才出现，broker 不存（保留消息除外） |
| 主题树存主题 | 存过滤器，主题只是来走树 |
| 订阅者只挂在叶子 | 挂在过滤器结尾节点，可在中间 |
| 订阅越多每条消息越慢 | 主题树下与订阅数基本无关 |
| 通配订阅一定慢 | 慢的是大扇出和多层 `+` 分支 |
| 订阅内存 ∝ 订阅者数 | ∝ 不同路径的节点数 |
| `em/#` 不包含 `em` | 包含 |
| `#` 能收到所有消息 | 收不到 `$` 开头的 |
| `em/+` 能收 `em/a/b` | `+` 只一层 |
| 订阅者去 broker 拉消息 | broker 推送 |
| 路由快 broker 就能扛 | 扇出复制、入队、写 socket 常是真瓶颈 |

## 3. 与其他章节的关联

| 本篇内容 | 相关专题 |
|---|---|
| 主题层级与通配符 | 8（回顾） |
| 推送与 Receive Maximum | 10、17（回顾） |
| 离线入队、重连推送 | 12（回顾） |
| 保留消息按主题存 | 14（回顾） |
| 共享订阅在树中的表示 | 19（回顾） |
| 订阅时接受、投递时按权限过滤 | 24（回顾） |
| 流水线第 ④ 步、单线程事件循环 | 26（回顾） |
| 订阅标识符区分重叠订阅 | 20 |
| 集群路由表 | 31、32 |
| 订阅数、扇出监控 | 46 |

## 4. 诊断实践

### 4.1 实验（云端真实输出）

**A 主题树 vs 逐条比对**（Python，两种算法结果先断言一致再计时）：

```
订阅数    1003: 逐条比对     679.4 µs/条  主题树   2.76 µs/条  快    246 倍  每条命中 2.4 个
订阅数   10003: 逐条比对    5823.4 µs/条  主题树   2.43 µs/条  快   2398 倍  每条命中 2.4 个
订阅数  100003: 逐条比对   55639.8 µs/条  主题树   2.80 µs/条  快  19866 倍  每条命中 2.4 个
```

逐条比对随订阅数线性增长；主题树基本不变。绝对值是 Python 的，看趋势。

**B Mosquitto 2.0.18 加 10 万条不相关订阅后的吞吐与内存**（1 发 1 收，QoS 0，5 秒，复用专题 26 的 blast/sink）：

```
--- 额外订阅数 0,      broker 内存 VmRSS:    2972 kB
发送 1168000 条, sink 收到 1168000 条
--- 额外订阅数 100000, broker 内存 VmRSS:  174876 kB
发送 1240000 条, sink 收到 1240000 条
```

内存：基线 3.0 MB → 1 万订阅 20.4 MB → 10 万订阅 174.9 MB（约 1.7 KB/条）。每条 `em/meterK/down/cmd` 新建 3 个节点。吞吐不受影响，内存随节点数增长。

**C 匹配规则**：9 个过滤器 × 8 个主题，结果即 1.5 节的表；非法过滤器 mosquitto_sub 直接报 `Invalid subscription topic`。

### 4.2 脚本

`bench.py`：

```python
import random, time
random.seed(1)

def match_linear(filt, topic):
    f = filt.split('/'); t = topic.split('/')
    for i, p in enumerate(f):
        if p == '#': return True
        if i >= len(t): return False
        if p != '+' and p != t[i]: return False
    return len(f) == len(t)

class Node:
    __slots__ = ('kids', 'subs')
    def __init__(self): self.kids = {}; self.subs = []

def insert(root, filt, sub):
    n = root
    for p in filt.split('/'):
        n = n.kids.setdefault(p, Node())
    n.subs.append(sub)

def match_trie(root, topic):
    levels = topic.split('/'); out = []
    def walk(n, i):
        if '#' in n.kids: out.extend(n.kids['#'].subs)
        if i == len(levels): out.extend(n.subs); return
        c = n.kids.get(levels[i])
        if c: walk(c, i + 1)
        c = n.kids.get('+')
        if c: walk(c, i + 1)
    walk(root, 0); return out

def build(N):
    filters = []
    for k in range(N):
        m = f"meter{k}"
        r = random.random()
        if r < 0.6:   filters.append(f"em/{m}/down/cmd")            # 设备订阅自己的下行
        elif r < 0.9: filters.append(f"em/{m}/up/telemetry/power")  # 精确订阅
        else:         filters.append(f"em/{m}/up/#")                 # 带 # 通配
    filters += ["em/+/up/telemetry/+", "em/#", "$SYS/#"]            # 后端少量通配订阅
    return filters

for N in [1_000, 10_000, 100_000]:
    fs = build(N)
    root = Node()
    for i, f in enumerate(fs): insert(root, f, i)
    topics = [f"em/meter{random.randrange(N)}/up/telemetry/power" for _ in range(200)]
    t0 = time.perf_counter()
    a = [sorted(i for i, f in enumerate(fs) if match_linear(f, t)) for t in topics]
    lin = (time.perf_counter() - t0) / len(topics)
    t0 = time.perf_counter()
    for _ in range(50):
        b = [sorted(match_trie(root, t)) for t in topics]
    tri = (time.perf_counter() - t0) / len(topics) / 50
    assert a == b
    print(f"订阅数 {len(fs):>7}: 逐条比对 {lin*1e6:>9.1f} µs/条  主题树 {tri*1e6:6.2f} µs/条  "
          f"快 {lin/tri:>6.0f} 倍  每条命中 {sum(map(len,a))/len(a):.1f} 个")
```

`manysub.py`（一个连接订阅 N 个不同过滤器）：

```python
# 一个连接订阅 N 个不同的精确过滤器 em/meterK/down/cmd，然后保持在线
import socket, struct, sys, time
def s(x): x=x.encode(); return struct.pack(">H",len(x))+x
def rl(n):
    o=b""
    while True:
        b=n%128; n//=128
        o+=bytes([b|0x80 if n else b])
        if not n: return o
N=int(sys.argv[1]); sk=socket.create_connection(("127.0.0.1",1883))
body=s("MQTT")+bytes([5,0x02])+struct.pack(">H",600)+b"\x00"+s("manysub"); sk.sendall(b"\x10"+bytes([len(body)])+body); sk.recv(16)
pid=1; sent=0
while sent<N:
    payload=b"".join(s(f"em/meter{k}/down/cmd")+b"\x00" for k in range(sent,min(N,sent+500)))
    vh=struct.pack(">H",pid)+b"\x00"; b=vh+payload
    sk.sendall(b"\x82"+rl(len(b))+b); sent=min(N,sent+500); pid+=1
sk.settimeout(5); got=0
try:
    while got<pid-1:
        d=sk.recv(1<<20); got+=d.count(b"\x90")  # 粗略统计 SUBACK
except Exception: pass
print("subscribed",N, flush=True); time.sleep(float(sys.argv[2]))
```

规则实验（本地复现）：

```bash
for f in 'em/#' 'em/+' 'em/meter3/up/#' 'em/+/up/telemetry/+' '+/meter3/#' '#' 'em/meter3/up' '/em/#' 'Em/#'; do
  mosquitto_sub -V 5 -t "$f" -F "[$f] <- %t" & done
sleep 1
for t in em em/meter3 em/meter3/up em/meter3/up/telemetry/power /em/meter3 'em//up/telemetry/x' '$SYS/test'; do
  mosquitto_pub -V 5 -t "$t" -m x; done
```

### 4.3 现象 → 怀疑 → 观察点

| 现象 | 优先怀疑 | 观察点 |
|---|---|---|
| 订阅了却收不到 | 大小写、开头 `/`、空层、`+` 层数不对、`$` 主题 | 对照 8 条规则；用 `#` 订阅抓真实主题名 |
| 同一消息收到多份 | 重叠订阅 | 订阅列表；订阅标识符 |
| 订阅数暴涨后内存猛涨 | 每设备独立路径，节点爆炸 | 内存 ÷ 订阅数；`$SYS` 订阅计数 |
| 某类消息一来 CPU 飙 | 大扇出 | 每个过滤器的订阅者数 |
| 批量上下线时整体卡顿 | 订阅树频繁增删 | 连接/断开速率与 CPU 相关性 |

## 5. 复习 checklist

- [ ] 能区分主题、过滤器、订阅者列表，说出谁定义、broker 存不存
- [ ] 能算出逐条比对的代价，说明哈希表为什么不够
- [ ] 能画出场景的主题树，说明订阅者可挂在中间节点
- [ ] 能用"每层三个分支"手工走一遍匹配
- [ ] 能背出 8 条匹配规则，尤其 `#` 含父级、`$` 规则、空层、大小写
- [ ] 能说出重叠订阅在 Mosquitto 的实测行为
- [ ] 能说明 MQTT 是推送，以及推送的三道节流阀，并与 Kafka 对比
- [ ] 能说出"匹配快 ≠ 投递快"的四种情况
- [ ] 能复述实验 A、B 的结论

---

参考：[EMQX 早期设计文档](https://ee-doc-en.readthedocs.io/zh/latest/design.html)、[EMQX · Wildcard Subscription](https://docs.emqx.com/en/emqx/latest/messaging/mqtt-wildcard-subscription.md)、[EMQX Trie improvements (2021)](https://assets.emqx.com/resources/2021-05-13-trie-improvements.pdf)
