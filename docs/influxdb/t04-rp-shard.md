# Database、保留策略、Shard Group、Shard 的层次

> 专题 4 · 模块二 · ★ 核心必会 · 主线：S O
> 地图位置：写入路径第 ④ 步"按时间戳决定进哪个 shard"。专题 3 讲按 series 归堆，本篇讲按时间装箱，以及箱子什么时候被删除。
> 实验环境：云端 1.6.7 实测，规则已对照 1.13.2 源码与 v1 官方文档。

## 一、核心概念

### 1.1 从"过期怎么删才便宜"推出四层容器

| 步骤 | 问题 | 得到的概念 |
|---|---|---|
| 1 | 逐条删除过期数据太慢 | **shard**：按时间分装的箱子，过期时删除整个目录 |
| 2 | 不同数据保留时长不同，箱子大小也该不同 | **保留策略 RP**：`DURATION`（保留多久）+ `SHARD DURATION`（每个箱子装多长时间）；一个库可以有多个 RP |
| 3 | 需要一个最外层的命名空间 | **database**；series 登记簿 `_series` 按库存放 |
| 4 | 集群需要把同一时间段的数据分到多个节点 | **shard group**：同一时间段的那组箱子；开源单机版一组只有一个 shard |

```
database  r4
 └─ RP h1（保留 1h，箱子 1h）
     └─ shard group [07:00, 08:00)
         └─ shard  data/r4/h1/18/
```

### 1.2 一个点落进哪个箱子（1.13.2 源码 `services/meta/data.go`）

1. 确定 RP：写入请求里有 `rp=` 就用指定的，没有就用默认 RP。
2. 如果已有 shard group 的时间范围覆盖了这个点，就放进去。
3. 没有就新建一个：起点 = `timestamp.Truncate(shard 时长)`，终点 = 起点 + shard 时长，区间左闭右开。

```
d3（箱子 1 天）写入 11-23 05:00、11-24 23:59:59、11-25 00:00:00
15  11-23 00:00 → 11-24 00:00  过期 11-27
16  11-24 00:00 → 11-25 00:00  过期 11-28
17  11-25 00:00 → 11-26 00:00  过期 11-29     ← 00:00:00 属于下一个箱子
```

- 边界按 **UTC** 对齐。1 天的箱子边界在北京时间 08:00。
- 7 天的箱子从**周一**开始：Go 的 `Truncate` 从零时刻（公元 1 年 1 月 1 日，周一）开始按整倍数截断。

### 1.3 默认的 shard 时长与保留下限（实测，与源码 `shardGroupDuration()`、官方文档一致）

| 保留时长 | 自动给的 shard 时长 |
|---|---|
| 小于 2 天 | 1 小时 |
| 2 天到 6 个月 | 1 天 |
| 6 个月以上，或永久保留（INF / 0s） | 7 天 |

- 保留时长最短 1 小时（`retention policy duration must be at least 1h0m0s`）。
- `SHARD DURATION` 可以手动指定，最小 1 小时。
- 1.6.7 的语法要求先写 `REPLICATION`，再写 `SHARD DURATION`。

### 1.4 过期删除（1.13.2 源码 `ExpiredShardGroups`）

> **shard group 终点 + 保留时长 < 当前时间** → 过期；后台每隔 `check-interval`（默认 30 分钟）检查一次，过期的整组删除。

`SHOW SHARDS` 最后一列的过期时间就是"终点 + 保留时长"。

h1（保留 1h、箱子 1h）实验，检查间隔临时改为 10 秒：

```
08:53  写 2 小时前的点 → 400 "partial write: points beyond retention policy dropped=1"
08:53  写 07:55、08:48 两个点 → 204；shard 18 [07:00,08:00) 过期 09:00，shard 19 过期 10:00
08:56  07:55 那个点已超过 1 小时，仍能查到
09:00:07  日志 "Deleted shard group" db_shard_group=18 → 07:55 那个点消失
```

- 超出保留期的点，**写入时就会被拒绝**。
- 箱子删除之前，**查询不会按保留期过滤数据**。
- 数据最多会多留：**shard 时长 + 检查间隔**。

### 1.5 修改 RP 的影响

