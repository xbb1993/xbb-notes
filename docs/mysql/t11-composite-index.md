# 专题 11 · 多列索引：列顺序、最左前缀、索引下推、前缀索引

> 级别 ★（核心）· 主线 A · 实测版本：沙箱 MySQL 8.0.46，数据为专题 1 的 `lab.t_order`（实验库重建后重新随机生成，个别数值与前几个专题略有不同）

贯穿全篇的联合索引：

```sql
ALTER TABLE t_order ADD INDEX idx_u_s_c (user_id, status, created_at);
```

本专题回答四个问题：

1. `WHERE status = 1` 为什么用不上它？
2. `WHERE user_id = 123 AND status > 1 AND created_at >= '2026-06-01'`，`created_at` 能用上吗？
3. 用不上的列就完全没有作用吗？
4. 列的顺序该怎么排？

## 一、类比：电话簿

电话簿**先按姓排，姓相同按名排，名相同按城市排**。

| 要找的人 | 能否快速翻到 |
| --- | --- |
| 姓张的 | 能 |
| 姓张、名伟的 | 能 |
| 姓张、名伟、住北京的 | 能，一路精确定位 |
| 名叫伟的（不知道姓） | 不能，“伟”分散在每个姓的段落里 |
| 姓张、名字拼音在 L 到 M 之间、住北京的 | 能翻到“张 L…”到“张 M…”这一段，但这段里不按城市排，城市帮不上忙 |

## 二、联合索引怎么排序与最左前缀

### 2.1 真实数据

`idx_u_s_c` 的叶子按 `(user_id, status, created_at)` 排序，末尾附带主键 `id`（专题 10）。沙箱中 `user_id` 为 122、123 的记录按索引顺序：

```
user_id  status  created_at            id
122      0       2026-07-01 11:51:47   591667
122      1       2026-04-03 09:33:12   808133
122      1       2026-06-24 23:43:34   577622
122      1       2026-11-07 00:22:39   809239
122      4       2026-10-13 02:20:35   416219
123      0       2026-01-23 15:12:44   408945
123      1       2025-12-08 21:59:14   807790   ┐
123      1       2026-02-08 23:39:57   524283   │ user_id=123 且 status=1：连续一段，
123      1       2026-10-19 14:51:42   466811   ┘ 段内按 created_at 有序
123      2       2025-12-02 15:01:44   848937
…（user_id=123 共 13 行）
123      4       2026-08-28 05:40:12   627050
```

1. `user_id` 全局有序；
2. `status` 只在 `user_id` 相同时有序，单看这一列是 0,1,1,1,4,0,1… 整体无序；
3. `created_at` 只在前两列都相同时有序。

### 2.2 最左前缀原则

B+ 树只能在有序部分上二分查找，由此直接推出：

> 联合索引 `(a, b, c)` 只能按 **a**、**a+b**、**a+b+c** 这些从最左开始、连续的前缀缩小查找范围。

| 条件 | 能缩小范围的列 | 原因 |
| --- | --- | --- |
| `user_id = 123` | user_id | 最左列 |
| `user_id = 123 AND status = 1` | user_id、status | 连续前缀 |
| `status = 1 AND user_id = 123` | user_id、status | WHERE 书写顺序无关，优化器会重排 |
| `status = 1` | 无 | 缺最左列，status 整体无序 |
| `user_id = 123 AND created_at >= …` | user_id | 缺中间列，created_at 在 user_id=123 范围内无序 |

## 三、用 key_len 判断用到了几列

### 3.1 计算规则

`key_len` 是索引中被用来缩小查找范围的那部分键的字节数（字段大小见专题 5、8）：

| 列类型 | 字节数 |
| --- | --- |
| `INT` | 4 |
| `TINYINT` | 1 |
| `DATETIME`（无小数秒） | 5 |
| `VARCHAR(n)` | n × 字符集每字符最大字节数 + 2 |
| 允许 NULL | 再加 1 |

