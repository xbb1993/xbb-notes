# 边缘网关与南向协议接入

> 专题 40 · 模块九 · ☆ 高频重点 · 第二遍 · 详细
> 云端实测：自写 Modbus TCP 电表模拟器（3 个站号）+ pymodbus 3.16.1 客户端做网关 + paho-mqtt 2.1.0 + Mosquitto 2.0.18
> 总线速度、轮询周期为常见参数的粗略估算，需实测

**这一章解决什么**：一串电表用 RS-485 连到网关、由网关统一联网时，网关作为"中间人"要做什么，方案里因为多了网关而要改什么。

## 1. 核心概念

### 1.1 角色

- **电表**：只会说 Modbus，只被动应答，从不主动说话。
- **RS-485 总线**：两芯线串起多块表，同一时刻只能一个人说话。
- **网关**：对下是 **Modbus 主站**，挨个问每块表；对上是 **MQTT 客户端**，把读数发给 broker。
- **点表**：网关里的配置，写明每块表哪个位置存什么、怎么换算。
- **broker 与平台**：同专题 50。

面向现场设备的一侧叫**南向**，面向云端的一侧叫**北向**；网关把南向协议（Modbus）翻译成北向协议（MQTT）。

### 1.2 架构

```
 ┌───────────────── 现场 ─────────────────┐
 │  电表 1     电表 2     电表 3   ……  电表 30  │   ← Modbus 从站，只应答
 │  站号 1     站号 2     站号 3          站号 30│
 │  ══╧══════════╧══════════╧═══════════════╧══ │   ← RS-485 总线
 │                     │                       │
 │              ┌──────┴──────┐                │
 │              │    网关      │ 南向：Modbus 主站，按点表轮询
 │              │              │ 中间：换算、打时间、编号、缓存
 │              │              │ 北向：MQTT 客户端
 │              └──────┬──────┘                │
 └─────────────────────┼───────────────────────┘
                       │ 一条 MQTT 连接（代表 30 块表）
                       ▼
                    broker ──→ 入库服务、上下线服务 ……
```

一句话：**MQTT 连接属于网关，数据属于网关后面的每块电表。**后面的变化都由此推出。

### 1.3 南向：Modbus 怎么取数

- 一问一答、挨个来：网关请求"站号 3，从第 0 号读 8 个寄存器"，该表应答，再问下一块。问完一圈叫一个**轮询周期**。
- **站号**：总线上的编号 1–247。**寄存器**：16 位的数据格子。**功能码**：请求类型，03 = 读保持寄存器。

点表（实验用）：

| 字段 | 寄存器 | 类型 | 系数 | 含义 |
|---|---|---|---|---|
| v | 0–1 | 32 位浮点 | 1 | 电压 |
| i | 2–3 | 32 位浮点 | 1 | 电流 |
| p | 4–5 | 32 位浮点 | 1 | 有功功率 kW |
| kwh | 6–7 | 32 位无符号整数 | 0.01 | 正向有功电量 |

点表三大坑：**字序**（32 位数据两个寄存器谁在前，各厂不同）、**系数**（整数存的电量漏乘就差 100 倍）、**地址起点**（说明书"40001"实际请求常是 0）。点表应按型号统一管理、由平台下发。

总线速度（粗估）：9600 bit/s，串口每字节约 10–11 位，约 870–960 字节/秒；读 8 个寄存器请求约 8 字节、应答约 21 字节，加收发切换等待，一块表往返几十毫秒；30 块表一个周期约一到两秒。**一块坏表要等超时，会拖慢整条总线。**

### 1.4 中间：网关替电表做的事

| 事情 | 直连时 | 网关场景 |
|---|---|---|
| 编号 | 电表 | 网关，每块表单独编号 |
| 采样时间 | 电表 | 网关，用轮询时刻 |
| 断网缓存与补传 | 电表 | 网关，替所有表 |
| 重连退避 + 随机 | 电表 | 网关 |
| 单块表是否在线 | 遗嘱 | 网关按 Modbus 是否应答判断 |

