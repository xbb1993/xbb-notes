# 专题 21 · 常见慢 SQL 成因与特定查询优化

> 级别 ☆ · 主线 A / C · 实测版本：沙箱 MySQL 8.0.46

本专题回答：为什么“明明有索引却很慢”？哪些写法让索引失去定位能力？OR、COUNT、MIN/MAX、UNION 有哪些特定的优化点？

**实验表**：`t_s` 为 `t_order` 的 100 万行副本，额外索引：`idx_created(created_at)`、`idx_order_no(order_no)`、`idx_code(code)`（code 为 utf8mb4 字符串，值等于 id，如 `'123456'`）、`idx_code_mb3(code_mb3)`（内容相同，字符集 utf8mb3）。

**类比**：索引是按“原始值”排序的字典。拿原始值来查能直接翻到那一页；拿“加工后的值”（套函数、换类型、换编码）来查，字典里没有按这个顺序排的目录，只能逐页翻，把每个词加工一遍再比。

## 一、先读懂 type：index 与 ALL

后文多次出现 type=index，先明确定义（8.0 手册 EXPLAIN Output）：

| type | 含义 |
| --- | --- |
| `ALL` | 全表扫描：把聚簇索引（存整行的树，专题 10）从头读到尾 |
| `index` | 同样从头读到尾，但读的是**某一棵索引树**；常见于覆盖索引（查询需要的列这棵索引都有），Extra 为 `Using index`，因索引比表小，通常比 ALL 快 |

两者**都是全量扫描、都没有定位**，区别只是扫哪棵树。决定因素是：**查询需要的列能否全部从某个二级索引中取得**——而不是“是否尝试过用索引定位”。

同一个 WHERE，只改 SELECT 部分（`COUNT(*)` 表示统计满足条件的行数，只返回一个数字，不需要任何列的值）：

| SQL | 需要的列 | type / key | 检查行数 | 耗时 |
| --- | --- | --- | --- | --- |
| `SELECT COUNT(*) FROM t_s WHERE DATE(created_at)='2026-03-01'` | 仅 created_at | index / idx_created | 1000000 | 119 ms |
| `SELECT * FROM t_s WHERE DATE(created_at)='2026-03-01'` | 所有列 | ALL | 1000000 | 305 ms |
| `SELECT COUNT(*) FROM t_s WHERE code = 123456` | 仅 code | index / idx_code | 1000000 | 112 ms |
| `SELECT * FROM t_s WHERE code = 123456` | 所有列 | ALL | 1000000 | 293 ms |

```
idx_created（二级索引）：[created_at | id]   100 万项约 2213 页
聚簇索引：            [id | 整行所有列]    100 万行约 5480 页

COUNT(*) 只需 created_at → 扫小树即可 → index
SELECT * 需要整行 → 扫小树后还要回表 100 万次，不如直接扫大树 → ALL
```

::: danger 错误理解 vs 正确理解
- ❌ type 不是 ALL，说明用上了索引定位。
- ✅ 判断是否“定位”，看 type 是否为 `const / eq_ref / ref / range`，或检查行数是否远小于表行数。`index` 与 `ALL` 都是全量扫描，`index` 只是扫得便宜一些。
:::

## 二、索引失效的典型写法

### 2.1 总览

| # | 完整 SQL | type / key | 检查行数 | 耗时 |
| --- | --- | --- | --- | --- |
| ① | `SELECT COUNT(*) FROM t_s WHERE DATE(created_at) = '2026-03-01'` | index / idx_created | 1000000 | 106 ms |
| ①' | `SELECT COUNT(*) FROM t_s WHERE created_at >= '2026-03-01' AND created_at < '2026-03-02'` | range / idx_created | 2822 | 0.81 ms |
| ② | `SELECT * FROM t_s WHERE id + 1 = 500001` | ALL | 1000000 | 256 ms |
| ③ | `SELECT * FROM t_s WHERE code = 123456` | ALL | 1000000 | 311 ms |
| ③' | `SELECT * FROM t_s WHERE code = '123456'` | ref / idx_code | 1 | 0.23 ms |
| ④ | `SELECT * FROM t_s WHERE user_id = '5'` | ref / idx_user | 6 | 0.30 ms |
| ⑤ | `SELECT * FROM t_s WHERE order_no LIKE '%00123456'` | ALL | 1000000 | 451 ms |
| ⑤' | `SELECT * FROM t_s WHERE order_no LIKE 'NO00000012345%'` | range / idx_order_no | 10 | 0.26 ms |

