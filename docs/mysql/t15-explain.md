# 专题 15 · EXPLAIN、EXPLAIN ANALYZE 与 optimizer trace

> 级别 ★（核心）· 主线 A / C · 实测版本：沙箱 MySQL 8.0.46

本专题回答四个问题：

1. EXPLAIN 每一列的准确含义？多表、子查询时怎么读？
2. 优化器的估算与实际执行差多少？时间花在哪一步？
3. 优化器放着某个索引不用，理由是什么？
4. 线上正在执行的语句用的是什么计划？

## 一、类比：导航软件

| 导航软件 | MySQL 工具 | 是否真正执行 |
| --- | --- | --- |
| 出发前看规划路线与预计用时 | EXPLAIN | 否 |
| 真开一遍，记录每段实际用时与预计的差距 | EXPLAIN ANALYZE | 是 |
| 查看计算过程：“为什么不走另一条路” | optimizer trace | 是（记录本次优化过程） |
| 看另一辆正在路上的车走哪条路线 | EXPLAIN FOR CONNECTION | 否，查看他人正在执行的计划 |

## 二、EXPLAIN 逐列

### 2.1 各列速查

| 列 | 含义 | 看什么 |
| --- | --- | --- |
| `id` | 查询块编号 | 见 2.4 |
| `select_type` | 查询块类型 | 见 2.4 |
| `table` | 访问的表；`<derivedN>`、`<subqueryN>`、`<unionM,N>` 为中间结果 | — |
| `partitions` | 用到的分区（专题 37） | — |
| `type` | **访问方式** | 见 2.2，最重要的一列 |
| `possible_keys` | 候选索引 | 有候选却没选，要追问原因 |
| `key` | 实际选用的索引 | — |
| `key_len` | 用于缩小范围的索引字节数 | 联合索引用到几列（专题 11） |
| `ref` | 与索引比较的值：`const` 常量，或 `库.表.列` | 多表时看关联列 |
| `rows` | 估计检查的行数 | 估算值，可能偏差很大（专题 13） |
| `filtered` | 检查的行中估计满足其余条件的百分比 | `rows × filtered%` = 估计传给下一步的行数 |
| `Extra` | 补充信息 | 见 2.3 |

### 2.2 type：从好到差（手册顺序，示例为沙箱实测）

| type | 含义 | 实测示例 |
| --- | --- | --- |
| `system` | 表只有一行，const 的特例 | `SELECT * FROM (SELECT 1 AS a) t` 中的 `<derived2>` |
| `const` | 主键或唯一索引全部列与常量比较，最多一行，优化阶段即读取 | `WHERE id = 500000` |
| `eq_ref` | 关联时对前表每一行，用主键或非空唯一索引恰好找到一行 | `t_order o JOIN t_user u ON u.id = o.user_id` 中的 u |
| `ref` | 非唯一索引（或唯一索引最左前缀）等值查找 | `WHERE user_id = 123` |
| `fulltext` | 全文索引 | — |
| `ref_or_null` | ref 并额外查找 NULL | `WHERE remark = 'remark-5' OR remark IS NULL`（remark 有索引时） |
| `index_merge` | 索引合并 | `user_id = 123 OR created_at >= …` |
| `unique_subquery` / `index_subquery` | 某些 `IN (子查询)` 的专用查找 | — |
| `range` | 索引范围查找 | `WHERE id BETWEEN 1 AND 100` |
| `index` | **扫描整个索引** | `SELECT user_id FROM t_order`（key=idx_user，Using index） |
| `ALL` | 全表扫描 | `WHERE amount > 999` |

::: warning 易混淆
| 错误理解 | 正确理解 |
| --- | --- |
| `type=index` 说明用上了索引 | 它是把整个索引从头扫到尾，只比 ALL 稍好；range 及以上才是用索引缩小了范围 |
| `ref` 一定比 `range` 快 | type 只说明访问方式；ref 命中 5 万行比 range 命中 10 行慢得多，须结合 rows |
| 看到 ALL 就要加索引 | 命中比例高时全表扫描本来更快（专题 10） |
:::

### 2.3 Extra 常见取值

**与索引使用有关**

