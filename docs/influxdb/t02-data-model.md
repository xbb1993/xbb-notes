# 数据模型：measurement、tag、field、时间戳与 point

> 专题 2 · 模块二 · ★ 核心必会 · 主线：S Q
> 地图位置：写入路径第 ① 步"解析行协议"。解析出来的这几样东西，决定后面怎么拼 series、查不查索引、按什么类型存储。
> 实验环境：云端 1.6.7 真实运行；与 1.13.2 可能存在的差异已标注。

## 一、核心概念

### 1.1 从一句话推出四个组成部分

最小例子："电表 m1 在 2025-11-25 00:00 的累计电度是 1000.5 kWh。"

| 步骤 | 要解决的问题 | 得到的概念 |
|---|---|---|
| 1 | 什么时候 | **时间戳**（timestamp），默认单位纳秒 |
| 2 | 测的是什么、值是多少 | **field**（字段）`kwh=1000.5`；同一时刻往往有多个值，合起来叫 **field set** |
| 3 | 是谁。如果放在 field 里，查"m1 的数据"就得逐条比较 | **tag**（标签）`meter_id=m1`，建索引，可以快速定位 |
| 4 | 为什么不给所有东西建索引 | 索引成本取决于取值有多少种：meter_id 只有 1 万种，几乎不增长；kwh 几乎每条都不同。所以只给"是谁"建索引 |
| 5 | 不同种类的数据要分开 | **measurement**（测量名），作用类似表名 |
| 6 | 四样东西合起来 | **point**（数据点）= measurement + tag set + field set + 时间戳 |

```
meter,meter_id=m1 kwh=1000.5,voltage=229.8 1764028800000000000
└─┬─┘ └────┬────┘ └──────────┬──────────┘ └────────┬────────┘
measurement tag set       field set              时间戳
```

| | tag | field |
|---|---|---|
| 用途 | 说明"是谁"，用来筛选和分组 | 测量值本身，用来计算 |
| 取值种类 | 有限，最好不增长 | 无限，每条都可能不同 |
| 是否建索引 | 建 | 不建 |
| 类型 | 只能是字符串 | float / integer / string / boolean |

### 1.2 point 的判断依据与"一行"模型

- 一个 point 由四部分组成：一个 measurement、**一组确定的 tag 组合**、**一组 field**（至少一个）、一个时间戳。
- **判断是不是同一个 point，只看 measurement + tag 组合 + 时间戳，field 不参与判断**。官方原话："A point is uniquely identified by its series and timestamp."
- 再写一次相同的（measurement, tag 组合, 时间戳）：新旧 field set **合并**，同名 field 用新值覆盖。
- 可以把 point 理解成"一行以（measurement, tag 组合, 时间戳）为主键、按 upsert 方式写入的数据"，但要记住：

| | 关系库里的"一行" | InfluxDB 的 point |
|---|---|---|
| 主键 | 自己定义 | 固定：measurement + tag 组合 + 时间戳 |
| 再写一次相同主键 | 报错或产生重复行 | 合并，同名 field 覆盖 |
| 列 | 建表时定好，没值存 NULL | 每个 point 的 field 可以不同，没写的不存 |
| 物理存储 | 整行存在一起 | 每个 field 单独存放，"一行"是查询时按时间戳拼出来的 |

**实验（云端 1.6.7）**：

```
写入 1：meter,meter_id=m1 kwh=1000.5     T1   → 204
写入 2：meter,meter_id=m1 voltage=229.8  T1   → 204
写入 3：meter,meter_id=m2 kwh=2000.1     T1   → 204

SELECT * FROM meter
1764028800000000000 1000.5 m1 229.8     ← 写入 1 和 2 合并成同一个 point
1764028800000000000 2000.1 m2           ← tag 组合不同，是另一个 point

COUNT(kwh)=1, COUNT(voltage)=1          ← 各 field 分开计数：存储层按 field 分列
```

**查询时选哪些 field 只决定显示哪几列，不改变 point 的归属**（T1 写 a、b、c，T2 只写 b）：

