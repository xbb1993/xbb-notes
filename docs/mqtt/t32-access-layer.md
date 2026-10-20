# 接入层：负载均衡、TLS 终结、PROXY protocol 与百万连接调优

> 专题 32 · 模块七 · ★ 核心必会 · 中等深度
> 云端实测：Mosquitto 2.0.18 + HAProxy 2.8.16，2 核，fd 上限 20000
> 官方资料（已核实）：Mosquitto 2.1 PROXY protocol 文档、EMQX 性能调优文档
> 贯穿场景：10 万电表 → 负载均衡（LB）→ 多个 broker 节点

**对应全景图的哪一块**：集群（专题 31）前面那一层——连接分给谁、TLS 在哪解密、真实 IP 怎么传、单机连接数卡在哪。

## 1. 核心概念

### 1.1 术语

- **负载均衡（LB）**：后端前面的"总机"，把连接分给后端。
- **L4 / L7**：L4 只看 TCP（IP、端口）；L7 能解析应用协议（如读 CONNECT 里的 Client ID）。
- **HAProxy**：常用开源 L4/L7 负载均衡。

> 类比：大楼前台把访客带去某间办公室——但访客一进去就待几个月不出来。

### 1.2 长连接让"均衡"变难

| | HTTP 短请求 | MQTT 长连接 |
|---|---|---|
| 连接寿命 | 毫秒到秒 | 天到月 |
| LB 分配时机 | 每个请求 | 只在建连时一次 |
| 加机器后 | 新请求立刻分过去 | 老连接不动，新机器空着 |

实测（2.1 节实验 A）：B 宕机后其设备全落到 A；B 恢复后**一台都不回来**，A 扛 2 倍负载。

| 应对 | 作用 | 局限 |
|---|---|---|
| `leastconn` | 新连接优先去少的节点 | 老连接不动 |
| broker 主动断开一部分 | 重新打散 | 控制节奏，否则自造重连风暴（43、47） |
| 5.0 DISCONNECT 0x9C / 0x9D | 协议层让客户端换服务器（17、21） | 需客户端支持 |
| 滚动重启加随机延迟 | 避免同时涌向一台 | 只是减轻 |

**会话粘性**：真集群里非必须（会话可跨节点接管，专题 31），但能省接管开销；按 Client ID 粘性需要 L7 解析 CONNECT（各家支持程度未逐一核实）；按源 IP 粘性在 NAT 后失真。

**健康检查**：TCP 层检查发现不了"进程卡死但端口开着"；更可靠的是 MQTT 层检查或 broker 的 HTTP 健康接口。

### 1.3 TLS 在哪解密

代价（实验 B）：TLS 每连接内存约为明文 21 倍（17.2 KB vs 0.8 KB），握手耗时约 9 倍（同机双方都在加密，仅供参考）。100 万 TLS 连接在 Mosquitto 进程内约 17 GB。

```
① LB 终结：设备 ══TLS══→ LB ──明文──→ broker
② 透传：   设备 ══TLS══════════════════→ broker
③ 重加密： 设备 ══TLS══→ LB ══TLS══→ broker
```

| 维度 | ① LB 终结 | ② 透传 | ③ 重加密 |
|---|---|---|---|
| broker CPU/内存 | 最省 | 全部承担 | 都承担 |
| 证书管理 | 集中在 LB | 分散在 broker | 两套 |
| broker 能否拿到设备证书（mTLS 身份，专题 25） | 否，除非 PROXY v2 转发 | 能 | 否，除非转发 |
| 内网明文 | 是 | 否 | 否 |
| LB 能否做 L7 | 能 | 不能 | 能 |

### 1.4 PROXY protocol

问题（实验 C）：broker 只看到 LB 的地址，按 IP 封禁、限速、审计失效。

**PROXY protocol**：LB 连后端时先发一个"信封"写明原始源 IP/端口；v2 为二进制，可附带 TLS 信息（如证书 CN）。