### 2.2 在索引列上套函数或运算（① ②）

```
idx_created 叶子层：2026-02-28 23:59 | 2026-03-01 00:03 | 2026-03-01 08:12 | ... | 2026-03-02 00:01
                                       └────── 按原始值有序，可二分定位 ──────┘
DATE(created_at)：MySQL 不利用 DATE() 结果与原始值的顺序关系，只能逐行计算后比较
```

修复：

- **首选改写为范围**（①'）：运算移到常量一侧，列保持原样；② 改为 `id = 500000`。
- 改不了 SQL 时，8.0.13 起可建**函数索引** `INDEX ((DATE(created_at)))`。实测建立后 ① 变为 ref，检查 2822 行，9 ms。代价是多一个索引的写入与空间成本，且查询表达式必须与索引定义一致。

### 2.3 隐式类型转换（③ ④）

**规则**（8.0 手册 Type Conversion）：字符串与数字比较时，按浮点数比较。

**为什么 ③ 不能把 123456 只转换一次变成 `'123456'`？** 因为按数字语义，能匹配的字符串不止一个。实测小表：

```
WHERE code = 123456（按数字比较）匹配 6 行：
  '123456'  '0123456'  ' 123456'  '123456abc'  '123456.0'  '1.23456e5'
WHERE code = '123456'（按字符串比较）只匹配 1 行：
  '123456'
```

- 转成单个字符串常量会把 6 行变成 1 行，**改变查询语义**。手册原文：“there are many different strings that may convert to the value 1, such as '1', ' 1', or '1a'”。
- 也无法转成范围：索引按字符串规则排序，与数值顺序不一致（实测索引顺序 `'100' < '2' < '20'`，数值顺序 2 < 20 < 100），匹配的字符串在索引中不连续（如 `' 123456'` 以空格开头排在最前）。
- 只剩逐行把列转为数字再比较 = 对列套函数 → 无法定位。

**为什么 ④ 没问题？** `user_id`（整数列）= `'5'`：常量 `'5'` 转为数字只有唯一结果 5；整数列每个值的数值唯一，且索引就按数值排序，“数值等于 5”在索引中正好是连续的一段。

|  | 列 = 字符串，常量 = 数字（③） | 列 = 整数，常量 = 字符串（④） |
| --- | --- | --- |
| 比较语义 | 按数字 | 按数字 |
| 能匹配的列值 | 无穷多种字符串 | 唯一的整数 |
| 在索引中是否连续 | 否（索引按字符串排序） | 是（索引按数值排序） |
| 能否只转换常量 | 不能，会改变结果 | 能 |

**本质**：能否利用索引，取决于“按比较语义能匹配的列值，在索引中是否构成一段连续区间”。“转换在列一侧失效、在常量一侧无影响”是这一原因的表现。

::: warning 不只是慢，还可能错
`SELECT '0123456' = 123456, '123456abc' = 123456, ' 123456' = 123456, 'abc' = 0;` 实测全部返回 1，并产生 Warning 1292（Truncated incorrect DOUBLE value）。手机号、订单号等定义为 VARCHAR、应用却按数字传参，是典型来源。
:::

### 2.4 LIKE 以通配符开头（⑤）

