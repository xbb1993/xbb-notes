# 桥接与多地域

> 专题 33 · 模块七 · ☆ 高频重点 · 第二遍 · 简述
> 云端实测：两台 Mosquitto 2.0.18（边缘 1884、云端 1883）+ paho-mqtt 2.1.0；同一实验重复两次结果一致
> 防环路的 Mosquitto 桥接识别机制与 5.0 No Local 用于桥接，未单独实验

**这一章解决什么**：园区、配电房需要本地 broker（本地系统直接用数据、断网照常工作），或多地区各有平台只汇总部分数据时，用桥接连接两台 broker。讲怎么配、断网时怎样、怎么避免转圈。

## 1. 核心概念

### 1.1 角色与架构

- **边缘 broker**：现场那台，电表和本地系统连它。
- **云端 broker**：总部/云上那台，平台服务连它。
- **桥接连接**：边缘 broker 以客户端身份连云端，按规则转发指定主题。

```
 ┌──────────── 园区 site01 ────────────┐                ┌──────── 云端 ────────┐
 │ 电表 ─┐                              │                │                      │
 │ 电表 ─┼─→ 边缘 broker ══桥接连接══════════════════→   云端 broker ─→ 平台服务  │
 │ 本地监控 ─┘   │                      │  上行 em/#      │                      │
 │              │ 断网时：本地照常工作，    │  加前缀 site01/ │                      │
 │              │ 要转发的消息先缓存       │                │                      │
 │              ←══════════════════════════════════════  下行 site01/cmd/#       │
 └─────────────────────────────────────┘  去掉前缀       └──────────────────────┘
```

与专题 31 的区别：桥接**不是集群**（无会话迁移、全量转发浪费、ID 不全局唯一）。桥接的本来用途是连接两个**各自独立**的地方，只转发需要的那部分。

### 1.2 配置要点（Mosquitto）

```
connection site01-to-cloud            # 桥接连接名
address 127.0.0.1:1883                # 云端地址
cleansession false                    # 持久会话：断开期间的消息要保留
restart_timeout 1                     # 断开后多久重试
topic em/# out 1 "" site01/           # 上行：本地 em/# → 云端，QoS 1，云端加前缀 site01/
topic cmd/# in 1 "" site01/           # 下行：云端 site01/cmd/# → 本地，去掉前缀
```

- **方向**：`out` 本地到云端，`in` 云端到本地，`both` 双向。
- **前缀**：多个园区桥到同一云端时区分来源；电表和本地系统无需知道前缀。
- **QoS 1 + 持久会话**：断网期间数据不丢的前提。

### 1.3 方案要考虑的四点

1. **边缘缓存能撑多久**：受队列上限（满了丢最新）、内存、边缘是否开持久化（没开则重启丢缓存）限制（28）。按"消息速率 × 最长断网时间"配置。
2. **防环路**：一个主题只配一个方向（上行只 out、下行只 in，最简单可靠）；用前缀区分；两台 Mosquitto 间桥接有识别对方是桥接的机制，5.0 No Local 也可防收到自己转出的消息（20）——后两点未实验。
3. **桥接只是一条连接**：整个园区上行挤在一条连接上，吞吐、断线都影响整个园区，数据量大要压测（48）。
4. **多地域**：每个地区一套完整平台（可集群），地区间只桥接需要汇总的数据；Client ID、设备序列号全局唯一。

## 2. 易混淆 / 易错点

| 错误理解 | 正确理解 |
|---|---|
| 桥接就是集群 | 桥接连接独立的地方，不迁移会话、不保证全局 ID 唯一 |
| 桥接默认就不丢数据 | 需 QoS 1 + 持久会话，且受边缘队列、内存、持久化限制 |
| 双向配 `both` 最省事 | 易形成环路；一个主题一个方向更可靠 |
| 现场设备要知道前缀 | 前缀只在桥接两端转换，设备无感 |
| 多地区全量互相桥接 | 只桥接需要汇总的数据 |

## 3. 与其他章节的关联

| 本篇内容 | 相关专题 |
|---|---|
| 持久会话 | 12（回顾） |
| No Local、Retain As Published | 20（回顾） |
| 边缘缓存的队列与持久化 | 28（回顾） |
| 桥接不是集群 | 31（回顾） |
| 网关、园区接入 | 40（回顾） |
| Client ID 冲突 | 47 现场 A（回顾） |
| 桥接连接压测 | 48（回顾） |

## 4. 诊断实践

### 4.1 实验（云端真实输出）

设置：电表连边缘 broker，每秒发一条（seq 0–11）；第 5 秒停云端 broker（模拟园区到云端断网），第 9 秒恢复；最后云端发"读表"命令。