- **两端都要支持**：HAProxy 发 v2 头给 Mosquitto 2.0.18，被当畸形报文断开（实验 D）。
- Mosquitto **2.1** 起支持：`enable_proxy_protocol 2`（推荐 v2，也支持 v1）；配合 HAProxy `send-proxy-v2-ssl-cn` 与 `use_identity_as_username true`，可在 LB 终结 TLS 的同时把证书身份传给 broker。
- 安全：broker 端口绝不能对外直接暴露，否则连接信息可被轻易伪造；用防火墙只放行 LB。

### 1.5 单机百万连接的瓶颈

| 瓶颈 | 说明 |
|---|---|
| 文件描述符 | 每连接 1 个；进程、系统、systemd 多处上限（实验 E） |
| 内存 | 明文 ~0.8 KB/条，TLS ~17 KB/条（进程内），另有内核缓冲 |
| LB → 后端源端口 | 一个（LB 源 IP → broker IP:端口）组合最多用 `ip_local_port_range` 内的端口数；本环境 32768–60999 ≈ 2.8 万 |
| conntrack | 防火墙连接跟踪表满了新连接被丢 |
| backlog | 重连风暴时 SYN 涌入 |
| 单核 CPU | Mosquitto 单线程，TLS 握手放大（专题 26） |

设备 → LB 的四元组各不相同不受端口限制；LB → broker 这侧源 IP 是 LB 自己。突破：LB 多源 IP、broker 多监听端口、扩大端口范围。

EMQX 调优文档建议值（节选，已核实）：

| 参数 | 建议值 |
|---|---|
| `fs.file-max`、`fs.nr_open`、`ulimit -n`、systemd `LimitNOFILE` | 2097152（四处都改） |
| `net.core.somaxconn` | 32768 |
| `net.ipv4.tcp_max_syn_backlog` | 16384 |
| `net.ipv4.ip_local_port_range` | 1024 65535 |
| `net.nf_conntrack_max` | 1000000 |
| `net.ipv4.tcp_rmem` / `tcp_wmem` | 1024 4096 16777216 |
| 不建议 | `tcp_tw_recycle` / `tcp_tw_reuse`（NAT 下导致重置） |

## 2. 易混淆 / 易错点

| 错误理解 | 正确理解 |
|---|---|
| LB 会自动保持均衡 | 长连接只在建连时分配；节点恢复后负载不回流 |
| leastconn 解决不均衡 | 只影响新连接 |
| LB 终结 TLS 只有好处 | broker 失去证书身份与真实 IP，需 PROXY v2 补；内网明文 |
| 开 PROXY protocol 就行 | 两端都要支持，broker 端口不能外露 |
| 百万连接只要调 ulimit | fd、内存、端口、conntrack、backlog、单核一串瓶颈 |
| 日志写什么就是什么原因 | fd 耗尽时日志写成"被 tcpd 拒绝"（实验 E） |
| TLS 只是多点 CPU | 每连接内存约 21 倍 |
| TCP 健康检查足够 | 卡死但端口开着时检测不到 |

## 3. 与其他章节的关联

| 本篇内容 | 相关专题 |
|---|---|
| CONNACK 变长、按固定长度解析的坑 | 5、17（回顾） |
| 客户端保活发现断线 | 7（回顾） |
| TLS、mTLS 身份、按 IP 防护 | 22、25（回顾） |
| 单线程、每连接内存 | 26（回顾） |
| 会话跨节点接管 | 31（回顾） |
| 服务器重定向 0x9C/0x9D | 21 |
| 重连退避、重连风暴 | 43、47 |
| 连接数监控 | 46 |
| 压测与容量规划 | 48 |

## 4. 诊断实践

### 4.1 实验（云端真实输出）

**A 长连接负载不回流**（200 台模拟电表经 HAProxy roundrobin 连 A/B，断线后 1–3 秒随机退避重连；计数含查询客户端，±1）：

```
t=0  200 台设备 roundrobin：A B = 100 100
B 宕机 20s 后：A B = 201 -
B 恢复 15s 后：A B = 200 0
B 恢复 60s 后：A B = 200 0
```

**B TLS vs 明文**（各 3000 条空闲连接）：

