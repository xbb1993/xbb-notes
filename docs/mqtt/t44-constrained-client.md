# 受限设备上的 MQTT 客户端

> 专题 44 · 模块十 · ☆ 高频重点 · 第二遍
> 云端实测：Mosquitto 2.0.18 + Python ssl，统计一次"连接→发一条→断开"的线路字节数（不含 TCP/IP 包头）
> 官方资料（已核实）：coreMQTT 代码体积与设计、Mbed TLS 缓冲区默认值；真实芯片上的 RAM 占用未测

**这一章解决什么**：一块电表上，MQTT 程序装不装得下、跑不跑得动、费不费流量、费不费电？它决定方案里要不要上 TLS、用什么证书、长连接还是短连接。

## 1. 核心概念

### 1.1 电表里是谁在跑 MQTT

- **主控芯片（MCU，微控制器）**：电表的"大脑"，计量、显示、存储、业务程序。RAM 常见几十到几百 KB，Flash 几百 KB 到几 MB，看型号。
- **通信模组**：4G、NB-IoT 模组或以太网芯片，负责上网。

联网程序分层：业务程序 → MQTT 客户端库 → TLS 库（可选，最占资源）→ TCP/IP 协议栈 → 模组/网卡。

**做法 A：主控芯片跑全部**

```
┌──────────── 主控芯片 ────────────┐       ┌──── 通信模组 ────┐
│ 业务程序                         │       │                 │
│ MQTT 客户端库                     │       │  只负责收发       │
│ TLS 库                           │ ───→  │  原始数据         │
│ TCP/IP 协议栈                     │       │                 │
└─────────────────────────────────┘       └─────────────────┘
```

好处：完全自己掌控（5.0、重连策略、缓存）。代价：内存和计算压力全在主控芯片，TLS 最重。

**做法 B：通信模组内置 MQTT 和 TLS**

```
┌──────── 主控芯片 ────────┐         ┌──────────── 通信模组 ────────────┐
│ 业务程序                  │  AT 指令  │ MQTT 客户端（模组厂写好的）       │
│ （发指令：连接、发布、订阅）  │ ──────→  │ TLS                             │
│                          │ ←──────  │ TCP/IP                          │
└─────────────────────────┘  回调通知  └─────────────────────────────────┘
```

**AT 指令**：主控芯片通过串口给模组发一行行文本命令（连接、发布、订阅）。好处：主控几乎不用额外资源、开发快。代价：能力取决于模组厂实现——是否支持 5.0、重连能否加随机等待（47 现场 C）、证书怎么灌、本地缓存多大，都要逐项向模组厂确认。

对方案：先弄清电表是 A 还是 B；若是 B，专题 50 的"电表侧 12 条规范"要逐条核对模组手册。

### 1.2 第一本账：程序空间与内存

**MQTT 库很小**（coreMQTT，官方文档已核实）：ARM Cortex-M 上代码约 6.9 KB（-Os）到 8.5 KB（-O1）；不动态申请内存，收发缓冲区由应用提供；文档写明遵循 MQTT 3.1.1，要 5.0 功能需确认所选库版本。缓冲区给多大，就只能处理多大的报文。

**TLS 才是大头**：TLS 按"记录"分段加密，协议允许一段最大 16 KB，所以要能装下 16 KB 的接收缓冲区。Mbed TLS（API 文档已核实）：
- 接收缓冲区默认 16 KB；小于它时，客户端应配合**最大分片长度扩展（MFL）**，可选 512/1024/2048/4096 字节，且服务器要支持。
- 发送缓冲区可调小省内存，太小则握手失败（最小值取决于加密方式和证书大小）。

光收发缓冲区就十几到三十几 KB，再加握手校验证书的临时内存，对只有几十 KB RAM 的主控芯片往往装不下——这是很多电表选做法 B 的原因。具体占用需用实际芯片和库实测，列入方案"待验证事项"。

### 1.3 第二本账：流量