```
SELECT a     → 只有 T1 一行（T2 没有 a，整行不出现）
SELECT a,b   → T1：1 2；T2：（空）20     ← 所选 field 中只要有一个有值，这一行就出现
```

### 1.3 schema on write 与"登记"的位置

- 没有建表语句，写入方写成什么样，结构就是什么样（schema on write，写入即定义结构）。
- **tag key**：登记在索引里，跟着 series 一起存在。
- **field 的类型**：按"measurement + field"登记在**每个 shard 自己的** `fields.idx` 里，**不区分是哪块表**；shard 被删除时，这份登记也一起消失。

### 1.4 tag 只能是字符串

官方原话："Tag keys and tag values are both strings."

```
写入：meter,meter_id=1001 kwh=7.5
WHERE meter_id=1001     → 空结果，不报错（数字和字符串比较，永远不相等）
WHERE meter_id='1001'   → 7.5
```

### 1.5 field 的四种类型（1.x 官方文档）

| 类型 | 写法 | 说明 |
|---|---|---|
| float | `kwh=1000.5`、`kwh=1001` | 默认类型，数字后面不加任何后缀就是浮点 |
| integer | `pulse=1001i` | 必须带 `i`，64 位有符号整数 |
| string | `status="ok"` | 必须加双引号，最长 64KB |
| boolean | `online=true` | t/T/true/True/TRUE（假值同理），不能加引号 |

- 无符号整数 `u`：1.x 官方类型表里没有。云端 1.6.7 实测 `cnt=5u` 返回 `invalid number`（400）。1.13.2 的行为**未核实**。1.x 上不要使用。

### 1.6 field 类型冲突

**同一个 shard 内会被拒绝，跨 shard 可以写入**。官方原话："Field value types cannot differ within a shard, but they can differ across shards."

```
（T1、T2 在 11-24 那一周的 shard；T3 在 12-01 那一周的 shard）
kwh=1000.5  T1 → 204
kwh=1001i   T2 → 400 {"error":"partial write: field type conflict: input field \"kwh\" on measurement
                 \"meter\" is type integer, already exists as type float dropped=1"}
kwh=1001    T2 → 204（去掉 i 就成功）
kwh=1002i   T3 → 204（下一个 shard）
```

为什么只在 shard 内检查：类型登记在每个 shard 自己的 `fields.idx` 里，写入时只和这个 shard 的登记比对。为什么这样设计，官方没有说明；推断是因为 shard 独立存储、独立过期，跨 shard 检查成本太高。

**补充规则（实验验证）**：

1. **被拒绝的类型不会登记**，`SHOW FIELD KEYS` 只反映写入成功的类型。
2. **一个 point 要么整个写入，要么整个丢弃**：`kwh=1002i,current=5.1` 里只有 kwh 冲突，整个 point 被丢弃，全新的 field `current` 也没有被登记。
3. **类型登记不区分是哪块表**：m2 先在某个 shard 写了 `kwh=5i`，m1 再在同一个 shard 写 `kwh=1000.5` 就会被拒绝（`is type float, already exists as type integer`）。

### 1.7 查询时遇到多种类型：按优先级选一种，其余的不返回

规则（官方 FAQ）：在本次查询涉及的 shard 里，按 **float → integer → string → boolean** 的顺序选排在最前的类型返回；integer 可以转成 float 一起返回，其余类型的数据不返回。

**优先级只在查询时间范围涉及的 shard 之间比较**（t2 库：11-24 那一周是 float，12-01 那一周是 integer，12-08 那一周是 string）：

```
只查 12-08 之后（只有 string）    → bad
查 12-01 之后（integer + string） → 1002（"bad" 不返回）
查全部（三种类型都有）              → 1000.5 / 1001 / 1002（"bad" 不返回）
SELECT kwh::string                → bad
SELECT kwh::integer               → 1000 / 1001 / 1002   ← 1000.5 被截断成了 1000
```

- 挑选 shard 只看时间范围，不看 tag 条件。加上类型登记不分表，其他表写错的类型也会影响你的查询。
- `SHOW FIELD KEYS` 会列出所有 shard 登记过的类型。1.6.7 不支持给它加 `WHERE time`（语法错误）；1.13.2 未核实。

