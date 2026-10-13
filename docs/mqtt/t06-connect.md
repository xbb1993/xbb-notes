# 连接建立：CONNECT / CONNACK、Client ID 与连接标志

> 专题 6 · 模块二 · ★ 核心必会 · 侧重通用学习
> 版本基线：MQTT 5.0，3.1.1 差异单独标注
> 贯穿场景：电表以 Client ID `meter3` 连接 broker，订阅 `m/meter3/cmd` 接收指令

**对应全景图的哪一块**：电表主动建立长连接的那一刻。心跳（7）、会话（12）、遗嘱（15）、认证（23）都在这一刻约定。

## 1. 核心概念

### 1.1 类比：酒店前台办入住

| 入住时 | MQTT |
|---|---|
| 出示身份证 | Client ID |
| 会员卡和密码 | 用户名、密码 |
| "还住上次那间，东西别动" | Clean Start = 否（延续会话） |
| "超过 1.5 天没见到我就当我退房" | Keep Alive |
| "我失联了请通知家人" | 遗嘱消息 |
| 前台答"办好了，上次的房间还在" | CONNACK + Session Present |

### 1.2 CONNECT（表格视图）

```
┌──────────────────── CONNECT（meter3 申请连接）────────────────────┐
│ 【可变头】                                                        │
│   协议名：MQTT     协议级别：5（3.1.1 填 4）                         │
│   连接标志：有用户名？ 有密码？ 有遗嘱？(及遗嘱QoS、是否保留) Clean Start？│
│   Keep Alive：60 秒                                               │
│   属性（5.0）：如 Receive Maximum = 20                             │
│ 【载荷】按固定顺序，开关打开才有                                     │
│   Client ID（必填，可为空串）→ 遗嘱主题/内容 → 用户名 → 密码          │
└───────────────────────────────────────────────────────────────────┘
```

- 开关决定后面有没有对应的栏（字段按需出现）。
- 一条连接只能发一次 CONNECT，且必须是第一个报文，否则 broker 断开。
- 3.1.1：没有属性栏；"Clean Start" 叫 **Clean Session**，语义不同（专题 12）。

### 1.3 CONNACK

```
┌────────── CONNACK ──────────┐
│ Session Present：是/否       │ ← 实际有没有接上旧会话
│ 原因码：0x00 成功 / 拒绝原因   │
│ 属性（5.0）：分配的 Client ID、│
│   改写后的 Keep Alive 等       │
└─────────────────────────────┘
```

| 情况 | 3.1.1 返回码 | 5.0 原因码 |
|---|---|---|
| 成功 | 0 | 0x00 |
| 协议版本不支持 | 1 | 0x84 |
| Client ID 不合法 | 2 | 0x85 |
| 服务不可用 | 3 | 0x88 |
| 用户名或密码错 | 4 | 0x86 |
| 无权限 | 5 | 0x87 |
| 服务器忙、封禁、超配额等 | 无法表达 | 0x89、0x8A、0x97 等 |

**Session Present 必须检查**：为"否"时（broker 重启、会话过期），设备必须重新订阅，否则"在线但收不到指令"。

### 1.4 Client ID

- broker **只按 Client ID 认人**（不是 IP、不是用户名）；会话、离线消息、遗嘱都挂在它下面。
- 规范要求 broker 至少接受 1～23 个数字和字母；更长或其他字符 broker 可以接受（主流 broker 都接受）。

**接管（take-over）**：同一 ID 再次连接时，broker **断开旧连接、接受新连接**（5.0 发 DISCONNECT 0x8E Session taken over）。

为什么新的赢：设备断网重连时，broker 可能还没发现旧连接已死（半开连接，专题 7）；若拒绝新连接，设备要等很久才能恢复。

**互踢**：两个客户端用同一个 ID 且都会自动重连 → 你踢我、我踢你，无限循环。

```
 broker:  [meter3 = A] → [meter3 = B] → [meter3 = A] → [meter3 = B] ...
```

后果：收不全消息、日志刷屏、遗嘱反复误报离线。

### 1.5 Client ID 由谁定、怎么防撞名

**基本由设备自己设置**。broker 分配仅在传空 ID 时发生（5.0 通过属性 Assigned Client Identifier 返回；3.1.1 空 ID 只允许不保留会话），每次名字不同，只适合临时客户端。

三道防线：

| 防线 | 做法 |
|---|---|
| 源头唯一 | 用出厂序列号（生产系统统一发号，最推荐）、IMEI/MAC、或首次启动生成并**持久化**的 UUID；加前缀做命名空间：`dev-<型号>-<序列号>`、`svc-<服务>-<实例>`、`dbg-<人>-<时间>` |
| broker 校验 | Client ID 必须与认证身份（证书名或用户名）一致，不一致拒绝；可配设备注册表，未登记拒绝（专题 23～25） |
| 监测告警 | 监控接管次数（0x8E）；同一 ID 来自多个 IP 时告警（专题 46、47） |

量产常见坑：整片 flash 镜像拷贝导致一批设备 ID 相同。身份信息应与固件镜像分开存放、单独烧录。

| 场景 | 正确做法 |
|---|---|
| 网关下挂多台电表 | 网关用**自己的** ID 开一条连接，电表靠**主题**区分（专题 40） |
| 后端服务多实例 | 每个实例独立 ID，用共享订阅分摊（专题 19） |

