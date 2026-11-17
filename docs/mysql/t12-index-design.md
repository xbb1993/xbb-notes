# 专题 12 · 索引设计实践与案例

> 级别 ★（核心）· 主线 A / C · 实测版本：沙箱 MySQL 8.0.46

本专题回答三个问题：

1. 拿到一条慢 SQL，怎么一步步设计索引并证明它有效？
2. 索引是不是越多越好？代价有多大？
3. 哪些写法会让索引失效？

## 一、实验数据与衡量指标

`t_case`：`t_order` 的 100 万行，加一个大客户 `user_id = 777`，共 50013 笔订单（status = 1 的 9938 笔）；普通用户平均约 10 笔。初始只有主键与 `idx_user (user_id)`。

衡量指标取自 `performance_schema.events_statements_history`，也是慢查询日志的核心字段（专题 22）：

| 指标 | 含义 |
| --- | --- |
| `ROWS_EXAMINED` | 服务端为该语句检查的行数 |
| `ROWS_SENT` | 返回给客户端的行数 |
| `SORT_ROWS` | 额外排序的行数（出现 filesort 时） |

**检查行数 ÷ 返回行数**越接近 1，说明索引越贴合这个查询。

## 二、设计方法

### 2.1 从查询出发

| 错误做法 | 正确做法 |
| --- | --- |
| 看表结构，给“可能会查的列”各建一个索引 | 先列出高频查询与慢查询，再为它们设计索引 |
| 每个查询各配一个专属索引 | 让一个索引尽量服务多个查询（每个索引都有写入代价，见第四节） |

### 2.2 四问检查表

```
SELECT <返回的列>                 ④ 能否覆盖？   → 放最后（可选）
FROM t
WHERE <等值条件> AND <范围条件>    ① 等值列       → 放最前
                                   ③ 范围列       → 放等值列之后
ORDER BY <排序列>                  ② 排序列       → 紧跟等值列，方向一致
LIMIT n
```

范围列与排序列同时存在且不是同一列时，**只能保一个**（案例二）。

### 2.3 验证四步

1. **EXPLAIN**：type、key、key_len、rows、Extra 是否符合预期；
2. **检查行数 / 返回行数**是否接近 1；
3. **服务端耗时**是否下降；
4. **副作用**：其他查询的执行计划是否改变，写入代价能否接受。

## 三、三个案例

### 3.1 案例一：用户订单列表

```sql
SELECT id, status, amount, created_at FROM t_case
WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT 20;
```

**诊断**（仅 `idx_user`，大客户 777）：

```
type=ref  key=idx_user  rows=97774  Extra=Using where; Using filesort
检查 50033 行，返回 20 行，排序 20 行，42.1 ms
```

找出大客户全部 5 万笔订单、逐行回表、判断 status、再排序取前 20，检查行数是返回行数的 2500 倍。（排序行数只有 20，是因为 `ORDER BY ... LIMIT` 只保留前 N 行，见专题 19。）

**设计**：等值 user_id、status 放前两列；排序 created_at DESC 放第三列（倒序读）；amount 不在索引中，20 次回表可接受 → `INDEX (user_id, status, created_at)`。

**验证**：

```
                 type   key         Extra                检查行数   耗时
大客户 777       ref    idx_u_s_c   Backward index scan       20    1.48 ms
普通用户 123     ref    idx_u_s_c   Backward index scan        3    0.29 ms
```

定位到 (777, 1) 后从末尾倒读 20 条即结束，与客户订单量无关。

**需求变化**：同时显示状态 1 和 2：

```sql
WHERE user_id = 777 AND status IN (1, 2) ORDER BY created_at DESC LIMIT 20
```

```
用 (user_id, status, created_at)：优化器改回 idx_user，Using filesort，检查 50033 行，45.4 ms
```

`IN` 的两段各自有序、合起来无序（专题 11），排序又回来了。两种解法：

```
方法一：加 INDEX (user_id, created_at)
  → ref, Backward index scan，检查 42 行，2.6 ms
  按时间倒序扫该用户订单，用 status IN (1, 2) 过滤，凑够 20 条即停
方法二：应用层分两次查询（status = 1、status = 2 各取 20 条），内存中合并后取前 20
```