### 1.8 tag 和 field 同名

```
写入：meter,meter_id=m1,phase=A kwh=1000.5,phase="A相"     → 204，没有任何警告
SELECT *                          → phase=A相  phase_1=A
SELECT phase                      → 只返回 field（A相）
SELECT "phase"::tag, "phase"::field → phase=A  phase_1=A相（_1 加在哪一列取决于书写顺序）
```

结论：不要让 tag 和 field 同名。

### 1.9 串联图

```
一句话："m1 在 T 时刻的 kwh 是 1000.5"
   ├─ 什么时候 ─────→ 时间戳
   ├─ 测什么、多少 ──→ field（不建索引）
   │                    └ 类型按"measurement + field"登记在【每个 shard】，不分表
   │                       ├ 同 shard 不同类型 → 整个 point 被拒（400），新 field 也不登记
   │                       └ 跨 shard 不同类型 → 能写入；查询时按优先级只返回一种
   ├─ 是谁 ─────────→ tag（只能是字符串，建索引，取值必须有限）
   └─ 哪一类 ───────→ measurement
   
四样合起来 = point
   唯一标识 = measurement + tag 组合 + 时间戳（field 不参与）
   再写一次 = field set 合并，同名覆盖
   查询结果里的"一行" = 按时间戳把各 field 列拼起来
measurement + tag 组合 → series（专题 3）
```

## 二、易混淆 / 易错点

| 错误理解 | 正确理解 |
|---|---|
| point 由某一个 field 决定 | point 带的是一组 field；判断是否同一个 point 只看 measurement + tag 组合 + 时间戳 |
| 再写一次相同时间戳会新增一行 | 合并成同一个 point，同名 field 被覆盖 |
| `SELECT a` 返回 1 行，所以只有 1 个点 | 没有 a 的 point 整行不出现；统计数量要用 `COUNT(a)` |
| measurement 是一张有固定列的表 | 没有建表语句，每个 point 的 field 可以不同 |
| 没写的 field 存成 NULL | 根本不存 |
| 表号是数字，WHERE 里不用加引号 | tag 永远是字符串，不加引号会返回空，而且不报错 |
| `1001` 和 `1001i` 是一回事 | 前者是浮点，后者是整数，混用会引起类型冲突 |
| 类型冲突只影响写错的那块表 | 类型按 measurement 登记、不分表，先写的表决定这个 shard 的类型，后写的所有表都受影响 |
| 一行里只有一个 field 冲突，其他 field 还能写进去 | 整个 point 被丢弃 |
| 跨 shard 类型不同只是显示有点乱 | 查询时低优先级类型的数据会被悄悄丢弃，结果随查询时间范围变化 |
| `::integer` 可以安全地读出整数 | 会把浮点值截断，造成计量误差 |
| `SHOW FIELD KEYS` 也会记录被拒绝的类型 | 只记录写入成功的类型 |
| tag 和 field 同名没关系 | 查询时会出现 `_1` 列，只写名字时默认取 field |

## 三、与其他章节的关联

| 关联对象 | 关系 |
|---|---|
| 专题 1 | 地图写入路径第 ①、② 步；专题 1 实验中出现的 `fields.idx` 就是 field 类型登记 |
| 专题 3 | measurement + tag 组合 → series；官方定义的 series 还包含 field key，两种用法在专题 3 区分 |
| 专题 4 | 类型约束的边界是 shard，shard 的划分规则在专题 4 |
| 专题 5 | 同一时间戳再写一次的合并覆盖：补传和重算的基础 |
| 专题 6 | tag / field 的选择原则；同名、类型不统一等反模式 |
| 专题 9 | "每个 field 单独存放"在 TSM 文件中的具体体现 |
| 专题 14、31 | tag 过滤和 field 过滤的代价差异 |
| 专题 20 | 缺行与 `fill()`：区分"没有这个 field"和"没有上报" |
| 专题 32 | `partial write` 与 400 返回码的完整语义 |
| MySQL | point ≈ 以（measurement, tag 组合, 时间戳）为主键、按 upsert 写入的一行；但存储是按 field 分列的 |