```
明文 3000 条：建连耗时 0.76s，broker 内存 6.0 → 8.3 MB，每条约 0.8 KB
TLS  3000 条：建连耗时 6.98s，broker 内存 6.0 → 56.5 MB，每条约 17.2 KB
```

**C 真实 IP 丢失**（客户端源 127.0.0.9，HAProxy 源 127.0.0.5）：

```
New client connected from 127.0.0.5:57978 as meter3 (p5, c1, k60).
```

**D PROXY v2 发给不支持的 broker**（Mosquitto 2.0.18）：

```
New connection from 127.0.0.5:57440 on port 1883.
Client <unknown> disconnected due to protocol error.
```

**E fd 上限 1024，尝试 1100 条**：

```
Max open files            1024                 1024                 files
尝试 1100 条：成功 1016，失败 {'IncompleteReadError': 84}
     84 ... Client connection from 127.0.0.1 denied access by tcpd.
```

日志具有误导性。推测（未查源码确认）：Ubuntu 包启用了 TCP Wrappers，检查规则时需再打开文件，fd 已耗尽导致检查失败而记为"拒绝"。连接数卡在 1024、4096、65535 附近时先查 fd。

**踩坑记录**：`fleet.py` 最初按固定 5 字节读 CONNACK，而 5.0 CONNACK 带属性、长度不固定；残留字节被当作 PINGRESP，导致后端宕机约 30 秒内"设备"仍以为在线、首轮数据错误。修正为"先读固定头再按剩余长度读"。真实固件中同类 bug：按固定长度解析变长报文。

### 4.2 脚本与配置（本地复现：Linux + Mosquitto + HAProxy + Python 3）

`h.cfg`（HAProxy）：

```
global
  maxconn 5000
defaults
  mode tcp
  timeout connect 3s
  timeout client 1h
  timeout server 1h
frontend mqtt
  bind 127.0.0.1:11883
  default_backend brokers
backend brokers
  balance roundrobin
  server A 127.0.0.1:1883 check inter 1s source 127.0.0.5
  server B 127.0.0.1:1884 check inter 1s source 127.0.0.5
```

后端 broker（1883、1884 各一份）：

```
listener 1883
allow_anonymous true
sys_interval 1
connection_messages true
```

TLS 实验 broker：

```
listener 1883
allow_anonymous true
listener 8883
certfile /tmp/t32/cert.pem
keyfile /tmp/t32/key.pem
allow_anonymous true
max_keepalive 65535
```

证书：`openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 30 -subj "/CN=localhost"`

`fleet.py`（参数：设备数、运行秒数）：

```python
# N 台"电表"经负载均衡保持长连接；断线后 1~3 秒随机退避重连
import asyncio, struct, sys, random
N=int(sys.argv[1]); T=float(sys.argv[2])
def s(x): x=x.encode(); return struct.pack(">H",len(x))+x
def pkt(c): b=s("MQTT")+bytes([5,2])+struct.pack(">H",30)+b"\x00"+s(c); return b"\x10"+bytes([len(b)])+b
async def dev(i):
    while True:
        try:
            r,w=await asyncio.open_connection("127.0.0.1",11883); w.write(pkt(f"meter{i}")); await w.drain()
            h=await r.readexactly(2); await r.readexactly(h[1])   # CONNACK（5.0 带属性，长度不固定）
            while True:
                await asyncio.sleep(10); w.write(b"\xc0\x00"); await w.drain()   # PINGREQ
                await asyncio.wait_for(r.readexactly(2),5)
        except Exception: await asyncio.sleep(random.uniform(1,3))
async def main():
    for i in range(N): asyncio.create_task(dev(i))
    await asyncio.sleep(T)
asyncio.run(main())
```

`hold.py`（参数：连接数、端口 1883/8883、broker PID）：

