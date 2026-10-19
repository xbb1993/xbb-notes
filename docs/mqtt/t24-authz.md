# 授权：ACL 与主题权限设计

> 专题 24 · 模块五 · ★ 核心必会 · 侧重两者兼顾
> 版本基线：MQTT 5.0
> 贯穿场景：10 万台电表各自只能碰自己的主题；入库服务只读遥测；平台可向任意电表下发指令

**对应全景图的哪一块**：认证确认"你是谁"之后，决定"能对哪些主题做什么"。专题 8 的主题树在这里变成权限规则。

## 1. 核心概念

### 1.1 为什么要授权

只认证不授权，一台被攻破的电表就能：订阅 `em/#` 窃取全部数据；发到别人的 `up` 伪造计量；发到别人的 `down/cmd` 下"拉闸"指令。

**最小权限原则**：每个身份只拿完成本职所需的最小权限。

> 类比：认证是刷卡确认你是员工，授权是这张卡只能开你所在楼层的门。

### 1.2 ACL

"谁 × 哪些主题 × 什么动作 → 允许/拒绝"。**发布（写）与订阅/接收（读）分开设。**

### 1.3 模板规则

前提：**主题里带设备 ID**（专题 8）。Mosquitto（`%u` 用户名，`%c` Client ID；EMQX 用 `${username}`、`${clientid}`）：

```
# 设备模板（用户名 = 设备序列号）
pattern write em/%u/up/#
pattern write em/%u/status
pattern read  em/%u/down/#

user svc-ingest
topic read em/+/up/telemetry/#

user svc-platform
topic write em/+/down/#
```

| 身份 | 能发布 | 能接收 |
|---|---|---|
| 电表 X | `em/X/up/#`、`em/X/status` | `em/X/down/#` |
| 入库服务 | 无 | `em/+/up/telemetry/#` |
| 平台 | `em/+/down/#` | — |

### 1.4 Client ID 必须与身份绑定

ACL 按用户名判断时，冒用者读不到别人的数据，但可**填别人的 Client ID 把正主踢下线**（接管机制，专题 6），触发其遗嘱、互踢。

| 方式 | 做法 |
|---|---|
| Mosquitto 用户名认证 | `use_username_as_clientid true`（实测：冒用者的 Client ID 被强制改为自己的用户名） |
| Mosquitto 证书认证 | `use_identity_as_username` + `use_username_as_clientid`（按选项含义推断，未实测组合） |
| EMQX 等 | 规则中校验 `${clientid}` 与 `${username}`/证书 CN 一致 |

### 1.5 设计要点

| 要点 | 说明 |
|---|---|
| 警惕通配符 | 给所有设备 `readwrite em/#` 是最常见的错误配置；大范围订阅只给少数后端且只读 |
| 默认拒绝 | 白名单：漏写只会功能不可用，不会越权（Mosquitto 配置 `acl_file` 后未匹配即拒绝） |
| 检查时机 | 发布时（5.0 回 0x87）；订阅时（部分 broker 在 SUBACK 拒绝）；**投递时**（Mosquitto 订阅一律接受、投递再按读权限过滤） |
| 规则存放 | 配置文件（模板为主）；数据库/HTTP（动态，需缓存）；JWT 中的 acl（EMQX） |
| 多租户 | 主题前缀加租户 `em/{租户}/{设备}/...`，规则同时限定（50） |

### 1.6 局限

- 只管主题层面；被攻破设备在自己的主题上发假数据，需数据校验与异常检测。
- 主题设计决定授权粒度。
- 每条消息都有检查开销，外部授权服务影响吞吐（28、48）。

## 2. 易混淆 / 易错点

| 错误理解 | 正确理解 |
|---|---|
| 认证通过就安全 | 还要授权限定只能碰自己的主题 |
| 给设备 `readwrite em/#` 方便调试 | 任何设备可看全部、可给任何设备下指令 |
| 发布订阅权限一起给 | 分开，按最小权限 |
| 每台设备写一条规则 | 模板占位符一条管所有 |
| ACL 限制了用户名，Client ID 无所谓 | 可被冒用踢掉正主，需绑定 |
| SUBACK 成功即有权接收 | 可能投递时才过滤 |
| 3.1.1 PUBACK 成功即有权限 | 无法表达拒绝，看 broker 日志 |
| 没写到的规则默认允许 | 应默认拒绝 |

## 3. 与其他章节的关联

| 本篇内容 | 相关专题 |
|---|---|
| 接管与互踢、ID 绑定 | 6（回顾） |
| 主题带设备 ID、上下行分开 | 8（回顾） |
| 遗嘱主题需授权 | 15（回顾） |
| 0x87、订阅时不拒绝 | 17（回顾） |
| 证书 CN | 22（回顾） |
| 用户名、JWT acl | 23（回顾） |
| Client ID 劫持等攻击 | 25 |
| 授权开销 | 28、48 |
| 多租户 | 50 |

