# 设备影子、指令下发与 OTA

> 专题 39 · 模块九 · ★ 核心必会 · 详细
> 云端实测：Mosquitto 2.0.18 + paho-mqtt 2.1.0；AWS Device Shadow 字段已核实
> 贯穿场景：业务服务想让电表 meter3 改费率、拉闸、升级固件，而 meter3 随时可能离线

**这一章解决什么**：业务服务想让电表做一件事，怎么确定它**真的做了，而且只做了一次**。MQTT 协议本身不回答这个问题，要靠在它上面自己设计。

## 1. 核心概念

### 1.1 先认清角色

- **业务服务**：真正"想让电表做事"的一方，如计费系统、运维平台、App 后台，通常有好几个。
- **影子服务**：单独部署的服务，替每块电表保管"应该是什么样"和"实际是什么样"，并负责让两者一致。
- **broker**：唯一的传话通道。电表只会说 MQTT、只连 broker，影子服务想和电表说话也得经过 broker。
- **数据库**：影子的正本存这里；broker 里的保留消息只是方便推送的副本（专题 28：broker 崩溃会丢）。

一句话：**业务服务提要求，影子服务记账并盯着执行，broker 负责传话。**

### 1.2 架构

```
 ┌──────────────────────── 云端 / 机房 ─────────────────────────┐
 │   ┌────────────┐   ┌────────────┐   ┌────────────┐           │
 │   │  计费系统   │   │  运维平台   │   │ App 后台    │  ← 业务服务│
 │   └─────┬──────┘   └─────┬──────┘   └─────┬──────┘           │
 │         │ HTTP："把 meter3 费率设为 T3"     │                 │
 │         ▼                 ▼                 ▼                 │
 │   ┌──────────────────────────────────────────────┐           │
 │   │              影子服务（单独部署）               │           │
 │   │  · 对业务服务：HTTP 接口（读/改期望值）          │           │
 │   │  · 对电表：作为 MQTT 客户端连 broker            │           │
 │   │  · 计算差异、判断是否已做到                     │           │
 │   └───────────────┬───────────────────┬──────────┘           │
 │            ┌──────▼──────┐            │ MQTT                 │
 │            │ 数据库（正本） │            ▼                      │
 │            └─────────────┘   ┌───────────────────────┐       │
 │                              │      MQTT broker       │       │
 │                              │  只管把消息送给订阅者     │       │
 │                              └───────────▲───────────┘       │
 └──────────────────────────────────────────┼───────────────────┘
                                            │ MQTT（电表唯一的对外连接）
                               meter1   meter3   …   meter100000
```

影子只管"状态类"的事；其他往来直接走 broker：

```
                           ┌──→ 影子服务 ──→ 业务服务   （状态：费率、配置、继电器该开该关）
 meter3 ⇄ broker ──────────┼──→ 时序库 / 计费系统       （实时读数：源源不断的数据流）
                           └──→ 命令服务 ⇄ 运维平台      （一次性动作：立即抄表，带回执）
```

| 往来内容 | 路径 | 为什么不走影子 |
|---|---|---|
| 实时读数 | 电表 → broker → 时序库 | 是数据流，不是"应该是什么样" |
| 状态和配置 | 业务服务 → 影子服务 → broker → 电表，原路返回 | 影子擅长的事 |
| 一次性动作 | 运维平台 → broker → 电表，回执原路返回 | 没有"最终状态" |
| 固件升级 | broker 发通知和进度，文件常走 HTTPS | 文件太大 |

影子服务放在哪：

| 放法 | 适用 | 问题 |
|---|---|---|
| 单独服务 | 大多数自建项目 | 多部署一个服务 |
| 塞进某个业务服务 | 很小的项目 | 其他业务服务要绕道调用，职责混杂 |
| broker 插件 | 不推荐 | 业务逻辑进 broker，升级、扩容、排障被牵连 |
| 云平台现成的 | AWS IoT、Azure IoT Hub | 平台把 broker 和影子打包在一起，看起来像"broker 自带影子"，实为两个职责 |

