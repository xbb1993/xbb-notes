# 专题 13 · 数据分布、基数、选择性与统计信息

> 级别 ☆（高频重点）· 主线 A / C · 实测版本：沙箱 MySQL 8.0.46

本专题回答专题 1 留下的问题：

```
EXPLAIN SELECT * FROM t_order WHERE amount > 999;
filtered = 33.33        ← 优化器估计 33% 的行满足条件，实际只有约 0.1%
```

1. EXPLAIN 的 `rows` 与 `filtered` 从哪里来？
2. 为什么有时很准（`user_id = 123` 估 13 行、实际 13 行），有时差几百倍？
3. 估错了会怎样？怎么发现、怎么修正？

## 一、类比：抽样调查

统计局不会挨家挨户数人口，而是抽样再推算，结果有误差，几年不更新还会过时。优化器同样必须在执行前知道“满足条件的大约有多少行”才能比较方案成本（专题 10 交叉点、专题 12 案例二），但不能先把数据数一遍。它依赖三类信息：

| 信息 | 类比 | 本笔记 |
| --- | --- | --- |
| 统计信息：表行数、各索引不同值个数 | 定期抽样调查结果 | 第二、三节 |
| 索引下潜（index dive）：执行前到索引树上实地查看 | 临时派人去现场看 | 第四节 |
| 直方图：某列的取值分布 | 专项调查报告 | 第五节 |

## 二、基数与选择性

| 概念 | 含义 | `t_order` 中的例子 |
| --- | --- | --- |
| 基数（cardinality） | 一列中不同值的个数 | `user_id` 约 10 万个 |
| 选择性（selectivity） | 基数 ÷ 总行数，越接近 1 区分度越高 | 主键为 1；`user_id` 约 0.1；`status` 为 5 / 100 万 |

```
SHOW INDEX FROM t_order;
Key_name   Column_name   Cardinality
PRIMARY    id            995558         ← 实际 1000000
idx_user   user_id       99214          ← 实际 99984
```

`Cardinality` 是来自抽样的**估算值**。

## 三、统计信息怎么来

### 3.1 存储

8.0 默认使用**持久化统计信息**（`innodb_stats_persistent = ON`），存于两张表，重启不丢失：

```
mysql.innodb_table_stats
n_rows    clustered_index_size   sum_of_other_index_sizes
995558    4647                   4843

mysql.innodb_index_stats
index_name   stat_name      stat_value   sample_size   stat_description
PRIMARY      n_diff_pfx01   995558       20            id
idx_user     n_diff_pfx01   99214        20            user_id
idx_user     n_diff_pfx02   1039822      20            user_id,id
idx_user     n_leaf_pages   1799                       Number of leaf pages in the index
```

- `n_diff_pfxNN`：索引前 NN 列组合的不同值个数；非唯一索引后面自动带主键列（专题 10），所以 `idx_user` 有 `n_diff_pfx02`。
- `sample_size = 20`：只抽样 20 页（`innodb_stats_persistent_sample_pages`，默认 20）。
- 抽样误差明显：`(user_id, id)` 每行都不同，正确值是 100 万，估出 1039822，比实际行数还多。

### 3.2 更新时机（手册）

| 方式 | 说明 |
| --- | --- |
| 自动 | `innodb_stats_auto_recalc`（默认 ON）：超过 10% 的行变化后，**后台异步**重新计算，可能滞后几秒 |
| 手动 | `ANALYZE TABLE t`：前台同步重新计算 |
| 按表设置 | `STATS_PERSISTENT`、`STATS_AUTO_RECALC`、`STATS_SAMPLE_PAGES` |

自动重新计算不经复制同步（各服务器各算各的），手动 `ANALYZE TABLE` 会写入 binlog、在从库也执行。

### 3.3 抽样页数与误差

连续 `ANALYZE`（`idx_user` 实际不同值个数 99984）：

```
抽样页数   n_rows    idx_user 不同值个数
20         995097    108299
20         995558    100114
20         994867    101013
200        995927     98162
200        995927     98837
```

抽样 20 页时每次结果不同，最大偏差约 8%；200 页更稳定，代价是 ANALYZE 读更多页。手册建议：估算不准导致计划变差时调大，ANALYZE 太慢时调小。

## 四、两种行数估算方式