`idx_u_s_c` 三列均 NOT NULL：4、1、5。key_len 为 4 表示用了第一列，5 表示前两列，10 表示三列。

### 3.2 实测

```
条件                                                         type   key_len  rows  Extra
user_id = 123 AND status = 1                                 ref      5        3   NULL
user_id = 123 AND status = 1 AND created_at >= '2026-06-01'  range   10        1   Using index condition
status = 1 AND user_id = 123                                 ref      5        3   NULL
status = 1 AND created_at >= '2026-06-01'                    ALL     NULL  995328   Using where
user_id = 123 AND created_at >= '2026-06-01'（强制用该索引）  ref      4       10   Using index condition
user_id = 123 AND status > 1 AND created_at >= '2026-06-01'  range    5        9   Using index condition
```

（单写 `user_id = 123` 时优化器选了更小的单列索引 `idx_user`，key_len 也是 4。）

### 3.3 为什么范围之后的列用不上

`user_id = 123 AND status > 1` 对应 status 为 2、3、4 的三小段，每段内 created_at 有序，连起来无序：

```
status=2：2025-12-02, 2026-03-29, 2026-04-16, 2026-10-09
status=3：2026-04-07, 2026-04-12
status=4：2025-11-15, 2025-12-02, 2026-08-28
           ↑ 日期回到更早，整体无序
```

手册的表述：构造查找区间时，遇到 `=`、`<=>`、`IS NULL` 会继续使用后面的列；遇到 `>`、`<`、`>=`、`<=`、`BETWEEN`、`LIKE` 等范围运算符，会用上这一列，但不再考虑之后的列。

::: warning 易错：key_len 会“多报”
```
user_id BETWEEN 100 AND 200 AND status = 1  →  type=range  key_len=5  rows=1006  Extra=Using index condition
```
key_len 为 5 看似 status 也用上了，但 rows = 1006 约等于 user_id 在 100–200 之间的全部行数（101 个用户 × 约 10 行），status 并未缩小扫描范围。按手册规则，`BETWEEN` 之后的列不参与区间构造，这里的 5 只是区间端点 `(100, 1)` 到 `(200, 1)` 的长度。

**key_len 说明哪些列出现在查找区间里，rows 说明扫描范围实际缩小了多少，两者要一起看。**
:::

## 四、索引下推（ICP）

### 4.1 问题与方案

`user_id BETWEEN 1 AND 2000 AND status = 1`：按 user_id 定位到约 2 万条索引记录，其中 status = 1 的约 4000 条。

```
无索引下推：读出 2 万条 → 每条回表 → Server 层判断 status = 1 → 留下 4000 条（1.6 万次回表白做）
有索引下推：读出 2 万条 → status 就在索引记录里，引擎当场判断 → 只对 4000 条回表
```

**索引下推**（ICP，Index Condition Pushdown）：把 WHERE 中能用索引列判断的条件交给存储引擎，在读索引时就过滤，不满足的不回表。它不缩小扫描范围，但减少回表，是专题 2 中“Server 层过滤”的例外。

### 4.2 实测

```
SELECT SUM(amount) FROM t_order FORCE INDEX(idx_u_s_c) WHERE user_id BETWEEN 1 AND 2000 AND status = 1;
（范围内 20124 行，其中 status = 1 的 3940 行）

             Extra                   Handler_read_next   逻辑读    服务端耗时
ICP 开启     Using index condition         3940          15,808    16.2 ms
ICP 关闭     Using where                  20117          71,995    74.7 ms
```

`Handler_read_next`（引擎交给 Server 层的行数）从 20117 降到 3940；逻辑读降到约 1/4.5，与回表次数比例一致（每次回表约 4 次逻辑读，专题 3）。