### 1.3 最直接的做法会出什么事

做法：业务服务往 `em/meter3/down/cmd` 发 QoS 1，收到 PUBACK 就算成功。

问题：**PUBACK 是 broker 回的，不是电表回的**，只说明"broker 收到了"（专题 10）。在这个盲区里：

1. **电表离线太久，命令没了**：会话过期，排队的命令跟着删掉，业务服务毫不知情（实验 A2）。
2. **离线期间改了好几次，上线后挨个执行**：T1、T2、T3 切三次，前两次白做（实验 A1）。
3. **同一条命令执行两次**：QoS 1 至少一次，拉闸、清零执行两次就是事故。

### 1.4 思路一：不发"去做什么"，而是写"应该是什么样"

业务服务其实只关心"最后费率是 T3"。所以在一个固定地方写下"meter3 费率应该是 T3"；电表每次上线去看一眼，不一样就改，改完把"我现在是 T3"写到另一个地方。

- 离线多久都没关系：记录一直在，不随会话过期消失。
- 中间改几次都没关系：只看最后的值，一步到位。
- 重复收到没关系：已经是 T3，什么也不用做。

**专业上叫设备影子**（Azure 叫 Device Twin）。字段（AWS 文档已核实）：

| 字段 | 谁写 | 大白话 |
|---|---|---|
| desired | 影子服务（代业务服务） | 应该是什么样 |
| reported | 电表 | 我现在实际是什么样 |
| delta | 影子服务自动算 | 还没做到的部分；**变空 = 已做到** |
| version | 影子服务 | 每改一次加 1；收到比已知还旧的就忽略 |

判断成功看 **delta 是否变空**，不看 PUBACK。

改费率的完整过程：

```
计费系统        影子服务              数据库        broker            meter3（离线中）
   │ ①改期望值      │                    │             │                   │
   │──────────────→│ ②写 desired=T3      │             │                   │
   │               │───────────────────→│             │                   │
   │               │ ③发保留消息 desired  │             │                   │
   │               │────────────────────────────────→│ 存着等电表来取       │
   │  ④"已受理"     │                    │             │      ……电表上线……   │
   │←──────────────│                    │             │ ⑤推送 desired=T3  │
   │               │                    │             │──────────────────→│ ⑥改成 T3
   │               │                    │             │ ⑦上报 reported=T3 │
   │               │ ⑧收到实际值          │             │←──────────────────│
   │               │←────────────────────────────────│                   │
   │               │ ⑨写 reported，两边一致│            │                   │
   │ ⑩通知"已完成"  │───────────────────→│             │                   │
   │←──────────────│                    │             │                   │
```

④ 是"已受理"，⑩ 才是"已完成"。

自建时（Mosquitto/EMQX）：两个保留消息主题 `em/meter3/shadow/desired`、`em/meter3/shadow/reported` 加一个影子服务；电表只能写自己的 reported、读自己的 desired（专题 24 ACL）。

边界：
- 正本放数据库，broker 丢了保留消息要由影子服务补发。
- "立即抄表""重启一次"没有最终状态，不能写成影子，只能用命令。
- 反过来，**很多命令其实可以写成状态**：拉闸 = "继电器应为断开"，离线多久上线都会收敛，重复也无害。能写成状态的尽量写成状态。
- 设备本地改了配置、同时远端改了 desired，听谁的要事先定好规则。
- 每秒变化的读数不要放进 reported。

### 1.5 思路二：必须用命令时，做成闭环

一环扣一环推出来：

1. **只信电表亲口说"做完了"**：电表执行完发一条消息回来。专业上叫**业务回执**。
2. **回执要能对上号**：每条命令一个唯一编号，回执原样带回。5.0 提供 **Response Topic**（回执发到哪）和 **Correlation Data**（编号原样带回）；3.1.1 把它们写进消息内容即可。
3. **等不到回执只能再发**：业务服务分不清"命令没到"还是"做了但回执丢了"，只能用**同一编号**再发。专业上叫**超时重发**。
4. **再发就可能做两次，所以电表要记账**：记住执行过的编号，重复收到时不执行、只把上次结果再回一遍。专业上叫**幂等**。账要存在断电不丢的地方，否则重启后失效。
5. **太旧的命令作废**：5.0 的 **Message Expiry Interval**，消息在 broker 里待超时就扔掉；载荷里再放截止时间，由电表二次检查。

