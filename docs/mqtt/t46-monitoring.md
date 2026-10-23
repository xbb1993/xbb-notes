# 监控与指标方法论

> 专题 46 · 模块十一 · ★ 核心必会 · 中等深度
> 云端实测：Mosquitto 2.0.18 的 `$SYS` 指标；EMQX 健康指标与 Prometheus 接口引自官方文档（已核实）
> 贯穿场景：200 块模拟电表 + 一个后端服务，依次制造故障，看指标怎么变

**这一章解决什么**：线上几十上百个数字，该看哪个？哪个变了说明什么？什么时候该叫醒人？三个问题：盯哪几类数、异常说明什么、告警怎么设。

## 1. 核心概念

### 1.1 先数清楚角色

- **被监控对象**：broker，以及前面的负载均衡、后面的入库服务。
- **指标**：对象自己报出的数字（连接数、每分钟丢弃数），告诉你**当前状态和趋势**。
- **日志**：带时间的事件记录（"meter3 心跳超时被断开"）。指标说"出事了"，日志说"是谁、为什么"。
- **拨测**：专门的监控客户端，自己发一条、自己收回来、量耗时，从**用户角度**检查系统。
- **采集与展示**：定期收指标、存储、画图、超阈值告警。常见 Prometheus + Grafana。
- **业务侧数据**：入库服务知道"每块电表最后一条数据多久前到的"，broker 不知道，但对业务最重要。

### 1.2 整体架构

```
                          ┌───────────── 告警（短信 / 电话 / IM）
              ┌───────────┴────────────┐       ┌──────────────┐
              │ 采集与存储（Prometheus）  │──────→│ 看板（Grafana）│
              └──▲──────▲──────▲───────┘       └──────────────┘
     ① broker 指标  ② 拨测结果  ③ 业务指标
                 │      │      │
 电表 ⇄ LB ⇄ ┌───┴──────┴─┐    │
             │   broker    │←── 拨测客户端：定时发一条、收回来、量耗时
             └──────┬──────┘    │
                    ▼           │
               入库服务 ─────────┘  "每块电表最后一条数据多久之前到的"
                    ▼
                  时序库
```

三路数据看到不同侧面：
- **broker 指标**：broker 眼里的自己，不知道业务好不好。
- **拨测**："假用户"的亲身体验；LB 坏了、证书过期，拨测第一个发现。
- **业务指标**：最终结果；broker 和拨测都正常时，一批电表三小时没数据只有它能发现。

### 1.3 盯哪几类数：顺着消息路径找

不从"broker 提供了哪些指标"出发，而从"一条消息从电表到入库，路上会在哪出事"出发：

| 类别 | 回答的问题 | 典型指标 | 异常说明什么 |
|---|---|---|---|
| 1 连接 | 设备连得上吗 | 在线连接数、连接速率、连接失败数 | 断崖下跌 = 一批设备同时断；速率飙高 = 重连风暴（43）；失败激增 = 证书过期、认证服务挂、撞库（23、25） |
| 2 消息流量 | 数据在流动吗 | 每秒收/发条数 | 电表定时上报，收消息应像心跳一样稳；**掉下去比涨上来更该警惕** |
| 3 丢弃 | 有东西被扔吗 | 丢弃消息数 | 队列满、太大、超配额（17、28）；**最早暴露问题的指标**，平时应为 0 |
| 4 积压 | 有东西越堆越多吗 | 存储消息数、离线会话数 | 一直涨迟早撑爆内存（28） |
| 5 资源 | broker 撑得住吗 | 内存、CPU、fd | Mosquitto 单线程，整机 50% 可能一个核已满（26） |
| 6 端到端 | 用起来好不好 | 拨测延迟、数据新鲜度 | 超过 3 个上报周期没数据算"失联" |

### 1.4 告警怎么设

道理：告警是要叫醒人的。太多大家就习惯性忽略，真出事反而没人看。所以**每条告警响了，都必须需要有人处理**。

- **和平时比，不只看绝对值**：用"比 10 分钟前掉了 5%"代替"小于 9 万"。
- **持续一段时间才报**：滤掉抖动。例外：丢弃平时为 0，一出现就值得看。
- **先报症状，再看原因**：拨测失败、数据新鲜度超标、丢弃持续出现，是用户能感受到的，叫**症状告警**。CPU、内存是原因，放看板或低优先级。
- **分级**：