::: warning 易混淆
| 错误理解 | 正确理解 |
| --- | --- |
| `Using index condition` 表示覆盖索引 | 表示索引下推，**仍要回表**，只是次数变少；覆盖索引显示 `Using index` |
| 索引下推让 status 也参与了查找 | 扫描范围不变（仍是 2 万条索引记录），只是提前过滤 |
| 用不上的列放进索引没意义 | 可用于索引下推和覆盖，减少回表 |
:::

### 4.3 适用边界

- 只对需要回表的情况有意义，覆盖索引用不到它；
- 只能下推索引中包含的列的条件；
- 对聚簇索引无效：主键叶子就是整行，没有回表可省。

## 五、列顺序

### 5.1 原则一：等值列在前，范围列在后

查询 `WHERE status = 1 AND created_at >= '2026-11-01'`，两个顺序相反的覆盖索引对比：

```
索引                   key_len   rows    实际读的索引记录（Handler_read_next）   返回行数
(status, created_at)     6       5308         5308                                5308
(created_at, status)     6      49456        26304                                5308
```

- `(status, created_at)`：定位到 status = 1 这一段，段内按日期有序，读出的正好是结果，一条不多读；
- `(created_at, status)`：日期是范围，之后的 status 不能缩小范围，要读出 11 月以来全部 26304 条再逐条判断，多读 4 倍。

两者 key_len 相同，只看 key_len 分辨不出差异。

### 5.2 原则二：全是等值时，这个查询不在乎顺序

`user_id = 123 AND status = 1` 用 `(user_id, status)` 或 `(status, user_id)` 都能直接定位。此时决定顺序的是**其他查询**：如果很多查询只按 `user_id` 查，就把它放前面，让一个索引服务两类查询；还要兼顾排序。

::: warning 易混淆
| 错误理解 | 正确理解 |
| --- | --- |
| 区分度高的列一定放最前面 | 对全等值查询顺序不影响其效率；决定顺序的是范围条件、排序，以及能否让一个索引服务更多查询 |
| WHERE 书写顺序要与索引一致 | 无关，优化器自动匹配 |
:::

“区分度高的放前面”只在部分查询只带第一列时有意义，是参考因素而非规则。

### 5.3 原则三：兼顾排序

ORDER BY 顺序与索引一致时，可按索引顺序直接读出结果、不再排序；需要额外排序时 EXPLAIN 显示 `Using filesort`（名字有误导性，排序不一定用文件，专题 19）。实测（索引 `(user_id, status, created_at)`）：

```
查询                                                         Extra
WHERE user_id = 123 ORDER BY status, created_at              NULL                  ← 无需排序
WHERE user_id = 123 AND status = 1 ORDER BY created_at DESC  Backward index scan   ← 反向读索引，无需排序
WHERE user_id = 123 ORDER BY created_at                      Using filesort        ← 跳过了 status
WHERE user_id IN (123, 456) ORDER BY status                  Using filesort        ← 两段各自有序，合起来无序
WHERE user_id = 123 ORDER BY status DESC, created_at ASC     Using filesort        ← 两列方向不同
```

规律：**WHERE 中等值固定的列加上 ORDER BY 的列，要能构成索引的连续前缀，且方向一致**。`IN` 是多个等值，每段内有序、多段合起来无序，对排序而言相当于范围。方向混合的排序可用 8.0 降序索引解决（专题 14）。

### 5.4 原则四：考虑覆盖

```
SELECT user_id, status, created_at FROM t_order WHERE user_id = 123 AND status = 1;     → Using index
SELECT user_id, status, created_at, id FROM t_order WHERE user_id BETWEEN 100 AND 105;  → Using where; Using index
```

查询需要的列都在索引中（加上自动附带的主键）就不回表。高频查询可把 SELECT 的列放到索引末尾，代价是索引变宽（专题 12）。

### 5.5 决策过程

```
① 等值条件的列 → 最前面（多个等值列之间，按“哪个前缀还能服务其他查询”排序）
② 排序的列     → 紧接着，方向与 ORDER BY 一致
③ 范围条件的列 → 等值列之后（与排序列冲突时通常只能保一个，见专题 12、19）
④ 只为覆盖的列 → 最后
```