命令状态（业务服务的数据库里要记）：

```
[已创建] ─发送─→ [已下发] ─回执 ok──→ [成功]
                   │  ├─回执 fail─→ [失败]
                   │  ├─超时─→ 同一编号重发
                   │  └─重试用尽─→ [结果未知] ─查实际状态对账─→ 成功/失败
                   └─超过截止时间─→ [已过期]
```

拉闸这类高风险动作，工业上常用"先选择、后执行"：先发选择、设备回就绪，再在短窗口内发执行，窗口过期作废（通用做法，具体规约未展开核实）。

### 1.6 固件升级（OTA）

专业上叫 **OTA**（空中升级）。难点：文件大、过程长、刷坏可能开不了机。

不能一次发过去：电表内存可能只有几十 KB，broker 有单条大小限制（专题 17、28）。所以**切块逐块传**，并解决四件事：

1. **断了接着传**：每收好一块，在断电不丢的地方记下进度，上线从下一块继续。
2. **每块查有没有坏**：每块带校验值（常用 **CRC**），对不上只重要这一块。
3. **整包查对不对、是不是厂家的**：整包指纹（**SHA-256**）防漏块拼错；再用厂家公钥**验签名**，防止有人连包带指纹一起替换（专题 22、25）。
4. **刷坏能退回**：两块固件区域，新的写另一块，重启后自检，不行自动切回旧的。专业上叫 **A/B 分区**与**回滚**。

电表主动逐块去要，而不是被推，快慢由电表掌握（专题 28 背压）。

工程选择：
- **固件不一定走 MQTT**：10 万台 × 200 KB = 20 GB 压在 broker 上。常见做法是 MQTT 只发"有新版本、地址在这"，文件走 HTTPS；只有设备太弱或网络只通 MQTT 才走 MQTT 分块。
- **分批升级**：1% → 10% → 50% → 100%，每批盯失败率，超阈值自动停；批内加随机延迟。

## 2. 易混淆 / 易错点

| 错误理解 | 正确理解 |
|---|---|
| "后端"是一个东西 | 要分清业务服务（提要求）、影子服务（记账盯执行）、broker（传话） |
| 有了影子，broker 就不重要了 | 所有和电表的往来都过 broker，影子服务只是它的客户端之一 |
| 影子放进 broker 插件最省事 | 业务逻辑进 broker，牵连升级、扩容、排障 |
| PUBACK 成功 = 电表做了 | 只说明 broker 收到；看业务回执或 delta 变空 |
| 所有下发都用命令 | 能写成状态的写成状态 |
| 影子存 broker 保留消息就够 | 正本放数据库 |
| 实时读数也放 reported | 数据流走遥测主题 |
| QoS 2 能防重复执行 | 超时重发是全新消息，QoS 2 管不到；靠编号记账 |
| 幂等记录放内存 | 重启即丢，要放断电不丢的存储 |
| 重发换新编号 | 必须沿用原编号 |
| 重试用尽 = 失败 | 是"结果未知"，要对账 |
| SHA-256 对上就安全 | 还要验签名 |
| 刷完直接重启 | 要 A/B 分区 + 自检 + 回滚 |

## 3. 与其他章节的关联

| 本篇内容 | 相关专题 |
|---|---|
| PUBACK 只管一段路 | 10（回顾） |
| 会话过期，命令跟着丢 | 12（回顾） |
| 保留消息存期望值 | 14（回顾） |
| 属性：Response Topic、Correlation Data、Message Expiry | 17（回顾） |
| 电表只读写自己的影子主题 | 24（回顾） |
| 固件签名、命令防伪 | 22、25（回顾） |
| broker 持久化不可靠 → 正本放数据库；OTA 由设备控速 | 28（回顾） |
| 请求/响应细节 | 20 |
| 上行数据的去重与入库 | 41 |
| 客户端离线缓冲与幂等 | 43 |
| 受限设备内存 | 44 |
| 设备接入整体架构 | 50 |