| 级别 | 例子 | 处理 |
|---|---|---|
| 紧急（打电话） | 拨测连续失败；大批电表数据中断；在线数断崖 | 立刻 |
| 重要（发消息） | 丢弃持续出现；存储消息持续涨；认证失败激增 | 当天 |
| 提醒（看板标黄） | CPU、内存接近上限；离线会话缓慢增多 | 规划扩容 |

最小起步清单：
1. 拨测失败或延迟显著高于基线
2. 超过一定比例电表超过 3 个周期没数据
3. 丢弃持续大于 0
4. 在线连接数比 10 分钟前降超过 5%
5. 连接速率远高于平时
6. 存储消息或内存持续上涨超过 1 小时

EMQX 官方"broker 生病最小指标集"思路一致（已核实）：丢弃速率、集群停止节点数、过载拒绝新连接速率、认证失败速率、调度队列长度、集群复制延迟。

### 1.5 不同 broker 怎么拿指标

| | Mosquitto | EMQX |
|---|---|---|
| 方式 | `$SYS` 主题：broker 定期把指标当消息发布，订阅即可 | Prometheus 接口 `/api/v5/prometheus/stats` 等（已核实） |
| 接 Prometheus | 写个小程序订阅 `$SYS` 再转格式 | 直接对接 |
| 注意 | 间隔由 `sys_interval` 控制；`$SYS` 要做权限控制，别让设备订阅 | 6.3 有若干指标改名（加 `_total`、`_seconds`），升级后看板要改 |

Mosquitto 2.0.18 实测 `$SYS/broker/` 下主要有：`clients/connected`、`clients/disconnected`（离线持久会话）、`clients/maximum`、`publish/messages/received|sent|dropped`、`store/messages/count|bytes`、`retained messages/count`、`subscriptions/count`、`heap/current|maximum`、`load/...（1/5/15 分钟平均）`、`uptime`、`version`。没有延迟类指标，所以要靠拨测。

## 2. 易混淆 / 易错点

| 错误理解 | 正确理解 |
|---|---|
| broker 指标正常 = 系统正常 | 还要看拨测和业务指标 |
| 拨测正常 = 没问题 | 拨测只证明 broker 通；某个订阅者出问题时拨测照样正常（实验"后端变慢"） |
| 收消息数正常 = 数据没丢 | 收到不等于发出去，看丢弃 |
| 消息量涨才要警惕 | 定时上报场景，掉下去更危险 |
| 没报错就没事 | 积压是慢性病，只有数字在悄悄涨 |
| 告警越多越安全 | 太多会被忽略；少而准 |
| CPU 高就要半夜叫人 | 原因类指标放看板；症状告警才叫人 |
| 阈值写死就行 | 和平时比、要持续 |
| Mosquitto 有延迟指标 | 没有，用拨测 |

## 3. 与其他章节的关联

| 本篇内容 | 相关专题 |
|---|---|
| 认证失败、撞库 | 23、25（回顾） |
| 单线程 CPU 判读 | 26（回顾） |
| 丢弃、积压、内存 | 28（回顾） |
| 节点停止、复制延迟 | 31（回顾） |
| fd、连接数瓶颈 | 32（回顾） |
| 数据新鲜度、断档 | 41（回顾） |
| 连接速率与重连风暴 | 43（回顾） |
| 看着指标破案 | 47 |
| 压测与容量规划 | 48 |

## 4. 诊断实践

### 4.1 实验（云端真实输出）

设置：Mosquitto `sys_interval 1`、`max_queued_messages 100`（为让问题更快暴露）；200 块模拟电表每秒上报一次（其中 100 块用持久会话）；一个后端订阅全部上报；监控客户端每 2 秒打一行并拨测。依次：正常 → 后端变慢 → 后端恢复 → 100 台掉线 → 给离线表下命令。