网关打的是"问到"的时间，不是"测量"的时间（误差在一个轮询周期内）；计费用的冻结电量要读电表自己的冻结值和冻结时刻（看说明书）。

### 1.5 北向：方案要改什么

- **身份**：Client ID、证书都是网关的；一台网关一条连接。
- **主题**：每块表的数据仍发到这块表自己的主题（`em/v1/t01/AE10000001/up/telemetry`），网关状态单独 `em/v1/t01/gw/GW0001/status`。平台不用区分直连还是网关。
- **权限**：网关要写名下几十块表的主题，需要"网关 → 名下电表"对应关系，通常要能查库的授权服务，不能只靠简单 ACL 文件（23、24）。
- **上下线分两层**：网关用遗嘱；单块表由网关连续几次问不到后主动报告。**网关离线时名下电表的状态不可信**，平台按"网关在线且这块表在线"判断。
- **下发命令**：平台 → 网关 → 翻译成 Modbus 写寄存器；专题 39 的闭环照样需要，执行者变成网关；拉闸类要确认站号、写后回读。
- **网关是新的单点**：单独监控；断电不丢的缓存按"所有表 × 最长断网时间"算；双网关同时轮询一条总线会冲突，需专门设计。

## 2. 易混淆 / 易错点

| 错误理解 | 正确理解 |
|---|---|
| 网关场景和直连差不多 | 连接属于网关、数据属于每块表，身份、权限、上下线、缓存都要重设计 |
| 每块表的在线可以用遗嘱 | 遗嘱只管网关；单块表由网关主动报告 |
| 电表显示在线就能联系上 | 网关离线时电表状态不可信，两层一起看 |
| 点表照说明书抄 | 字序、系数、地址起点是三大坑 |
| 轮询周期固定 | 坏表等超时会拖慢整条总线 |
| 网关时间就是测量时间 | 是"问到"的时间；冻结数据读电表自己的时刻 |
| 简单 ACL 就够 | 需要能查"网关 → 名下电表"的授权服务 |
| broker 重启不影响状态 | 实测 Mosquitto 停止时会发出遗嘱，可能造成全体"离线" |

## 3. 与其他章节的关联

| 本篇内容 | 相关专题 |
|---|---|
| 遗嘱、在线状态 | 15（回顾） |
| 授权服务 | 23、24（回顾） |
| 命令闭环 | 39（回顾） |
| 补传、编号、采样时间 | 41（回顾） |
| 重连退避 | 43（回顾） |
| broker 重启造成全体离线 | 47 现场 C（回顾） |
| 网关接入方案要点 | 50（回顾） |
| 出生/死亡消息的标准做法 | 37 |

## 4. 诊断实践

### 4.1 实验（云端真实输出）

设置：3 块模拟电表（站号 1–3，序列号 AE10000001–3），用 Modbus TCP 代替 RS-485（一问一答方式相同）；网关每秒轮询、按点表换算、发到每块表自己的主题，连续 3 次问不到报离线，与 broker 断开时本地缓存、恢复后补传；平台订阅全部主题。时间线：约 4 s 3 号表故障；约 9 s 停 broker；约 15 s 恢复 broker；约 17 s 3 号表恢复。

网关日志：

```
  第   0.0s [网关] 连上 broker
  第   0.0s [网关] AE10000001 → online
  第   0.0s [网关] AE10000002 → online
  第   0.0s [网关] AE10000003 → online
  第   7.5s [网关] AE10000003 → offline
  第   8.9s [网关] 与 broker 断开，开始本地缓存
  第  15.9s [网关] 连上 broker
  第  17.6s [网关] AE10000003 → online
  第  22.6s [网关] 结束，缓存中剩余 0 条
```

平台：

