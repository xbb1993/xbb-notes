# 专题 20 · join 与子查询优化

> 级别 ☆ · 主线 A · 实测版本：沙箱 MySQL 8.0.46

本专题回答：两表关联在 MySQL 内部怎么执行？驱动表怎么选、为什么会选错？IN / EXISTS / NOT IN 子查询和派生表会被优化器改写成什么？

**贯穿场景**：运营要看“某城市用户的订单汇总”。`t_user` 10 万行（Beijing 49732 人，City12 257 人）；`t_order` 100 万行，关联列索引 `idx_user(user_id)`；`amount > 999` 的订单 946 行。

**类比**：拿名单去档案室找档案。档案按名字建了目录（索引），就逐个查目录；没有目录，就把名单抄在一张大纸上，把档案室从头扫一遍，每份档案和名单对一下（hash join）。

## 一、join 的执行算法

### 1.1 从朴素做法到两种改进

**嵌套循环连接（Nested-Loop Join，NLJ）** 就是两层 for 循环：

```
for u in t_user (过滤后):            ← 外层：驱动表
    for o in t_order:                ← 内层：被驱动表
        if o.user_id == u.id: 输出
```

内层若每次扫全表，代价 = 驱动行数 × 被驱动表行数（257 × 100 万 ≈ 2.6 亿次比较）。两种改进：

| 条件 | 做法 | 名称 / EXPLAIN 表现 |
| --- | --- | --- |
| 被驱动表关联列有索引 | 每个驱动行到索引查一次 | **Index Nested-Loop Join**；被驱动表 type 为 ref / eq_ref |
| 无可用索引 | 一侧装进内存哈希表，扫另一侧去匹配，内层只扫一遍 | **Hash Join**；Extra 为 `Using join buffer (hash join)` |

版本（8.0 手册）：8.0.18 引入 hash join；此前无索引时用 **Block Nested-Loop（BNL）**——驱动行成批装入 join buffer，每批扫一遍被驱动表；**8.0.20 移除 BNL**，原用 BNL 处一律改用 hash join，并支持外连接 / 半连接 / 反连接及非等值条件。

### 1.2 hash join

```
构建（build）：扫描较小一侧，按关联键放入内存哈希表
  t_user WHERE city='City12' → 257 行 → 哈希表 { id → 行 }

探测（probe）：扫描另一侧，每行用关联键查哈希表
  t_order 100 万行逐行扫 → 用 user_id 查哈希表 → 命中即输出
```

哈希表内存上限为 `join_buffer_size`（沙箱实测默认 262144 字节 = 256 KB），超过则两侧按哈希值切分成多个文件写盘，再逐对处理。

### 1.3 实验：同一条 SQL，三种执行方式

```sql
SELECT COUNT(*), SUM(o.amount) FROM t_user u JOIN t_order o ON o.user_id = u.id
WHERE u.city = 'City12';
```

| | 条件 | 计划（FORMAT=TREE） | 检查行数 | 耗时 |
| --- | --- | --- | --- | --- |
| A | 正常 | u 全表扫描过滤出 257 行 → 每行用 idx_user 查 o | 102540 | 26.8 ms |
| B | o 加 `IGNORE INDEX (idx_user)` | **驱动表换成 o**：扫 o 100 万行，每行按主键查 u | 2000000 | 773 ms |
| C | 两边索引都忽略 | Inner hash join：u 过滤后 257 行建哈希表，扫 o 探测 | 1100000 | 145 ms |

- **A vs B**：被驱动表关联列上的索引是 NLJ 的生命线。去掉 idx_user 后，优化器宁可换大表驱动，也要让内层走 u 的主键。
- **B vs C**：优化器估算 B 成本约 4.5 × 10⁵、C 约 2.57 × 10⁷，因此选 B；实际 C 快 5 倍。据此推断 **8.0 对 hash join 的成本估算偏高**，有索引可走时它很少被选中——成本模型局限的又一例（专题 16）。
- **join_buffer_size**：把建表一侧换成 Beijing 的 49732 人：

| join_buffer_size | 256 KB | 4 MB | 64 MB |
| --- | --- | --- | --- |
| 耗时 | 366 ms | 299 ms | 236 ms |

256 KB 装不下需写临时文件。它**每个 join 单独分配**，不宜全局调大，需要时用 `SET_VAR` 对单条语句调整（专题 17）。