| 操作 | 对已有箱子的影响（实测） |
|---|---|
| 修改 `SHARD DURATION` | 已有箱子不变；只对没有箱子覆盖的新时间段生效。d3 改成 2h 后，11-25 的新点仍然落进已有的 1 天箱子 17 |
| **缩短 `DURATION`** | 过期时间按新的保留时长重新计算，**下一次检查时就会删除**，没有确认步骤 |

**追问：保留期由长改短后，"超过新保留期、但没超过旧保留期"的数据会不会被删？**

会，但**按整个箱子判断，不按单条数据判断**。实验（长 → 短：200d → 7d，箱子 7 天）：

```
修改前：22 [09-21,09-28)、23 [11-09,11-16)、24 [11-16,11-23)、25 [11-23,11-30)
        数据：60 天前、15 天前、8 天前、1 天前
修改后 20 秒：22、23 被删除（60 天前、15 天前的数据消失）
             24 仍在：过期时间变为 11-23 + 7d = 11-30，晚于现在
SELECT → 8 天前、1 天前的数据还在       ← 8 天前已超过新的 7 天，但所在箱子还没过期
```

结论：整个箱子的"终点 + 新保留时长"早于现在，这个箱子就会在下一次检查时被删除；只有一部分过期的箱子会保留到它自己的过期时间。

### 1.6 默认 RP

- 建库时自动建 `autogen`（永久保留、箱子 7 天）并设为默认，由配置 `retention-autocreate` 控制（源码默认 `true`）。
- **写入和查询都不指定 RP 时，都使用默认 RP**。

```
不指定 RP 写入 kwh=7 → 进入 autogen；SELECT kwh FROM meter → 7
ALTER ... d3 DEFAULT 后，同一条 SELECT kwh FROM meter → 1..5（d3 的数据）
SELECT kwh FROM autogen.meter → 7
```

建议：生产环境的写入和查询都**显式写出 RP**。

### 1.7 补充

- ☆ **FUTURE LIMIT / PAST LIMIT**：v1 官方文档（1.13.2）的 RP 支持这两项，用来拒绝时间戳超前或滞后太多的点；从哪个版本开始支持**未核实**，1.6.7 不支持。
- ○ **shard 预创建**：默认开启，每 10 分钟检查一次，提前 30 分钟创建下一个箱子（官方配置文档）。
- ○ **REPLICATION**：开源版中没有作用。

### 1.8 各层的来龙去脉

| 层 | 归属 | 什么时候创建 | 什么时候销毁 | 记录在哪 |
|---|---|---|---|---|
| database | 全局 | `CREATE DATABASE` | `DROP DATABASE` | `meta.db` |
| RP | 某个库 | 建库自动建 autogen，或 `CREATE RETENTION POLICY` | `DROP RETENTION POLICY` | `meta.db` |
| shard group | 某个 RP | 第一次有数据落进该时间段时，或预创建 | 终点 + 保留时长 < 现在，后台检查时 | `meta.db` |
| shard | 某个 shard group | 与所在组一起 | 与所在组一起，目录一并删除 | `meta.db` + `data/`、`wal/` 下的目录 |

起止时间看起来可以推算，但 shard 时长是创建箱子时定下的，之后修改 RP 不影响已有箱子，所以每个箱子的起止时间必须单独记录。

### 1.9 串联图

```
写入（时间戳 T，可选 rp=）
  ├─ 没有 rp → 默认 RP
  ├─ T < 现在 − 保留时长 → 400 points beyond retention policy
  ├─ 已有组覆盖 T → 放进去（即使 shard 时长后来改过）
  └─ 没有 → 新建组：起点 = T 截断（UTC；7 天从周一开始），终点 = 起点 + shard 时长

后台每 check-interval（默认 30 分钟）：
  终点 + 保留时长 < 现在 → 整组删除
  缩短保留期 → 按新时长重算，整箱都过期的在下一次检查时删除
```

## 二、易混淆 / 易错点

| 错误理解 | 正确理解 |
|---|---|
| 保留 90 天就是每条数据满 90 天时删除 | 按整个箱子删除，最多多留 shard 时长 + 检查间隔 |
| 过期数据查不到 | 箱子删除之前仍然能查到 |
| 缩短保留期只影响以后的数据 | 下一次检查时就会删除已整箱过期的旧箱子 |
| 缩短保留期后，超过新期限的数据都会立即删除 | 按箱子判断，只有部分过期的箱子会保留到它自己的过期时间 |
| 改了 SHARD DURATION，已有箱子会变 | 只对没有箱子覆盖的新时间段生效 |
| `SELECT ... FROM meter` 能查到库里所有数据 | 只查默认 RP |
| 开源版里 shard group 和 shard 是两样东西 | 一组只有一个 shard，这一层为集群准备 |
| 箱子边界按本地时间对齐 | 按 UTC；7 天的箱子从周一 00:00 UTC 开始 |
| 补传多旧的数据都能写进去 | 超出保留期的点会被拒绝 |