实验（4.1）：一次"连接 → 发 1 条遥测 → 断开"：
- 明文仅 **131 字节**——MQTT 本身很省。
- TLS 为 **1422–2451 字节**，是明文 10–19 倍，几乎全是握手（交换密钥、发证书）。
- **ECDSA 证书更省**：完整握手比 RSA-2048 少约 580 字节（证书 1115 vs 579 字节，加签名差），差别主要在下行。受限设备通常优选 ECDSA。
- **会话恢复省得有限**：跳过发证书，省 400–1100 字节；但上行反而变多（475 → 770），因为要带回服务器给的会话凭证（session ticket）。
- **TLS 1.3 实验中字节略多**：握手后服务器主动发会话凭证。它的优势是往返次数少，不是字节少。

局限：未计 TCP/IP 包头（每包约 40 字节）；只有一张自签名证书，真实证书链每多一张中间证书约多 1 KB；双向 TLS 时电表还要上传自己的证书；只测了一种实现。

结论：**TLS 流量成本集中在建连接那一刻，所以电表要长连接。**每分钟一次"连-发-断"：每天 1440 次 × 约 2 KB ≈ 2.8 MB/天 ≈ 84 MB/月，而专题 50 估算的长连接遥测每月约 7 MB，差十倍以上。长连接的代价是心跳（7、47 现场 B）。

### 1.4 第三本账：电量

市电供电通常不是问题；电池供电才需要算。无线模块"醒着"最费电，发送更费。

| 方式 | 特点 | 适合 |
|---|---|---|
| 长连接 + 心跳 | 定期醒来发心跳，不能深睡 | 市电；需随时收命令 |
| 定时醒来、连上、发完、断开、深睡 | 最省电；每次重新握手、流量大 | 电池；上报间隔长；不需实时收命令 |

第二种要配合：持久会话（12，睡着时命令在 broker 排队）、会话恢复（减握手流量）、设备影子（39，状态不依赖实时在线）。NB-IoT 的省电模式与长连接、心跳的配合取决于网络和模组，未核实，用到需单独研究。

### 1.5 用 MQTT 5.0 保护电表（CONNECT 属性，17）

| 属性 | 作用 | 对电表 |
|---|---|---|
| Maximum Packet Size | 超过此大小的报文别发给我 | 与 MQTT 库缓冲区对齐 |
| Receive Maximum | 同时最多几条未确认的 QoS 1/2 | 限制要同时记住的消息数，省内存 |
| Topic Alias Maximum | 最多几个主题别名 | 短数字代替长主题名，省流量（18） |

3.1.1 没有这些属性，只能靠 broker 全局设置和业务约定。

## 2. 易混淆 / 易错点

| 错误理解 | 正确理解 |
|---|---|
| MQTT 库很占资源 | 库本身很小（coreMQTT 约 7–8.5 KB 代码）；大头是 TLS |
| TLS 只是多点计算 | 收发缓冲区默认十几到三十几 KB，小芯片可能装不下 |
| TLS 缓冲区随便调小 | 接收 < 16 KB 要配合 MFL 且服务器支持；发送太小握手失败 |
| TLS 流量和数据量成正比 | 主要在建连接时（实测每次 1.4–2.5 KB），所以要长连接 |
| 每次上报连一次最省事 | 每分钟一次，光握手一个月约 84 MB |
| 会话恢复能把开销降到很小 | 实测只省 400–1100 字节，上行反而变多 |
| TLS 1.3 一定更省流量 | 省的是往返次数，字节实验中略多 |
| 模组内置 MQTT 什么都不用管 | 重连、5.0、缓存都受模组限制，要逐项核对 |

## 3. 与其他章节的关联

| 本篇内容 | 相关专题 |
|---|---|
| 报文开销小 | 1、5（回顾） |
| 心跳、长连接维持 | 7、47（回顾） |
| 持久会话 | 12（回顾） |
| CONNECT 属性 | 17（回顾） |
| TLS、证书、双向 TLS | 22、25（回顾） |
| 每连接 TLS 内存（broker 侧） | 32（回顾） |
| 影子 | 39（回顾） |
| 重连策略与模组限制 | 43、47 现场 C（回顾） |
| 方案中的设备能力判断 | 50（回顾） |
| Topic Alias | 18 |
| 网关替电表跑 MQTT | 40 |