`'NO00000012345%'` 是前缀，等价于范围 `[NO00000012345, NO00000012346)`；`'%00123456'` 无固定前缀，不知从何处开始。对策：后缀匹配可另存反转字符串列并建索引；分词搜索用全文索引（专题 14）或外部搜索引擎。

### 2.5 关联列字符集或排序规则不一致

**字符集（charset）**：字符编码方式。utf8mb3 每字符最多 3 字节，存不了 emoji；utf8mb4 最多 4 字节，为 8.0 默认。**排序规则（collation）**：字符串的比较与排序规则（如是否区分大小写）。

小表 `t_m`（1000 行，code 为 utf8mb4）与大表 `t_s` 关联：

| 关联 | 计划 | 检查行数 | 耗时 |
| --- | --- | --- | --- |
| `t_s.code`(mb4) = `t_m.code`(mb4) | t_m 驱动 → idx_code 查 t_s（ref） | 2000 | 4.7 ms |
| `t_s.code_mb3`(mb3) = `t_m.code`(mb4) | 优化器改为 t_s 驱动，扫描整个 idx_code_mb3（100 万项）再查 t_m | 1001000 | 1322 ms |
| 小表 `t_m3.code`(mb3) 驱动，查 `t_s.code`(mb4) | ref / idx_code | 2000 | 5.3 ms |

比较 mb3 与 mb4 时，MySQL 把 **mb3 一侧转换为 mb4**（转向范围更大的字符集才不丢字符）。第 2 行中被转换的恰是被驱动表上带索引的列，相当于对列套函数；第 3 行被转换的是驱动表传来的值，相当于常量。强制 t_m 驱动后 `SHOW WARNINGS`：

```
Warning 1739: Cannot use range access on index 'idx_code_mb3'
              due to type or collation conversion on field 'code_mb3'
```

**排序规则不一致**：同为 utf8mb4，一边 `utf8mb4_general_ci`、一边 8.0 默认 `utf8mb4_0900_ai_ci`，关联直接报错：

```
ERROR 1267: Illegal mix of collations (utf8mb4_0900_ai_ci,IMPLICIT) and (utf8mb4_general_ci,IMPLICIT) for operation '='
```

常见于老表从 5.7 升级、新表按 8.0 默认值创建。对策：统一字符集与排序规则（`ALTER TABLE ... CONVERT TO CHARACTER SET ...` 会重建表，大表按 Online DDL 评估）；临时措施是把转换写在驱动表一侧；排查用 `information_schema.COLUMNS` 对比 `CHARACTER_SET_NAME`、`COLLATION_NAME`。

::: tip 第二节一句话
列一侧发生“加工”（函数、运算、类型转换、字符集转换），且加工后的匹配值在索引中不连续，索引就失去定位能力。
:::

## 三、OR 条件

| 完整 SQL | 计划 | 检查行数 | 耗时 |
| --- | --- | --- | --- |
| `SELECT * FROM t_s WHERE user_id = 5 OR order_no = 'NO000000000054'` | index_merge，`Using union(idx_user,idx_order_no)` | — | 0.38 ms |
| `SELECT COUNT(*) FROM t_s WHERE user_id IN (5,6) OR created_at >= '2026-11-10'` | index_merge，`Using sort_union(...)` | — | 6.6 ms |
| `SELECT * FROM t_s WHERE user_id = 5 OR amount > 999.5`（amount 无索引） | ALL | 1000000 | 316 ms |
| 上一条改写为 `... WHERE user_id = 5 UNION ALL ... WHERE amount > 999.5 AND user_id <> 5` | 分支一 ref，分支二 ALL | 1000006 | 307 ms |

（index_merge 两行 performance_schema 报告检查行数为 0，属统计口径问题，以 — 表示。）