```
== 平台收到的状态变化（按到达时间）
  第   0.4s  gw          status = online
  第   0.4s  AE10000001  status = online
  第   0.4s  AE10000002  status = online
  第   0.4s  AE10000003  status = online
  第   8.0s  AE10000003  status = offline
  第   9.4s  gw          status = offline
  第  16.4s  gw          status = online
  第  18.0s  AE10000003  status = online
== 各电表遥测
  AE10000001：收到 18 条，编号 0~17，缺号 无；晚到超过 1.5s 的 4 条（补传），其中最晚一条采样于第 10.5s、到达于第 16.5s
  AE10000002：收到 18 条，编号 0~17，缺号 无；晚到超过 1.5s 的 4 条（补传），其中最晚一条采样于第 10.5s、到达于第 16.5s
  AE10000003：收到 9 条，编号 0~8，缺号 无；晚到超过 1.5s 的 0 条（补传），其中最晚一条采样于第 0.0s、到达于第 0.0s
```

（"最晚一条采样于"一栏实为补传数据中最早的采样时刻；3 号表一栏无补传，数值无意义。）

解读：
1. **单块表离线由网关报告**：3 号表约 4 s 坏，连续 3 次问不到，7.5 s 报离线；网关与 broker 连接正常，遗嘱不会触发。
2. **坏表拖慢总线**：1、2 号表约 22 s 只收到 18 条，每轮在 3 号表白等 0.5 s 超时，周期从约 1 s 变约 1.5 s。
3. **网关替所有表缓存**：8.9 s 断开到 15.9 s 重连期间本地缓存，平台上 1、2 号表编号 0–17 连续无缺，4 条为补传。
4. **broker 停止时发出了网关遗嘱**（实测现象）：9.4 s 平台收到"网关 offline"，网关本身正常。Mosquitto 2.0.18 停止时替在线客户端发了遗嘱，其他 broker 不一定相同。一次重启可能让平台收到全体"离线"，告警要能识别。
5. **两层状态要一起看**：9.4–16.4 s 网关离线，但 1、2 号表状态一直是 online（没人更新），印证"网关离线时子设备状态不可信"。

局限：未体现真实 RS-485 速率和电气干扰；缓存只在内存；只有 3 块表。可用 USB 转 RS-485 + 真实电表在本地仿真中替换。

### 4.2 脚本（本地：Mosquitto + `pip install paho-mqtt pymodbus`）

`meters.py`（模拟总线上 3 块电表，只实现功能码 03；往 `/tmp/t40/fail_unit` 写站号即让该表不应答，写 0 恢复）：

```python
# 模拟一条 RS-485 总线上的 3 块 Modbus 电表（这里用 Modbus TCP 承载，站号 1/2/3）
# 只实现功能码 03（读保持寄存器）。寄存器布局见 POINT_TABLE（float32/uint32 各占 2 个寄存器，高字在前）
import asyncio, struct, time, random, sys
FAIL_FILE="/tmp/t40/fail_unit"           # 文件里写着哪个站号"坏了"（不应答）
class Meter:
    def __init__(s, unit): s.unit=unit; s.kwh=1000.0*unit; s.t=time.time()
    def regs(s):
        now=time.time(); p=1.5*s.unit+random.uniform(-0.1,0.1); s.kwh+=p*(now-s.t)/3600*100; s.t=now   # 加速 100 倍，便于看到电量变化
        v=230+random.uniform(-2,2); i=p*1000/v
        r=[]
        for x in (v,i,p): r+=list(struct.unpack(">HH",struct.pack(">f",x)))     # 0:电压 2:电流 4:有功功率kW（float32）
        r+=list(struct.unpack(">HH",struct.pack(">I",int(s.kwh*100))))           # 6:正向有功电量，单位 0.01 kWh（uint32）
        return r
M={u:Meter(u) for u in (1,2,3)}
async def handle(reader, writer):
    try:
        while True:
            h=await reader.readexactly(7); tid,pid,ln,unit=struct.unpack(">HHHB",h)   # MBAP 头
            pdu=await reader.readexactly(ln-1)
            try: bad=int(open(FAIL_FILE).read().strip() or 0)
            except Exception: bad=0
            if unit==bad or unit not in M: continue                                  # 坏表：不应答，网关只能等超时
            fc,addr,cnt=struct.unpack(">BHH",pdu)
            data=M[unit].regs()[addr:addr+cnt]
            body=bytes([fc,len(data)*2])+b"".join(struct.pack(">H",x) for x in data)
            writer.write(struct.pack(">HHHB",tid,0,len(body)+1,unit)+body); await writer.drain()
    except Exception: pass
async def main():
    srv=await asyncio.start_server(handle,"127.0.0.1",5020); print("模拟电表总线已启动：站号 1、2、3", flush=True)
    async with srv: await srv.serve_forever()
asyncio.run(main())
```