## 4. 诊断实践

### 4.1 实验（云端真实输出）

设置：Mosquitto 同时开明文 1883、RSA-2048 证书 TLS 8883、ECDSA P-256 证书 TLS 8884；客户端与 broker 之间放计数代理；每次"CONNECT → CONNACK → 发 1 条 QoS 1 遥测 → PUBACK → DISCONNECT"。

```
明文 MQTT                         ：合计   131 字节（上行 115，下行 16）
RSA-2048 证书 TLS1.2 完整握手      ：合计  2002 字节（上行 475，下行 1527）
RSA-2048 证书 TLS1.2 会话恢复      ：合计  1016 字节（上行 770，下行 246），确实复用=True
RSA-2048 证书 TLS1.3 完整握手      ：合计  2451 字节（上行 504，下行 1947）
RSA-2048 证书 TLS1.3 会话恢复      ：合计  1387 字节（上行 791，下行 596），确实复用=True
ECDSA P-256 证书 TLS1.2 完整握手      ：合计  1422 字节（上行 475，下行 947）
ECDSA P-256 证书 TLS1.2 会话恢复      ：合计  1016 字节（上行 770，下行 246），确实复用=True
ECDSA P-256 证书 TLS1.3 完整握手      ：合计  1871 字节（上行 504，下行 1367）
ECDSA P-256 证书 TLS1.3 会话恢复      ：合计  1371 字节（上行 791，下行 580），确实复用=True
```

broker 配置：

```
listener 1883
allow_anonymous true
listener 8883
certfile /tmp/t44/rsa.crt
keyfile /tmp/t44/rsa.key
allow_anonymous true
listener 8884
certfile /tmp/t44/ec.crt
keyfile /tmp/t44/ec.key
allow_anonymous true
```

证书：

```bash
openssl req -x509 -newkey rsa:2048 -nodes -keyout rsa.key -out rsa.crt -days 30 -subj "/CN=localhost"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout ec.key -out ec.crt -days 30 -subj "/CN=localhost"
```

`tlsbytes.py`：

