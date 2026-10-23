# 断网补传与数据质量：时间戳、乱序、重复与幂等入库

> 专题 41 · 模块九 · ★ 核心必会 · 详细
> 云端实测：Mosquitto 2.0.18 + paho-mqtt 2.1.0 + SQLite 内存库；InfluxDB 去重规则已核实
> 贯穿场景：电表 meter3 每 5 秒上报一次读数，中途断网一段时间后恢复

**这一章解决什么**：上一章是往电表发东西（下行），这一章是电表往上报数据（上行）。麻烦出在断网又恢复的时候。目标一句话：**断网前后的数据，最终在数据库里一条不多、一条不少、顺序正确、时间正确。**

## 1. 核心概念

### 1.1 先数清楚角色

- **电表**：采样，给每条数据打上编号和自己的时间；断网时存在本地，恢复后补发。
- **broker**：只传话，**不**去重、**不**按时间排序。
- **入库服务**：订阅上报主题，去重、排序、查缺口，再写库。问题主要在这里解决。
- **时序库**（如 InfluxDB）：它的存储规则决定重复数据会不会被自动合并。
- **用数据的一方**：实时大屏、告警、计费结算，最容易被补传数据坑到。

### 1.2 整体架构

```
 ┌─────────── 电表 meter3 ───────────┐
 │ 每 5 秒采样一次                     │
 │ 每条数据带：编号 + 电表自己的时间      │        网络通时：直接发
 │ 断网时 → 存进本地缓存 ──────────────┼──────────────────────┐
 │ 恢复后 → 边发新数据，边补发旧数据      │                      ▼
 └────────────────────────────────────┘              ┌──────────────┐
                                                     │    broker     │
                                                     │ 只传话，不去重、 │
                                                     │ 不排序          │
                                                     └──────┬───────┘
                                                            ▼
                                        ┌───────────────────────────────┐
                                        │           入库服务              │
                                        │ ① 去重：同一条只留一份             │
                                        │ ② 用电表时间入库，不用到达时间       │
                                        │ ③ 查编号断档，有就去补要            │
                                        └──────────────┬────────────────┘
                                                       ▼
                                                 ┌──────────┐
                                                 │  时序库    │
                                                 └────┬─────┘
                                  ┌───────────────────┼───────────────────┐
                                  ▼                   ▼                   ▼
                              实时大屏               告警               计费结算
                       （别被旧数据刷回去）  （补传的旧数据别乱报警）  （等数据补齐再算）
```

### 1.3 电表侧：断网时怎么办

**先存起来**：扔掉就找不回来了。但存储有限，要考虑：
- 能存多久（每 5 秒一条、每条几十字节，一天约几百 KB 到 1 MB）。
- 存满扔哪条：一般扔最旧的；计费用的整点电量优先保住，秒级功率可以先扔。
- 存储芯片有写入寿命，要攒一批再写。

**恢复后边发边补**：先补完旧的再发新的，会让实时数据卡住；所以每个周期发 1 条新的、顺带补几条旧的。补发要**限速**，一万块电表同时全速补传会冲垮 broker 和入库服务（专题 32、43）。

**每条数据带两样东西**：
- **编号**：从小到大、不重复；断电后要接着数，不能从 0 重来。
- **采样时间**：读数发生的时间，用电表时钟。

### 1.4 为什么会重复，怎么去重

道理：断网往往不是干净地断。最后几条发出去了，电表没等到确认（PUBACK），不知道送没送到，只能恢复后再发一次——和上一章"回执丢了分不清"是同一处境，只是方向反了。加上 QoS 1 本身"至少一次"。**重复是正常现象，要默认一定发生。**

解决：每条数据一个"身份证号"，入库时同号只存一份。
- **电表号 + 编号**：最直接，前提是编号断电不丢。
- **电表号 + 数据项 + 采样时间**：计费数据常按固定时刻冻结（如每 15 分钟整点），天然唯一；前提是时钟可信不回跳。
- **不能用到达时间**：同一条发两次，到达时间一定不同。

专业上："来几次效果都和来一次一样"叫**幂等**，这里叫**幂等入库**；身份证号叫**唯一键**（业务主键）。