## 4. 诊断实践

### 4.1 实验（云端真实输出）

> 说明：脚本里用一个 `backend` 客户端同时扮演了业务服务和影子服务两个角色，只为演示简洁；真实系统里它们是分开的。

**A 离线期间连改 3 次费率：命令 vs 期望值**（会话过期 5 秒；同时发命令和带版本号的保留期望值）

A1 离线 2 秒（会话还在）：

```
[device ] 离线 2s 后重连，Session Present=True
[device ] 收到命令 {'op': 'set_tariff', 'tariff': 'T1'}
[device ] 收到期望状态 {'tariff': 'T1', 'version': 1} retain=False → 应用
[device ] 收到命令 {'op': 'set_tariff', 'tariff': 'T2'}
[device ] 收到期望状态 {'tariff': 'T2', 'version': 2} retain=False → 应用
[device ] 收到命令 {'op': 'set_tariff', 'tariff': 'T3'}
[device ] 收到期望状态 {'tariff': 'T3', 'version': 3} retain=False → 应用
[result ] 共收到命令 3 条，最终 tariff 版本 = 3
```

A2 离线 7 秒（会话已过期）：

```
[device ] 离线 7s 后重连，Session Present=False
[device ] 会话已过期，重新订阅
[device ] 收到期望状态 {'tariff': 'T3', 'version': 3} retain=True → 应用
[result ] 共收到命令 0 条，最终 tariff 版本 = 3
```

命令全丢，期望值还在并直接是最终的 T3。

**B 命令闭环**

```
== B1 正常下发
[device ] 收到 c-000 → 执行 relay_on，继电器=on
[backend] 第 1 次发送 c-000（relay_on），等待回执 2s
[backend] 收到回执 {'id': 'c-000', 'result': 'ok', 'relay': 'on'}
== B2 回执丢失 → 后端重发 → 设备幂等
[device ] 收到 c-001 → 执行 relay_off，继电器=off
[device ] 回执 c-001 在网络中丢失（模拟）
[backend] 第 1 次发送 c-001（relay_off），等待回执 2s
[backend] c-001 超时未收到回执
[device ] 收到 c-001（重复）→ 不再执行，回放上次结果
[backend] 第 2 次发送 c-001（relay_off），等待回执 2s
[backend] 收到回执 {'id': 'c-001', 'result': 'ok', 'relay': 'off'}
```

继电器只动了一次。（设备日志先于"发送"日志出现，是因为本机投递比打印还快。）

过期对照（离线 5 秒后上线）：

```
[result ] Message Expiry=未设置，离线 5 秒后上线收到 1 条
[result ] Message Expiry=3，离线 5 秒后上线收到 0 条
```

**C OTA**（200 KB，16 KB 一块共 13 块；第 4 块后断电；第 7 块故意改坏一次）

```
[ota-svc] 发布清单（保留消息）：版本 2.5.0，204800 字节，13 块，sha256=8095320f22f0…
== C1 第一次下载，中途断电
[device ] 读到清单 v2.5.0，从第 0 块开始
[device ] 已写入 0..4 块，此时断电/断网！
== C2 重新上线，断点续传
[device ] 读到清单 v2.5.0，从第 5 块开始
[device ] 块 7 CRC 不符 → 重新请求
[device ] 全部 13 块完成，整包 SHA-256 校验：通过 → 切换分区、重启、上报新版本
```

未模拟签名验证和 A/B 分区。

### 4.2 脚本（本地：Mosquitto + `pip install paho-mqtt`）

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

`a_shadow.py`：

