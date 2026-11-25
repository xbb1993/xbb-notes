# Series 与 series key：时间线为什么是核心单位

> 专题 3 · 模块二 · ★ 核心必会 · 主线：S
> 地图位置：写入路径第 ② 步"拼出 series key"、第 ③ 步"查索引"。专题 2 讲了一个点由什么组成，本篇讲点按什么归堆。
> 实验环境：云端 1.6.7 真实运行；与 1.13.2 可能存在的差异已标注。

## 一、核心概念

### 1.1 series 的定义与两种用法

**series（时间线）**：measurement 相同、tag 组合也相同的点，归为一堆，就是一条 series。

官方文档对 series 的定义包含 field key（"a collection of points that share a measurement, tag set, and field key"）。实际使用中存在两种说法：

| | 索引层的 series | 存储层的 series（官方定义） |
|---|---|---|
| 组成 | measurement + tag 组合 | measurement + tag 组合 + 一个 field key |
| 在哪能看到 | `SHOW SERIES`、`SERIES CARDINALITY`、索引、`max-series-per-database` | TSM 文件的 key、Cache 条目 |
| 1 万块表 × 4 个 field | 1 万 | 4 万 |
| 决定什么 | 索引大小、基数上限 | 磁盘上的列数、Cache 条目数 |

**本课程的约定**：不加说明的"series"指**索引层**用法。专题 1 笔记中的定义也是这一层的意思。

### 1.2 series 数怎么增长（从 1 块表逐步加量，云端 1.6.7 实测）

| 步骤 | 输入 | series 数 | 规则 |
|---|---|---|---|
| A | 1 块表，tag 只有 `meter_id` | 1 | measurement 和 tag 组合都相同，属于同一条 |
| B | 3 块表 | 3 | 每多一个 tag 取值，就多一条 |
| C | 3 块表 × 独立的 tag `phase`（A/B/C） | 9 | 相互独立的 tag：取值数相乘 |
| D | 3 块表 + 依附的 tag `site`（每块表固定在一个站点） | 3 | 依附于其他 tag 的 tag：不增加 series 数 |

> **series 数 = 实际写入过的不同 tag 组合的个数**。各 tag 取值数相乘只是上限，只有相互独立的 tag 才会相乘。（这一条更正了大纲里"相乘"的说法。）

**步骤 E：中途给已有的表加 tag**

```
SHOW SERIES FROM ma
ma,meter_id=m1              ← 旧 series 仍然存在
ma,meter_id=m1,site=s1      ← 新 series
SELECT * FROM ma WHERE meter_id='m1'  → 两条 series 的数据都能查到；旧数据的 site 列为空
```

tag 组合变了，series 也就变了：同一块表的历史被拆成两条时间线。按新 tag（`site='s1'`）查询时，查不到加 tag 之前的数据。

### 1.3 series key：时间线的标准名字

- **问题**：同一组 tag，不同写入方的书写顺序可能不同。
- **设计**：解析时把 tag **按 key 的字母顺序排序**后再拼接，得到 **series key**，例如 `md,meter_id=m1,phase=A`。

```
写入 1：md,phase=A,meter_id=m1 kwh=1
写入 2：md,meter_id=m1,phase=A voltage=230
SHOW SERIES FROM md → md,meter_id=m1,phase=A     （只有 1 条）
SELECT *            → kwh=1 与 voltage=230 合并为同一个 point
```

| | 说明 |
|---|---|
| 谁生成 | 服务端在解析时生成：measurement + 排好序的 tag |
| 存在哪 | 索引、库级 series 登记簿 `_series`、TSM 文件里每个 key 的前缀 |
| 能否推导 | 能，完全由 measurement 和 tag 推导出来；写入方不需要、也不能指定 series ID |
| 何时出现 | 这个 tag 组合第一次被写入时 |
| 何时消失 | 见 1.5 |

### 1.4 存储层的 key：series key + `#!~#` + field

1.6.7 的安装包里没有 `influx_inspect`。下面的输出来自一个按官方 TSM 格式写的小脚本，它直接读出 TSM 文件索引里的 key：

```
ma,meter_id=m1#!~#kwh                 float  块数=1
ma,meter_id=m1,site=s1#!~#kwh         float  块数=1
md,meter_id=m1,phase=A#!~#kwh         float  块数=1
md,meter_id=m1,phase=A#!~#voltage     float  块数=1
```