数据库写法：关系库用唯一键冲突时忽略或覆盖（`INSERT ... ON CONFLICT DO NOTHING` / upsert）。**InfluxDB 自带此规则**（官方文档已核实）：用"表名 + 标签 + 时间戳"识别一个点，三者相同时后写的字段值覆盖先写的。所以时间戳用电表采样时间，重复会自动合并；用到达时间，重复就变成两个点。

### 1.5 为什么会乱序

broker 在同一条连接上大体先收先转，**传输没乱，乱的是含义**：恢复后新旧交替发，收到的顺序是"40、17、18、19、41、20……"。到达顺序不等于发生顺序。入库服务多实例共享订阅（专题 19）时，写库先后会更乱。

解决：**不依赖到达顺序**，查询和计算时一律按采样时间或编号排序。

### 1.6 用哪个时间

- **采样时间**：读数什么时候发生，电表打。
- **到达时间**：服务器什么时候收到，服务器打。

用到达时间入库：断网那段一个点都没有，恢复那刻挤进一大堆——既"丢了"又"堆了"。**所以入库用采样时间。**

但电表时钟可能不准（走偏、断电重置）：
- 平台定期给电表**校时**。
- **两个时间都存**：某块电表"采样时间 − 到达时间"一直比别人大几分钟，说明它时钟偏了。

专业上：采样时间叫**事件时间**（event time），到达时间叫**处理时间**（processing time）。计算按事件时间，处理时间用来监控延迟和时钟偏差。

### 1.7 补传对下游的影响

| 下游 | 错误写法的后果 | 正确做法 |
|---|---|---|
| 实时大屏 | 取"最后收到的那条"，补传时显示旧值，电量"倒退" | 取采样时间最新（编号最大）的那条 |
| 累计电量算用电 | 按到达顺序相减出现**负数** | 先去重，再按采样时间/编号排序后相减 |
| 告警 | 旧数据被当成刚发生，触发过时告警或重复告警 | 按采样时间判断；补传数据打标记，过时的只记录不通知 |
| 计费结算 | 0 点立刻结算，断网电表的最后几小时没算进去 | 等约定时间（如 2 小时），查齐全，不齐去补要，要不到标为估算 |

"等多久算数据到齐"这条线，流式计算里叫**水位线**（watermark）。

### 1.8 怎么发现少了数据

编号连续，中间断了一截就说明少了。入库服务定期查每块电表编号是否连续，发现断档就通过上一章的命令通道让电表"补发编号 120 到 135"；电表本地没了，就在库里标记该段为"缺失"，而不是假装不存在。专业上叫**断档检测**与**召测**。

## 2. 易混淆 / 易错点

| 错误理解 | 正确理解 |
|---|---|
| broker 会帮我去重、排序 | broker 只传话 |
| 出现重复说明系统有故障 | 重复是正常现象，必须默认会发生 |
| 用 QoS 2 就不会重复 | 电表恢复后重发的是新消息；靠唯一键去重 |
| 用到达时间当唯一键 | 同一条发两次到达时间不同，去不掉 |
| 编号每次重启从 0 开始也行 | 重启前后编号撞车，去重会误删 |
| 传输有序，所以数据有序 | 补传新旧交替，到达顺序 ≠ 发生顺序 |
| 入库用到达时间更可靠 | 断网段变空、恢复时堆积；用采样时间，到达时间只做监控 |
| 只存采样时间就够 | 两个都存，才能发现电表时钟偏差 |
| 大屏取最后到达的值 | 取编号最大或采样时间最新的值 |
| 按到达顺序做累计量差分 | 会出现负数；先去重排序 |
| 0 点准时结算 | 等数据到齐（水位线），不齐去补要 |
| 没收到就当没有 | 查编号断档，召测或标记缺失 |

## 3. 与其他章节的关联

| 本篇内容 | 相关专题 |
|---|---|
| PUBACK 没等到 → 重发 → 重复 | 10（回顾） |
| QoS 2 只管一段路 | 11（回顾） |
| 共享订阅多实例写库更乱 | 19（回顾） |
| broker 不去重、不排序 | 26、27（回顾） |
| 补传要限速，避免同时涌入 | 32（回顾） |
| 召测走命令通道；幂等的同一道理 | 39（回顾） |
| 客户端离线缓冲、重连退避 | 43 |
| 受限设备存储 | 44 |
| 数据延迟、缺失的监控 | 46 |