### 1.6 局限

- 接管机制防不了冒充：拿到 ID 就能踢人，必须靠认证 + 授权绑定（专题 24、25）。
- 3.1.1 返回码太粗；5.0 原因码更细，但前提是两端都真的用 5.0 连接。

## 2. 易混淆 / 易错点

| 错误理解 | 正确理解 |
|---|---|
| broker 按 IP 或用户名区分设备 | 只按 Client ID |
| 同 ID 再连会被拒绝 | 新连接接管，旧连接被踢 |
| 被踢是 broker 出了问题 | 先查是否两个客户端共用一个 ID |
| 请求了延续会话就一定有会话 | 以 Session Present 为准，为"否"要重新订阅 |
| 3.1.1 也能用空 ID 延续会话 | 会返回码 2 |
| CONNACK 成功就能随便收发 | 主题权限由授权决定，失败体现在 PUBACK/SUBACK |
| 用户名就是 Client ID | Client ID 认会话，用户名认身份 |
| 用随机 UUID 每次开机生成就不会撞名 | 不撞名，但每次都像新设备，会话和指令都接不上；要持久化 |
| 网关下每台子设备都要一个 Client ID | 网关一条连接，子设备用主题区分 |

## 3. 与其他章节的关联

| 本篇内容 | 后续专题 |
|---|---|
| Keep Alive 栏 | 7 Keep Alive |
| 半开连接是接管的动机 | 7 |
| Clean Start、Session Present | 12 会话状态 |
| 遗嘱标志与栏目 | 15 遗嘱 |
| 原因码、属性 | 17 |
| 共享订阅替代多实例共用 ID | 19 |
| 用户名密码、ID 与身份绑定 | 23 认证、24 授权、25 设备身份与攻击 |
| 网关与子设备 | 40 边缘网关 |
| 接管次数告警 | 46 监控、47 故障诊断 |

## 4. 诊断实践

### 4.1 实验（云端真实输出，Mosquitto 2.0.18）

**① 两个客户端同用 `meter3`**，观察 5 秒：

```
旧客户端：
Client meter3 sending CONNECT
Client meter3 received CONNACK (0)
Received DISCONNECT (142)          ← 0x8E Session taken over
Client meter3 sending CONNECT      ← 自动重连，再去踢对方
...
broker 日志：
New client connected from 127.0.0.1:45340 as meter3 (p5, c1, k60).
Client meter3 already connected, closing old connection.
New client connected from 127.0.0.1:45344 as meter3 (p5, c1, k60).
```

抓包：5 秒内 broker 发出 4 次 `Session taken over (142)`。日志 `p5, c1, k60` = 协议级别 5、Clean Start 是、Keep Alive 60。

**② Session Present**：

```
第1次  Clean Start=否（会话保留300秒） → Session Present=否（之前没有会话）
第2次  Clean Start=否（会话保留300秒） → Session Present=是（接上了）
第3次  Clean Start=是                 → Session Present=否（主动丢弃）
```

**③ 空 Client ID**（构造原始 CONNECT）：

| 版本 | 发送 | 回复 |
|---|---|---|
| 5.0 | 空 ID + Clean Start=是 | 成功，属性带回 `auto-AADB15C1-DC99-...` |
| 3.1.1 | 空 ID + Clean Session=否 | 返回码 2 |

**④ 匿名连接被拒**（broker 禁止匿名）：5.0 客户端提示 `Not authorized`，3.1.1 提示 `Connection Refused: not authorised`。

本地复现（互踢）：

```bash
mosquitto_sub -V 5 -i meter3 -t 'm/meter3/cmd' -d &
mosquitto_sub -V 5 -i meter3 -t 'm/meter3/cmd' -d &
sleep 5; kill %1 %2
docker logs mosquitto | grep "already connected"
```

### 4.2 现象 → 怀疑 → 观察点

| 现象 | 优先怀疑 | 观察点 |
|---|---|---|
| 设备频繁上下线、日志刷屏 | Client ID 冲突互踢 | 日志 `already connected`；断开原因 0x8E；同 ID 来自几个 IP |
| 设备在线但收不到指令 | 会话没接上又没重新订阅 | CONNACK Session Present；broker 上该客户端的订阅列表 |
| 连接被拒 | 版本、认证、ID 不合法 | 返回码 / 原因码；broker 日志 |
| 遗嘱频繁误报离线 | 互踢导致反复断开 | 同第一行 |
| 新一批设备上线就互踢 | 量产时 ID 随镜像被复制 | 对比这批设备的 ID 是否相同 |

## 5. 复习 checklist

- [ ] 能用"酒店入住"类比说出 CONNECT 的各栏用途
- [ ] 能说出 CONNECT 必须是第一个且唯一的 CONNECT
- [ ] 能说出 CONNACK 的两个关键栏，以及 Session Present 为"否"时设备该做什么
- [ ] 能说出 3.1.1 返回码与 5.0 原因码的差别，记住 0x87、0x86、0x85
- [ ] 能解释为什么同 ID 是"新的接管旧的"
- [ ] 能画出互踢循环，说出四个真实成因
- [ ] 能说出 Client ID 防撞名的三道防线
- [ ] 能说出网关场景和后端多实例场景的正确做法
- [ ] 能说出 5.0 与 3.1.1 对空 Client ID 的不同处理