## 六、索引跳跃扫描（8.0）

8.0 引入**索引跳跃扫描**（Skip Scan，5.7 没有）：最左列取值很少时，优化器可把查询拆成“最左列的每个取值各查一次”。实测，索引 `(status, created_at)`，status 只有 5 个值：

```
EXPLAIN SELECT status, created_at FROM t_order WHERE created_at >= '2026-11-01';
  type=range  key=idx_s_c  Extra=Using where; Using index for skip scan

EXPLAIN SELECT * FROM t_order WHERE created_at >= '2026-11-01';
  type=ALL                    ← 需要回表时不能用
```

手册列出的主要条件：只查一张表；查询用到的列**全部在索引中**；无 GROUP BY 与 DISTINCT；被跳过的前导列只能有等值条件或无条件。由 `optimizer_switch` 的 `skip_scan` 控制，默认开启。条件苛刻，**设计索引时仍按最左前缀原则**。

## 七、前缀索引与索引合并

### 7.1 前缀索引

长字符串可只索引前 N 个字符，如 `INDEX (order_no(13))`。选多长看前缀区分度（不同前缀数 ÷ 总行数）。实测 `order_no`（`NO` + 12 位数字）：

```
前缀长度    8        10       12       13       完整
区分度     0.0000   0.0001   0.0100   0.1000   1.0000
```

前 8 位全是 `NO000000`，区分度为 0。前面相同、后面不同的值（这里的订单号、同域名邮箱）前缀索引几乎无效，可改用完整索引，或另存反转后的值再建前缀索引。

**三个限制**（实测）：

```
前缀索引 order_no(13)：
  WHERE order_no = 'NO000000123456'   key_len=54   rows=9   Extra=Using where   ← 要回表核对完整值
  ORDER BY order_no LIMIT 10          type=ALL    Using filesort                ← 不能用于排序
完整索引 order_no：
  WHERE order_no = 'NO000000123456'   key_len=130  rows=1   Extra=Using index   ← 可以覆盖
  ORDER BY order_no LIMIT 10          type=index  rows=10   Using index         ← 可按索引顺序读
```

1. **不能覆盖**：只有前缀，必须回表确认完整值；
2. **不能用于排序、分组**：前缀相同的值之间顺序未知；
3. **省空间取决于原始长度**：本例前缀索引 30.6MB、完整索引 31.6MB，几乎没省，`order_no` 本来只有 14 个字符；只对真正很长的列有意义。

### 7.2 索引合并

优化器有时同时使用多个索引再合并结果，称为**索引合并**（index merge）。实测（`user_id`、`created_at` 各有单列索引）：

```
WHERE user_id = 123 OR created_at >= '2026-11-09 23:00:00'
  type=index_merge  key=idx_user,idx_created  Extra=Using sort_union(idx_user,idx_created); Using where
WHERE user_id = 123 AND created_at >= '2026-11-01'
  type=ref  key=idx_user  Extra=Using where     ← 只用了一个，另一条件回表后判断
```

- 对 **OR**，索引合并有用：一个联合索引无法同时服务“满足 A 或满足 B”；
- 对 **AND**，多个单列索引远不如一个联合索引；AND 条件上频繁出现 `index_merge`，通常说明缺一个合适的联合索引。

## 八、在三条主线中的位置

```
A 性能：SQL → 优化器（能用哪个前缀？要不要排序？） → 执行计划 → [联合索引：区间扫描 → 索引下推 → 回表] → 页
         列顺序决定扫描范围，ICP 与覆盖决定回表次数
B 一致性：不涉及
C 诊断：见第九节
```