- 一条（索引层的）series 有几个 field，磁盘上就有几列。
- 每一列带着自己的类型，对应专题 2 中"类型按 field 登记"。
- 按 field 分列存储的好处：同类型、变化平缓的值放在一起，压缩效果好；查询只选某个 field 时，只读那一列（专题 9、10）。

### 1.5 生命周期："现在"和"历史"

```
11-24 那一周（shard 13）：m1、m9 都上报；12-01 那一周（shard 14）：只有 m1
SHOW SERIES → m1、m9                        ← m9 已经一周没有数据，仍然存在
DROP SHARD 13（模拟到期）→ SHOW SERIES → m1  ← m9 这时才消失
```

- series 在第一次写入时出现。只要还有任何一个 shard 里有它的数据，它就一直存在。
- 含有它数据的 shard 全部被删除（保留策略到期，或手工删除），或者执行 `DROP SERIES` 后，它才消失。
- `SHOW SERIES WHERE time > ...` 在 1.6.7 中**会忽略时间条件**，照样列出全部 series（1.13.2 未核实）。想知道某段时间里哪些表有数据，用 `SELECT COUNT(x) ... GROUP BY meter_id`。

### 1.6 估算基数与精确基数

| 命令 | 做法 | 实测（100 条 → DROP 50 条） |
|---|---|---|
| `SHOW SERIES CARDINALITY` | 用近似统计结构直接估算，速度快 | 100 → 50 |
| `SHOW SERIES EXACT CARDINALITY` | 逐条计数，数据量大时慢 | 100 → 50 |

这个小实验里两者一致。什么情况下会出现差异，留到专题 16、23 再测。

### 1.7 为什么 series 数是核心指标

| 位置 | 每条 series 带来的负担 |
|---|---|
| 索引 | 一个条目。inmem 索引在内存里，所以内存随 series 数线性增长（专题 15） |
| `_series` 登记簿 | 一条记录 |
| Cache / TSM | 每个 field 一列，各自有 key 和数据块 |
| 查询 | 命中的每条 series 都要单独读取一次（专题 24、31） |

默认上限（已对照 v1 官方配置文档）：`max-series-per-database = 1000000`、`max-values-per-tag = 100000`。超出后的表现与治理见专题 17。

### 1.8 串联图

```
写入一行：meter,phase=A,meter_id=m1 kwh=1000.5,voltage=229.8 T
        │
        ▼ 解析，把 tag 按 key 排序
series key：meter,meter_id=m1,phase=A          ← 推导得到，不单独记录
        │
        ├─【索引层】第一次出现？→ 在索引和 _series 中登记
        │      series 数 = 实际出现过的 tag 组合数（独立 tag 相乘，依附 tag 不增加）
        │      生命周期：首次写入时出现 → 相关 shard 全部删除或 DROP SERIES 时消失
        │      受 max-series-per-database / max-values-per-tag 限制
        │
        └─【存储层】按 field 拆成多列
               meter,meter_id=m1,phase=A#!~#kwh
               meter,meter_id=m1,phase=A#!~#voltage
               → 各自进入 Cache、各自写成 TSM 块（专题 8、9）
```

## 二、易混淆 / 易错点

| 错误理解 | 正确理解 |
|---|---|
| series 数 = 各 tag 取值数相乘 | = 实际出现过的 tag 组合数；相乘只是上限，依附的 tag 不增加 series 数 |
| 加 tag 就像关系表加一列 | 加 tag 会改变 series 的身份，同一块表的历史被拆成两条时间线 |
| tag 书写顺序不同就是不同的 series | series key 按 tag key 排序，顺序不影响 |
| series 只有一种含义 | 索引层不含 field，存储层（官方定义）含 field；1 万块表 × 4 个 field 对应 1 万条索引层 series、4 万列 |
| series 数 = 当前在线的表数 | = 保留期内出现过的所有 tag 组合；拆掉的表要等相关 shard 到期才会消失 |
| `SHOW SERIES WHERE time ...` 能列出某段时间有数据的表 | 1.6.7 中时间条件被忽略；应该用 `SELECT COUNT ... GROUP BY` |
| series ID 可以由写入方指定 | series key 完全由 measurement 和 tag 推导出来 |

## 三、与其他章节的关联