| Extra | 含义 | 出处 |
| --- | --- | --- |
| `Using index` | 覆盖索引，不回表 | 专题 10 |
| `Using index condition` | 索引下推，仍要回表 | 专题 11 |
| `Using where` | 引擎返回行后 Server 层再过滤 | 专题 1、2 |
| `Using index for skip scan` | 索引跳跃扫描 | 专题 11 |
| `Using index for group-by` | 每组只读少量索引记录（松散索引扫描） | 专题 19 |
| `Using sort_union / union / intersect(...)` | 索引合并方式 | 专题 11 |
| `Backward index scan` | 反向读索引 | 专题 11、14 |
| `Using MRR` | 多范围读：先排序要回表的主键再按序回表 | 专题 21 |

**需要额外工作（重点关注）**

| Extra | 含义 | 实测示例 |
| --- | --- | --- |
| `Using filesort` | 额外排序 | 专题 11、12 |
| `Using temporary` | 建临时表 | `SELECT status, COUNT(*) FROM t_order GROUP BY status`；UNION 去重 |
| `Using join buffer (hash join)` | 关联列无可用索引，用哈希 join | `t_order o JOIN t_user u ON u.city = o.order_no` |

**优化器提前得出结果**

| Extra | 含义 | 实测示例 |
| --- | --- | --- |
| `Impossible WHERE` | 条件恒假 | `WHERE id = 1 AND id = 2` |
| `Select tables optimized away` | 优化阶段即得出结果 | `SELECT MAX(id) FROM t_order` |
| `No tables used` | 无 FROM 或 `FROM DUAL` | `SELECT 1` |

**子查询相关**（专题 20）

| Extra | 含义 |
| --- | --- |
| `Not exists` | 反连接，找到一条匹配即停；`NOT EXISTS (SELECT 1 FROM t_order o WHERE o.user_id = u.id)` 中实测出现 |
| `FirstMatch` / `LooseScan` / `Start temporary`、`End temporary` | 半连接的执行策略 |

### 2.4 多个查询块

**规则**：id 不同时，一般 id 大的先执行；id 相同时，**从上到下就是 join 顺序**，第一行是驱动表。

```
① UNION
SELECT id FROM t_order WHERE id = 1 UNION SELECT id FROM t_order WHERE id = 2
1   PRIMARY        t_order      const   Using index
2   UNION          t_order      const   Using index
3   UNION RESULT   <union1,2>   ALL     Using temporary        ← 合并去重用临时表

② 相关子查询
SELECT o.id, (SELECT u.city FROM t_user u WHERE u.id = o.user_id) FROM t_order o WHERE o.id < 10
1   PRIMARY             o   range
2   DEPENDENT SUBQUERY  u   eq_ref                             ← 依赖外层 o.user_id，每行执行一次

③ IN 子查询改写为 join（子查询列是 t_user 主键，不会重复）
SELECT * FROM t_order WHERE user_id IN (SELECT id FROM t_user WHERE city = 'City5')
1   SIMPLE   t_user    ALL
1   SIMPLE   t_order   ref   idx_user

④ IN 子查询物化（结果可能重复）
SELECT * FROM t_user WHERE id IN (SELECT user_id FROM t_order WHERE amount > 999)
1   SIMPLE         t_user        ALL
1   SIMPLE         <subquery2>   eq_ref   <auto_distinct_key>
2   MATERIALIZED   t_order       ALL      Using where          ← 先算出存成临时表并去重建索引

⑤ 派生表
SELECT t.user_id, t.c FROM (SELECT user_id, COUNT(*) c FROM t_order GROUP BY user_id) t WHERE t.c > 25
1   PRIMARY   <derived2>   ALL
2   DERIVED   t_order      index   idx_user   Using index
```

③④说明：**写成子查询不代表按子查询执行**，8.0 会把很多子查询改写为关联或半连接，执行计划以 EXPLAIN 为准（专题 20）。

### 2.5 rows × filtered

```
EXPLAIN SELECT o.id, u.city FROM t_order o JOIN t_user u ON u.id = o.user_id WHERE o.id BETWEEN 1 AND 10;
table  type    key      ref              rows  filtered
o      range   PRIMARY  NULL               10  100.00     → 估计传给下一步 10 行
u      eq_ref  PRIMARY  lab.o.user_id       1  100.00     → 对这 10 行各查 1 行
```

多表时优化器用每张表的 `rows × filtered` 推算后续处理量；专题 13 中 `filtered` 估错导致 join 顺序选错，就发生在这里。

## 三、三种输出格式

### 3.1 FORMAT=TREE