方法一的前提是该用户近期订单中状态 1、2 足够多；若某状态极少，要扫很多行。方法二扫描量确定，但代码更复杂。

::: tip 要点
- 设计索引时要测**数据最多的那类用户**，普通用户怎样都快；
- 需求一变（`=` 变 `IN`），原索引就可能失效，**索引要随查询一起评审**。
:::

### 3.2 案例二：范围条件与排序冲突

```sql
-- 最近 30 天已支付订单，按金额从高到低取前 20（符合条件 17712 行）
SELECT id, user_id, amount, created_at FROM t_case
WHERE status = 1 AND created_at >= '2026-10-11' ORDER BY amount DESC LIMIT 20;
```

| 候选 | 能做到 | 做不到 |
| --- | --- | --- |
| A：`(status, created_at)` | 只扫描最近 30 天、status = 1 的行 | 结果要额外排序 |
| B：`(status, amount)` | 按金额倒序读、无需排序，凑够 20 条即停 | 不能用 created_at 缩小范围，要边读边过滤 |

**实测**（分别强制使用）：

```
                         Extra                                       检查行数   排序行数   耗时
无合适索引                Using where; Using filesort（全表扫描）      1050020        20    255.5 ms
A (status, created_at)   Using index condition; Using filesort          17732        20     67.9 ms
B (status, amount)       Using where; Backward index scan                 146         0      5.3 ms
两者都在时，优化器选 B
```

B 按金额从高到低读 status = 1 的订单，30 天约占全年 8%，平均十几行就遇到一条符合的，146 行即凑够 20 条。

**B 的风险**：范围缩到最近 1 天（约 380 行符合）：

```
                         检查行数   耗时
强制 B (status, amount)     6639    47.2 ms   ← 符合的行稀疏，要读很多行
优化器自己选：A               399     4.6 ms
```

| 方案 | 成本取决于 | 适合 |
| --- | --- | --- |
| A：按范围列建索引再排序 | 范围内行数（全部取出再排序） | 范围窄、结果少 |
| B：按排序列建索引再过滤 | 凑够 LIMIT 条要读多少行，即符合条件的行有多稀疏 | 范围宽、条件宽松 |

两索引都在时优化器按估算切换，本例两次都选对；但若数据有相关性（如近期订单金额普遍偏小），B 的实际扫描量会远超估算。**此类查询上线前要用最宽、最窄两种极端参数分别验证。**

::: warning 易混淆
| 错误理解 | 正确理解 |
| --- | --- |
| 把范围和排序都放进一个索引即可，如 (status, created_at, amount) | 范围列之后的列不能用于排序，仍要 filesort |
| 避免 filesort 的索引一定更好 | 要看凑够 LIMIT 条需读多少行；条件很严时“不排序”反而扫大量行 |
:::

### 3.3 案例三：深分页

```sql
SELECT * FROM t_case WHERE status = 1 ORDER BY id LIMIT 100000, 20;
```

`idx_status (status)` 的叶子实为 `(status, id)`（主键自动附加），status = 1 的部分天然按 id 有序。

**诊断**：

```
LIMIT 100000, 20：type=range  key=idx_status  检查 100020 行，返回 20 行，164.5 ms
LIMIT 100, 20：   检查 563 行，0.45 ms
```

MySQL 无法直接跳到第 10 万行，**只能读出前 100020 行再丢弃**，且每行都回表取全部列。页数越往后越慢。

**改写一：延迟关联**（先只取主键，最后回表）

```sql
SELECT t.* FROM t_case t
JOIN (SELECT id FROM t_case WHERE status = 1 ORDER BY id LIMIT 100000, 20) x ON t.id = x.id
ORDER BY t.id;
```

子查询只要 id，`idx_status` 可覆盖，跳过 10 万行时只读索引不回表，最后只对 20 行回表。