- **OR 只要有一个分支无法走索引，整条语句只能全表扫描**：满足无索引分支的行可能分布在任何位置。
- **UNION ALL 改写不是万能的**：实测无收益，因第二分支本身要全表扫描。改写只在“每个分支都能走索引，但优化器未选 index_merge”时有用（如 OR 跨 join 中两张表，或各分支需各自 `ORDER BY ... LIMIT`，见专题 19）。
- 改写须去重：第二分支加 `AND user_id <> 5`，否则同时满足两条件的行出现两次。

## 四、COUNT

### 4.1 InnoDB 为什么不存总行数

手册：并发事务可能同时“看到”不同的行数，InnoDB 不维护全局行数，`COUNT(*)` 只统计当前事务可见的行。

```
T1 插入 1 行未提交       T2 查询
T1 看到：1000001          T2 看到：1000000   → 不存在对所有人都正确的“总行数”
```

“可见”的判定属于 MVCC（模块五）。MyISAM 无事务，可直接存总数。

### 4.2 几种写法

| 完整 SQL | 语义 | 结果 | 耗时 |
| --- | --- | --- | --- |
| `SELECT COUNT(*) FROM t_s` | 行数 | 1000000 | 84 ms |
| `SELECT COUNT(1) FROM t_s` | 行数，与 `COUNT(*)` 完全等价（手册：无性能差异） | 1000000 | 84 ms |
| `SELECT COUNT(id) FROM t_s` / `COUNT(user_id)` | 该列**非 NULL** 的行数；NOT NULL 列等于行数 | 1000000 | 101–106 ms |
| `SELECT COUNT(remark) FROM t_s` | remark 可为 NULL，只数非 NULL | **900179** | 115 ms，ALL |

- **语义优先**：`COUNT(列)` 不是 `COUNT(*)` 的“优化写法”，统计对象不同。数行数就写 `COUNT(*)`。
- 无 WHERE 时 `EXPLAIN FORMAT=TREE` 显示 `Count rows in t_s`：计数交给 InnoDB 内部完成（手册：8.0.13 起对无 WHERE / GROUP BY 的 `COUNT(*)` 做了优化），默认遍历**最小的二级索引**。
- 实测现象（不推断机制）：`FORCE INDEX (PRIMARY)` 反而更快（40 ms）；会话 `innodb_parallel_read_threads`（沙箱默认 4）由 4 改为 1 后，主键计数 60 → 114 ms，说明主键计数用到了并行读；默认路径也有变化（86 → 123 ms），手册未说明机制。
- 百万行 COUNT 在 100 ms 量级，问题集中在千万 / 亿级大表与高频调用。

### 4.3 大表计数方案

| 方案 | 精确度 | 代价 / 局限 | 适用 |
| --- | --- | --- | --- |
| `SHOW TABLE STATUS` / `information_schema.TABLES.table_rows` | 估算（实测 995170，真实 1000000） | 来自统计信息（专题 13），误差可能很大 | 运维看规模 |
| 计数表，与业务在同一事务内更新 | 精确且一致 | 计数行成热点，高并发行锁争用（模块五） | 中低并发需精确 |
| Redis 计数器 | 近似 | 与数据库不在同一事务，失败或宕机产生偏差，需定期校准 | 高并发展示类计数 |
| 按条件计数 + 合适索引 | 精确 | 依赖索引设计 | WHERE 能缩小范围 |
| 产品不展示精确总数（“10000+”） | — | 需产品配合 | 列表页总页数 |

::: tip 与 Redis 笔记对照
Redis 计数“先写库还是先写缓存”与缓存一致性一节是同类问题；计数通常可接受近似，多采用异步校准。
:::

## 五、其他特定写法

| 完整 SQL | 实测 | 要点 |
| --- | --- | --- |
| `SELECT MAX(created_at) FROM t_s` | `Select tables optimized away`，0.11 ms | 优化阶段直接读索引最右端，执行时不访问表 |
| `SELECT MAX(amount) FROM t_s` | ALL，133 ms | 无索引只能全表扫描 |
| `SELECT MAX(created_at) FROM t_s WHERE user_id = 5` | idx_user，检查 6 行 | 有 `(user_id, created_at)` 联合索引可直接取该段最后一项 |
| `... UNION ...` vs `... UNION ALL ...`（两个 created_at 范围取 user_id） | UNION 多一步 `<union1,2>` 临时表去重，155 ms，40251 行；UNION ALL 128 ms，51762 行 | **结果可能不同**：UNION 去重（含同一分支内部重复）；不需去重用 UNION ALL |