```
-> Nested loop inner join  (cost=13.3 rows=10)
    -> Filter: (o.id between 1 and 10)  (cost=2.26 rows=10)
        -> Index range scan on o using PRIMARY over (1 <= id <= 10)  (cost=2.26 rows=10)
    -> Single-row index lookup on u using PRIMARY (id=o.user_id)  (cost=1.01 rows=1)
```

每行是一个执行步骤（迭代器）；缩进更深的为上一层提供数据；同层子步骤从上到下执行。手册说明 TREE 比表格描述更准确，且**是唯一显示哈希 join 的格式**。

### 3.2 FORMAT=JSON

```
query_cost: 13.26
o  range   rows_examined_per_scan=10  rows_produced_per_join=10  read_cost=1.26   eval_cost=1.00  prefix_cost=2.26
u  eq_ref  rows_examined_per_scan=1   rows_produced_per_join=10  read_cost=10.00  eval_cost=1.00  prefix_cost=13.26
```

| 字段 | 含义 |
| --- | --- |
| `read_cost` | 读取数据的成本 |
| `eval_cost` | 对读到的行判断条件的成本 |
| `prefix_cost` | 到该表为止的累计成本 |
| `query_cost` | 整个查询的总成本 |

计算方法见专题 16。`explain_format` 决定默认格式（实测默认 `TRADITIONAL`）。

## 四、EXPLAIN ANALYZE

### 4.1 含义

8.0.18 引入（MySQL 官方博客）。手册：它**真正执行语句**，在 EXPLAIN 基础上给出实际耗时等信息，总是使用 TREE 格式。

```
(cost=… rows=…)                          ← 估算
(actual time=A..B rows=R loops=L)        ← 实际
```

| 字段 | 含义 |
| --- | --- |
| A | 返回第一行的时间（毫秒） |
| B | 返回全部行的时间（毫秒），含子步骤、不含父步骤 |
| R | 返回的行数 |
| L | 该步骤执行的次数 |

::: warning 关键细节
`loops > 1` 时，**时间与行数都是每次的平均值**（手册说明时间为每次平均；官方博客说明行数同样是每次平均），求总量需乘以 loops。
:::

### 4.2 实验一：找估算错误与耗时瓶颈

（`t_user.city` 有直方图，`t_order.amount` 无）

```
EXPLAIN ANALYZE SELECT COUNT(*) FROM t_user u JOIN t_order o ON o.user_id = u.id
WHERE o.amount > 999 AND u.city = 'Beijing';

-> Aggregate: count(0)  (cost=208308 rows=1) (actual time=1750..1750 rows=1 loops=1)
    -> Nested loop inner join  (cost=191086 rows=172218) (actual time=1.8..1750 rows=468 loops=1)
        -> Filter: (u.city = 'Beijing')  (cost=10239 rows=49861) (actual time=0.845..44.8 rows=49732 loops=1)
            -> Table scan on u  (cost=10239 rows=100136) (actual time=0.838..30.5 rows=100000 loops=1)
        -> Filter: (o.amount > 999.00)  (cost=2.59 rows=3.45) (actual time=0.0341..0.0341 rows=0.00941 loops=49732)
            -> Index lookup on o using idx_user (user_id=u.id)  (cost=2.59 rows=10.4) (actual time=0.0303..0.033 rows=9.99 loops=49732)
```

| 步骤 | 估算行数 | 实际行数 | 结论 |
| --- | --- | --- | --- |
| u 全表扫描 | 100136 | 100000 | 准 |
| 过滤 city = 'Beijing' | 49861 | 49732 | 准（有直方图） |
| 每用户在 o 上查找 | 10.4 / 次 | 9.99 / 次 | 准 |
| **过滤 amount > 999** | **3.45 / 次** | **0.00941 / 次** | **高估约 367 倍**（无直方图，33% 经验值） |
| 关联结果 | 172218 | 468 | 高估约 368 倍 |

**耗时瓶颈**（总 1750 ms）：u 扫描与过滤 44.8 ms；o 上查找 0.033 ms/次 × 49732 次 ≈ 1641 ms。单次只有 0.033 ms，乘以 loops 才成为瓶颈。根因是 `amount > 999` 估错使 u 成为驱动表；专题 13 给 amount 建直方图后驱动表变为 o，耗时降到 217 ms。

### 4.3 实验二：估算方式切换的后果

```
-> Index range scan on t_case using idx_user over (user_id = 777) OR (user_id = 1000) OR (198 more), …
   (cost=2360 rows=1800) (actual time=151..1549 rows=52116 loops=1)
```

200 个值的 IN 列表（专题 13）：估算 1800 行，实际 52116 行，一行内并排可见。