```
子查询强制 idx_status：13.4 ms     ← 约快 12 倍
子查询不加提示：        84.3 ms     ← 优化器选了 idx_s_c (status, created_at)，它也能覆盖 id，
                                       但不按 id 排序，于是排序了 10 万行
```

::: warning 意外
表上同时有 `(status, created_at)` 与 `(status)`，前缀相同，优化器选错导致排序 10 万行。**前缀相同的多个索引会干扰优化器**，这是清理冗余索引的又一理由。
:::

**改写二：游标分页**（记住上一页最后一条）

```sql
-- 上一页最后一条 id = 497550
SELECT * FROM t_case WHERE status = 1 AND id > 497550 ORDER BY id LIMIT 20;
```

```
type=range  key=PRIMARY  检查 119 行，0.34 ms
```

两种写法返回的 20 行完全相同（MD5 校验一致）。

| 方法 | 第 5000 页耗时 | 代价与限制 |
| --- | --- | --- |
| 原始 `LIMIT M, N` | 164.5 ms，越往后越慢 | 无 |
| 延迟关联 | 13.4 ms | 仍扫描 M 条索引记录（不回表），仍随页数变慢，斜率小得多 |
| 游标分页 | 0.34 ms，与页数无关 | 不能跳到第 N 页，只能上一页/下一页；排序列须唯一（或加主键组成唯一组合） |

App 信息流、下拉加载用游标分页；后台需要“跳到第 N 页”时用延迟关联并限制最大页数（专题 19）。

## 四、索引的代价

同一表结构分别带 0、1、3、5 个二级索引，各插入 100 万行（10 批，每批 10 万）：

| 二级索引数 | 包含的索引 |
| --- | --- |
| 0 | 仅主键 |
| 1 | `user_id` |
| 3 | `user_id`、`created_at`、`order_no` |
| 5 | 上述 3 个加 `amount`、`(user_id, status, created_at)` |

```
                  Buffer Pool 512MB    Buffer Pool 64MB    全部索引总大小（主键 73MB）
0 个二级索引           6.09 s               6.52 s                73 MB
1 个                   9.12 s              10.18 s               105 MB
3 个                  17.68 s              20.58 s               167 MB
5 个                  27.11 s              84.23 s               240 MB
```

1. **内存充足时写入耗时约随索引数线性增长**：5 个二级索引慢 4.5 倍，每插一行要在每棵索引树上各插一次。
2. **索引总大小超过内存后代价陡增**：5 个索引、64MB 内存时 84 秒，是无二级索引的 13 倍；二级索引插入位置随机，装不进内存时每次插入都可能先读磁盘（专题 9）。
3. 64MB 下 1–3 个索引增幅不大，一个可能原因是 8.0 默认开启的 change buffer（专题 4）缓冲了二级索引修改；8.4 默认关闭 change buffer，差距可能更大（未在 8.4 验证）。
4. **空间**：5 个二级索引使总大小从 73MB 变为 240MB，并占用 Buffer Pool，挤掉热数据。

**结论：每加一个索引，都要能说出它服务哪几条查询。**

## 五、冗余与无用索引

### 5.1 sys schema 的两个视图

sys schema 是 MySQL 自带的一组视图，把 `performance_schema` 的数据整理成易读形式（专题 44）。

```sql
SELECT table_name, redundant_index_name, redundant_index_columns, dominant_index_name, dominant_index_columns
FROM sys.schema_redundant_indexes WHERE table_schema = 'lab' AND table_name = 't_case';
```

沙箱实测（当时有 `idx_user`、`idx_u_s_c`、`idx_s_c`、`idx_s_a`、`idx_status`）：

```
冗余索引     冗余索引的列   被哪个索引覆盖   覆盖它的索引的列
idx_status   status         idx_s_a          status,amount
idx_status   status         idx_s_c          status,created_at
idx_user     user_id        idx_u_s_c        user_id,status,created_at
```

```sql
SELECT object_name, index_name FROM sys.schema_unused_indexes
WHERE object_schema = 'lab' AND object_name = 't_case';
-- 结果：idx_s_a、idx_s_c、idx_user（自重启以来未被使用）
```

### 5.2 不能直接照着删