```
    2s 正常          在线  202  离线会话    0  收消息/2s     0  发消息/2s     0  丢弃/2s     0  存储消息    53  堆内存KB   550  拨测ms None
    4s 正常          在线  202  离线会话    0  收消息/2s   401  发消息/2s   414  丢弃/2s    27  存储消息    53  堆内存KB   551  拨测ms 0.6
    6s 正常          在线  202  离线会话    0  收消息/2s   401  发消息/2s   418  丢弃/2s    21  存储消息    53  堆内存KB   551  拨测ms 0.8
    8s 正常          在线  202  离线会话    0  收消息/2s   401  发消息/2s   438  丢弃/2s     0  存储消息    53  堆内存KB   551  拨测ms 0.7
   10s 后端变慢        在线  202  离线会话    0  收消息/2s   401  发消息/2s   438  丢弃/2s     0  存储消息    53  堆内存KB   551  拨测ms 0.6
   12s 后端变慢        在线  202  离线会话    0  收消息/2s   401  发消息/2s   281  丢弃/2s    42  存储消息   193  堆内存KB   591  拨测ms 0.6
   14s 后端变慢        在线  202  离线会话    0  收消息/2s   401  发消息/2s    39  丢弃/2s   400  存储消息   193  堆内存KB   591  拨测ms 0.6
   16s 后端变慢        在线  202  离线会话    0  收消息/2s   401  发消息/2s    39  丢弃/2s   400  存储消息   193  堆内存KB   591  拨测ms 0.7
   18s 后端变慢        在线  202  离线会话    0  收消息/2s   401  发消息/2s    39  丢弃/2s   400  存储消息   193  堆内存KB   591  拨测ms 0.6
   20s 后端恢复        在线  202  离线会话    0  收消息/2s   401  发消息/2s    39  丢弃/2s   400  存储消息   193  堆内存KB   591  拨测ms 0.6
   22s 后端恢复        在线  202  离线会话    0  收消息/2s   401  发消息/2s   162  丢弃/2s   400  存储消息    53  堆内存KB   551  拨测ms 0.6
   24s 后端恢复        在线  202  离线会话    0  收消息/2s   401  发消息/2s   437  丢弃/2s     0  存储消息    53  堆内存KB   551  拨测ms 0.6
   26s 100台掉线      在线  202  离线会话    0  收消息/2s   401  发消息/2s   418  丢弃/2s    21  存储消息    53  堆内存KB   551  拨测ms 0.8
   28s 100台掉线      在线  102  离线会话  100  收消息/2s   301  发消息/2s   343  丢弃/2s     0  存储消息    53  堆内存KB   553  拨测ms 0.6
   30s 100台掉线      在线  102  离线会话  100  收消息/2s   201  发消息/2s   237  丢弃/2s     0  存储消息    53  堆内存KB   553  拨测ms 0.9
   32s 给离线表下命令     在线  102  离线会话  100  收消息/2s   201  发消息/2s   238  丢弃/2s     0  存储消息    53  堆内存KB   553  拨测ms 0.6
   34s 给离线表下命令     在线  103  离线会话  100  收消息/2s   301  发消息/2s   246  丢弃/2s     0  存储消息   153  堆内存KB   583  拨测ms 0.6
   36s 给离线表下命令     在线  103  离线会话  100  收消息/2s   701  发消息/2s   242  丢弃/2s     0  存储消息   653  堆内存KB   727  拨测ms 0.5
   38s 给离线表下命令     在线  103  离线会话  100  收消息/2s   701  发消息/2s   242  丢弃/2s     0  存储消息  1153  堆内存KB   872  拨测ms 0.6
   40s 给离线表下命令     在线  103  离线会话  100  收消息/2s   701  发消息/2s   242  丢弃/2s     0  存储消息  1653  堆内存KB  1017  拨测ms 0.6
   42s 给离线表下命令     在线  103  离线会话  100  收消息/2s   601  发消息/2s   242  丢弃/2s     0  存储消息  2053  堆内存KB  1132  拨测ms 0.6
```

（阶段名在切换时刻打上，指标变化晚一行左右体现；在线数含后端、监控、下命令的客户端。）