### 4.4 使用注意

| 注意点 | 说明 |
| --- | --- |
| **真正执行查询** | 10 分钟的查询也要跑 10 分钟、消耗同样资源；可用 `KILL QUERY` 或 Ctrl-C 中止（手册） |
| 支持的语句（手册） | SELECT、多表 UPDATE / DELETE、TABLE；单表 DELETE 实测输出 `<not executable by iterator executor>` |
| 对 UPDATE / DELETE 的影响 | 手册称其“运行”语句；8.0.46 实测多表 DELETE、多表 UPDATE 后修改步骤显示 `rows=0`、数据**未被修改**。这是实测观察而非手册保证，**勿在生产数据上依赖**，分析 DML 应在测试环境或副本上进行 |
| 不能与 FOR CONNECTION 合用（手册） | — |
| 仅 TREE 格式（手册） | 指定 TRADITIONAL 或 JSON 报错 |

## 五、optimizer trace

### 5.1 用法

```sql
SET optimizer_trace = 'enabled=on';        -- 仅当前会话，默认关闭
SELECT …;
SELECT TRACE, MISSING_BYTES_BEYOND_MAX_MEM_SIZE FROM information_schema.OPTIMIZER_TRACE;
SET optimizer_trace = 'enabled=off';
```

- 默认最多保存 `optimizer_trace_max_mem_size` = 1048576 字节（实测），超出部分被截断，`MISSING_BYTES_BEYOND_MAX_MEM_SIZE` 显示截断字节数，需调大。
- 跟踪本身有开销，只在诊断时于当前会话临时开启。

```
join_preparation        ← 预处理与改写（如子查询变半连接）
join_optimization
  ├─ condition_processing                         条件化简、常量传播
  ├─ rows_estimation → range_analysis             各候选索引的行数与成本估算
  ├─ considered_execution_plans                   比较访问方式与 join 顺序
  ├─ attaching_conditions_to_tables               条件挂到哪张表判断
  └─ reconsidering_access_paths_for_index_ordering   为 ORDER BY 重新考虑索引
join_execution
```

### 5.2 实验：专题 12 案例三为何选错索引

子查询 `SELECT id FROM t_case WHERE status = 1 ORDER BY id LIMIT 100000, 20`，表上有 `idx_status (status)` 与 `idx_s_c (status, created_at)`；优化器选 `idx_s_c` 导致排序 10 万行（84 ms），强制 `idx_status` 只要 13 ms。跟踪关键部分：

```
"potential_range_indexes": [
   { "index": "idx_status", "usable": true, "key_parts": ["status", "id"] },
   { "index": "idx_s_c",    "usable": true, "key_parts": ["status", "created_at", "id"] }
]                                             ↑ 可见自动附带的主键 id

"range_scan_alternatives": [
   { "index": "idx_status", "ranges": ["status = 1"], "index_only": true, "rows": 430884, "cost": 43562.4 },
   { "index": "idx_s_c",    "ranges": ["status = 1"], "index_only": true, "rows": 426484, "cost": 43377.2 }
]

"considered_access_paths": [
   { "access_type": "ref", "index": "idx_status", "rows": 430884, "cost": 43562.4 },
   { "access_type": "ref", "index": "idx_s_c",    "rows": 426484, "cost": 43377.2, "chosen": true }
]

"reconsidering_access_paths_for_index_ordering": {
   "clause": "ORDER BY",
   "index_order_summary": { "index": "idx_s_c", "index_provides_order": false, "plan_changed": false }
}
```

1. 两个索引估算的是同一批行（`status = 1`），索引下潜估出的行数却相差约 1%；
2. 成本只差 0.4%，`idx_s_c` 因估算行数略少而被选中；
3. 选择访问方式时**未计入后续排序成本**；为 ORDER BY 重新考虑时发现 `idx_s_c` 不能提供 id 顺序，但**未改变计划**，只能排序 10 万行。

**结论**：选择取决于 1% 的估算误差，“成本几乎打平”非常脆弱，重新统计一次选择就可能改变。对策：删除冗余索引（专题 12），或用提示固定选择（专题 17）。只看 EXPLAIN 只知道选了什么，看 trace 才知道为什么。

::: warning 易混淆
| 错误理解 | 正确理解 |
| --- | --- |
| 优化器选的就是成本最低的索引 | 是**它估算的**成本最低；估算有误差，不同阶段考虑的成本项也不同 |
| 选错说明优化器有 bug | 多为估算误差加成本打平，用 trace 看清原因再定对策 |
:::