::: warning 冗余视图的误判
它认为 `idx_status (status)` 被 `(status, amount)` 覆盖。但案例三恰恰需要 `idx_status`：其叶子实为 `(status, id)`，status = 1 部分按 id 有序；`(status, amount)` 的叶子是 `(status, amount, id)`，**不能用于 `ORDER BY id`**。该视图只比较显式定义的列，未考虑末尾自动附带的主键。
:::

::: warning 无用视图的误判
统计从**实例启动时**开始。月底报表、季度对账用到的索引，平时看都是“无用”的。
:::

**安全删除流程**：

```
① 用两个视图找候选
② 人工确认：结合主键后缀判断是否真冗余；无用统计是否覆盖至少一个完整业务周期
③ 先设为不可见：ALTER TABLE t ALTER INDEX idx_x INVISIBLE;（优化器不再使用，但仍维护，可随时恢复，专题 14）
④ 观察一个业务周期，确认无查询变慢
⑤ 再删除：ALTER TABLE t DROP INDEX idx_x;
```

## 六、常见的索引失效写法

`t_case` 上 `created_at`、`order_no`、`user_id` 均有单列索引，实测：

| 写法 | EXPLAIN | 原因 | 改写 | 改写后 |
| --- | --- | --- | --- | --- |
| `DATE(created_at) = '2026-10-01'` | index（扫描整个索引） | 对索引列套函数 | `created_at >= '2026-10-01' AND created_at < '2026-10-02'` | range，rows=2832 |
| `user_id + 1 = 124` | ALL | 对索引列做运算 | `user_id = 124 - 1` | ref，rows=13 |
| `order_no LIKE '%00123456'` | ALL | 前缀不确定，无法定位 | 改为前缀匹配，或用全文索引 | — |
| `order_no LIKE 'NO00000012345%'` | range，rows=10 | 前缀确定即范围 | — | — |
| `order_no = 123456` | ALL | 隐式转换落在列上（专题 5） | `order_no = '123456'` | — |
| `user_id = 123 OR amount > 999` | ALL | OR 一侧无索引 | 给 amount 建索引或拆成 UNION | — |
| `user_id = 123 OR created_at >= '…15:00'` | index_merge，rows=57 | 两侧都有索引可合并 | — | — |
| `user_id <> 123`、`NOT IN (1,2,3)` | ALL | 几乎所有行都满足，全表扫描更便宜 | — | — |
| `remark IS NULL AND user_id = 123` | ref（idx_user） | IS NULL 可以用索引，这里选了更合适的 | — | — |

- **函数问题在 8.0 可用函数索引解决**（专题 14）：`ALTER TABLE t_case ADD INDEX ((DATE(created_at)))` 后，`DATE(created_at) = '2026-10-01'` 变为 ref、rows=2832。能改写成范围时优先改写。

::: warning 易混淆
| 错误理解 | 正确理解 |
| --- | --- |
| `!=`、`NOT IN` 一定用不上索引 | 可转换为范围；通常不走索引是因为满足的行太多，全表扫描更便宜 |
| `IS NULL` 用不上索引 | 可以用（专题 5） |
| `LIKE` 都用不上索引 | 前缀确定的 `LIKE 'abc%'` 可以，只有以 `%` 开头的不行 |
:::

**总规则：索引列必须“原样”出现在比较的一侧**，对它做函数、运算或类型转换都会破坏与索引顺序的对应关系（与专题 5“转换落在列上就失效”同理）。

## 七、在三条主线中的位置

```
A 性能：把专题 9–11 的原理落地：查询 → 四问 → 索引 → 验证
B 一致性：索引越多，每次写入修改的页越多，持锁时间越长（专题 26：索引还影响加锁范围）
C 诊断：见第八节
```

::: tip PG 对照
PostgreSQL 有 MySQL 没有的**部分索引**（如 `CREATE INDEX ... WHERE status = 1`）与表达式索引（MySQL 8.0 函数索引与之类似）。PG 的 `pg_stat_user_indexes.idx_scan` 相当于无用索引视图，同样从统计重置时计数，有同样的误判风险。
:::