::: tip PG 对照
PostgreSQL 多列 B 树索引同样“最左列优先”，原因相同。PG 索引扫描时也可用非前缀列的条件在索引内过滤（EXPLAIN 中的 Index Cond / Filter）。`key_len` 是 MySQL 特有的观察手段，PG 中看 Index Cond 包含哪些列。
:::

## 九、诊断实践

### 9.1 判断联合索引是否被充分利用

| 观察点 | 回答的问题 |
| --- | --- |
| `key_len` | 哪些列出现在查找区间里 |
| `rows` 与实际行数 | 扫描范围实际缩小了多少（key_len 多报时以它为准） |
| Extra | `Using index`（覆盖）/ `Using index condition`（下推）/ `Using filesort`（额外排序） |
| `Handler_read_next` | 引擎交给 Server 层的行数，验证下推效果 |

### 9.2 病例一：有联合索引，查询仍然慢

1. **现象**：`WHERE user_id = ? AND created_at >= ?` 已有 `(user_id, status, created_at)` 索引，仍扫描大量行。
2. **指标**：key_len 为 4，Extra 为 `Using index condition`。
3. **定位**：缺中间列 status，created_at 只能用于下推过滤，不能缩小范围。
4. **处置**：若该查询高频，增加 `(user_id, created_at)` 或调整列顺序；先评估其他查询对现有索引的依赖。

### 9.3 病例二：列表查询出现 Using filesort

1. **现象**：`WHERE user_id = ? ORDER BY created_at DESC LIMIT 20` 偶发变慢，大客户尤甚。
2. **指标**：Extra 为 `Using filesort`，rows 随客户订单量增长。
3. **定位**：等值列与排序列之间隔着 status，无法按索引顺序读取，须先取出该用户全部行再排序。
4. **处置**：建 `(user_id, created_at)`，或在查询中固定 status 使 `(user_id, status, created_at)` 生效（专题 12 案例一）。

### 9.4 病例三：key_len 看起来用满了，扫描量却很大

1. **现象**：EXPLAIN 的 key_len 覆盖了多列，rows 却很大。
2. **指标**：rows 约等于第一个范围列所覆盖的全部行数。
3. **定位**：范围条件之后的列只出现在区间端点，没有缩小范围。
4. **处置**：把等值列移到范围列之前；以 rows 和 `Handler_read_next` 为准判断效果。

## 十、本地复现脚本

在专题 1 的 Docker 环境（`mysql:8.4`）中执行。日期条件按你数据中最近约 10 天的某一天替换。

