# Line Protocol 详解：类型、转义、精度与重复点

> 专题 5 · 模块二 · ★ 核心必会 · 主线：W
> 地图位置：写入路径第 ① 步"解析行协议"。写入失败大多发生在这一步；重复点的合并规则是补传、重算覆盖的基础。
> 实验环境：云端 1.6.7 实测；规则已对照 v1 官方文档。

## 一、核心概念

### 1.1 语法骨架：空格分段，逗号分项

```
meter,meter_id=m1,phase=A   kwh=1000.5,voltage=229.8   1795593600000000000
└────────── 第 1 段 ──────┘ └───────── 第 2 段 ────────┘ └────── 第 3 段 ──────┘
  measurement + tag            field                       时间戳（可省略）
```

| 符号 | 作用 |
|---|---|
| 空格 | 分隔三段 |
| 逗号 | 分隔同一段内的各项 |
| 等号 | 连接 key 和 value |
| `#` 开头 | 整行注释 |

换行符不能出现在 tag 值或 field 值里。

### 1.2 转义（官方文档）

| 位置 | 需要用 `\` 转义的字符 |
|---|---|
| measurement | 逗号、空格 |
| tag key、tag value、field key | 逗号、等号、空格 |
| 字符串 field 值（双引号内） | 双引号、反斜杠 |

实测：

```
esc,site=Plant A kwh=1 T              → 400 invalid field format（空格被当成分段）
esc,site=Plant\ A kwh=1 T             → 204
note="fault, phase A lost"            → 204（双引号内的逗号、空格不用转义）
note="say "hi""（未转义）              → 204（碰巧成功）
note="say "hi there""（未转义）        → 400 bad timestamp（报错与原因看似无关）
note="say \"hi\""                     → 204
meter,v2 kwh=1 T                      → 400 missing tag value
```

建议：用客户端库生成行协议，不要手工拼接字符串。

### 1.3 时间戳与精度

- 默认单位纳秒。写入参数 `precision` 可取 `n`、`u`、`ms`、`s`、`m`、`h`，默认 `n`（v1 API 文档）。
- 时间戳不能加引号，否则报 `bad timestamp`。
- 官方建议使用尽可能粗的精度，压缩效果更好。

实测（同一时刻 2026-11-25 08:00 UTC）：

| 写法 | 结果 |
|---|---|
| 秒级时间戳，不带 precision，写入永久保留的 autogen | **204，时间变成 1970-01-01**，新建了 1969-12-29 起的箱子 |
| 同上，写入保留 30 天的 RP | 400 `points beyond retention policy` |
| 秒级时间戳 + `precision=s` | 204，时间正确 |
| 纳秒时间戳 + `precision=s` | 400 `time outside range` |

### 1.4 省略时间戳

规则：使用服务器收到请求时的 UTC 纳秒时间。

```
同一请求 3 行同一 series、不带时间戳 → 204，最终只剩 1 行（kwh=3）
同一请求、不同 series → 两行时间戳完全相同
```

- 同一请求里的所有点共用一个时间戳，同一 series 的点会互相覆盖，**静默丢失数据**。
- 补传时不带时间戳，记录的是到达时间，而不是测量时间。
- 设备或网关必须自带测量时间戳。

### 1.5 部分写入

```
3 行中第 2 行写成 kwh=oops
→ 400 "partial write: unable to parse '...kwh=oops...': invalid boolean dropped=0"
→ 第 1、3 行已经写入
```

- 400 **不等于什么都没写进去**。
- 不带引号的文字被当成布尔值解析，所以报错是 `invalid boolean`。
- `dropped` 不统计解析失败的行，只统计类型冲突、超出保留期等被丢弃的点。
- 整批重发是安全的（见 1.6 的幂等性），但坏行要先修好。

### 1.6 重复点：合并与覆盖

官方规则："the field set becomes a union of the old and new field set, and conflicts favor the new field set." 即新旧 field 取并集，同名 field 用新值覆盖。

从 `dup,meter_id=m1 raw=1000.5,diff=0.5 T` 开始：

| 操作 | 结果 | 说明 |
|---|---|---|
| 同一时间戳只重写 `raw=2000.0` | raw=2000，**diff=0.5** | 没写的 field 保留旧值，raw 和 diff 可能变得不一致 |
| 同一时间戳写 `voltage=230` | diff、raw、voltage 都在 | 取并集；**重写无法删掉 field** |
| 同一请求同一点写两次 | 后一次生效 | 请求内也是后写的覆盖先写的 |
| 同一时间戳，tag 写成 `M1` | 多出 M1 一行，m1 那行不变 | tag 区分大小写，是另一条 series，变成新增 |

**覆盖成功的前提**：RP、measurement、tag 组合、时间戳（精确到纳秒）四样完全一致。任何一样不同都会变成新增数据，导致重复（例如原来按毫秒写入、重算时按秒写入）。

**幂等**：同一批带测量时间戳的数据重发多次，结果和只发一次相同。"至少一次投递 + 幂等入库"在 InfluxDB 端依赖的就是这条规则。

覆盖在存储层并不是原地修改，而是追加新值，在查询合并或压实时以新值为准（专题 11、12）。

### 1.7 串联图

```
一行文本
  │ ① 按空格分段、逗号分项、等号分 key/value（未转义会切错，报错位置可能误导）
  │ ② 解析 field 类型（小数=float，i=integer，"..."=string，t/f=boolean）
  │ ③ 时间戳：有 → 按 precision 换算成纳秒；没有 → 服务器时间（同一请求共用）
  ▼
  某行解析失败 → 只丢该行，其余照常写入 → 400 partial write
  ▼
  落箱（专题 4）→ 类型检查（专题 2）
  ▼
  (RP, measurement, tag 组合, 时间戳) 已存在？
     ├─ 是 → field 取并集，同名覆盖
     └─ 否 → 新的点（大小写、精度、RP 不同都会走到这里）
