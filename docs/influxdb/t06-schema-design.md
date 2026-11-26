# Schema 设计：tag 还是 field、宽表与窄表、常见反模式

> 专题 6 · 模块二 · ★ 核心必会 · 主线：S Q
> 地图位置：把专题 2～5 的规则用到设计上。schema 一旦写入就很难修改，它影响写入、存储、查询的每一步。
> 实验环境：云端 1.6.7 实测。

## 一、核心概念

### 1.1 tag 还是 field：四个问题

| 问题 | 规则来源 | 判断 |
|---|---|---|
| 1 要不要按它筛选或分组？ | tag 建索引，field 不建（专题 2） | 要 → 倾向 tag；不要 → field |
| 2 取值有多少？会不会无限增长？ | series 数 = 实际出现过的 tag 组合数（专题 3） | 会无限增长 → 必须 field |
| 3 同一个对象身上会不会变？ | tag 变了，series 就变了，历史被拆开（专题 3） | 经常变 → field；很少变且需要分组 → 可以做 tag，但要接受历史被拆开 |
| 4 是不是数值，要不要计算或比较大小？ | tag 只能是字符串（专题 2） | 要 → field |

**实验：读数做成 tag**（100 块表 × 1 小时）→ `SHOW SERIES EXACT CARDINALITY` = **24000**。照这个速度，一天约 57.6 万条，不到 2 天就会碰到 `max-series-per-database = 1000000` 的上限。

**实验：数值做成 tag**（floor = 9 / 10 / 2）：

```
WHERE floor > '3'          → 只返回 10（按字符串比较，"9" 被漏掉了，而且不报错）
WHERE floor = '10'         → 10
WHERE floor =~ /^(9|10)$/  → 9、10
```

tag 能可靠使用的只有：等于、不等于、正则匹配。

```
一个信息
  ├─ 会无限增长？（读数、ID、时间戳、自由文本）────→ field
  ├─ 需要比较大小或参与计算？──────────────────────→ field
  ├─ 需要按它筛选或分组？
  │     ├─ 否 ─────────────────────────────────→ field
  │     └─ 是 → 同一对象身上会经常变吗？
  │              ├─ 会 ─────────────────────────→ field（或接受历史被拆开）
  │              └─ 不会 → 取值有限 ────────────→ tag
  └─ 设计完估算 series 数：只把相互独立的 tag 的取值数相乘
```

电表示例：

| 信息 | 结论 |
|---|---|
| 表号 meter_id | tag |
| 站点 site（依附于表号，不增加 series 数） | tag |
| 相别 phase（与表号独立，series 数 × 3） | tag |
| 电度、电压、电流、功率、CT 变比 | field |
| 固件版本 | 一般做 field；确实需要按版本分组时可以做 tag，但历史会被拆开 |
| 通信状态 | field |

### 1.2 宽表与窄表

```
宽表：    meter_wide,meter_id=m1 kwh=..,voltage=..,current=..,power=.. T
窄表 A：  kwh,meter_id=m1 value=.. T          （每个指标一个 measurement）
窄表 B：  metric,meter_id=m1,name=kwh value=.. T  （指标名做成 tag）
```

实验：100 块表 × 1 天 × 每 15 秒，同一份数据分别写入三种结构（写入耗时是单次运行的粗略参考）：

| | 宽表 | 窄表 A | 窄表 B |
|---|---|---|---|
| 行数 | 57.6 万 | 230.4 万 | 230.4 万 |
| 写入请求体积 | 49.9 MB | 98.7 MB | 126.4 MB |
| 写入耗时 | 2.35 秒 | 4.61 秒 | 5.21 秒 |
| 索引层 series 数 | 100 | 400 | 400 |
| 压实后 TSM 大小 | 14,410,264 B | 14,408,264 B | 14,413,064 B |

- **磁盘几乎一样大**：存储层的一列是"series + field"，三种结构都是 100 × 4 = 400 列，每列的数据相同。
- **series 数相差 4 倍**：窄表把"指标"变成了 series 的一部分，索引和基数上限的压力更大。
- **写入更慢、请求体积更大**：窄表每个值都要单独写一行，measurement、tag、时间戳重复出现。

查询对比：

| 需求 | 宽表 | 窄表 A | 窄表 B |
|---|---|---|---|
| 某块表某一时刻的全部指标 | 1 行 | 4 个独立的结果集 | 4 行；`name` 是关键字，必须写成 `"name"`，否则报 `found NAME, expected identifier` |
| 电压 × 电流 | `SELECT voltage * current / 1000` → 1.221405 | `voltage.value * current.value FROM voltage, current` → **空结果，不报错** | 无法直接计算 |