## 六、在三条主线中的位置

```
A 性能：SQL 写法 → [优化器能否把条件转为索引上的连续区间] → 计划（range/ref vs index/ALL）→ 索引 → 页
B 一致性：COUNT 不存总数的原因（MVCC，模块五）
C 诊断：possible_keys 有索引但 key 为 NULL / type 为 index 或 ALL / SHOW WARNINGS 中的 1739、1292
```

## 七、排查要点

| 现象 | 先查什么 | 可能原因 / 对策 |
| --- | --- | --- |
| possible_keys 有索引，key 为 NULL 或 type=index | WHERE 中列一侧是否有函数 / 运算 | 改写为范围；8.0.13+ 函数索引 |
| 字符串列等值查询全表扫描 | 传参类型；`SHOW WARNINGS` 有无 1292 | 字符串列与数字比较，参数改为字符串 |
| 等值查询结果多出奇怪的行 | 同上 | 按数字比较语义匹配了 `'0123456'` 等，修正参数类型 |
| 两表关联很慢，被驱动表关联列有索引却不用 | 两列字符集 / 排序规则；`SHOW WARNINGS` 有无 1739 | 统一字符集与排序规则 |
| 关联报 ERROR 1267 | 两列 collation | 统一排序规则 |
| `LIKE '%xx'` 慢 | 通配符位置 | 反转列、全文索引、搜索引擎 |
| OR 查询全表扫描 | 每个分支是否都有索引 | 补索引；必要时 UNION ALL 并去重 |
| `COUNT(列)` 与 `COUNT(*)` 结果不同 | 列是否可为 NULL | 数行数用 `COUNT(*)` |
| 大表 COUNT 慢 / 高频 | 调用频率与精确度要求 | 计数表、Redis、估算或产品改造 |

::: tip PG 对照
PostgreSQL 对字符串列与数字比较通常直接报类型错误（如 `operator does not exist: character varying = integer`），而不是静默转换，因此隐式转换导致的“慢且错”在 PG 中少见；PG 的表达式索引对应 MySQL 的函数索引。PG 的 `COUNT(*)` 同样因 MVCC 需要扫描，常用 `pg_class.reltuples` 做估算。
:::

## 八、本地复现（Docker mysql:8.4）