## 六、EXPLAIN FOR CONNECTION

```sql
SELECT id, time, info FROM performance_schema.processlist WHERE command = 'Query';
EXPLAIN FOR CONNECTION 54;
```

沙箱实测（后台执行上述关联查询时）：

```
id  select_type  table  type  possible_keys  key       key_len  ref       rows    filtered  Extra
1   SIMPLE       u      ALL   PRIMARY        NULL      NULL     NULL      100136  49.79     Using where
1   SIMPLE       o      ref   idx_user       idx_user  4        lab.u.id  10      100.00    Using where
```

手册：查看其他用户的连接需要 `PROCESS` 权限；不能与 `ANALYZE` 合用。它显示的是**该语句执行时真正使用的计划**；统计信息变化后重新 EXPLAIN 看到的可能是另一个计划。

## 七、在三条主线中的位置

```
A 性能：SQL → [优化器：估算 → 比较成本 → 选计划] → 执行计划 → 索引 → 页
         EXPLAIN 看计划，EXPLAIN ANALYZE 看估算与实际的差距，trace 看选择理由
B 一致性：不涉及（注意 EXPLAIN ANALYZE 会执行语句）
C 诊断：见第八节
```

::: tip PG 对照
PostgreSQL 的 `EXPLAIN (ANALYZE, BUFFERS)` 与 EXPLAIN ANALYZE 类似，同样真正执行，PG 用户常在事务中执行后 ROLLBACK 以免修改数据；PG 的 actual rows 同样是每次循环的平均值。PG 没有与 optimizer trace 直接对应的内置功能。
:::

## 八、诊断实践

### 8.1 一条慢 SQL 的分析顺序

```
① EXPLAIN：type / key / rows / Extra，先看明显问题（ALL、index、filesort、temporary、hash join）
② EXPLAIN ANALYZE：逐步对比估算与实际行数，找第一个偏差很大的步骤；用 时间 × loops 找耗时最多的步骤
③ optimizer trace：计划不合理时，看比较了哪些方案、成本差多少、哪些成本没计入
④ 线上正在执行的语句：EXPLAIN FOR CONNECTION
```

### 8.2 病例一：关联查询很慢，单看 EXPLAIN 每一步都“用了索引”

1. **现象**：两表关联耗时秒级，EXPLAIN 中被驱动表为 ref。
2. **指标**：EXPLAIN ANALYZE 中被驱动表步骤 loops 达数万，某个 Filter 的估算行数远大于实际。
3. **定位**：某无索引列条件用经验值估算，导致驱动表选错（4.2 节）。
4. **处置**：为该列建直方图（专题 13），或调整 join 顺序（专题 17、20）；用 EXPLAIN ANALYZE 验证。

### 8.3 病例二：有更合适的索引，优化器却不用

1. **现象**：强制某索引明显更快，优化器默认选另一个。
2. **指标**：trace 中两个候选成本非常接近；`reconsidering_access_paths_for_index_ordering` 显示 `plan_changed: false`。
3. **定位**：估算误差加成本打平；访问方式选择未计入排序成本（5.2 节）。
4. **处置**：删除冗余、前缀相同的索引；必要时用提示固定（专题 17）。

### 8.4 病例三：线上某条语句突然变慢，测试环境 EXPLAIN 正常

1. **现象**：线上执行时间长，复制到测试环境 EXPLAIN 看不出问题。
2. **指标**：`EXPLAIN FOR CONNECTION` 显示的计划与测试环境不同。
3. **定位**：线上统计信息或数据分布不同，导致计划不同（专题 13）。
4. **处置**：在线上环境对比统计信息，必要时 ANALYZE；以线上实际计划为准分析。

## 九、本地复现脚本

需专题 12 的 `t_case`、专题 13 的 `t_user`（`city` 有直方图、`t_order.amount` 无），在专题 1 的 Docker 环境（`mysql:8.4`）中执行。