InfluxQL 不能跨 measurement 计算（没有 join）。

| 结构 | 适合的情况 |
|---|---|
| 宽表 | 同一设备、同一时刻一起上报的一组指标；电表场景的默认选择 |
| 窄表 B | 指标种类很多、各设备的指标集合差异很大（例如几千种点位的网关点表） |
| 窄表 A | 基本没有优势 |

宽表里某些点缺少部分 field 没有关系：没写的 field 不存储。

### 1.3 常见反模式

| 反模式 | 后果 |
|---|---|
| 把信息编进 measurement 名（`meter_m1_kwh`） | `SELECT SUM(value) FROM /meter_.*_kwh/` 返回 3 个独立结果，无法按表 GROUP BY |
| 会无限增长的值做成 tag | series 爆炸 |
| 数值做成 tag | 数值比较按字符串规则进行，结果错误且不报错 |
| 需要筛选的信息做成 field | 查询要逐条比对 |
| 同一含义、不同写法的 tag（`m1`/`M1`） | 一块表变成多条 series，重写时无法覆盖 |
| tag 与 field 同名 | 查询结果出现 `_1` 列 |
| 同一个 field 在不同写入方的类型不一致 | 400 类型冲突，或查询时数据被丢弃 |
| 会变的属性做成 tag | 历史被拆成多段 |

### 1.4 raw 与 diff 放在哪里

| 做法 | 优点 | 风险 / 代价 |
|---|---|---|
| ① 同一个点的两个 field | 一次写入同时更新；series key 相同；可以直接做字段运算 | 重写时必须两个 field 一起写 |
| ② 分放在两个 measurement | 可以分开写入 | 容易只改一边；无法跨 measurement 计算 |
| ③ 只存 raw，查询时计算 diff | 没有一致性问题 | 复位、换表、缺数时处理复杂；查询开销更大 |

目前的结论：如果要把 diff 存下来，① 优于 ②。① 和 ③ 怎么选，等专题 30、31 再定。

### 1.5 修改 schema 的代价

| 想改什么 | 能否直接改 |
|---|---|
| tag 名 / tag 值 | 不能（改了就是另一条 series） |
| field 与 tag 互换 | 不能，只能导出后重写（专题 35） |
| field 类型 | 不能，只能从某个时间点起改用新的 field 名 |
| 新增 field | 可以 |
| 新增 tag | 可以写入，但会拆开历史 |

### 1.6 串联图

```
每个信息 → 四个问题
   ├─ tag  → series key → series 数（独立 tag 相乘）→ 索引、基数上限
   └─ field → 存储层的一列 → 类型按 shard 定死 → 磁盘 = 列数 × 每列数据

同设备同时刻的指标
   ├─ 宽表：series 少、写入省、能做字段运算 ← 电表默认
   └─ 窄表：磁盘不变、series 更多、写入更多、不能跨 measurement 计算

raw / diff：同一个点的两个 field，一起写；是否只存 raw → 专题 30、31
改 schema 很贵 → 设计阶段一次想好
```

## 二、易混淆 / 易错点

| 错误理解 | 正确理解 |
|---|---|
| 窄表行数多，磁盘也会大好几倍 | 磁盘取决于列数和每列的数据，三种结构几乎相同 |
| 窄表和宽表只是写法不同 | 窄表的 series 数多（本例 4 倍），写入量更大，而且不能跨 measurement 计算 |
| 跨 measurement 计算写错了会报错 | 返回空结果，不报错 |
| 数值 tag 也能用 `>` 比较 | 按字符串比较，结果错误且不报错 |
| 只要取值有限就可以做 tag | 还要看会不会变；会变的 tag 会拆开历史 |
| 加 tag 的数量决定 series 数 | 只有相互独立的 tag 才相乘 |
| 窄表 B 的 `name` 可以直接写 | `name` 是关键字，要加双引号 |
| schema 以后可以慢慢调整 | tag、类型、tag/field 的划分都不能直接改，只能重写数据 |

## 三、与其他章节的关联