```python
# 一块电表"连上 → 发 1 条遥测 → 断开"一次，线路上一共走了多少字节？
# 在客户端和 broker 之间放一个计数代理，分别统计明文 / TLS（RSA、ECDSA 证书，TLS1.2 / 1.3，完整握手 / 会话恢复）
import socket, ssl, struct, threading, time
def s(x): x=x.encode(); return struct.pack(">H",len(x))+x
def connect_pkt(): b=s("MQTT")+bytes([5,2])+struct.pack(">H",60)+b"\x00"+s("AE12345678"); return b"\x10"+bytes([len(b)])+b
def pub_pkt():
    vh=s("em/v1/t01/AE12345678/up/telemetry")+struct.pack(">H",1)+b"\x00"; pl=b'{"seq":1,"ts":1760000000,"kwh":1234.56,"p":1.23}'
    b=vh+pl; return b"\x32"+bytes([len(b)])+b
DISC=b"\xe0\x00"
count={"up":0,"down":0}
def proxy(lport, rport):
    ls=socket.socket(); ls.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); ls.bind(("127.0.0.1",lport)); ls.listen(5)
    while True:
        c,_=ls.accept(); r=socket.create_connection(("127.0.0.1",rport))
        def pipe(a,b,k):
            try:
                while True:
                    d=a.recv(65536)
                    if not d: break
                    count[k]+=len(d); b.sendall(d)
            except Exception: pass
            finally:
                try: b.shutdown(socket.SHUT_WR)
                except Exception: pass
        threading.Thread(target=pipe,args=(c,r,"up"),daemon=True).start()
        threading.Thread(target=pipe,args=(r,c,"down"),daemon=True).start()
for lp,rp in ((11883,1883),(18883,8883),(18884,8884)): threading.Thread(target=proxy,args=(lp,rp),daemon=True).start()
time.sleep(0.3)
def recv_n(sk,n):
    b=b""
    while len(b)<n: b+=sk.recv(n-len(b))
    return b
def session(port, ctx=None, sess=None):
    count["up"]=count["down"]=0
    raw=socket.create_connection(("127.0.0.1",port))
    sk=ctx.wrap_socket(raw, server_hostname="localhost", session=sess) if ctx else raw
    sk.sendall(connect_pkt()); h=recv_n(sk,2); recv_n(sk,h[1])          # CONNACK
    sk.sendall(pub_pkt()); recv_n(sk,2); recv_n(sk,2)                    # PUBACK（3.1.1 风格 4 字节；5.0 成功时也是 4 字节）
    time.sleep(0.2)
    reused = getattr(sk,"session_reused",None); out_sess=getattr(sk,"session",None)
    sk.sendall(DISC); time.sleep(0.2); sk.close(); time.sleep(0.3)
    return count["up"]+count["down"], count["up"], count["down"], reused, out_sess
tot,u,d,_,_=session(11883)
print(f"明文 MQTT                         ：合计 {tot:>5} 字节（上行 {u}，下行 {d}）")
for name,port,cert in (("RSA-2048 证书",18883,"rsa.crt"),("ECDSA P-256 证书",18884,"ec.crt")):
    for ver in (ssl.TLSVersion.TLSv1_2, ssl.TLSVersion.TLSv1_3):
        ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT); ctx.load_verify_locations(cert); ctx.check_hostname=False
        ctx.minimum_version=ctx.maximum_version=ver
        tot,u,d,_,sess=session(port,ctx)
        vn="TLS1.2" if ver==ssl.TLSVersion.TLSv1_2 else "TLS1.3"
        print(f"{name} {vn} 完整握手      ：合计 {tot:>5} 字节（上行 {u}，下行 {d}）")
        if sess is not None:
            tot2,u2,d2,re,_=session(port,ctx,sess)
            print(f"{name} {vn} 会话恢复      ：合计 {tot2:>5} 字节（上行 {u2}，下行 {d2}），确实复用={re}")
```

### 4.2 现象 → 怀疑 → 观察点

| 现象 | 优先怀疑 | 观察点 |
|---|---|---|
| 电表 4G 流量远超估算 | 频繁重连，每次完整 TLS 握手 | 设备重连次数 × 每次握手字节 |
| 电表连接时偶发失败或重启 | TLS 握手内存不足 | 握手阶段 RAM 峰值；证书大小、加密方式 |
| 电表收到大消息后异常 | 报文超过 MQTT 库缓冲区 | Maximum Packet Size 是否设置；broker 下发大小 |
| 模组重连策略改不了 | 做法 B，受模组实现限制 | 模组手册；是否需主控补逻辑 |
| 电池设备续航不达标 | 长连接心跳阻止深睡 | 改定时连接 + 持久会话 + 会话恢复 |

## 5. 复习 checklist

- [ ] 能说出电表里两块芯片、联网程序五层，以及做法 A/B 的取舍
- [ ] 能说出 coreMQTT 的代码体积、不动态申请内存的含义
- [ ] 能解释 TLS 为什么需要 16 KB 接收缓冲区、怎么压缩及前提
- [ ] 能复述实验：明文 vs TLS、RSA vs ECDSA、完整 vs 恢复、1.2 vs 1.3
- [ ] 能算出"每分钟连一次"的月流量，说明为什么要长连接
- [ ] 能说出电池设备的连接方式及配套机制
- [ ] 能说出三个保护电表的 5.0 CONNECT 属性

---

参考：[AWS · coreMQTT library](https://docs.aws.amazon.com/freertos/latest/userguide/coremqtt.md)、[Mbed TLS · ssl.h API](https://mbed-tls.readthedocs.io/projects/api/en/v3.6.2/api/file/ssl_8h/)