```python
# 实验 A：设备离线期间，"命令"与"期望状态（影子）"的区别
from common import *
def run(offline_secs, title):
    print(f"== {title}")
    c0,_=client("cleaner"); c0.publish("em/meter3/shadow/desired", b"", qos=1, retain=True).wait_for_publish(); stop(c0)   # 清掉上一轮的保留消息
    got=[]
    def on_msg(c,u,m): got.append((m.topic.split('/')[-1], json.loads(m.payload), m.retain))
    dev,_=client("meter3", clean=True, expiry=5, on_msg=on_msg)       # 会话过期 5 秒
    dev.subscribe([("em/meter3/down/cmd",1),("em/meter3/shadow/desired",1)]); time.sleep(0.5); stop(dev)
    log("device","下线")
    be,_=client("backend")
    for v,t in enumerate(["T1","T2","T3"],1):
        be.publish("em/meter3/down/cmd", json.dumps({"op":"set_tariff","tariff":t}), qos=1).wait_for_publish()
        be.publish("em/meter3/shadow/desired", json.dumps({"tariff":t,"version":v}), qos=1, retain=True).wait_for_publish()
        log("backend",f"发命令 set_tariff={t}；更新期望状态 tariff={t} version={v}")
    stop(be); time.sleep(offline_secs)
    dev,sp=client("meter3", clean=False, expiry=5, on_msg=on_msg)
    log("device",f"离线 {offline_secs}s 后重连，Session Present={sp}")
    if not sp: dev.subscribe([("em/meter3/down/cmd",1),("em/meter3/shadow/desired",1)]); log("device","会话已过期，重新订阅")
    time.sleep(1.5); stop(dev)
    cur=None
    for kind,body,ret in got:
        if kind=="cmd": log("device",f"收到命令 {body}")
        else:
            act = "应用" if cur is None or body["version"]>cur else "跳过（版本不新）"
            if act=="应用": cur=body["version"]
            log("device",f"收到期望状态 {body} retain={ret} → {act}")
    log("result",f"共收到命令 {sum(k=='cmd' for k,_,_ in got)} 条，最终 tariff 版本 = {cur}")
run(2, "A1 离线 2 秒（会话未过期）")
run(7, "A2 离线 7 秒（会话已过期 5 秒上限）")
```

`b_cmd.py`：

```python
# 实验 B：指令下发 + 回执 + 超时重发 + 设备端幂等 + 过期指令
from common import *
executed={}            # 设备端：已执行指令 id → 结果（真实设备要存进掉电不丢的存储）
drop_first_ack={"c-001"}
relay={"state":"on"}
def dev_msg(c,u,m):
    cmd=json.loads(m.payload); cid=cmd["id"]
    rt=m.properties.ResponseTopic; corr=m.properties.CorrelationData
    if cid in executed:
        log("device",f"收到 {cid}（重复）→ 不再执行，回放上次结果")
        result=executed[cid]
    else:
        relay["state"]="off" if cmd["op"]=="relay_off" else "on"
        result={"id":cid,"result":"ok","relay":relay["state"]}
        executed[cid]=result
        log("device",f"收到 {cid} → 执行 {cmd['op']}，继电器={relay['state']}")
    if cid in drop_first_ack:
        drop_first_ack.discard(cid); log("device",f"回执 {cid} 在网络中丢失（模拟）"); return
    p=Properties(PacketTypes.PUBLISH); p.CorrelationData=corr
    c.publish(rt, json.dumps(result), qos=1, properties=p)
dev,_=client("meter3", on_msg=dev_msg); dev.subscribe("em/meter3/down/cmd",1); time.sleep(0.5)

acks={}
def be_msg(c,u,m):
    acks[m.properties.CorrelationData.decode()]=json.loads(m.payload)
be,_=client("backend", on_msg=be_msg); be.subscribe("svc/backend1/acks",1); time.sleep(0.5)

def send(cid, op, expiry=30, timeout=2, retries=3):
    for n in range(1,retries+1):
        p=Properties(PacketTypes.PUBLISH); p.ResponseTopic="svc/backend1/acks"; p.CorrelationData=cid.encode(); p.MessageExpiryInterval=expiry
        be.publish("em/meter3/down/cmd", json.dumps({"id":cid,"op":op}), qos=1, properties=p).wait_for_publish()
        log("backend",f"第 {n} 次发送 {cid}（{op}），等待回执 {timeout}s")
        t=time.time()
        while time.time()-t<timeout:
            if cid in acks: log("backend",f"收到回执 {acks[cid]}"); return acks[cid]
            time.sleep(0.05)
        log("backend",f"{cid} 超时未收到回执")
    log("backend",f"{cid} 重试 {retries} 次仍失败 → 标记为'状态未知'，转人工/后续核对")
print("== B1 正常下发"); send("c-000","relay_on")
print("== B2 回执丢失 → 后端重发 → 设备幂等"); send("c-001","relay_off")
print("== B3 设备离线时下发，指令带 3 秒过期；设备 5 秒后上线")
stop(dev)
dev,_=client("meter3x", clean=True, expiry=3600, on_msg=dev_msg); dev.subscribe("em/meter3x/down/cmd",1); time.sleep(0.5); stop(dev)
p=Properties(PacketTypes.PUBLISH); p.MessageExpiryInterval=3; p.ResponseTopic="svc/backend1/acks"; p.CorrelationData=b"c-002"
be.publish("em/meter3x/down/cmd", json.dumps({"id":"c-002","op":"relay_off"}), qos=1, properties=p).wait_for_publish()
log("backend","已发送 c-002（Message Expiry=3s）给离线设备 meter3x")
time.sleep(5)
got=[]
dev,sp=client("meter3x", clean=False, expiry=3600, on_msg=lambda c,u,m: got.append(m.payload))
time.sleep(1.5); log("device",f"meter3x 上线，Session Present={sp}，收到指令 {len(got)} 条")
stop(dev); stop(be)
```