::: danger 错误理解 vs 正确理解
- ❌ 8.0 有了 hash join，关联列不建索引也无所谓。
- ✅ hash join 的探测侧仍要**扫全表**（C 扫了 100 万行），只是把 BNL 的多遍扫描变成一遍。OLTP 中按条件关联少量行，靠的仍是被驱动表索引（A 比 C 快 5 倍）；hash join 适合两边都要扫大量数据的报表类关联。
:::

## 二、驱动表的选择

### 2.1 “小表驱动大表”的“小”

```sql
SELECT COUNT(*) FROM t_user u JOIN t_order o ON o.user_id = u.id
WHERE o.amount > 999 AND u.city = 'Beijing';
```

| 顺序 | 过程 | 检查行数 | 耗时 |
| --- | --- | --- | --- |
| 优化器默认 u → o | 49732 个用户，每人用 idx_user 查约 10 笔订单并回表，再过滤 amount | 597052 | 1182 ms |
| `STRAIGHT_JOIN` o → u | 顺序扫 o 100 万行，过滤出 946 行，每行按主键查 u | 1000946 | 185 ms |

```
u → o：49732 次“索引查找 + 约 10 次回表”   ≈ 50 万次随机读
o → u：100 万行顺序扫描 + 946 次主键查找   ≈ 以顺序读为主
```

- **“小”指过滤后的行数**，不是表大小：t_user 表小但过滤后 5 万行；t_order 表大但过滤后 946 行。
- **检查行数少 ≠ 快**：默认顺序检查行数少 40%，耗时却是 6 倍——50 万次随机回表比 100 万行顺序扫描贵得多（专题 3、10）。

### 2.2 为什么选错

o 的 `filtered=33.33`：`amount` 无索引无直方图，优化器按经验值猜 33%（专题 13），实际 0.09%，差约 350 倍。

建直方图后：`filtered` 33.33 → 0.10，优化器自动改选 o → u，205 ms。专题 17 中 `JOIN_ORDER` 把 945 ms 降到 205 ms 的根源即在此。**修统计信息优于加提示**：条件值变化时优化器能自行调整，提示则把顺序写死。

::: danger 错误理解 vs 正确理解
- ❌ 写 SQL 时要把小表放在 JOIN 左边。
- ✅ 普通 `JOIN` 的书写顺序不影响执行顺序，优化器会重排（`STRAIGHT_JOIN`、`LEFT JOIN` 才限制顺序）。要做的是：被驱动表关联列有索引，过滤条件的行数估算准确。
:::

## 三、子查询的改写

### 3.1 IN / EXISTS → 半连接

**半连接（semi-join）**：外表每行只要内表**存在**匹配就输出一次，匹配几行都只输出一次（区别于普通 join）。

```sql
SELECT COUNT(*) FROM t_user u WHERE u.id IN (SELECT o.user_id FROM t_order o WHERE o.amount > 999);
SELECT COUNT(*) FROM t_user u WHERE EXISTS (SELECT 1 FROM t_order o WHERE o.user_id = u.id AND o.amount > 999);
```

实测两种写法**计划完全相同**，均约 160 ms，结果 942：

```
Nested loop inner join
├─ Index scan on u using PRIMARY
└─ Single-row index lookup on <subquery2>
   └─ Materialize with deduplication       ← 子查询结果物化为带索引的去重临时表
      └─ Filter: o.amount > 999 → Table scan on o
```

`EXISTS` 自 8.0.16 起与 `IN` 走同样的半连接改写（8.0 手册）。

::: warning 常见误区
“IN 子查询很慢，一定要改成 JOIN / EXISTS”是老版本经验（当年子查询逐行执行）。现在三种写法常得到相同计划，**以 EXPLAIN 为准**。
:::

半连接执行策略（优化器按成本选择）：

| 策略 | 思路 | EXPLAIN 标志 |
| --- | --- | --- |
| Table pullout | 子查询的表提到外层变成普通 join | 子查询消失 |
| FirstMatch | 内表找到第一条匹配即停 | `FirstMatch(表名)` |
| LooseScan | 沿内表索引每组值只取一条 | `LooseScan(m..n)` |
| Materialization | 物化为带索引的去重临时表 | select_type `MATERIALIZED` |
| Duplicate Weedout | 按普通 join 执行再用临时表去重 | `Start temporary` / `End temporary` |

不能改写：子查询含 `UNION`、聚合函数、`HAVING`、`LIMIT`，或外层用了 `STRAIGHT_JOIN`（8.0 手册）。

### 3.2 NOT IN / NOT EXISTS → 反连接，与 NULL 陷阱