## 四、诊断实践

| 现象 | 看哪里 | 判断与处置 |
|---|---|---|
| 写入返回 400，内容含 `field type conflict` | HTTP 返回内容里的 `is type X, already exists as type Y` | 这个 shard 已被先写入的数据定成了 Y。查是哪块表、哪个写入方先写了 Y；统一类型（检查 `i` 后缀） |
| 一行里只有一个值有问题，整行都没写进去 | 返回内容里的 `dropped=` 数量 | 整个 point 被丢弃；修正冲突的 field 后重写 |
| 统计结果偏小，不报错 | `SHOW FIELD KEYS` 是否出现同名多类型；用 `SELECT x::string` 等找出异常类型的数据 | 跨 shard 类型不一致导致数据被丢弃；从某个时间点起改写到新的 field 名，或重写历史数据 |
| 同一条查询，时间范围不同时结果数量差别很大 | 改变时间范围，对比结果 | 范围内的 shard 类型组合变了，优先级规则导致数据被丢弃 |
| 按 tag 查询返回空 | WHERE 里的 tag 值有没有加单引号 | tag 是字符串 |
| 查询结果出现 `xxx_1` 列 | `SHOW TAG KEYS` 和 `SHOW FIELD KEYS` 里有没有同名 key | tag 和 field 同名；修改写入端 |
| 结果行数比预期少 | 用 `COUNT(field)` 分别核对各 field 的数量 | 所选 field 在某些 point 上没有值，整行不出现 |

本地复现（1.13.2）：

```bash
DB=t2
w() { curl -s -w ' [HTTP %{http_code}]\n' -XPOST "http://localhost:8086/write?db=$DB" --data-binary "$1"; }
q() { docker exec influx113 influx -database "$DB" -execute "$1"; }
docker exec influx113 influx -execute "CREATE DATABASE $DB"
w 'meter,meter_id=m1 kwh=1000.5 1764028800000000000'
w 'meter,meter_id=m1 kwh=1001i 1764029700000000000'           # 预期 400
w 'meter,meter_id=m1 kwh=1002i,current=5.1 1764030600000000000' # 预期 400，current 不登记
w 'meter,meter_id=m1 kwh=1002i 1764633600000000000'           # 预期 204（下一个 shard）
w 'meter,meter_id=m1 kwh="bad" 1765238400000000000'           # 预期 204
w 'meter,meter_id=m1 cnt=5u 1764028800000000000'              # 1.13.2 行为待验证
q 'SHOW FIELD KEYS'
q "SELECT kwh FROM meter WHERE meter_id='m1'"
q "SELECT kwh FROM meter WHERE meter_id='m1' AND time >= '2025-12-08T00:00:00Z'"
q "SELECT kwh::integer FROM meter WHERE meter_id='m1'"
```

## 五、复习 checklist

- [ ] 能从一句话推出时间戳、field、tag、measurement 四个部分，并说出 tag 为什么要单独拿出来建索引
- [ ] 能用"取值种类"解释为什么 field 不建索引
- [ ] 能说出 point 的四个组成部分，以及判断"同一个 point"只看哪三样
- [ ] 知道再写一次相同时间戳会合并、同名 field 被覆盖
- [ ] 知道查询结果里的"一行"是按时间戳拼出来的，统计数量要用 `COUNT(field)`
- [ ] 知道 tag 只能是字符串，WHERE 里必须加单引号
- [ ] 能写出四种 field 类型的写法，知道 `1001` 和 `1001i` 的区别，知道 1.x 不要用 `u`
- [ ] 能说出类型冲突的四条规则：同 shard 拒绝、跨 shard 允许、整个 point 一起丢弃、按 measurement 登记不分表
- [ ] 能说出查询时多类型的优先级，以及它只在查询涉及的 shard 之间比较
- [ ] 知道 `::integer` 会截断浮点值
- [ ] 知道 tag 和 field 同名会出现 `_1` 列
- [ ] 遇到 400 `field type conflict`、统计结果偏小、按 tag 查询为空时，知道先看哪里