## 4. 诊断实践

### 4.1 实验（云端真实输出）

设置：每 0.1 秒采一点（代表 5 秒），共 60 点（编号 0–59）；第 20 点断网、第 40 点恢复；断网前最后 3 条（17、18、19）未等到确认，恢复后重发；恢复后每周期发 1 条新的、补 3 条旧的；电表时钟故意快 420 秒；入库服务同时写"来一条插一条"表和"电表号 + 编号"唯一键表。

```
  [device ] 第 20 个点时断网，本地开始缓存
  [device ] 第 40 个点时恢复，待补传 23 条

== 入库服务视角
  电表实际采样 60 个点；入库服务收到 63 条
  朴素表行数 63（重复的序号：[17, 18, 19]）
  幂等表行数 60（按 设备号+序号 去重）
  到达顺序前后颠倒 8 次；到达序列片段：[18, 19, 40, 17, 18, 19, 41, 20, 21, 22, 42, 23, 24, 25, 43, 26]
  缺失的序号：无

== 大屏'当前读数'（取补传进行中的某一刻：刚收到补传的旧数据序号 25 时）
  按'最后到达'取：序号 25，1003.12 kWh
  按'最大序号'取：序号 42，1005.16 kWh

== 时间戳：序号 5 的电表时间 421.0s，到达入库服务时间 1.0s，相差 420s（电表时钟偏快）

== 断网那段时间（2.0s）里有几个点？按到达时间：0 个；按电表时间（扣掉时钟偏差）：21 个；而恢复后 1 秒内按到达时间挤进了 30 个
== 用累计电量算每段用电：按到达顺序相减，出现负值 8 次，例如 [(17, -2.76), (20, -2.52), (23, -2.28)]；按序号排序并去重后相减，负值 0 次
```

逐段解读：

1. **重复**：多出的 3 条正是重发的 17、18、19；唯一键表正好 60 条。
2. **乱序**：先到断网前的 18、19，然后新数据 40，接着重发的 17、18、19，再新数据 41、补 20、21、22……新旧交替。
3. **大屏倒退**：刚收到补传的 25 时，取"最后到达"显示 1003.12，比已显示过的 1005 多还小；按编号最大取才对。
4. **用哪个时间**：按到达时间，断网期间 0 个点、恢复后 1 秒挤进 30 个；按电表时间，断网期间的点回到原位（约 20 个，边界多算 1 个）。
5. **时钟偏差**：两个时间差了整 420 秒，一眼看出这块电表快了 7 分钟。
6. **累计量差分**：按到达顺序相减出负数（编号 17 处"用了 −2.76 度"）；去重排序后 0 个负数。

### 4.2 脚本（本地：Mosquitto + `pip install paho-mqtt`，无需数据库）

`common.py`：

```python
import paho.mqtt.client as mqtt, time, json, threading
from paho.mqtt.properties import Properties
from paho.mqtt.packettypes import PacketTypes
V2=mqtt.CallbackAPIVersion.VERSION2
def client(cid, clean=True, expiry=0, on_msg=None):
    c=mqtt.Client(V2, client_id=cid, protocol=mqtt.MQTTv5)
    if on_msg: c.on_message=on_msg
    p=Properties(PacketTypes.CONNECT); p.SessionExpiryInterval=expiry
    ev=threading.Event(); info={}
    def on_conn(c,u,f,rc,props): info['sp']=f.session_present; ev.set()
    c.on_connect=on_conn
    c.connect("127.0.0.1",1883,keepalive=30,clean_start=clean,properties=p); c.loop_start(); ev.wait(3)
    return c, info.get('sp')
def stop(c): c.disconnect(); c.loop_stop()
def log(who,msg): print(f"  [{who:<7}] {msg}", flush=True)
```

`backfill.py`：