### 4.1 有索引：索引下潜

条件落在有索引的列上时，优化器执行前到索引树上分别定位范围两端，估算两端之间的行数，称为**索引下潜**（index dive）。

```
WHERE user_id = 123    → rows = 13      实际 13
WHERE user_id = 777    → rows = 97774   实际 50013（t_case 中的大客户）
```

范围小时几乎数得准；跨越很多页时根据部分页推算，误差变大，但数量级正确。

### 4.2 值很多的 IN：从下潜切换为统计信息

`IN (v1, …, vN)` 每个值都要各下潜一次。阈值 `eq_range_index_dive_limit`（默认 200）：手册规定**值的个数小于阈值时用下潜，达到或超过时改用统计信息**（每个值的平均行数）。

实验：`t_case` 中 `IN` 列表放大客户 777，再补若干普通用户：

```
                        优化器估算行数   实际行数    估算方式
IN 列表 199 个值           99869          52108      下潜（199 < 200）
IN 列表 200 个值            2000          52116      统计信息：200 个值 × 平均约 10 行
```

只多一个值，估算从约 10 万掉到 2000，少估 26 倍；统计信息只知道“平均每个用户约 10 行”，不知道 777 是大客户。同一组列表用于 `SELECT *` 时，计划随之改变：

```
199 个值：估约 10 万行 → 认为回表太多，选全表扫描（type=ALL）
200 个值：估 2000 行  → 选 idx_user 范围扫描（type=range）
```

::: warning 易混淆
| 错误理解 | 正确理解 |
| --- | --- |
| IN 列表长短不影响执行计划 | 跨过 `eq_range_index_dive_limit` 时估算方式改变，计划可能跟着变 |
| 统计信息中的平均值适用于所有值 | 数据倾斜时（大客户、热门商品）平均值对个别值完全不准 |
:::

**工作中**：代码拼接的 `WHERE id IN (…)` 长度随业务变化，某天计划突变时要想到这个阈值。

### 4.3 无索引、无直方图：固定经验值

```
条件                               filtered
amount = 500.00                    10.00
amount > 999                       33.33
amount BETWEEN 100 AND 200         11.11
city = 'Beijing'（t_user）         10.00
```

等值估 10%，大小比较估约 1/3，BETWEEN 估约 1/9，与 MySQL 源码中的固定估算常数一致。专题 1 的 33.33% 由此而来，**它根本没看数据**。单表时往往无害（反正只能全表扫描），但在 join 中 `filtered` 决定驱动表（第五节）。

## 五、直方图

### 5.1 作用

给 `amount` 建索引能让优化器下潜，但索引有写入代价，而该列可能并不需要用于查找。8.0 的**直方图**（histogram）只记录列的取值分布，供估算 `filtered` 使用，不参与查找、不随写入维护。

### 5.2 建立与查看

```sql
ANALYZE TABLE t_order UPDATE HISTOGRAM ON amount WITH 100 BUCKETS;
```

桶数 1–1024，默认 100（手册）。两种类型：

| 类型 | 何时生成 | 每个桶表示 |
| --- | --- | --- |
| singleton | 不同值个数 ≤ 桶数 | 一个具体值及其出现比例 |
| equi-height（等高） | 不同值个数 > 桶数 | 一个取值区间，每个桶行数大致相同 |

```
information_schema.COLUMN_STATISTICS
表        列       类型          桶数   抽样比例
t_order   amount   equi-height   100    0.119
t_user    city     equi-height   100    0.734

amount 的最后一个桶：[991.77, 999.98, 1.0, 1164]
                     下限     上限    累计比例  桶内不同值个数
```

每个等高桶约占 1% 的行，优化器据此推算 `amount > 999` 约 0.1%。抽样比例 0.119：所需数据量超过 `histogram_generation_max_mem_size`（实测 20000000 字节）时只抽样部分行。

### 5.3 建立前后的估算

```
条件                               无直方图   有直方图   实际
amount > 999                       33.33      0.10       0.09%
amount = 500.00                    10.00      0.10       —（等高直方图对单值只能近似）
amount BETWEEN 100 AND 200         11.11      9.98       约 10%
t_user.city = 'Beijing'            10.00      49.79      49.73%
```