| 关联对象 | 关系 |
|---|---|
| 专题 1 | 全链路地图写入路径第 ②、③ 步；专题 1 中的 series 定义是索引层用法 |
| 专题 2 | point 的唯一标识 = series + 时间戳；按 field 分列在存储层体现为 `#!~#field` |
| 专题 4 | series 的生命周期跟随 shard；保留策略决定 shard 何时被删除 |
| 专题 6 | 按"独立 / 依附"来判断该不该做成 tag；中途加 tag 是 schema 变更的风险 |
| 专题 8、9 | 存储层的列（series key + field）在 Cache 和 TSM 中的组织方式 |
| 专题 14–18 | 索引层 series 的登记与查找；inmem 内存随 series 数增长；高基数治理 |
| 专题 23 | 估算基数与精确基数的差异与代价 |
| 专题 24、31 | 查询代价随命中的 series 数增长 |
| MySQL | series key 类似由列值推导出的复合主键前缀；但没有建表约束，任何新组合都会自动产生新的 series |

## 四、诊断实践

| 现象 | 看哪里 | 判断与处置 |
|---|---|---|
| series 数远多于表数 | `SHOW SERIES` 抽样，看同一块表是否对应多个 tag 组合 | 中途加了 tag、tag 写法不一致（大小写、空格）、存在独立变化的 tag；统一写入端 |
| 按某个 tag 查询，历史数据"丢了" | 同一块表在 `SHOW SERIES` 中是否有多条 | 加 tag 之前的数据属于旧 series；查询改用不变的 tag，或补写历史数据 |
| 拆掉的表仍出现在 `SHOW SERIES` 里 | 对应时间段的 shard 是否还在保留期内（`SHOW SHARDS`） | 正常现象；急需清理时用 `DROP SERIES` |
| 需要统计某段时间里有数据的表 | 用 `SELECT COUNT(x) ... WHERE time ... GROUP BY meter_id` | `SHOW SERIES` 的时间条件不起作用 |
| 基数接近 `max-series-per-database` | `SHOW SERIES [EXACT] CARDINALITY` | 见专题 17 |

本地复现（1.13.2）：

```bash
DB=s3
w() { curl -s -w ' [HTTP %{http_code}]\n' -XPOST "http://localhost:8086/write?db=$DB" --data-binary "$1"; }
q() { docker exec influx113 influx -database "$DB" -execute "$1"; }
T=1764028800000000000
docker exec influx113 influx -execute "CREATE DATABASE $DB"
for m in m1 m2 m3; do for p in A B C; do echo "mb,meter_id=$m,phase=$p kwh=1 $T"; done; done > mb.lp
w @mb.lp;                         q "SHOW SERIES EXACT CARDINALITY FROM mb"   # 预期 9
w "mc,meter_id=m1,site=s1 kwh=1 $T
mc,meter_id=m2,site=s1 kwh=1 $T
mc,meter_id=m3,site=s2 kwh=1 $T"; q "SHOW SERIES EXACT CARDINALITY FROM mc"   # 预期 3
w "md,phase=A,meter_id=m1 kwh=1 $T"
w "md,meter_id=m1,phase=A voltage=230 $T"; q "SHOW SERIES FROM md"          # 预期 1 条
q "SHOW SERIES FROM mb WHERE time > '2030-01-01T00:00:00Z'"                  # 观察 1.13.2 是否仍忽略时间条件
# 查看 TSM 里的 key（Cache 需先落盘）：
# docker exec influx113 sh -c 'influx_inspect dumptsm -index /var/lib/influxdb/data/s3/autogen/*/*.tsm'
```

## 五、复习 checklist

- [ ] 能说出 series 的两种用法（索引层、存储层），以及本课程默认指哪一种
- [ ] 能从 1 块表逐步加量，算出 series 数；能区分独立的 tag 和依附的 tag
- [ ] 知道中途加 tag 会把同一块表的历史拆成两条时间线
- [ ] 能解释 series key 为什么要把 tag 排序
- [ ] 能写出存储层 key 的格式：series key + `#!~#` + field
- [ ] 能说出 series 什么时候出现、什么时候消失
- [ ] 知道 `SHOW SERIES` 显示的是"保留期内出现过的"，而不是"当前在线的"
- [ ] 知道统计某段时间有数据的表该用什么语句
- [ ] 能说出估算基数与精确基数两条命令的区别
- [ ] 能说出 series 数影响哪几处，以及两个默认上限