**反连接（anti-join）**：外表行在内表**不存在**匹配才输出。8.0.17 起 `NOT IN` / `NOT EXISTS` 改写为反连接，实测计划为 `Nested loop antijoin`，Extra `Not exists`。

**NULL 陷阱**：黑名单表 `t_black(user_id INT UNSIGNED NULL)`，插入 1、2、NULL：

```
NOT IN            → 0          ← 一行都没有
NOT EXISTS        → 99998
LEFT JOIN IS NULL → 99998
```

三值逻辑（专题 5）：

```
3 NOT IN (1, 2, NULL)
= 3<>1 AND 3<>2 AND 3<>NULL
= TRUE AND TRUE AND NULL
= NULL   → WHERE 只保留 TRUE，被过滤
```

实测 `SELECT 3 NOT IN (1, 2, NULL)` 返回 NULL。子查询结果只要含一个 NULL，`NOT IN` 对任何值都不会为 TRUE。

性能副作用：列可为 NULL 时，计划变为 `Filter: <in_optimizer>(... in (select #2) is false)`，**未改写为反连接**——手册说明比较表达式可为 NULL 时一般不能做反连接改写。

::: tip 工程建议
“不存在”语义优先用 `NOT EXISTS` 或 `LEFT JOIN ... WHERE 右表.主键 IS NULL`；关联列尽量 `NOT NULL`。
:::

## 四、派生表与 CTE

**派生表（derived table）**：FROM 中的子查询 `FROM (SELECT ...) x`。**CTE（公用表表达式）**：`WITH x AS (...)` 定义的命名子查询，处理方式同派生表。

| 方式 | 何时 | 实测 |
| --- | --- | --- |
| 合并（merge） | 简单 SELECT ... WHERE | `FROM (SELECT * FROM t_order WHERE user_id=5) x WHERE x.amount>500` → EXPLAIN 只剩一行 t_order，走 idx_user |
| 物化（materialize） | 含聚合 / 窗口函数、`DISTINCT`、`GROUP BY`、`HAVING`、`LIMIT`、`UNION`、select 列表中有子查询、用户变量赋值等（8.0 手册） | 带 GROUP BY 的派生表 → `<derived2>`，先算出结果放入临时表 |

**派生条件下推**（8.0.22 引入）：必须物化时，把外层过滤条件推进子查询内部。

```sql
SELECT * FROM (SELECT user_id, SUM(amount) s FROM t_order GROUP BY user_id) x WHERE x.user_id = 5;
```

```
derived_condition_pushdown=on   0.57 ms   内部变为 WHERE user_id=5 GROUP BY ...，只算一个用户
derived_condition_pushdown=off  2154 ms   先对 100 万行分组出 10 万用户，再挑 user_id=5
```

不能下推：派生表含 `LIMIT`、条件含子查询、派生表是外连接的内表；含 `UNION` 到 8.0.29 才支持（8.0 手册）。

::: warning 版本注意
5.7 及 8.0.22 之前，“子查询里聚合、外面再过滤”的写法很慢，过滤条件需手动写进子查询内部。
:::

## 五、在三条主线中的位置

```
A 性能：SQL → [优化器：join 顺序 + 每张表的访问方式 + 子查询改写] → 计划 → 索引 → 页 → …
B 一致性：不涉及
C 诊断：EXPLAIN 第一行 = 驱动表；看被驱动表 type、filtered 与 Extra（hash join / Materialize / antijoin）
```

## 六、排查要点

| 现象 | 先查什么 | 可能原因 / 对策 |
| --- | --- | --- |
| join 很慢，被驱动表 type=ALL 且 `Using join buffer (hash join)` | 关联列是否有索引 | 补被驱动表关联列索引 |
| 驱动表过滤后行数很多 | EXPLAIN 第一行的 rows × filtered 与真实行数 | 过滤条件估算错（无索引列默认 33%），建直方图；必要时 `JOIN_ORDER` |
| 检查行数少却更慢 | 被驱动表是否大量回表 | 随机回表比顺序扫描贵，考虑换驱动顺序或覆盖索引 |
| hash join 落盘变慢 | 建表一侧行数、`join_buffer_size` | 单条语句 `SET_VAR` 调大 |
| `NOT IN` 结果为空或明显偏少 | 子查询列是否含 NULL | 改用 `NOT EXISTS`，列定义 `NOT NULL` |
| `NOT IN` 未出现 antijoin | 比较列是否可为 NULL | 同上 |
| 派生表 / CTE 很慢 | 是否 `<derived>` 物化、条件是否下推 | 版本 < 8.0.22 手动把条件写进子查询；去掉阻止合并 / 下推的构造 |