`gateway.py`（参数：运行秒数）：

```python
# 边缘网关：按点表轮询 Modbus 电表 → 换算 → 每块表发到自己的 MQTT 主题；
# 单块表通信失败 3 次标记离线；broker 断开时本地缓存，恢复后补传
import asyncio, json, time, collections, paho.mqtt.client as mqtt
from pymodbus.client import AsyncModbusTcpClient as MB
GW="GW0001"; TENANT="t01"
BUS=[{"unit":1,"meter":"AE10000001"},{"unit":2,"meter":"AE10000002"},{"unit":3,"meter":"AE10000003"}]   # 站号 → 电表序列号
POINT_TABLE=[  # 点表：寄存器地址、类型、倍率、上报字段名
    {"name":"v",   "addr":0,"type":"FLOAT32","scale":1},
    {"name":"i",   "addr":2,"type":"FLOAT32","scale":1},
    {"name":"p",   "addr":4,"type":"FLOAT32","scale":1},
    {"name":"kwh", "addr":6,"type":"UINT32", "scale":0.01},
]
POLL=1.0; FAIL_LIMIT=3
seq=collections.defaultdict(int); fails=collections.defaultdict(int); state={}
buffer=collections.deque(maxlen=10000)                   # 网关本地缓存（真实网关要放在断电不丢的存储里）
T0=time.time()
def log(s): print(f"  第 {time.time()-T0:5.1f}s [网关] {s}", flush=True)
cli=mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=GW, protocol=mqtt.MQTTv5)
cli.will_set(f"em/v1/{TENANT}/gw/{GW}/status","offline",qos=1,retain=True)
cli.reconnect_delay_set(1,2)
def on_conn(c,u,f,rc,p): c.publish(f"em/v1/{TENANT}/gw/{GW}/status","online",qos=1,retain=True); log("连上 broker")
cli.on_connect=on_conn; cli.on_disconnect=lambda c,u,f,rc,p: log("与 broker 断开，开始本地缓存")
cli.connect_async("127.0.0.1",1883,keepalive=10); cli.loop_start()
def publish(topic,payload,retain=False):
    if cli.is_connected():
        while buffer:                                            # 先补传旧的
            t,pl,rt=buffer.popleft(); cli.publish(t,pl,qos=1,retain=rt)
        cli.publish(topic,payload,qos=1,retain=retain)
    else: buffer.append((topic,payload,retain))
def set_state(meter, s):
    if state.get(meter)!=s:
        state[meter]=s; log(f"{meter} → {s}")
        publish(f"em/v1/{TENANT}/{meter}/up/status", s, retain=True)
async def main():
    mb=MB("127.0.0.1",port=5020,timeout=0.5,retries=0); await mb.connect()
    while time.time()-T0<float(__import__("sys").argv[1]):
        for d in BUS:
            m=d["meter"]
            try:
                rr=await mb.read_holding_registers(0,count=8,device_id=d["unit"])
                if rr.isError(): raise IOError(rr)
                rec={"seq":seq[m],"ts":round(time.time(),1)}
                for pt in POINT_TABLE:
                    raw=MB.convert_from_registers(rr.registers[pt["addr"]:pt["addr"]+2], getattr(MB.DATATYPE,pt["type"]))
                    rec[pt["name"]]=round(raw*pt["scale"],3)
                seq[m]+=1; fails[m]=0; set_state(m,"online")
                publish(f"em/v1/{TENANT}/{m}/up/telemetry", json.dumps(rec))
            except Exception:
                fails[m]+=1
                if not mb.connected: await mb.connect()
                if fails[m]==FAIL_LIMIT: set_state(m,"offline")
        await asyncio.sleep(POLL)
    log(f"结束，缓存中剩余 {len(buffer)} 条"); cli.disconnect(); cli.loop_stop()
asyncio.run(main())
```