`city` 有 201 个不同值，超过 100 个桶，生成等高直方图；Beijing 一个值占一半行，占据约一半的桶，仍能估出 49.79%。

### 5.4 对 join 顺序的影响

```sql
-- t_user 10 万用户，一半在 Beijing；结果 468
SELECT COUNT(*) FROM t_user u JOIN t_order o ON o.user_id = u.id
WHERE o.amount > 999 AND u.city = 'Beijing';
```

**无直方图**：u 估 10 万 × 10% ≈ 1 万行，o 估 100 万 × 33.33% ≈ 33 万行 → 先查 u，再到 o 的 idx_user 查找：

```
u 全表扫描 → o ref(idx_user)    检查 597052 行，1054.5 ms
```

实际 u 过滤后约 5 万用户，再各查约 10 笔订单并回表，约 50 万次随机查找。

**有直方图**：u 估约 5 万行，o 估约 1000 行 → 先查 o，再到 u 主键查找：

```
o 全表扫描（过滤后约 1000 行）→ u eq_ref(PRIMARY)    检查 1000946 行，217.0 ms
```

检查行数更多，但 100 万行是**顺序读**，之后只有约 1000 次主键查找；原方案是 50 万次**随机查找加回表**，耗时降约 5 倍。

::: warning 易混淆
| 错误理解 | 正确理解 |
| --- | --- |
| 检查行数越少查询越快 | 还要看顺序读还是随机读 |
| `filtered` 不准只影响显示 | 在 join 中决定驱动表，直接影响计划 |
:::

### 5.5 局限

| 局限 | 说明 |
| --- | --- |
| 8.0 不自动更新 | 手册：只在手动执行时创建或更新，数据变化后逐渐过时。8.4 的 `ANALYZE TABLE` 新增 `AUTO UPDATE` 选项，随 InnoDB 自动重新统计一起更新；实测 8.0.46 报语法错误 |
| 对有索引的列作用有限 | 手册：主要用于无索引列；有索引时优先使用下潜的范围估算 |
| 等值只能近似 | 等高桶内包含多个值 |
| 部分列不能建 | 单列唯一索引覆盖的列；JSON、空间类型列 |
| 构建有成本 | 要读该列数据（超过内存上限时抽样） |

**适用**：无索引、常出现在 WHERE 中、分布明显不均的列，尤其参与多表 join 的查询（状态、类型、地区、金额区间等）。

## 六、统计信息过时

### 6.1 什么时候会过时

| 情况 | 原因 |
| --- | --- |
| 关闭了自动重新统计 | `STATS_AUTO_RECALC = 0` 或全局关闭 |
| 变化不到 10% 但很集中 | 如新增大客户的 5 万笔订单，只占 5%，不触发 |
| 大批量导入或删除刚结束 | 后台异步计算有滞后 |
| 直方图 | 8.0 中从不自动更新 |

### 6.2 实验

```sql
CREATE TABLE t_stale (
  id BIGINT UNSIGNED PRIMARY KEY, user_id INT UNSIGNED NOT NULL, amount DECIMAL(10,2) NOT NULL,
  KEY idx_user (user_id)
) STATS_AUTO_RECALC = 0;
-- ① 先放 1000 行（user_id 只有 100 个不同值），ANALYZE
-- ② 再导入 999000 行（user_id 约 10 万个不同值），不重新统计
-- t_vip：500 个 VIP 用户
SELECT v.name, SUM(s.amount) FROM t_vip v JOIN t_stale s ON s.user_id = v.user_id GROUP BY v.name;
```

```
过时时：  idx_user 不同值个数 = 100
          s 全表扫描（100 万行）→ v eq_ref(PRIMARY)       检查 1005907 行，1878.3 ms
ANALYZE 后：n_rows = 997899，idx_user 不同值个数 = 89709
          v 全表扫描（500 行）→ s ref(idx_user)，每用户估 10 行   检查 6407 行，18.0 ms
```

耗时相差约 100 倍。过时时 EXPLAIN 中每个 `user_id` 估约 10000 行。由数字反推：10000 = 1000000 ÷ 100，即行数用的是导入后的真实规模，不同值个数用的却是导入前的 100。优化器认为每个 VIP 有 1 万笔订单，500 个用户即 500 万次查找，不如全表扫描；实际每人约 10 笔。