```sql
USE lab;
ALTER TABLE t_order ADD INDEX idx_u_s_c (user_id, status, created_at);
ANALYZE TABLE t_order;

-- 1. 索引顺序
SELECT user_id, status, created_at, id FROM t_order WHERE user_id IN (122, 123)
ORDER BY user_id, status, created_at;

-- 2. key_len
EXPLAIN SELECT * FROM t_order WHERE user_id = 123 AND status = 1;
EXPLAIN SELECT * FROM t_order WHERE user_id = 123 AND status = 1 AND created_at >= '2026-06-01';
EXPLAIN SELECT * FROM t_order WHERE status = 1 AND created_at >= '2026-06-01';
EXPLAIN SELECT * FROM t_order FORCE INDEX (idx_u_s_c) WHERE user_id = 123 AND created_at >= '2026-06-01';
EXPLAIN SELECT * FROM t_order WHERE user_id = 123 AND status > 1 AND created_at >= '2026-06-01';
EXPLAIN SELECT * FROM t_order WHERE user_id BETWEEN 100 AND 200 AND status = 1;   -- 注意 key_len 与 rows

-- 3. 索引下推
SET optimizer_switch = 'index_condition_pushdown=on';
FLUSH STATUS;
SELECT SUM(amount) FROM t_order FORCE INDEX (idx_u_s_c) WHERE user_id BETWEEN 1 AND 2000 AND status = 1;
SHOW SESSION STATUS WHERE Variable_name IN ('Handler_read_key', 'Handler_read_next');
SET optimizer_switch = 'index_condition_pushdown=off';
FLUSH STATUS;
SELECT SUM(amount) FROM t_order FORCE INDEX (idx_u_s_c) WHERE user_id BETWEEN 1 AND 2000 AND status = 1;
SHOW SESSION STATUS WHERE Variable_name IN ('Handler_read_key', 'Handler_read_next');
SET optimizer_switch = 'index_condition_pushdown=on';

-- 4. 排序
EXPLAIN SELECT * FROM t_order WHERE user_id = 123 ORDER BY status, created_at;
EXPLAIN SELECT * FROM t_order WHERE user_id = 123 ORDER BY created_at;
EXPLAIN SELECT * FROM t_order WHERE user_id = 123 AND status = 1 ORDER BY created_at DESC;
EXPLAIN SELECT * FROM t_order WHERE user_id IN (123, 456) ORDER BY status;

-- 5. 等值在前与范围在前
ALTER TABLE t_order ADD INDEX idx_s_c (status, created_at), ADD INDEX idx_c_s (created_at, status);
FLUSH STATUS;
SELECT COUNT(*) FROM t_order FORCE INDEX (idx_s_c) WHERE status = 1 AND created_at >= '2026-11-01';
SHOW SESSION STATUS LIKE 'Handler_read_next';
FLUSH STATUS;
SELECT COUNT(*) FROM t_order FORCE INDEX (idx_c_s) WHERE status = 1 AND created_at >= '2026-11-01';
SHOW SESSION STATUS LIKE 'Handler_read_next';

-- 6. 跳跃扫描
EXPLAIN SELECT status, created_at FROM t_order WHERE created_at >= '2026-11-01';

-- 7. 前缀区分度
SELECT COUNT(DISTINCT LEFT(order_no, 8)) / COUNT(*), COUNT(DISTINCT LEFT(order_no, 12)) / COUNT(*),
       COUNT(DISTINCT LEFT(order_no, 13)) / COUNT(*), COUNT(DISTINCT order_no) / COUNT(*) FROM t_order;

-- 恢复
ALTER TABLE t_order DROP INDEX idx_u_s_c, DROP INDEX idx_s_c, DROP INDEX idx_c_s;
```

**预期现象**：key_len 依次为 5、10、无、4、5；BETWEEN 一条 key_len 为 5 但 rows 约等于 user_id 范围内全部行数；关闭 ICP 后 `Handler_read_next` 约增至 5 倍；`(status, created_at)` 的 `Handler_read_next` 等于返回行数，`(created_at, status)` 多数倍；跳跃扫描显示 `Using index for skip scan`。

## 十一、与其他专题的关联

- **专题 2**：Server 层过滤与 `Handler_read_*`，索引下推是其例外。
- **专题 3、10**：回表代价、覆盖索引、二级索引自动包含主键。
- **专题 5、8**：key_len 所需的字段字节数。
- **专题 12**：用本专题原则设计索引并验证。
- **专题 13**：rows 估算来自统计信息。
- **专题 14**：降序索引、函数索引。
- **专题 19**：排序与分页、范围与排序的冲突。

## 十二、复习 checklist

- [ ] 能从联合索引的排序方式推导出最左前缀原则
- [ ] 会按字段字节数计算 key_len，判断用到了几列
- [ ] 能解释范围条件之后的列为何不能缩小范围，并知道 key_len 会“多报”
- [ ] 能说明索引下推的作用、适用边界，并区分 `Using index` 与 `Using index condition`
- [ ] 能用“等值在前、范围在后”解释两个索引的扫描量差异
- [ ] 知道全等值查询的列顺序由其他查询与排序决定，而非一律“区分度高的在前”
- [ ] 能判断 ORDER BY 能否利用索引避免排序
- [ ] 知道跳跃扫描的条件与局限
- [ ] 能说出前缀索引的三个限制，以及索引合并适合 OR、不适合替代联合索引