`b3_ctrl.py`：

```python
from common import *
for exp in (None, 3):
    dev,_=client("meter3y", clean=True, expiry=3600); dev.subscribe("em/meter3y/down/cmd",1); time.sleep(0.5); stop(dev)
    be,_=client("backend"); p=Properties(PacketTypes.PUBLISH)
    if exp: p.MessageExpiryInterval=exp
    be.publish("em/meter3y/down/cmd", b'{"id":"c-9","op":"relay_off"}', qos=1, properties=p).wait_for_publish(); stop(be)
    time.sleep(5); got=[]
    dev,sp=client("meter3y", clean=False, expiry=3600, on_msg=lambda c,u,m: got.append(m.payload)); time.sleep(1.5); stop(dev)
    log("result",f"Message Expiry={exp or '未设置'}，离线 5 秒后上线收到 {len(got)} 条")
```

`c_ota.py`：

```python
# 实验 C：OTA 分块下载 + 单块 CRC 校验 + 断点续传 + 整包 SHA-256 校验
from common import *
import os, hashlib, zlib, struct, random
random.seed(7)
FW=os.urandom(200*1024); CH=16*1024; CNT=(len(FW)+CH-1)//CH
manifest={"version":"2.5.0","size":len(FW),"sha256":hashlib.sha256(FW).hexdigest(),"chunk":CH,"count":CNT}
corrupt_once={7}
# ---- OTA 服务端：按设备请求发块 ----
def srv_msg(c,u,m):
    n=json.loads(m.payload)["n"]; data=FW[n*CH:(n+1)*CH]; crc=zlib.crc32(data)
    if n in corrupt_once: corrupt_once.discard(n); data=bytes([data[0]^0xFF])+data[1:]   # 模拟传输中被破坏
    c.publish("em/meter3/ota/chunk", struct.pack(">II",n,crc)+data, qos=1)
srv,_=client("ota-svc", on_msg=srv_msg); srv.subscribe("em/meter3/ota/req",1)
srv.publish("em/meter3/ota/manifest", json.dumps(manifest), qos=1, retain=True).wait_for_publish()
log("ota-svc",f"发布清单（保留消息）：版本 {manifest['version']}，{manifest['size']} 字节，{CNT} 块，sha256={manifest['sha256'][:12]}…")
# ---- 设备端 ----
flash=bytearray(len(FW)); progress={"next":0}     # 真实设备：flash 备用分区 + 掉电不丢的进度记录
def run_device(crash_after=None):
    st={"man":None,"waiting":None}; ev=threading.Event()
    def on_msg(c,u,m):
        if m.topic.endswith("manifest"): st["man"]=json.loads(m.payload); ev.set(); return
        n,crc=struct.unpack(">II",m.payload[:8]); data=m.payload[8:]
        if zlib.crc32(data)!=crc: log("device",f"块 {n} CRC 不符 → 重新请求"); c.publish("em/meter3/ota/req",json.dumps({"n":n}),qos=1); return
        flash[n*CH:n*CH+len(data)]=data; progress["next"]=n+1; ev.set()
    dev,_=client("meter3", on_msg=on_msg); dev.subscribe([("em/meter3/ota/manifest",1),("em/meter3/ota/chunk",1)])
    ev.wait(3); ev.clear(); man=st["man"]
    log("device",f"读到清单 v{man['version']}，从第 {progress['next']} 块开始")
    while progress["next"]<man["count"]:
        n=progress["next"]
        if crash_after is not None and n==crash_after: log("device",f"已写入 0..{n-1} 块，此时断电/断网！"); stop(dev); return False
        dev.publish("em/meter3/ota/req",json.dumps({"n":n}),qos=1); ev.wait(5); ev.clear()
    ok=hashlib.sha256(bytes(flash)).hexdigest()==man["sha256"]
    log("device",f"全部 {man['count']} 块完成，整包 SHA-256 校验：{'通过 → 切换分区、重启、上报新版本' if ok else '失败 → 丢弃，保持旧固件'}")
    stop(dev); return ok
print("== C1 第一次下载，中途断电"); run_device(crash_after=5)
time.sleep(1)
print("== C2 重新上线，断点续传"); run_device()
stop(srv)
```