::: tip PG 对照
PostgreSQL 有三种 join 算法：Nested Loop、Hash Join、**Merge Join**（两侧按关联键有序后归并）；MySQL 没有 Merge Join。`NOT IN` 遇 NULL 的语义陷阱来自 SQL 标准，PG 同样存在，PG 社区同样推荐 `NOT EXISTS`。
:::

## 七、本地复现（Docker mysql:8.4）

```sql
USE lab;
-- 一、三种执行方式
EXPLAIN FORMAT=TREE SELECT COUNT(*), SUM(o.amount) FROM t_user u JOIN t_order o ON o.user_id = u.id WHERE u.city='City12';
EXPLAIN FORMAT=TREE SELECT COUNT(*), SUM(o.amount) FROM t_user u JOIN t_order o IGNORE INDEX (idx_user) ON o.user_id = u.id WHERE u.city='City12';
EXPLAIN ANALYZE SELECT COUNT(*), SUM(o.amount) FROM t_user u IGNORE INDEX (PRIMARY)
  JOIN t_order o IGNORE INDEX (idx_user) ON o.user_id = u.id WHERE u.city='City12';

-- 二、驱动表顺序 + 直方图修正
EXPLAIN SELECT COUNT(*) FROM t_user u JOIN t_order o ON o.user_id = u.id WHERE o.amount > 999 AND u.city = 'Beijing';
SELECT COUNT(*) FROM t_order o STRAIGHT_JOIN t_user u ON o.user_id = u.id WHERE o.amount > 999 AND u.city = 'Beijing';
ANALYZE TABLE t_order UPDATE HISTOGRAM ON amount WITH 100 BUCKETS;
EXPLAIN SELECT COUNT(*) FROM t_user u JOIN t_order o ON o.user_id = u.id WHERE o.amount > 999 AND u.city = 'Beijing';
ANALYZE TABLE t_order DROP HISTOGRAM ON amount;

-- 三、NOT IN 的 NULL 陷阱
CREATE TABLE t_black (user_id INT UNSIGNED NULL);
INSERT INTO t_black VALUES (1),(2),(NULL);
SELECT COUNT(*) FROM t_user WHERE id NOT IN (SELECT user_id FROM t_black);
SELECT COUNT(*) FROM t_user u WHERE NOT EXISTS (SELECT 1 FROM t_black b WHERE b.user_id = u.id);

-- 四、派生条件下推
SET optimizer_switch = 'derived_condition_pushdown=off';
SELECT * FROM (SELECT user_id, SUM(amount) s FROM t_order GROUP BY user_id) x WHERE x.user_id = 5;
SET optimizer_switch = 'derived_condition_pushdown=on';
SELECT * FROM (SELECT user_id, SUM(amount) s FROM t_order GROUP BY user_id) x WHERE x.user_id = 5;
```

**预期现象**：一中三条计划分别为 Index lookup、换驱动表后的 Single-row index lookup、Inner hash join；二中建直方图前 u 驱动且 `filtered=33.33`，建后改为 o 驱动；三中 `NOT IN` 为 0、`NOT EXISTS` 为 99998；四中关闭下推慢几个数量级。具体耗时以本地为准。

## 八、与其他专题的关联

- **专题 3 / 10**：随机回表与顺序扫描的代价差，解释“检查行数少却更慢”。
- **专题 5**：三值逻辑，NOT IN 陷阱的根源。
- **专题 13**：无索引列 33% 经验值、直方图修正。
- **专题 16**：成本模型对 hash join 与回表的估算偏差。
- **专题 17**：`JOIN_ORDER` / `STRAIGHT_JOIN` / `SET_VAR`。
- **专题 19**：派生表物化使用内部临时表。

## 九、复习 checklist

- [ ] 能说出 Index NLJ 与 hash join 的执行过程和适用场景
- [ ] 知道 8.0.18 引入 hash join、8.0.20 移除 BNL
- [ ] 知道 `join_buffer_size` 的作用、默认值，以及不宜全局调大
- [ ] 能解释“小表驱动”的“小”指过滤后的行数，以及检查行数少却更慢的原因
- [ ] 能定位驱动顺序选错的根因（行数估算），并优先用直方图修正
- [ ] 知道 IN / EXISTS 改写为半连接，能认出几种半连接策略的 EXPLAIN 标志
- [ ] 能用三值逻辑解释 NOT IN 遇 NULL 返回空，知道可空列阻止反连接改写
- [ ] 知道派生表合并 vs 物化的条件，以及 8.0.22 派生条件下推
