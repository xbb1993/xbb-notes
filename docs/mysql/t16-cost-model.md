# 专题 16 · 优化器成本模型

> 级别 ★（核心，按学习者要求简述）· 主线 A · 实测版本：沙箱 MySQL 8.0.46

本专题回答：EXPLAIN JSON 与 optimizer trace 中的 `cost` 怎么算？为什么同一条 SQL 冷热不同计划会变？优化器为什么会系统性地选错？

## 一、成本怎么算

类比装修报价：总价 = 材料费 + 人工费。

```
成本 = 读页的成本（IO）              + 处理行的成本（CPU）
     = 要读的页数 × 每页读取成本      + 要判断的行数 × 每行判断成本
```

成本常数（沙箱实测默认值；`cost_value` 为 NULL 表示使用 `default_value`）：

| 表 | 常数 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `mysql.engine_cost` | `io_block_read_cost` | 1.0 | 从磁盘读一页 |
| | `memory_block_read_cost` | 0.25 | 读一个已在 Buffer Pool 的页 |
| `mysql.server_cost` | `row_evaluate_cost` | 0.1 | 判断一行是否满足条件 |
| | `key_compare_cost` | 0.05 | 比较一次键值（排序等） |
| | `memory_temptable_create_cost` / `memory_temptable_row_cost` | 1 / 0.1 | 内存临时表创建 / 每行 |
| | `disk_temptable_create_cost` / `disk_temptable_row_cost` | 20 / 0.5 | 磁盘临时表创建 / 每行 |

::: warning 关键细节
每页读取成本不是固定的 1.0。InnoDB 会估计表或索引有多大比例已在 Buffer Pool 中（trace 中的 `in_memory`），按比例在 0.25 与 1.0 之间取值。**同一条 SQL，数据冷热不同，成本不同，计划也可能不同。**
:::

## 二、手算验证

`t_order` 统计信息：998323 行、4647 页。

| 场景 | 手算 | 优化器给出 |
| --- | --- | --- |
| 全表扫描，数据不在内存 | 4647 × 1.0 + 998323 × 0.1 = 104479.3 | JSON `query_cost` = **104479.30** |
| 全表扫描，数据已在内存 | 4647 × 0.25 + 998323 × 0.1 ≈ 100994 | **100994.05** |
| 走 idx_user 回表 119176 行，页在内存 | 119176 × (0.25 + 0.1) ≈ 41711.6 | trace **41711.9** |
| 同上，按页不在内存计价 | 119176 × (1.0 + 0.1) ≈ 131093.6 | trace **131095** |

后两行揭示回表的计价方式：**每回表一行按读一个页计价**，再加判断该行的成本。

## 三、实验：交叉点随缓存状态与常数移动

`SELECT SUM(amount) FROM t_order WHERE user_id <= X`，看优化器在哪里由走索引切换为全表扫描：

```
                                            X=2000   4000    6000    8000    10000   14000
① 会话刚开始（表的页大多不在内存）            range    range   ALL     ALL      —       —
② 多次查询之后（表已在内存）                   —        —     range    —      range    ALL
③ 把 memory_block_read_cost 改为 1.0           —        —      ALL     ALL     ALL     ALL
```

- ①→②：数据变热后切换点从约 5% 移到 10%–14% 之间：回表每页成本从接近 1.0 降到 0.25，走索引变“便宜”，而全表扫描成本主要是行判断成本（99832），几乎不变。
- ③：内存页与磁盘页同价，6000 也改选全表扫描。

```sql
UPDATE mysql.engine_cost SET cost_value = 1.0 WHERE cost_name = 'memory_block_read_cost';
FLUSH OPTIMIZER_COSTS;     -- 重新读取成本表，只对之后新建的会话生效
-- 恢复：cost_value 设回 NULL，再 FLUSH OPTIMIZER_COSTS
```

**一般不建议修改成本常数**：影响全局所有查询，副作用难以评估。计划选错时，优先修正统计信息（专题 13）、索引（专题 12），或对单条语句用提示（专题 17）。

## 四、模型的主要局限

| 局限 | 后果 | 前面在哪里见过 |
| --- | --- | --- |
| 行数来自估算 | 行数错，成本就错 | 专题 13：IN 列表阈值、33% 经验值、统计信息过时 |
| 回表一行只按“读一个页”计价 | 未计入从根到叶的逐层查找（实测每次回表约 4 次逻辑读，专题 3）与每次查找的 CPU 开销，**低估回表**，切换到全表扫描偏晚 | 专题 10：实际交叉点 8%–10%，优化器 12.5%–15% 才切换 |
| 不区分顺序读与随机读 | 只有一个磁盘页成本常数 | 专题 3：冷状态随机读比顺序读慢 18 倍 |
| 选择访问方式时不计入后续排序成本 | 成本打平时可能选中需要额外排序的索引 | 专题 15：`idx_s_c` 与 `idx_status` 只差 0.4% |
| “多少数据在内存中”是估计 | 计划随缓存冷热变化 | 本专题第三节 |