```sql
USE lab;

-- 1. type 各级
EXPLAIN SELECT * FROM (SELECT 1 AS a) t;
EXPLAIN SELECT * FROM t_order WHERE id = 500000;
EXPLAIN SELECT o.id, u.city FROM t_order o JOIN t_user u ON u.id = o.user_id WHERE o.id BETWEEN 1 AND 10;
EXPLAIN SELECT * FROM t_order WHERE user_id = 123;
EXPLAIN SELECT * FROM t_order WHERE id BETWEEN 1 AND 100;
EXPLAIN SELECT user_id FROM t_order;
EXPLAIN SELECT * FROM t_order WHERE amount > 999;

-- 2. Extra
EXPLAIN SELECT * FROM t_order WHERE id = 1 AND id = 2;
EXPLAIN SELECT MAX(id) FROM t_order;
EXPLAIN SELECT status, COUNT(*) FROM t_order GROUP BY status;
EXPLAIN SELECT * FROM t_order o JOIN t_user u ON u.city = o.order_no LIMIT 1;

-- 3. 多个查询块
EXPLAIN SELECT id FROM t_order WHERE id = 1 UNION SELECT id FROM t_order WHERE id = 2;
EXPLAIN SELECT o.id, (SELECT u.city FROM t_user u WHERE u.id = o.user_id) FROM t_order o WHERE o.id < 10;
EXPLAIN SELECT * FROM t_user WHERE id IN (SELECT user_id FROM t_order WHERE amount > 999);
EXPLAIN SELECT * FROM t_user u WHERE NOT EXISTS (SELECT 1 FROM t_order o WHERE o.user_id = u.id);

-- 4. 输出格式
EXPLAIN FORMAT=TREE SELECT o.id, u.city FROM t_order o JOIN t_user u ON u.id = o.user_id WHERE o.id BETWEEN 1 AND 10;
EXPLAIN FORMAT=JSON SELECT o.id, u.city FROM t_order o JOIN t_user u ON u.id = o.user_id WHERE o.id BETWEEN 1 AND 10\G

-- 5. EXPLAIN ANALYZE
EXPLAIN ANALYZE SELECT COUNT(*) FROM t_user u JOIN t_order o ON o.user_id = u.id
WHERE o.amount > 999 AND u.city = 'Beijing'\G

-- 6. optimizer trace
ALTER TABLE t_case ADD INDEX idx_status (status), ADD INDEX idx_s_c (status, created_at);
SET optimizer_trace = 'enabled=on';
SELECT COUNT(*) FROM (SELECT id FROM t_case WHERE status = 1 ORDER BY id LIMIT 100000, 20) x;
SELECT TRACE, MISSING_BYTES_BEYOND_MAX_MEM_SIZE FROM information_schema.OPTIMIZER_TRACE\G
SET optimizer_trace = 'enabled=off';
ALTER TABLE t_case DROP INDEX idx_status, DROP INDEX idx_s_c;
```

**EXPLAIN FOR CONNECTION**：窗口 A 执行第 5 步的关联查询（去掉 EXPLAIN ANALYZE），执行期间在窗口 B：

```sql
SELECT id, info FROM performance_schema.processlist WHERE command = 'Query' AND info LIKE 'SELECT COUNT%';
EXPLAIN FOR CONNECTION 54;   -- 换成上一步查到的 id
```

**预期现象**：type 各级同 2.2 节；EXPLAIN ANALYZE 中 `o.amount > 999` 步骤估算远大于实际，o 上查找 loops 约 5 万；trace 中两个索引成本非常接近、`plan_changed` 为 false。

## 十、与其他专题的关联

- **专题 10–12**：type、key_len、Extra 的实际运用。
- **专题 13**：rows、filtered 的来源与估算误差。
- **专题 16**：JSON 中成本数字的计算。
- **专题 17**：用提示固定计划。
- **专题 19、20**：filesort、temporary、半连接、哈希 join。
- **专题 22**：慢 SQL 定位完整流程。

## 十一、复习 checklist

- [ ] 能说出 EXPLAIN 每一列的含义，用 `rows × filtered` 推算传给下一步的行数
- [ ] 能按从好到差列出 type 各级，并知道 `index` 是全索引扫描
- [ ] 能对 Extra 常见取值分类，指出哪些需要重点关注
- [ ] 能读懂 id 与 select_type，判断 join 顺序与子查询是否被改写
- [ ] 会读 TREE 格式的执行顺序，知道 JSON 格式中各成本字段的含义
- [ ] 能读 EXPLAIN ANALYZE 的 actual 字段，记得 loops > 1 时要乘以 loops
- [ ] 知道 EXPLAIN ANALYZE 会真正执行，以及对 DML 的注意事项
- [ ] 会开启与阅读 optimizer trace，能解释“成本打平导致选错”的案例
- [ ] 会用 EXPLAIN FOR CONNECTION 查看线上正在执行的计划