```sql
USE lab;
CREATE TABLE t_s (
  id BIGINT UNSIGNED PRIMARY KEY, user_id INT UNSIGNED NOT NULL, amount DECIMAL(10,2) NOT NULL,
  order_no VARCHAR(32) NOT NULL, created_at DATETIME NOT NULL, remark VARCHAR(255) NULL,
  code VARCHAR(20) CHARACTER SET utf8mb4 NOT NULL,
  code_mb3 VARCHAR(20) CHARACTER SET utf8mb3 NOT NULL,
  KEY idx_user(user_id), KEY idx_created(created_at), KEY idx_order_no(order_no),
  KEY idx_code(code), KEY idx_code_mb3(code_mb3));
INSERT INTO t_s SELECT id,user_id,amount,order_no,created_at,remark,CAST(id AS CHAR),CAST(id AS CHAR) FROM t_order;
CREATE TABLE t_m (code VARCHAR(20) CHARACTER SET utf8mb4 NOT NULL PRIMARY KEY);
INSERT INTO t_m SELECT CAST(id*997 AS CHAR) FROM t_order WHERE id <= 1000;
ANALYZE TABLE t_s, t_m;

-- 一、index vs ALL
EXPLAIN SELECT COUNT(*) FROM t_s WHERE DATE(created_at) = '2026-03-01';
EXPLAIN SELECT * FROM t_s WHERE DATE(created_at) = '2026-03-01';

-- 二、失效写法与隐式转换语义
EXPLAIN SELECT COUNT(*) FROM t_s WHERE created_at >= '2026-03-01' AND created_at < '2026-03-02';
EXPLAIN SELECT * FROM t_s WHERE code = 123456;
EXPLAIN SELECT * FROM t_s WHERE user_id = '5';
CREATE TABLE t_conv (code VARCHAR(20) NOT NULL, KEY idx_code(code));
INSERT INTO t_conv VALUES ('123456'),('0123456'),(' 123456'),('123456abc'),('123456.0'),('1.23456e5'),('2'),('100'),('20');
SELECT code FROM t_conv WHERE code = 123456;     -- 6 行
SELECT code FROM t_conv WHERE code = '123456';   -- 1 行
EXPLAIN SELECT * FROM t_s WHERE order_no LIKE '%00123456';

-- 字符集不一致
EXPLAIN SELECT COUNT(*) FROM t_m JOIN t_s ON t_s.code = t_m.code;
EXPLAIN SELECT COUNT(*) FROM t_m STRAIGHT_JOIN t_s ON t_s.code_mb3 = t_m.code;
SHOW WARNINGS;      -- 预期 Warning 1739

-- 三、OR
EXPLAIN SELECT * FROM t_s WHERE user_id = 5 OR order_no = 'NO000000000054';
EXPLAIN SELECT * FROM t_s WHERE user_id = 5 OR amount > 999.5;

-- 四、COUNT
EXPLAIN FORMAT=TREE SELECT COUNT(*) FROM t_s;
SELECT COUNT(*), COUNT(remark) FROM t_s;
```

（本地 `order_no` 格式若与沙箱不同，相关常量按实际数据替换。）

**预期现象**：`COUNT(*)` 版为 index、`SELECT *` 版为 ALL；函数、数字比较字符串、前导 % 写法扫描约 100 万行，改写后变为 range / ref；`user_id = '5'` 仍走索引；`t_conv` 两种比较分别返回 6 行与 1 行；mb3 / mb4 关联出现 Warning 1739；含无索引分支的 OR 为 ALL；`COUNT(remark)` 小于 `COUNT(*)`。

## 九、与其他专题的关联

- **专题 10**：聚簇索引与二级索引大小差异，解释 index 与 ALL 的选择。
- **专题 11 / 19**：索引按原始值有序，是“连续区间”判断的前提。
- **专题 13**：`table_rows` 来自统计信息，只是估算。
- **专题 14**：index_merge、全文索引、函数索引。
- **专题 20**：被驱动表关联列索引不可用时的驱动表重选。
- **专题 22**：把这些成因纳入完整定位流程。
- **模块五**：MVCC 解释 COUNT 无法存总数。

## 十、复习 checklist

- [ ] 能区分 type=index 与 ALL，知道两者都是全量扫描，取决于所需列能否被某个索引覆盖
- [ ] 能说出函数 / 运算、隐式类型转换、前导通配符、字符集不一致四类失效写法及修复
- [ ] 能用“匹配值在索引中是否连续”解释为什么字符串列与数字比较失效，而整数列与字符串比较不失效
- [ ] 知道字符串与数字比较还可能返回错误结果
- [ ] 知道 mb3 / mb4 关联时转换方向，以及 Warning 1739、ERROR 1267
- [ ] 知道 OR 有无索引分支时整条语句全表扫描，以及 UNION ALL 改写的适用条件和去重要求
- [ ] 能说出 InnoDB 不存总行数的原因，`COUNT(*)` / `COUNT(1)` / `COUNT(列)` 的区别，以及大表计数方案
- [ ] 知道 `MAX(索引列)` 的 `Select tables optimized away` 与 UNION / UNION ALL 的结果差异