## 八、诊断实践

### 8.1 慢 SQL 优化的标准动作

```
① 找到 SQL：慢查询日志 / sys.statement_analysis（专题 22、44）
② EXPLAIN：type、key、key_len、rows、Extra
③ 量化：检查行数 / 返回行数、排序行数、耗时
④ 设计：四问检查表
⑤ 验证：重新 EXPLAIN，用极端参数测试，检查其他查询是否受影响
⑥ 收尾：用两个 sys 视图清理多余索引，按安全流程删除
```

### 8.2 病例一：大客户的列表页超时

1. **现象**：普通用户的订单页很快，少数大客户频繁超时。
2. **指标**：慢日志中检查行数为数万、返回 20 行；EXPLAIN 出现 `Using filesort`。
3. **定位**：索引只覆盖了等值列，排序列不在索引中，须取出该用户全部订单再排序。
4. **处置**：按四问把排序列放到等值列之后（案例一）；用大客户参数验证。

### 8.3 病例二：后台报表时快时慢

1. **现象**：同一报表查询，选择不同时间范围时耗时差异很大。
2. **指标**：不同参数下 EXPLAIN 在 `(status, created_at)` 与 `(status, amount)` 之间切换，检查行数在几百与数千之间波动。
3. **定位**：范围与排序冲突，两种方案各适合不同范围宽度（案例二）。
4. **处置**：用极端参数验证两种方案；必要时按参数分别给出提示，或限制可选范围。

### 8.4 病例三：翻页越往后越慢

1. **现象**：后台列表翻到几千页后每页要数百毫秒。
2. **指标**：检查行数约等于 偏移量 + 页大小。
3. **定位**：`LIMIT M, N` 须读出并丢弃前 M 行，且每行回表。
4. **处置**：信息流改游标分页；需跳页时用延迟关联，并确认子查询走的是按排序列有序的覆盖索引。

## 九、本地复现脚本

在专题 1 的 Docker 环境（`mysql:8.4`）中执行，日期按你的数据调整。

```sql
USE lab;
CREATE TABLE t_case LIKE t_order;
INSERT INTO t_case SELECT * FROM t_order;
SET SESSION cte_max_recursion_depth = 100000;
INSERT INTO t_case (user_id, status, amount, order_no, created_at, remark)
WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 50000)
SELECT 777, FLOOR(RAND() * 5), ROUND(RAND() * 1000, 2), CONCAT('BIG', LPAD(n, 10, '0')),
       NOW() - INTERVAL FLOOR(RAND() * 365 * 86400) SECOND, NULL FROM s;
ANALYZE TABLE t_case;

-- 每条查询后查看检查行数、返回行数、排序行数、耗时
SELECT sql_text, rows_examined, rows_sent, sort_rows, ROUND(timer_wait / 1e9, 2) AS ms
FROM performance_schema.events_statements_history
WHERE thread_id = PS_CURRENT_THREAD_ID() ORDER BY event_id DESC LIMIT 2;

-- 案例一
EXPLAIN SELECT id, status, amount, created_at FROM t_case WHERE user_id = 777 AND status = 1 ORDER BY created_at DESC LIMIT 20;
ALTER TABLE t_case ADD INDEX idx_u_s_c (user_id, status, created_at);
EXPLAIN SELECT id, status, amount, created_at FROM t_case WHERE user_id = 777 AND status = 1 ORDER BY created_at DESC LIMIT 20;
EXPLAIN SELECT id, status, amount, created_at FROM t_case WHERE user_id = 777 AND status IN (1, 2) ORDER BY created_at DESC LIMIT 20;

-- 案例二
ALTER TABLE t_case ADD INDEX idx_s_c (status, created_at), ADD INDEX idx_s_a (status, amount);
SELECT id, user_id, amount, created_at FROM t_case FORCE INDEX (idx_s_c) WHERE status = 1 AND created_at >= '2026-10-11' ORDER BY amount DESC LIMIT 20;
SELECT id, user_id, amount, created_at FROM t_case FORCE INDEX (idx_s_a) WHERE status = 1 AND created_at >= '2026-10-11' ORDER BY amount DESC LIMIT 20;
SELECT id, user_id, amount, created_at FROM t_case FORCE INDEX (idx_s_a) WHERE status = 1 AND created_at >= '2026-11-10' ORDER BY amount DESC LIMIT 20;

-- 案例三
ALTER TABLE t_case ADD INDEX idx_status (status);
SELECT * FROM t_case WHERE status = 1 ORDER BY id LIMIT 100000, 20;
SELECT t.* FROM t_case t
JOIN (SELECT id FROM t_case FORCE INDEX (idx_status) WHERE status = 1 ORDER BY id LIMIT 100000, 20) x ON t.id = x.id
ORDER BY t.id;
SELECT id FROM t_case WHERE status = 1 ORDER BY id LIMIT 99999, 1;   -- 上一页最后一条的 id
SELECT * FROM t_case WHERE status = 1 AND id > 497550 ORDER BY id LIMIT 20;

-- 冗余与无用索引
SELECT * FROM sys.schema_redundant_indexes WHERE table_schema = 'lab' AND table_name = 't_case'\G
SELECT * FROM sys.schema_unused_indexes WHERE object_schema = 'lab' AND object_name = 't_case';

-- 索引失效写法
ALTER TABLE t_case ADD INDEX idx_created (created_at), ADD INDEX idx_no (order_no);
EXPLAIN SELECT id FROM t_case WHERE DATE(created_at) = '2026-10-01';
EXPLAIN SELECT id FROM t_case WHERE created_at >= '2026-10-01' AND created_at < '2026-10-02';
EXPLAIN SELECT * FROM t_case WHERE user_id + 1 = 124;
EXPLAIN SELECT * FROM t_case WHERE order_no LIKE '%00123456';
EXPLAIN SELECT * FROM t_case WHERE order_no LIKE 'NO00000012345%';
EXPLAIN SELECT * FROM t_case WHERE user_id = 123 OR amount > 999;
EXPLAIN SELECT * FROM t_case WHERE user_id <> 123;
```