```python
# 建 N 条空闲 MQTT 连接（可选 TLS），统计 broker 内存与握手耗时
import asyncio, ssl, struct, sys, time
N=int(sys.argv[1]); port=int(sys.argv[2]); PID=sys.argv[3]; tls=port==8883
def s(x): x=x.encode(); return struct.pack(">H",len(x))+x
def pkt(c): b=s("MQTT")+bytes([5,2])+struct.pack(">H",3600)+b"\x00"+s(c); return b"\x10"+bytes([len(b)])+b
ctx=ssl.create_default_context(); ctx.check_hostname=False; ctx.verify_mode=ssl.CERT_NONE
def rss(): return int([l for l in open(f"/proc/{PID}/status") if l.startswith("VmRSS")][0].split()[1])
keep=[]
async def one(i):
    r,w=await asyncio.open_connection("127.0.0.1",port,ssl=ctx if tls else None)
    w.write(pkt(f"d{port}-{i}")); await w.drain(); await r.readexactly(5); keep.append(w)
async def main():
    base=rss(); t=time.time()
    for k in range(0,N,200): await asyncio.gather(*[one(i) for i in range(k,min(N,k+200))])
    dt=time.time()-t; await asyncio.sleep(1); m=rss()
    print(f"{'TLS ' if tls else '明文'} {N} 条：建连耗时 {dt:.2f}s，broker 内存 {base/1024:.1f} → {m/1024:.1f} MB，每条约 {(m-base)/N:.1f} KB")
asyncio.run(main())
```

`many.py`（参数：连接数；broker 用 `prlimit --nofile=1024:1024 mosquitto -c fd.conf -d` 启动）：

```python
import asyncio, struct, sys
N=int(sys.argv[1])
def s(x): x=x.encode(); return struct.pack(">H",len(x))+x
def pkt(c): b=s("MQTT")+bytes([5,2])+struct.pack(">H",3600)+b"\x00"+s(c); return b"\x10"+bytes([len(b)])+b
ok=0; fail={}; keep=[]
async def one(i):
    global ok
    try:
        r,w=await asyncio.open_connection("127.0.0.1",1883); w.write(pkt(f"m{i}")); await w.drain()
        await asyncio.wait_for(r.readexactly(5),3); ok+=1; keep.append(w)
    except Exception as e: k=type(e).__name__; fail[k]=fail.get(k,0)+1
async def main():
    for k in range(0,N,100): await asyncio.gather(*[one(i) for i in range(k,min(N,k+100))])
    print(f"尝试 {N} 条：成功 {ok}，失败 {fail}")
asyncio.run(main())
```

### 4.3 现象 → 怀疑 → 观察点

| 现象 | 优先怀疑 | 观察点 |
|---|---|---|
| 连接数卡在 1016、4090、~2.8 万附近 | fd 上限或 LB 源端口耗尽 | `/proc/<pid>/limits`；LB 日志；`ip_local_port_range` |
| 某节点负载远高于其他 | 重启后长连接未回流 | 各节点连接数曲线对照重启时间 |
| 封一个 IP 掉一大片设备 | broker 看到的是 LB 的 IP | broker 日志来源地址 |
| 开 PROXY 后全连不上，刷 protocol error | broker 不支持或版本不符 | 两端配置与版本 |
| mTLS 改 LB 终结后认证失效 | 证书信息未传到 broker | PROXY v2 是否带 ssl-cn；broker 是否用证书身份做用户名 |
| 重连风暴时大量 SYN 超时 | backlog、conntrack 满 | `netstat -s` 溢出计数；conntrack 计数 |
| TLS 设备一多内存告急 | TLS 每连接开销 | 开关 TLS 对比 RSS |

## 5. 复习 checklist

- [ ] 能用实验 A 解释长连接下 LB 为什么不能自动均衡，说出 4 种应对
- [ ] 能说明会话粘性在真集群里为什么非必须
- [ ] 能比较 TLS 三种部署方式，复述实验 B 的数字
- [ ] 能说明 PROXY protocol 解决什么、两端都要支持、安全前提，以及 Mosquitto 2.1 的配置
- [ ] 能列出百万连接的 6 个瓶颈
- [ ] 能算出 LB → broker 的端口上限并给出突破办法
- [ ] 能说出实验 E 日志的误导之处

---

参考：[Mosquitto · HAProxy / PROXY protocol](https://mosquitto.org/documentation/listeners/haproxy/)、[EMQX · Performance Tuning (Linux)](https://docs.emqx.com/en/emqx/latest/performance/tune.md)