## 4. 诊断实践

### 4.1 实验（云端真实输出，Mosquitto 2.0.18，ACL 同 1.3）

在线监听：入库服务；meter1 订阅 `em/#`（想偷看全部）；meter2 订阅自己的指令。

```
  A1 meter1 发自己的遥测           → PUBACK RC:0
  A2 meter1 冒充 meter2 发遥测     → PUBACK RC:135
  A3 meter1 伪造给 meter2 的指令    → PUBACK RC:135
  A4 平台给 meter2 下发指令         → PUBACK RC:0
  A5 平台给 meter1 下发指令         → PUBACK RC:0
  A6 入库服务尝试发布              → PUBACK RC:135
--- 各订阅者实际收到：
  ingest 收到 em/dev-em300-SN20260001/up/telemetry/power 12.3
  meter1(订阅 em/#) 收到 em/dev-em300-SN20260001/down/cmd set-period-60
  meter2 收到 em/dev-em300-SN20260002/down/cmd set-period-30
--- broker 拒绝日志：
  Denied PUBLISH from m1p (... 'em/dev-em300-SN20260002/up/telemetry/power', ...)
  Denied PUBLISH from m1p (... 'em/dev-em300-SN20260002/down/cmd', ...)
  Denied PUBLISH from ing2 (... 'em/dev-em300-SN20260001/up/telemetry/power', ...)
```

- 越权发布被拦，返回 0x87（135）。
- meter1 订阅 `em/#` 只收到发给自己的指令；连自己发的遥测也收不到（只有写权限，没有读权限）。

**Client ID 冒用**：

```
=== B1 未限制：meter1 用自己的账号、却把 Client ID 填成 meter2 的 ===
  真 meter2 是否被踢：是，收到 DISCONNECT 0x8E Session taken over
  日志：... as dev-em300-SN20260002 (p5, c1, k60, u'dev-em300-SN20260002').   ← 真 meter2
  日志：... as dev-em300-SN20260002 (p5, c1, k60, u'dev-em300-SN20260001').   ← 冒用者
=== B2 开启 use_username_as_clientid ===
  真 meter2 是否被踢：否
  日志：... as dev-em300-SN20260002 (..., u'dev-em300-SN20260002').
  日志：... as dev-em300-SN20260001 (..., u'dev-em300-SN20260001').            ← 被强制改为自己的 ID
```

本地复现：

```bash
mosquitto_passwd -c -b pw dev-em300-SN20260001 p1; mosquitto_passwd -b pw dev-em300-SN20260002 p2
# mosquitto.conf: allow_anonymous false / password_file pw / acl_file acl.txt / use_username_as_clientid true
mosquitto_pub -V 5 -q 1 -u dev-em300-SN20260001 -P p1 -t em/dev-em300-SN20260002/down/cmd -m trip -d | grep PUBACK
```

### 4.2 现象 → 怀疑 → 观察点

| 现象 | 优先怀疑 | 观察点 |
|---|---|---|
| 发布返回 0x87，或 3.1.1 下数据消失 | 主题不在授权范围（拼写、租户前缀、大小写） | Denied 日志；对照模板 |
| 订阅成功却收不到部分消息 | 投递时被读权限过滤 | Denied 日志；读规则 |
| 某设备反复被踢、上下线跳动 | Client ID 被冒用 | 同一 Client ID 来自哪些用户名、IP |
| 审计发现设备能读别人数据 | 规则通配符过宽 | 搜索规则中的 `#` |
| 新业务部分功能不工作 | 默认拒绝，未加规则 | Denied 日志中的新主题 |
| 授权变慢、发布延迟升高 | 外部授权服务瓶颈 | 接口耗时；缓存命中率 |

## 5. 复习 checklist

- [ ] 能说出不授权时一台被攻破设备能做的三件事，以及最小权限原则
- [ ] 能写出电表场景的 ACL 模板，说明读写为何分开
- [ ] 能解释实验中 meter1 订阅 `em/#` 为何只收到自己的指令
- [ ] 能说明 Client ID 冒用的危害及 `use_username_as_clientid` 的作用
- [ ] 能说出通配符风险、默认拒绝、三种检查时机、规则存放方式
- [ ] 能按现象表排查授权问题

---

参考：[Mosquitto · mosquitto.conf](https://mosquitto.org/man/mosquitto-conf-5.html)、[EMQX · Authorization](https://docs.emqx.com/en/emqx/latest/access-control/authz/authz.html)