第二行为根据数字所做推断：回表成本是“行数 × 每页成本”，其中没有反映树高或逐层查找的项。

## 五、join 顺序的搜索

n 张表的关联顺序有 n! 种（5 张表 120 种，10 张表约 363 万种），优化器不会全部计算：

| 参数 | 默认值（实测） | 作用 |
| --- | --- | --- |
| `optimizer_search_depth` | 62 | 一次最多向前搜索几张表的组合；超过时改为分段贪心搜索 |
| `optimizer_prune_level` | 1 | 开启启发式剪枝，明显更差的部分顺序不再展开 |

剪枝缩短优化时间，代价是可能剪掉最优解，表很多时偶尔选出很差的顺序，可用 `STRAIGHT_JOIN` 或 `JOIN_ORDER` 提示固定（专题 17）。

::: tip PG 对照
PostgreSQL 区分顺序读与随机读：`seq_page_cost` 默认 1.0、`random_page_cost` 默认 4.0，另有 `cpu_tuple_cost`（0.01）等；SSD 上常把 `random_page_cost` 调低到约 1.1。MySQL 只有一个磁盘页成本，随机与顺序的差别只能间接体现在“读多少页”上，这是它对回表代价不够敏感的原因之一。
:::

## 六、在三条主线中的位置

```
A 性能：SQL → [优化器：行数估算（专题 13）× 成本常数 = 成本 → 比较 → 选计划] → 执行计划 → …
B 一致性：不涉及
C 诊断：见第七节
```

## 七、诊断实践

### 7.1 判断“为什么选这个计划”

```
① EXPLAIN FORMAT=JSON / optimizer trace：取出各候选方案的 cost 与 rows
② 用第一节公式手算：行数是否合理？每页成本按冷还是热计价？
③ 归因：是行数估错（→ 专题 13），还是模型未计入某项成本（回表逐层查找、排序、随机读）
④ 对策：修统计信息或索引；单条语句用提示（专题 17）；极少数情况才考虑调整成本常数
```

### 7.2 病例：同一条 SQL 白天走索引、凌晨走全表扫描

1. **现象**：同一报表 SQL 在不同时间耗时差异大，EXPLAIN 时而 range 时而 ALL。
2. **指标**：trace 中同一索引的 `in_memory` 与 cost 在不同时间明显不同。
3. **定位**：数据冷热变化改变了每页读取成本，命中比例又恰在交叉点附近。
4. **处置**：评估该查询在冷、热两种状态下哪种计划更稳；用覆盖索引消除回表使计划不再摇摆，或用提示固定。

## 八、本地复现

```sql
USE lab;
SELECT cost_name, cost_value, default_value FROM mysql.server_cost;
SELECT engine_name, device_type, cost_name, cost_value, default_value FROM mysql.engine_cost;
SELECT n_rows, clustered_index_size FROM mysql.innodb_table_stats WHERE database_name = 'lab' AND table_name = 't_order';
EXPLAIN FORMAT=JSON SELECT * FROM t_order WHERE amount > 999\G      -- 用上一行两个数手算 query_cost

-- 交叉点：X = 2000、4000、6000、10000、14000 分别执行，记录 access_type 与 query_cost
EXPLAIN FORMAT=JSON SELECT SUM(amount) FROM t_order WHERE user_id <= 6000\G

-- 修改常数（新开会话再看上面的 EXPLAIN），实验后恢复
UPDATE mysql.engine_cost SET cost_value = 1.0 WHERE cost_name = 'memory_block_read_cost';
FLUSH OPTIMIZER_COSTS;
UPDATE mysql.engine_cost SET cost_value = NULL WHERE cost_name = 'memory_block_read_cost';
FLUSH OPTIMIZER_COSTS;
```

**预期现象**：冷数据下全表扫描 `query_cost` 等于“页数 × 1.0 + 行数 × 0.1”；数据变热后切换点右移；`memory_block_read_cost` 改为 1.0 后原走索引的查询改选全表扫描。

## 九、与其他专题的关联

- **专题 3**：回表的真实代价（约 4 次逻辑读）；随机与顺序读的差距。
- **专题 10**：优化器切换偏晚的根源。
- **专题 13**：成本公式中的行数来自统计信息与下潜。
- **专题 15**：JSON 与 trace 中的 cost；成本打平案例。
- **专题 17**：用提示绕过模型局限。

## 十、复习 checklist

- [ ] 能写出成本 = 页数 × 每页成本 + 行数 × 每行成本，并说出主要常数的默认值
- [ ] 知道每页成本按 `in_memory` 比例在 0.25 与 1.0 之间取值
- [ ] 能手算全表扫描与回表的成本并与优化器输出对上
- [ ] 能解释交叉点为何随缓存冷热移动
- [ ] 能列出成本模型的五项局限，并对应到前面专题中的“选错”案例
- [ ] 知道 join 顺序搜索的两个参数及剪枝的代价
- [ ] 知道为什么一般不修改成本常数