`plat_sub.py`（平台订阅与统计；不要命名为 platform.py，会与 Python 标准库同名冲突）：

```python
# 平台侧：订阅所有电表与网关的主题，记录到达时间；结束后统计
import paho.mqtt.client as mqtt, time, json, sys, collections
T0=float(open("/tmp/t40/t0.txt").read()) if len(sys.argv)<2 else time.time()
rows=[]
c=mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="platform", protocol=mqtt.MQTTv5)
c.on_connect=lambda c,u,f,rc,p: c.subscribe("em/v1/#",1)
c.on_message=lambda c,u,m: rows.append((time.time(),m.topic,m.payload.decode(),m.retain))
c.reconnect_delay_set(1,1); c.connect("127.0.0.1",1883); c.loop_start()
time.sleep(float(sys.argv[1]) if len(sys.argv)>1 else 22); c.loop_stop()
T0=float(open("/tmp/t40/t0.txt").read())
print("== 平台收到的状态变化（按到达时间）")
for t,tp,pl,rt in rows:
    if tp.endswith("status"): print(f"  第 {t-T0:5.1f}s  {tp.split('/')[3]:<11} status = {pl}{'（保留消息）' if rt else ''}")
print("== 各电表遥测")
per=collections.defaultdict(list)
for t,tp,pl,rt in rows:
    if tp.endswith("telemetry"): d=json.loads(pl); per[tp.split('/')[3]].append((t-T0,d["seq"],d["ts"]-T0,d["kwh"]))
for m,v in sorted(per.items()):
    seqs=[x[1] for x in v]; late=[x for x in v if x[0]-x[2]>1.5]
    gaps=[s for s in range(max(seqs)+1) if s not in seqs]
    print(f"  {m}：收到 {len(v)} 条，编号 {min(seqs)}~{max(seqs)}，缺号 {gaps or '无'}；"
          f"晚到超过 1.5s 的 {len(late)} 条（补传），其中最晚一条采样于第 {min([x[2] for x in late] or [0]):.1f}s、到达于第 {max([x[0] for x in late] or [0]):.1f}s")
```

运行顺序：

```bash
echo 0 > /tmp/t40/fail_unit
mosquitto -c b.conf -d
python3 meters.py &
date +%s.%N > /tmp/t40/t0.txt
python3 plat_sub.py 24 > platform.out &
python3 gateway.py 22 &
sleep 4; echo 3 > /tmp/t40/fail_unit
sleep 5; pkill -x mosquitto
sleep 6; mosquitto -c b.conf -d
sleep 2; echo 0 > /tmp/t40/fail_unit
```

### 4.3 现象 → 怀疑 → 观察点

| 现象 | 优先怀疑 | 观察点 |
|---|---|---|
| 读数离谱（如电压几十万） | 字序或数据类型错 | 点表；原始寄存器值 |
| 电量差 100 倍 | 系数漏乘 | 点表系数 |
| 读到的是隔壁数据 | 地址起点差一位 | 说明书地址与请求地址 |
| 整条总线数据变慢 | 某块表不应答，反复等超时 | 每块表的失败计数；轮询周期 |
| 网关离线后电表仍显示在线 | 未做两层状态判断 | 平台状态计算逻辑 |
| broker 重启后大量离线告警 | 停止时发出遗嘱 | 告警是否识别全体离线 |
| 网关断网后数据缺一段 | 缓存不足或不持久 | 缓存容量与存储介质 |

## 5. 复习 checklist

- [ ] 能说出网关场景的角色与南向/北向含义，画出架构
- [ ] 能解释 Modbus 一问一答、站号、寄存器、功能码 03
- [ ] 能说出点表三大坑
- [ ] 能粗算轮询周期，解释坏表为何拖慢总线
- [ ] 能列出从电表转移到网关的五件事，说明时间戳的局限
- [ ] 能说出北向六项变化（身份、主题、权限、两层上下线、命令、单点）
- [ ] 能逐条解读实验结果，尤其 broker 停止发遗嘱和两层状态