```python
# 实验：电表断网 → 本地缓存 → 恢复后补传；入库服务统计重复、乱序，并对比两种入库方式
from common import *
import sqlite3, collections
TICK=0.1; TOTAL=60; OFF=(20,40); SKEW=420          # 每 0.1 秒采一个点（代表 5 秒）；第 20~39 个点断网；电表时钟快 7 分钟
T0=time.time()
# ---------------- 入库服务 ----------------
db=sqlite3.connect(":memory:", check_same_thread=False)
db.execute("create table naive(device text, seq int, ts real, kwh real, arrived real)")                      # 朴素：来一条插一条
db.execute("create table idem(device text, seq int, ts real, kwh real, arrived real, primary key(device,seq))")  # 幂等：设备号+序号唯一
arrivals=[]; lock=threading.Lock()
def ingest(c,u,m):
    r=json.loads(m.payload); now=time.time()
    with lock:
        arrivals.append(r["seq"])
        db.execute("insert into naive values(?,?,?,?,?)",(r["dev"],r["seq"],r["ts"],r["kwh"],now))
        db.execute("insert or ignore into idem values(?,?,?,?,?)",(r["dev"],r["seq"],r["ts"],r["kwh"],now))
svc,_=client("ingest", on_msg=ingest); svc.subscribe("em/+/up/telemetry",1); time.sleep(0.5)
# ---------------- 电表 ----------------
dev,_=client("meter3")
backlog=collections.deque(); kwh=1000.0; online=True
def send(r): dev.publish("em/meter3/up/telemetry", json.dumps(r), qos=1)
for seq in range(TOTAL):
    kwh+=0.12
    r={"dev":"meter3","seq":seq,"ts":round(time.time()-T0+SKEW,2),"kwh":round(kwh,2)}     # ts 用电表自己的时钟
    if seq==OFF[0]:
        backlog.extend(sent_last3)                       # 断网前最后 3 条没等到 PUBACK，电表不确定是否送达，留着重发
        stop(dev); online=False; T_OFF=time.time(); log("device",f"第 {seq} 个点时断网，本地开始缓存")
    if seq==OFF[1]:
        T_ON=time.time(); dev,_=client("meter3"); online=True; log("device",f"第 {seq} 个点时恢复，待补传 {len(backlog)} 条")
    if not online: backlog.append(r)
    else:
        send(r)                                          # 先发实时点
        for _ in range(min(3,len(backlog))): send(backlog.popleft())   # 每个周期顺带补传 3 条旧数据
    sent_last3=[r] if seq<OFF[0]-2 else (sent_last3+[r] if seq<OFF[0] else [])
    time.sleep(TICK)
while backlog: send(backlog.popleft()); time.sleep(0.02)
time.sleep(1); stop(dev); stop(svc)
# ---------------- 统计 ----------------
n_naive=db.execute("select count(*) from naive").fetchone()[0]
n_idem=db.execute("select count(*) from idem").fetchone()[0]
dups=db.execute("select seq,count(*) from naive group by seq having count(*)>1").fetchall()
inv=sum(1 for i in range(1,len(arrivals)) if arrivals[i]<arrivals[i-1])
print(f"\n== 入库服务视角")
print(f"  电表实际采样 {TOTAL} 个点；入库服务收到 {len(arrivals)} 条")
print(f"  朴素表行数 {n_naive}（重复的序号：{[s for s,_ in dups]}）")
print(f"  幂等表行数 {n_idem}（按 设备号+序号 去重）")
print(f"  到达顺序前后颠倒 {inv} 次；到达序列片段：{arrivals[18:34]}")
gaps=[s for s in range(TOTAL) if s not in {r[0] for r in db.execute('select seq from idem')}]
print(f"  缺失的序号：{gaps or '无'}")
# 大屏“当前读数”的两种取法
last_arrived=db.execute("select seq,kwh from naive order by arrived desc limit 1").fetchone()
mid=db.execute("select seq,kwh from naive where arrived=(select arrived from naive where seq=43 limit 1)").fetchone()
print(f"\n== 大屏'当前读数'（取补传进行中的某一刻：刚收到补传的旧数据序号 25 时）")
snap=db.execute("select max(arrived) from naive where seq=25").fetchone()[0]
by_arrival=db.execute("select seq,kwh from naive where arrived<=? order by arrived desc limit 1",(snap,)).fetchone()
by_seq=db.execute("select seq,kwh from naive where arrived<=? order by seq desc limit 1",(snap,)).fetchone()
print(f"  按'最后到达'取：序号 {by_arrival[0]}，{by_arrival[1]} kWh")
print(f"  按'最大序号'取：序号 {by_seq[0]}，{by_seq[1]} kWh")
# 时钟
r=db.execute("select ts, arrived from idem where seq=5").fetchone()
print(f"\n== 时间戳：序号 5 的电表时间 {r[0]:.1f}s，到达入库服务时间 {r[1]-T0:.1f}s，相差 {r[0]-(r[1]-T0):.0f}s（电表时钟偏快）")
# 用哪个时间戳：断网期间（第 20~39 个点）在两种时间轴上各落了几个点
t_off=T_OFF; t_on=T_ON
by_arr=db.execute("select count(*) from idem where arrived between ? and ?",(t_off,t_on)).fetchone()[0]
by_dev=db.execute("select count(*) from idem where ts-? between ? and ?",(SKEW,t_off-T0,t_on-T0)).fetchone()[0]
after=db.execute("select count(*) from idem where arrived between ? and ?",(t_on,t_on+1.0)).fetchone()[0]
print(f"\n== 断网那段时间（{t_on-t_off:.1f}s）里有几个点？按到达时间：{by_arr} 个；按电表时间（扣掉时钟偏差）：{by_dev} 个；而恢复后 1 秒内按到达时间挤进了 {after} 个")
# 累计电量算区间用电：按到达顺序相减 vs 按序号排序后相减
rows=db.execute("select seq,kwh from naive order by arrived").fetchall()
neg=[(rows[i][0],round(rows[i][1]-rows[i-1][1],2)) for i in range(1,len(rows)) if rows[i][1]-rows[i-1][1]<0]
s=db.execute("select kwh from idem order by seq").fetchall()
neg2=sum(1 for i in range(1,len(s)) if s[i][0]-s[i-1][0]<0)
print(f"== 用累计电量算每段用电：按到达顺序相减，出现负值 {len(neg)} 次，例如 {neg[:3]}；按序号排序并去重后相减，负值 {neg2} 次")
```