```
== 云端收到的遥测（到达时间, 主题, seq）
   (1.0, 'site01/em/AE1/up/telemetry', 0)
   (2.0, 'site01/em/AE1/up/telemetry', 1)
   (3.0, 'site01/em/AE1/up/telemetry', 2)
   (4.0, 'site01/em/AE1/up/telemetry', 3)
   (5.0, 'site01/em/AE1/up/telemetry', 4)
   (10.5, 'site01/em/AE1/up/telemetry', 5)
   (10.5, 'site01/em/AE1/up/telemetry', 6)
   (10.5, 'site01/em/AE1/up/telemetry', 7)
   (10.5, 'site01/em/AE1/up/telemetry', 8)
   (10.5, 'site01/em/AE1/up/telemetry', 9)
   (11.0, 'site01/em/AE1/up/telemetry', 10)
   (12.0, 'site01/em/AE1/up/telemetry', 11)
== 电表收到的云端命令：[('cmd/AE1', '读表')]
```

解读：前缀生效；5–9 在云端停机期间产生，边缘缓存；桥接重连后于 10.5 s 一次性回灌，12 条一条不少、顺序正确；下行命令去掉前缀后送达电表。

意外收获：首次运行时编号 0、2 丢失、命令收到两次。原因是上一轮中断的实验残留了同 Client ID（AE1）的进程，自动重连到边缘 broker 互踢——专题 47 现场 A 的真实再现。清掉残留后重跑得到上面结果。**本地仿真每次实验前要确认没有残留的同名客户端。**

### 4.2 配置与脚本

云端 `cloud.conf`：

```
listener 1883
allow_anonymous true
```

边缘 `edge.conf`：

```
listener 1884
allow_anonymous true
log_dest file /tmp/t33/edge.log
connection site01-to-cloud
address 127.0.0.1:1883
cleansession false
restart_timeout 1
topic em/# out 1 "" site01/
topic cmd/# in 1 "" site01/
```

`run.py`（参数：云端 broker 的 PID）：

```python
# 边缘 broker（1884）桥接到云端（1883）：主题加前缀、云端宕机时边缘缓存、恢复后回灌、云端下发命令
import paho.mqtt.client as mqtt, time, subprocess, json, sys
V2=mqtt.CallbackAPIVersion.VERSION2; T0=time.time()
def log(s): print(f"  第 {time.time()-T0:4.1f}s  {s}", flush=True)
got=[]
cloud=mqtt.Client(V2, client_id="cloud-svc", protocol=mqtt.MQTTv5)
cloud.on_connect=lambda c,u,f,rc,p: c.subscribe("site01/em/#",1)
cloud.on_message=lambda c,u,m: got.append((round(time.time()-T0,1), m.topic, json.loads(m.payload)["seq"]))
cloud.reconnect_delay_set(1,1); cloud.connect("127.0.0.1",1883); cloud.loop_start()
cmds=[]
meter=mqtt.Client(V2, client_id="AE1", protocol=mqtt.MQTTv5)
meter.on_connect=lambda c,u,f,rc,p: c.subscribe("cmd/AE1",1)
meter.on_message=lambda c,u,m: cmds.append((m.topic, m.payload.decode()))
meter.connect("127.0.0.1",1884); meter.loop_start(); time.sleep(1)
cloud_pid=int(sys.argv[1])
for seq in range(12):
    if seq==4: subprocess.run(["kill",str(cloud_pid)]); log("云端 broker 停止（模拟园区到云端的网络中断）")
    if seq==8:
        subprocess.Popen(["mosquitto","-c","/tmp/t33/cloud.conf","-d"]); log("云端 broker 恢复")
    meter.publish("em/AE1/up/telemetry", json.dumps({"seq":seq}), qos=1); log(f"电表在本地发出 seq={seq}")
    time.sleep(1)
time.sleep(3)
cloud.publish("site01/cmd/AE1","读表", qos=1); time.sleep(1)
print("== 云端收到的遥测（到达时间, 主题, seq）")
for g in got: print("  ",g)
print(f"== 电表收到的云端命令：{cmds}")
```

运行：

```bash
mosquitto -c cloud.conf -d; mosquitto -c edge.conf -d; sleep 3
python3 run.py $(ps -C mosquitto -o pid=,args= | awk '/cloud.conf/{print $1}')
```

注意：不要用 `pgrep -f` / `grep` 匹配配置文件名来取 PID，可能匹配到当前 shell 自己。

### 4.3 现象 → 怀疑 → 观察点

| 现象 | 优先怀疑 | 观察点 |
|---|---|---|
| 断网恢复后云端缺一段数据 | 桥接未用持久会话或 QoS 0；边缘队列满；边缘重启无持久化 | 桥接配置；边缘丢弃计数；边缘重启记录 |
| 消息在两边来回出现、流量暴涨 | 双向配置形成环路 | 桥接方向与前缀 |
| 云端看不出数据来自哪个园区 | 未加前缀 | 桥接 topic 规则 |
| 整个园区数据延迟 | 桥接连接是瓶颈或反复重连 | 边缘日志 "Connecting bridge"；连接吞吐 |
| 汇总后设备 ID 冲突 | 各地区 ID 未全局唯一 | ID 规则 |

## 5. 复习 checklist

- [ ] 能画出边缘—云端桥接架构，说明与集群的区别
- [ ] 能读懂桥接配置的方向、QoS、前缀
- [ ] 能用实验说明断网缓存与回灌
- [ ] 能说出边缘缓存的三个限制
- [ ] 能说出防环路的做法
- [ ] 能说出多地域的两条原则