### 4.3 现象 → 怀疑 → 观察点

| 现象 | 优先怀疑 | 观察点 |
|---|---|---|
| 业务说下发成功，电表没动作 | 只看了 PUBACK；会话过期命令丢失 | 命令状态记录；Session Present；会话过期时间 |
| 继电器动作两次 | 没幂等，或账没持久化、重启后丢失 | 同一编号在电表日志出现几次；电表重启时间 |
| 上线后执行了一周前的命令 | 没设过期 | Message Expiry；载荷截止时间 |
| 配置改了又被改回去 | 本地与远端冲突无规则 | 影子时间戳；双方写入记录 |
| broker 重启后电表拿不到期望配置 | 保留消息丢失，影子服务未补发 | broker 持久化；影子服务补发逻辑 |
| 一批电表升级后变砖 | 无 A/B 回滚或无分批 | 回滚率；分批记录 |
| 下载反复从头开始 | 进度没持久化或服务端不支持按块 | 电表续传点记录 |
| 升级时段平台变慢 | 全量同时下载、文件走 broker | broker 带宽；是否走 HTTPS/CDN |

## 5. 复习 checklist

- [ ] 能分清业务服务、影子服务、broker、数据库各自做什么，画出架构图
- [ ] 能说出影子之外还有哪几类往来直接走 broker，为什么
- [ ] 能用实验 A 说明命令模型的两个问题，以及写期望值为什么能解决
- [ ] 能用大白话解释 desired、reported、delta、version，知道看 delta 判断完成
- [ ] 能说出影子的边界，以及"拉闸写成状态"的思路
- [ ] 能一步步推出命令闭环的五个环节，并用实验 B 解释
- [ ] 能说明 QoS 2 为什么防不了重复执行、"重试用尽"为什么是"结果未知"
- [ ] 能说出 OTA 四件事、为什么由电表主动拉、固件为什么常走 HTTPS、为什么分批

---

参考：[AWS IoT · Device Shadow service documents](https://docs.aws.amazon.com/iot/latest/developerguide/device-shadow-document.html)、[AWS IoT · Device Shadow MQTT topics](https://docs.aws.amazon.com/iot/latest/developerguide/device-shadow-mqtt.html)