```

## 二、易混淆 / 易错点

| 错误理解 | 正确理解 |
|---|---|
| 报错指出的位置就是出错的位置 | 未转义的分隔符会让解析器切错，报错常出现在后面 |
| 字符串里的引号不转义也能写进去 | 有时碰巧成功，有时报 `bad timestamp`；一律转义 |
| 时间戳单位写错一定会报错 | 秒当成纳秒、写入永久保留的 RP 时，会静默写进 1970 年 |
| 不写时间戳也没关系 | 同一请求内同一 series 的点互相覆盖；补传记录的是到达时间 |
| 400 就是整批失败 | 可能是部分写入，好的行已经写进去了 |
| `dropped=0` 说明没丢数据 | `dropped` 不统计解析失败的行 |
| 重写一次就把旧数据替换了 | 只覆盖本次写入的 field，没写的保留旧值 |
| 重写时少写一个 field 就等于删掉它 | 取并集，删不掉；要用删除操作 |
| 重写一定是覆盖 | RP、measurement、tag、时间戳必须完全一致，否则是新增 |

## 三、与其他章节的关联

| 关联对象 | 关系 |
|---|---|
| 专题 2 | field 类型的写法与类型冲突 |
| 专题 3 | tag 大小写不同就是不同的 series |
| 专题 4 | 时间戳错误导致"超出保留期"，或在 1970 年新建箱子 |
| 专题 6 | 需要一致的 field（raw、diff）放在同一个点、一起写入 |
| 专题 10 | 为什么粗精度时间戳压缩更好 |
| 专题 11、12 | 覆盖在存储层的实现；删除 field 只能用删除操作 |
| 专题 29、35 | 补传、历史数据修订依赖幂等覆盖 |
| 专题 30 | raw 与 diff 的一致性 |
| 专题 32 | 返回码完整含义与客户端库 |
| MQTT 专题 41 | 至少一次投递 + 幂等入库；事件时间 vs 到达时间 |

## 四、诊断实践

| 现象 | 看哪里 | 判断与处置 |
|---|---|---|
| 400 `invalid field format` / `missing tag value` | 报错引用的行，查未转义的空格、逗号 | 转义问题，改用客户端库 |
| 400 `bad timestamp` | 时间戳有没有加引号；字符串里的双引号有没有转义 | 引号没有闭合，后面整段被误解析 |
| 400 `invalid boolean` | 字符串值有没有加双引号 | 没加引号的文字被当成布尔值 |
| 400 `time outside range` | `precision` 是否与时间戳单位一致 | 单位放大了 |
| 写入成功但查不到 | `SHOW SHARDS` 是否有 1970 年附近的箱子 | 单位偏小，又没传 `precision` |
| 条数比上报的少 | 写入是否省略了时间戳 | 同一请求共用时间戳，互相覆盖 |
| 重写后出现重复 | 对比 tag 大小写、时间戳精度、RP | 四样之一不一致 |
| 重写后 raw 与 diff 对不上 | 是否只重写了部分 field | 相关 field 要在同一次写入里一起重写 |

本地复现（1.13.2）：

```bash
w() { curl -s -w ' [HTTP %{http_code}]\n' -XPOST "http://localhost:8086/write?db=lp5$1" --data-binary "$2"; }
q() { docker exec influx113 influx -database lp5 -execute "$1"; }
docker exec influx113 influx -execute "CREATE DATABASE lp5"
T=1795593600000000000
w "" "esc,site=Plant A kwh=1 $T"                     # 预期 400
w "" "esc,site=Plant\ A kwh=1 $T"                    # 预期 204
w "" "prec,meter_id=m1 kwh=1 1795593600"             # 预期 204，落到 1970
w "&precision=s" "prec,meter_id=m1 kwh=2 1795593600"
w "" "nots,meter_id=m1 kwh=1
nots,meter_id=m1 kwh=2
nots,meter_id=m1 kwh=3";  q "SELECT kwh FROM nots"   # 预期只剩 1 行
w "" "batch,meter_id=m1 kwh=1 $T
batch,meter_id=m2 kwh=oops $T
batch,meter_id=m3 kwh=3 $T"; q "SELECT * FROM batch" # 预期 400，但 m1、m3 已写入
w "" "dup,meter_id=m1 raw=1000.5,diff=0.5 $T"
w "" "dup,meter_id=m1 raw=2000.0 $T"; q "SELECT raw, diff FROM dup"
w "" "dup,meter_id=M1 raw=3000 $T";   q "SELECT raw, meter_id FROM dup"
```

## 五、复习 checklist

- [ ] 能说出空格、逗号、等号各自的分隔作用
- [ ] 能背出三类位置各需转义哪些字符
- [ ] 知道报错位置可能与真正出错的位置不一致
- [ ] 能列出 `precision` 的取值，说出单位写错的两种后果
- [ ] 知道省略时间戳时，同一请求内的点共用一个时间戳
- [ ] 知道 400 可能是部分写入，`dropped` 不统计解析失败
- [ ] 能背出重复点规则：并集 + 同名覆盖
- [ ] 知道只重写部分 field 时，其他 field 保留旧值
- [ ] 能说出覆盖成功的四个前提
- [ ] 能解释为什么带测量时间戳的补传是幂等的