### 4.3 现象 → 怀疑 → 观察点

| 现象 | 优先怀疑 | 观察点 |
|---|---|---|
| 同一时刻出现两条一样的读数 | 没做唯一键，或唯一键含到达时间 | 表结构 / InfluxDB 时间戳来源 |
| 断网后曲线有一段空白、恢复时一根尖刺 | 用了到达时间入库 | 写入时间戳字段来源 |
| 大屏电量突然变小又恢复 | 取的是最后到达的值 | 大屏查询语句 |
| 用电量出现负数 | 差分前没去重排序 | 差分计算的排序依据 |
| 恢复后告警暴增 | 补传数据按到达时间判断 | 告警规则用的时间；是否有补传标记 |
| 月结电量偏少 | 结算没等补传 | 结算时刻与各表最后数据时间 |
| 某表数据时间总比别人超前或落后几分钟 | 电表时钟偏差 | 采样时间 − 到达时间的分布；校时记录 |
| 重启后部分数据被去重误删 | 编号重启归零 | 电表编号是否持久化 |
| 编号有断档 | 本地缓存满被丢弃或传输丢失 | 断档检测记录；召测结果 |

## 5. 复习 checklist

- [ ] 能说出五个角色各做什么，画出架构图
- [ ] 能说明电表断网时存储的三个实际问题，以及补发为什么要边发边补、要限速
- [ ] 能讲清为什么会重复，并给出两种唯一键方案及前提
- [ ] 能说明 InfluxDB 的去重规则，以及为什么时间戳必须用采样时间
- [ ] 能讲清"传输没乱、含义乱了"
- [ ] 能区分事件时间与处理时间，说出两个都存的理由
- [ ] 能说出补传对大屏、差分、告警、结算的影响及正确做法，知道水位线
- [ ] 能说明断档检测与召测
- [ ] 能逐行读懂实验输出

---

参考：[InfluxDB · Handle duplicate data points](https://docs.influxdata.com/influxdb/v2/write-data/best-practices/duplicate-points/)