## 三、与其他章节的关联

| 关联对象 | 关系 |
|---|---|
| 专题 1 | 实验中从周一开始的 shard 在这里得到解释 |
| 专题 2 | field 类型按 shard 登记，shard 的划分规则就在这里 |
| 专题 3 | series 要等含它数据的 shard 全部删除才会消失 |
| 专题 5 | 时间戳精度写错，时间跑到 1970 年后会撞上"超出保留期" |
| 专题 13 | shard 从预创建、热写、变冷到删除的完整生命周期 |
| 专题 20 | UTC 对齐与按本地日期统计 |
| 专题 27 | 多 RP 设计与 shard 时长的选择 |
| 专题 29 | 补传时的"超出保留期"与 FUTURE / PAST LIMIT |
| 专题 39 | 缩短保留期之前要先备份 |
| 专题 44 | shard group 在集群里的作用 |
| MySQL | 类似按时间分区 + 删除分区，但这里是自动的，而且按 RP 分柜 |

## 四、诊断实践

| 现象 | 看哪里 | 判断与处置 |
|---|---|---|
| 写入 400 `points beyond retention policy` | 点的时间戳与 RP 的保留时长 | 数据太旧，或时间戳单位写错 |
| 数据"消失"了，但没人删 | 写入与查询的 RP 是否一致；`SHOW RETENTION POLICIES` 中的 default 列 | 不写 RP 只查默认 RP |
| 过期数据仍然查得到 | `SHOW SHARDS` 的过期时间列 | 正常现象 |
| 改保留期后大量历史数据消失 | 有没有人执行 `ALTER ... DURATION`；日志中的 `Deleted shard group` | 缩短保留期会触发删除 |
| 改了 SHARD DURATION 但箱子没变 | `SHOW SHARDS` 的起止时间 | 只对没有箱子覆盖的新时间段生效 |
| 删除比预期晚很多 | shard 时长 + 检查间隔 | 正常的最大延迟 |

本地复现（1.13.2）：

```bash
q() { docker exec influx113 influx -database r4 -execute "$1"; }
w() { curl -s -w ' [HTTP %{http_code}]\n' -XPOST "http://localhost:8086/write?db=r4&$1" --data-binary "$2"; }
docker exec influx113 influx -execute "CREATE DATABASE r4"
q "CREATE RETENTION POLICY h1 ON r4 DURATION 1h REPLICATION 1"
q "CREATE RETENTION POLICY d3 ON r4 DURATION 3d REPLICATION 1"
q "SHOW RETENTION POLICIES"
OLD=$(( ($(date -u +%s) - 7200) * 1000000000 ))
w "rp=h1" "meter,meter_id=m1 kwh=10 $OLD"           # 预期 400 beyond retention
w "rp=d3" "meter,meter_id=m1 kwh=1 $(( $(date -u +%s) * 1000000000 ))"
q "SELECT kwh FROM meter"; q "SELECT kwh FROM d3.meter"
docker exec influx113 influx -execute "SHOW SHARDS"
```

## 五、复习 checklist

- [ ] 能从"过期怎么删才便宜"推出 shard、RP、database、shard group 四层
- [ ] 能说出一个点落进哪个箱子的三条规则，以及区间是左闭右开
- [ ] 能解释 7 天的箱子为什么从周一开始，以及边界按 UTC 对齐
- [ ] 能背出默认 shard 时长对照表和最短保留时长
- [ ] 能写出过期判断公式，算出数据最多会多留多久
- [ ] 知道超出保留期的点在写入时会被拒绝
- [ ] 知道修改 SHARD DURATION 与缩短 DURATION 分别对已有箱子有什么影响
- [ ] 能解释"缩短保留期后，部分过期的箱子为什么还在"
- [ ] 知道不指定 RP 时写入和查询都走默认 RP，以及生产环境应显式写出 RP