解读：
- **正常**：收 401、发约 418、丢弃 0、存储 53（`$SYS` 自身的保留消息）、拨测 < 1 ms。这是**基线**，异常都是和它比出来的。开头几行少量丢弃，推测是启动瞬间后端还没跟上（队列仅 100），未进一步验证。
- **后端变慢**：收消息仍 401（电表照发、broker 照收）；发消息 438 → 39；丢弃 0 → 每 2 秒 400（几乎全扔）；存储 53 → 193；**拨测始终正常**。问题在某个订阅者，不在 broker；只看拨测或收消息数都会以为正常，**只有丢弃在报警**。
- **后端恢复**：丢弃归 0、存储回 53，但扔掉的几千条找不回来（28）。
- **100 台掉线**：在线 202 → 102，离线会话 0 → 100，收消息 401 → 201。在线数和收消息数同时同比例下降 = 一批设备整体掉了，而非在线不发。
- **给离线表下命令**：存储每 2 秒涨 500，53 → 2053；堆内存 553 → 1132 KB；其他指标平稳。没有报错，只有积压在涨——慢性病。

### 4.2 脚本（本地：Mosquitto + `pip install paho-mqtt`）

broker 配置：

```
listener 1883
allow_anonymous true
sys_interval 1
max_queued_messages 100
```

`mon.py`：

```python
# 用 $SYS 做最小监控：正常 → 慢消费者 → 设备批量掉线 → 给离线设备下发命令
import asyncio, struct, time, json, threading, paho.mqtt.client as mqtt
V2=mqtt.CallbackAPIVersion.VERSION2
def s(x): x=x.encode(); return struct.pack(">H",len(x))+x
def rl(n):
    o=b""
    while True:
        b=n%128; n//=128; o+=bytes([b|0x80 if n else b])
        if not n: return o
def connect_pkt(cid, clean=True, expiry=0):
    props=b"\x05\x11"+struct.pack(">I",expiry) if expiry else b"\x00"
    b=s("MQTT")+bytes([5,0x02 if clean else 0x00])+struct.pack(">H",600)+props+s(cid); return b"\x10"+rl(len(b))+b
def pub_pkt(topic, payload, qos=1, pid=1):
    vh=s(topic)+(struct.pack(">H",pid) if qos else b"")+b"\x00"; b=vh+payload; return bytes([0x30|(qos<<1)])+rl(len(b))+b
def sub_pkt(f,qos=1): b=struct.pack(">H",1)+b"\x00"+s(f)+bytes([qos]); return b"\x82"+rl(len(b))+b
# ---------- 监控：订阅 $SYS + 拨测 ----------
M={}; lat=[None]
mon=mqtt.Client(V2, client_id="monitor", protocol=mqtt.MQTTv5)
def on_m(c,u,m):
    if m.topic=="probe/echo": lat[0]=(time.time()-float(m.payload))*1000
    else: M[m.topic.replace("$SYS/broker/","")]=m.payload.decode()
mon.on_message=on_m; mon.connect("127.0.0.1",1883); mon.loop_start(); time.sleep(0.3)
mon.subscribe([("$SYS/broker/#",0),("probe/echo",0)])
prev={}; T0=time.time(); phase=["正常"]
def row():
    def d(k):
        v=int(M.get(k,0)); r=v-prev.get(k,v); prev[k]=v; return r
    mon.publish("probe/echo", str(time.time()))          # 拨测：自己发、自己收，量往返时间
    print(f"{time.time()-T0:5.0f}s {phase[0]:<12}在线 {M.get('clients/connected','-'):>4}  离线会话 {M.get('clients/disconnected','-'):>4}  "
          f"收消息/2s {d('publish/messages/received'):>5}  发消息/2s {d('publish/messages/sent'):>5}  丢弃/2s {d('publish/messages/dropped'):>5}  "
          f"存储消息 {M.get('store/messages/count','-'):>5}  堆内存KB {int(M.get('heap/current',0))//1024:>5}  拨测ms {lat[0] and round(lat[0],1)}", flush=True)
# ---------- 被监控的系统 ----------
svc_reading=[True]; dev_writers={}
async def device(i, persistent):
    cid=f"m{i}"
    r,w=await asyncio.open_connection("127.0.0.1",1883); w.write(connect_pkt(cid, clean=not persistent, expiry=3600 if persistent else 0))
    h=await r.readexactly(2); await r.readexactly(h[1])
    w.write(sub_pkt(f"em/{cid}/down/cmd")); await w.drain(); dev_writers[i]=w
    async def drain():
        try:
            while await r.read(65536): pass
        except Exception: pass
    asyncio.create_task(drain())
    pid=1
    while i in dev_writers:
        w.write(pub_pkt(f"em/{cid}/up", b'{"p":12.3}', 1, pid)); pid=pid%60000+1
        await w.drain(); await asyncio.sleep(1)
    w.close()
async def svc():
    r,w=await asyncio.open_connection("127.0.0.1",1883); w.write(connect_pkt("svc")); h=await r.readexactly(2); await r.readexactly(h[1])
    w.write(sub_pkt("em/+/up")); await w.drain()
    buf=b""
    while True:
        if not svc_reading[0]: await asyncio.sleep(0.2); continue
        d=await r.read(65536); buf+=d
        while len(buf)>=2:                                         # 逐个解析并对 QoS1 回 PUBACK
            mul,ln,i=1,0,1
            while True:
                if i>=len(buf): break
                b=buf[i]; ln+=(b&127)*mul; mul*=128; i+=1
                if b<128: break
            if len(buf)<i+ln: break
            hd=buf[0]; pk=buf[i:i+ln]; buf=buf[i+ln:]
            if hd>>4==3 and (hd>>1)&3==1:
                tl=struct.unpack(">H",pk[:2])[0]; w.write(b"\x40\x02"+pk[2+tl:4+tl])
async def main():
    asyncio.create_task(svc())
    for i in range(200): asyncio.create_task(device(i, persistent=(i<100)))
    async def ticker():
        while True: await asyncio.sleep(2); row()
    asyncio.create_task(ticker())
    await asyncio.sleep(10)
    phase[0]="后端变慢"; svc_reading[0]=False; await asyncio.sleep(10)
    phase[0]="后端恢复"; svc_reading[0]=True; await asyncio.sleep(6)
    phase[0]="100台掉线"
    for i in range(100): dev_writers.pop(i)
    await asyncio.sleep(6)
    phase[0]="给离线表下命令"
    r,w=await asyncio.open_connection("127.0.0.1",1883); w.write(connect_pkt("ops")); h=await r.readexactly(2); await r.readexactly(h[1])
    for k in range(20):
        for i in range(100): w.write(pub_pkt(f"em/m{i}/down/cmd", b'{"op":"read"}', 1, (k*100+i)%60000+1))
        await w.drain(); await asyncio.sleep(0.4)
    await asyncio.sleep(4)
asyncio.run(main())
```