| 关联对象 | 关系 |
|---|---|
| 专题 2 | tag 只能是字符串、不能按数值比较；类型按 shard 定死 |
| 专题 3 | 独立 tag 相乘；会变的 tag 拆开历史；存储列 = series + field |
| 专题 5 | raw/diff 一致性；tag 写法不一致导致无法覆盖 |
| 专题 9、10 | 每列在 TSM 中的组织方式与压缩，解释"磁盘几乎相同" |
| 专题 14、15、17 | series 数对索引、内存、基数上限的影响 |
| 专题 26 | Flux 能做 join，但 1.x 上不建议新投入 |
| 专题 30、31 | 只存 raw 还是也存 diff 的最终判断 |
| 专题 35 | 修改 schema 需要导出后重写 |
| MySQL | 宽表/窄表类似"列式宽表"与 EAV（实体-属性-值）模型的取舍 |

## 四、诊断实践

| 现象 | 看哪里 | 判断与处置 |
|---|---|---|
| series 数快速增长 | `SHOW TAG VALUES WITH KEY = ...`，找出取值最多的 tag | 有会无限增长的值被做成了 tag，改成 field |
| `SHOW MEASUREMENTS` 很长且名字有规律 | measurement 名里是否带表号、指标名 | 信息编进了 measurement 名，改成 tag |
| 数值条件结果不对但不报错 | 条件里用的是 tag 还是 field | tag 是字符串比较 |
| 跨指标计算结果为空 | 指标是否分散在不同的 measurement | 改成宽表 |
| 同一块表有多段历史 | `SHOW SERIES WHERE meter_id='m1'` | 会变的属性做成了 tag，或 tag 写法不一致 |

本地复现（1.13.2），生成数据的脚本：

```python
# gen6.py：100 块表 × 1 天 × 每 15 秒，生成 wide.lp / narrowA.lp / narrowB.lp
import random
random.seed(1)
START = 1795536000  # 2026-11-24T16:00:00Z
METERS, STEP, N = 100, 15, 5760
out = {k: open(f"{k}.lp", "w") for k in ("wide", "narrowA", "narrowB")}
for m in range(1, METERS + 1):
    kwh = 1000.0 + m
    for i in range(N):
        t = START + i * STEP
        v = round(229 + random.uniform(-1, 1), 1)
        c = round(5 + random.uniform(-0.5, 0.5), 2)
        p = round(v * c / 1000, 3)
        kwh = round(kwh + p * STEP / 3600, 3)
        out["wide"].write(f"meter_wide,meter_id=m{m} kwh={kwh},voltage={v},current={c},power={p} {t}\n")
        for name, val in (("kwh", kwh), ("voltage", v), ("current", c), ("power", p)):
            out["narrowA"].write(f"{name},meter_id=m{m} value={val} {t}\n")
            out["narrowB"].write(f"metric,meter_id=m{m},name={name} value={val} {t}\n")
for f in out.values():
    f.close()
```

```bash
python3 gen6.py
for db in s6wide s6na s6nb; do docker exec influx113 influx -execute "CREATE DATABASE $db"; done
load() { split -l 50000 "$2" "c_$1_"; for f in c_$1_*; do curl -s -o /dev/null -XPOST "http://localhost:8086/write?db=$1&precision=s" --data-binary @"$f"; done; }
load s6wide wide.lp; load s6na narrowA.lp; load s6nb narrowB.lp
for db in s6wide s6na s6nb; do docker exec influx113 influx -database $db -execute "SHOW SERIES EXACT CARDINALITY"; done
# 等 10 分钟以上让 Cache 落盘后：
docker exec influx113 sh -c 'for db in s6wide s6na s6nb; do du -cb $(find /var/lib/influxdb/data/$db -name "*.tsm") | tail -1; done'
docker exec influx113 influx -database s6na -execute "SELECT voltage.value * current.value FROM voltage, current WHERE meter_id='m1' LIMIT 1"   # 预期为空
```

## 五、复习 checklist

- [ ] 能说出判断 tag / field 的四个问题，以及每个问题来自哪条规则
- [ ] 能用电表的各个信息完整套一遍决策流程
- [ ] 知道读数做成 tag 时 series 增长的速度
- [ ] 知道 tag 不能按数值比较大小，只能用等于、不等于、正则
- [ ] 能解释宽表和窄表磁盘几乎相同、series 数却相差数倍的原因
- [ ] 知道 InfluxQL 不能跨 measurement 计算，而且会返回空结果
- [ ] 能说出宽表、窄表 B 各自适合的场景
- [ ] 能列出至少 6 个反模式及其后果
- [ ] 能比较 raw/diff 的三种存放方式
- [ ] 知道哪些 schema 修改不能直接完成