## 七、在三条主线中的位置

```
A 性能：SQL → [优化器：统计信息、下潜、直方图估算行数 → 计算成本 → 选计划] → 执行计划 → 索引 …
         估算错误是“选错索引、选错 join 顺序”最常见的原因
C 诊断：见第八节
B 一致性：不涉及
```

::: tip PG 对照
PostgreSQL 的 `ANALYZE` 默认为**每一列**收集统计（最常见值列表 MCV、直方图、不同值个数等），由 autovacuum 自动维护，无索引列也有分布信息。MySQL 只为索引收集统计，列直方图要手动建，8.0 中还要手动更新。从 PG 转来要注意：MySQL 中无索引的列默认没有任何分布信息。
:::

## 八、排查要点

| 观察点 | 回答的问题 |
| --- | --- |
| EXPLAIN 的 rows / filtered 与实际行数 | 估算偏差有多大（专题 15 的 EXPLAIN ANALYZE 可并排显示估算与实际） |
| `mysql.innodb_table_stats` / `innodb_index_stats` 的 last_update、n_rows、n_diff | 统计信息是否过时 |
| IN 列表长度 | 是否跨过 `eq_range_index_dive_limit` |
| `information_schema.COLUMN_STATISTICS` | 直方图是否存在、是否过时 |

```sql
SELECT table_name, last_update, n_rows FROM mysql.innodb_table_stats WHERE database_name = '库名';
```

**处置**：

- 执行 `ANALYZE TABLE`（只抽样若干页，通常很快）；
- 大批量导入、删除后主动 ANALYZE，不依赖后台异步更新；
- 数据严重倾斜、平均值不代表个别值时，统计再新也解决不了（4.2 节），考虑查询提示（专题 17）或拆分查询。

## 九、本地复现脚本

在专题 1 的 Docker 环境（`mysql:8.4`）中执行。

```sql
USE lab;

-- 1. 统计信息与基数
SELECT @@innodb_stats_persistent, @@innodb_stats_auto_recalc, @@innodb_stats_persistent_sample_pages,
       @@eq_range_index_dive_limit, @@histogram_generation_max_mem_size;
SHOW INDEX FROM t_order;
SELECT COUNT(DISTINCT user_id) FROM t_order;
SELECT index_name, stat_name, stat_value, sample_size, stat_description
FROM mysql.innodb_index_stats WHERE database_name = 'lab' AND table_name = 't_order';

-- 2. 抽样误差：重复几次
ANALYZE TABLE t_order;
SELECT stat_value FROM mysql.innodb_index_stats
WHERE database_name = 'lab' AND table_name = 't_order' AND index_name = 'idx_user' AND stat_name = 'n_diff_pfx01';

-- 3. IN 列表阈值（需专题 12 的 t_case）：生成 199 个与 200 个值的列表，第一个值放 777
EXPLAIN SELECT SUM(amount) FROM t_case WHERE user_id IN (777, 1000, 1001, /* … */ 1197);   -- 199 个值
EXPLAIN SELECT SUM(amount) FROM t_case WHERE user_id IN (777, 1000, 1001, /* … */ 1198);   -- 200 个值

-- 4. 经验值与直方图
EXPLAIN SELECT COUNT(*) FROM t_order WHERE amount > 999;
EXPLAIN SELECT COUNT(*) FROM t_order WHERE amount BETWEEN 100 AND 200;
ANALYZE TABLE t_order UPDATE HISTOGRAM ON amount WITH 100 BUCKETS;
SELECT TABLE_NAME, COLUMN_NAME, HISTOGRAM->>'$."histogram-type"' AS type,
       JSON_LENGTH(HISTOGRAM->'$.buckets') AS buckets, HISTOGRAM->>'$."sampling-rate"' AS sampling
FROM information_schema.COLUMN_STATISTICS WHERE SCHEMA_NAME = 'lab';
EXPLAIN SELECT COUNT(*) FROM t_order WHERE amount > 999;

-- 5. 直方图对 join 的影响
CREATE TABLE t_user (id INT UNSIGNED PRIMARY KEY, city VARCHAR(20) NOT NULL, level TINYINT NOT NULL);
SET SESSION cte_max_recursion_depth = 100000;
INSERT INTO t_user WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 100000)
SELECT n, IF(RAND() < 0.5, 'Beijing', CONCAT('City', FLOOR(RAND() * 200))), FLOOR(RAND() * 5) FROM s;
ANALYZE TABLE t_user;
ANALYZE TABLE t_order DROP HISTOGRAM ON amount;
EXPLAIN SELECT COUNT(*) FROM t_user u JOIN t_order o ON o.user_id = u.id WHERE o.amount > 999 AND u.city = 'Beijing';
SELECT COUNT(*) FROM t_user u JOIN t_order o ON o.user_id = u.id WHERE o.amount > 999 AND u.city = 'Beijing';
ANALYZE TABLE t_order UPDATE HISTOGRAM ON amount WITH 100 BUCKETS;
ANALYZE TABLE t_user  UPDATE HISTOGRAM ON city   WITH 100 BUCKETS;
EXPLAIN SELECT COUNT(*) FROM t_user u JOIN t_order o ON o.user_id = u.id WHERE o.amount > 999 AND u.city = 'Beijing';
SELECT COUNT(*) FROM t_user u JOIN t_order o ON o.user_id = u.id WHERE o.amount > 999 AND u.city = 'Beijing';

-- 6. 统计信息过时
CREATE TABLE t_stale (id BIGINT UNSIGNED PRIMARY KEY, user_id INT UNSIGNED NOT NULL, amount DECIMAL(10,2) NOT NULL,
                      KEY idx_user (user_id)) STATS_AUTO_RECALC = 0;
INSERT INTO t_stale SELECT id, user_id % 100, amount FROM t_order WHERE id <= 1000;
ANALYZE TABLE t_stale;
INSERT INTO t_stale SELECT id, user_id, amount FROM t_order WHERE id > 1000;
CREATE TABLE t_vip (user_id INT UNSIGNED PRIMARY KEY, name VARCHAR(20));
INSERT INTO t_vip SELECT id, CONCAT('vip', id) FROM t_user WHERE id <= 500;
ANALYZE TABLE t_vip;
EXPLAIN SELECT v.name, SUM(s.amount) FROM t_vip v JOIN t_stale s ON s.user_id = v.user_id GROUP BY v.name;
ANALYZE TABLE t_stale;
EXPLAIN SELECT v.name, SUM(s.amount) FROM t_vip v JOIN t_stale s ON s.user_id = v.user_id GROUP BY v.name;
```