只想看 `$SYS` 有哪些指标：`mosquitto_sub -t '$SYS/#' -v`

### 4.3 现象 → 怀疑 → 观察点

| 现象 | 优先怀疑 | 观察点 |
|---|---|---|
| 拨测正常但业务说缺数据 | 某个订阅者慢，消息被丢 | 丢弃数；该订阅者的队列 |
| 收消息数下降、在线数不变 | 设备在线但不发（固件、采集故障） | 数据新鲜度；设备日志 |
| 收消息数和在线数同比例下降 | 一批设备掉线 | 掉线设备的共同点（地区、LB、节点） |
| 存储消息、内存持续上涨无报错 | 离线会话积压 | 离线会话数；会话过期时间 |
| 连接速率突然飙高 | 重连风暴 | 客户端重连策略；broker 重启记录 |
| 认证失败激增 | 证书过期、认证服务故障、撞库 | 失败的用户名/来源 IP 分布 |
| 拨测失败但 broker 指标正常 | LB、证书、DNS | 从外部拨测 vs 内部拨测对比 |

## 5. 复习 checklist

- [ ] 能说出监控的六个角色，画出三路数据的架构
- [ ] 能说明三路数据各自能发现、发现不了什么
- [ ] 能顺着消息路径说出六类指标及其异常含义
- [ ] 能用实验说明为什么"丢弃是最早的信号"、"积压是慢性病"
- [ ] 能说出告警四原则和三个级别
- [ ] 能写出最小起步告警清单
- [ ] 知道 Mosquitto 用 `$SYS`、EMQX 用 Prometheus 接口，Mosquitto 没有延迟指标

---

参考：[EMQX · Broker Health Indicators](https://docs.emqx.com/en/emqx/latest/observability/broker-health-indicators.md)、[EMQX · Integrate with Prometheus](https://docs.emqx.com/en/emqx/latest/observability/prometheus.md)