**索引代价实验**：建与 `t_order` 同结构、仅主键的表，分别加 0、1、3、5 个二级索引（组合见第四节），每次用 10 条 `INSERT ... SELECT * FROM t_order WHERE id > … AND id <= …`（每条 10 万行）插入并计时；可将 `innodb_buffer_pool_size` 临时设为 64M 重复。

**预期现象**：案例一建索引后检查行数从约 5 万降到 20，改为 `IN (1, 2)` 后又出现 filesort；案例二中 B 在 30 天范围检查行数最少、在 1 天范围反而远多于 A；案例三延迟关联快一个数量级、游标分页与页数无关；冗余视图把 `idx_status` 列为冗余；失效写法的 EXPLAIN 与第六节一致。

## 十、与其他专题的关联

- **专题 5**：隐式类型转换导致索引失效。
- **专题 9、10**：随机插入的代价；覆盖索引与主键后缀。
- **专题 11**：列顺序原则、IN 与排序。
- **专题 13、16**：rows 估算与成本模型，解释优化器在案例二、三中的选择。
- **专题 14**：函数索引、不可见索引、降序索引。
- **专题 19**：ORDER BY ... LIMIT 的排序方式与分页。
- **专题 22、44**：慢查询定位、sys schema。

## 十一、复习 checklist

- [ ] 能用四问检查表为一条 SQL 设计索引，并按验证四步证明效果
- [ ] 能用“检查行数 / 返回行数”评估索引贴合度
- [ ] 能解释案例一中 `IN` 导致 filesort 的原因及两种解法
- [ ] 能说明范围与排序冲突时两种方案的成本取决于什么，以及为何要用极端参数验证
- [ ] 能解释深分页慢的原因，比较延迟关联与游标分页的效果与限制
- [ ] 能用实验数据说明索引数量对写入与空间的影响
- [ ] 会用两个 sys 视图找冗余与无用索引，并知道各自的误判与安全删除流程
- [ ] 能列出常见索引失效写法并给出改写，说清“索引列须原样出现”的总规则