8.4 可额外试 `ANALYZE TABLE t_order UPDATE HISTOGRAM ON amount WITH 100 BUCKETS AUTO UPDATE;`（8.0 报语法错误）。

**预期现象**：`Cardinality` 与 `COUNT(DISTINCT)` 有偏差且重复 ANALYZE 会波动；IN 列表从 199 变为 200 个值时估算行数骤降；`amount > 999` 的 filtered 由 33.33 变为约 0.1；join 在建直方图后驱动表由 u 变为 o；`t_stale` ANALYZE 前选全表扫描、之后改为 ref，耗时相差约两个数量级。

## 十、与其他专题的关联

- **专题 1**：33.33% 的来源。
- **专题 10、12**：交叉点与范围/排序冲突中优化器的选择依赖本专题的估算。
- **专题 15**：EXPLAIN ANALYZE 对比估算与实际。
- **专题 16**：估算行数如何进入成本模型。
- **专题 17**：估算无法修正时用提示干预。
- **专题 20**：join 顺序的选择。

## 十一、复习 checklist

- [ ] 能区分基数与选择性，知道 `SHOW INDEX` 的基数是估算值
- [ ] 知道统计信息的存储位置、抽样页数、自动更新的 10% 阈值与异步特性
- [ ] 能解释索引下潜的原理与误差来源
- [ ] 能说明 `eq_range_index_dive_limit` 的规则，以及数据倾斜时它如何导致计划突变
- [ ] 知道无索引列的三个固定经验值，以及它们在 join 中的危害
- [ ] 会建立与查看直方图，能读懂等高桶的四个字段
- [ ] 能用实验解释直方图如何改变 join 顺序，以及“检查行数少不等于快”
- [ ] 知道直方图的局限与 8.0 / 8.4 在自动更新上的差异
- [ ] 能列出统计信息过时的四种情况，并给出发现与处置方法
