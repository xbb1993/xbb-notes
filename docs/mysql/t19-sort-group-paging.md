# 专题 19 · 排序、分组与分页

> 级别 ☆ · 主线 A · 实测版本：沙箱 MySQL 8.0.46

本专题回答：排序和分组什么时候能靠索引的有序性完成，什么时候需要 filesort 或临时表？深分页为什么越翻越慢，怎么解决？

**贯穿场景**：订单列表页——“用户 777 的订单，按下单时间倒序，每页 10 条”。`t_case` 中用户 777 有 50013 行，已有索引 `idx_user(user_id)`、`idx_u_s_c(user_id, status, created_at)`。

**类比**：索引像一本按“用户 → 状态 → 时间”排好的电话簿。顺着读拿到的就是有序结果；电话簿顺序与你要的顺序对不上时，只能把需要的页全抄下来自己重排——这就是 filesort。

## 一、ORDER BY 的两条路

### 1.1 什么时候“顺着读”就够

`idx_u_s_c` 叶子层的排列（专题 9、11）：

```
(777, 0, 01-02) (777, 0, 03-15) ... (777, 0, 12-30)   ← status=0 段内按时间有序
(777, 1, 01-05) (777, 1, 02-11) ... (777, 1, 12-28)   ← status=1 段内按时间有序
(777, 2, ...)
```

**只有前面的列都固定为单个值，后面的列才有序。** 只固定 `user_id=777` 时，`created_at` 按 status 分段、段内有序，整体不有序。

### 1.2 实验：五种写法

沙箱真实输出（都含 `WHERE user_id=777` 和 `LIMIT 10`，耗时取两次中较好值）：

| # | 写法 | key / Extra | 检查行数 | 耗时 |
| --- | --- | --- | --- | --- |
| ① | `AND status=1 ORDER BY created_at DESC` | idx_u_s_c / Backward index scan | 10 | 0.47 ms |
| ② | `ORDER BY created_at DESC` | idx_user / Using filesort | 50023 | 37.5 ms |
| ③ | `AND status IN (1,2) ORDER BY created_at DESC` | idx_user / Using where; Using filesort | 50023 | 37.8 ms |
| ④ | `ORDER BY status, created_at` | idx_u_s_c / （无） | 10 | 0.38 ms |
| ⑤ | `ORDER BY status ASC, created_at DESC` | idx_user / Using filesort | 50023 | 36.6 ms |

检查行数 50023 = 用户的 50013 行 + 排序后读出的 10 行（据数字推断）。

- ①：前两列等值，第三列有序；`Backward index scan`（反向索引扫描）沿叶子链表从后往前读，对应 DESC，读够 10 行即停。
- ②：跳过中间列 status，整体不有序，只能取出 5 万行再排序。
- ③：IN 两个值 = 两段各自有序，拼起来仍不有序。
- ④：排序列顺序与索引列一致。
- ⑤：方向混合（一升一降），正向、反向读都不满足。

::: danger 错误理解 vs 正确理解
- ❌ 排序列在索引里，就不会 filesort。
- ✅ 需同时满足：① 排序列之前的索引列均为等值条件；② 排序列顺序与索引列顺序一致；③ 各列方向全部相同，或与索引定义的方向模式一致。ORDER BY 中出现表达式（如 `ORDER BY -id`）、跨两个索引、使用前缀索引都无法利用索引顺序（8.0 手册）。
:::

### 1.3 修复

| 问题 | 做法 | 修复后 |
| --- | --- | --- |
| ② 跳过中间列 | 新建 `idx_u_c(user_id, created_at)` | 检查 10 行，0.40 ms |
| ⑤ 方向混合 | 降序索引 `(user_id, status, created_at DESC)` | 检查 10 行，0.32 ms |
| ③ IN 多值 | 改写为 UNION ALL，每个 status 各取前 10 行，合并后排序取前 10 | 检查 30 行，0.64 ms |

```sql
SELECT * FROM (
  (SELECT * FROM t_case WHERE user_id=777 AND status=1 ORDER BY created_at DESC LIMIT 10)
  UNION ALL
  (SELECT * FROM t_case WHERE user_id=777 AND status=2 ORDER BY created_at DESC LIMIT 10)
) x ORDER BY created_at DESC LIMIT 10;      -- 最后只对 20 行 filesort
```

- 降序索引 8.0 起真正支持；5.7 解析 `DESC` 但忽略，建出的仍是升序索引。
- 局限：每多一个索引，写入与空间成本增加（专题 12）；UNION ALL 只适合 IN 值很少的情况。

## 二、filesort 内部

需要排序时，MySQL 在 **sort buffer**（每个排序操作单独分配，上限 `sort_buffer_size`，沙箱实测默认 262144 字节 = 256 KB）中排序；放不下时，切成多段分别排序写入临时文件，再多路归并。

`SELECT id, remark FROM t_order ORDER BY remark`（100 万行，无 LIMIT）的 trace 与状态变量：

| | 256 KB | 64 MB |
| --- | --- | --- |
| `num_initial_chunks_spilled_to_disk`（写到磁盘的初始分段数） | 283 | 0 |
| `Sort_merge_passes`（归并轮数） | 47 | 0 |
| 耗时 | 1491 ms | 636 ms |
| `sort_mode` | `<varlen_sort_key, packed_additional_fields>` | 同左 |

`sort_mode` 表示 sort buffer 元组的内容：

- `additional_fields`：排序键 + 查询需要的列，排完直接输出，不回表；`packed` 表示变长列紧凑存放。
- `rowid`：排序键 + 行 ID，排完再按行 ID 回表。
- `max_length_for_sort_data` 原本影响模式选择，**8.0.20 起弃用且不再起作用**（8.0 手册）。

**带 LIMIT 的优先队列**：`ORDER BY remark LIMIT 5` 的 trace 出现 `filesort_priority_queue_optimization: chosen: true`，`peak_memory_used` 仅 31632 字节——用一个容纳 5 行的堆边扫边淘汰，不做全量排序。但**仍要扫描全部 100 万行**。

::: warning 易错点
- “filesort”是历史名称，内存够时完全在内存中完成。EXPLAIN 不显示是否落盘，要看 trace 或 `Sort_merge_passes`。
- `sort_buffer_size` 按排序操作分配，全局调大在高并发下内存成倍增长；需要时用 `SET_VAR` 只对单条语句调大（专题 17）。
:::

## 三、GROUP BY 与 DISTINCT

| 方式 | 条件 | 沙箱实例 |
| --- | --- | --- |
| 按索引顺序分组 | 分组列是索引最左列（或前面列均等值） | `GROUP BY user_id`：type=index，Using index，无临时表 |
| 内部临时表 | 无可用索引 | `GROUP BY status`：Using temporary |

**内部临时表**：执行时 MySQL 自建、用户不可见的表，按分组键累计结果。

| 参数 | 值 | 说明 |
| --- | --- | --- |
| `internal_tmp_mem_storage_engine` | TempTable（默认） | 内存临时表引擎 |
| `tmp_table_size` | 16 MB（默认） | 单张内存临时表上限，超过转为磁盘 InnoDB 表 |
| `temptable_max_ram` | 8.0.46 实测 1 GB；8.4 为物理内存 3%，最小 1 GB、最大 4 GB（8.4 手册） | TempTable 全局内存上限 |

实测按 `order_no` 分组（100 万组）：

```
tmp_table_size = 16MB   → Created_tmp_disk_tables = 2，耗时 5377 ms
tmp_table_size = 256MB  → Created_tmp_disk_tables = 0，耗时 1458 ms
```

（外层 `COUNT(*)` 套了一层派生表，派生表也算一张临时表，故计数为 2。）

::: warning 5.7 → 8.0 差异
5.7 中 `GROUP BY` 会隐式排序，8.0 已取消（8.0 手册）。实测 `GROUP BY status` 返回顺序为 3、0、2、1、4。依赖分组结果顺序的老代码升级后可能出错，需要顺序必须显式 `ORDER BY`。
:::

## 四、深分页

### 4.1 越翻越慢

`LIMIT offset, 10` 的语义：**先找出前 offset+10 行，再丢掉前 offset 行**。B+ 树不记录“某行排第几”，无法直接跳到第 90 万行（专题 9）。

| offset（按主键排序） | 检查行数 | 耗时 |
| --- | --- | --- |
| 0 | 10 | 0.13 ms |
| 100000 | 100010 | 17.6 ms |
| 500000 | 500010 | 95.6 ms |
| 900000 | 900010 | 175.2 ms |

耗时随 offset 线性增长——这还是不用回表的最有利情况。

### 4.2 按二级索引排序：四种写法

按 `user_id, id` 排序，取第 50 万行之后的 10 行：

| 写法 | 计划 | 检查行数 | 耗时 |
| --- | --- | --- | --- |
| A. 直接 `LIMIT 500000,10` | ALL + Using filesort | 1500010 | 570 ms |
| B. 延迟关联 | 子查询沿 idx_user 只读索引，外层按主键取 10 行 | 30（未计入子查询内部扫描） | 39 ms |
| C. 游标分页（OR 展开） | range，key_len=12 | 10 | 0.44 ms |
| D. 游标分页（行构造器） | **index**，Using where | 500010 | 790 ms |

```sql
-- B 延迟关联（专题 12）
SELECT o.* FROM t_order o
JOIN (SELECT id FROM t_order ORDER BY user_id, id LIMIT 500000,10) x ON o.id = x.id
ORDER BY o.user_id, o.id;

-- C 游标分页：上一页最后一行为 (user_id=50071, id=149181)
SELECT * FROM t_order
WHERE user_id > 50071 OR (user_id = 50071 AND id > 149181)
ORDER BY user_id, id LIMIT 10;

-- D 语义同 C
SELECT * FROM t_order WHERE (user_id, id) > (50071, 149181) ORDER BY user_id, id LIMIT 10;
```

- A：回表 50 万次比全表扫描加排序更贵（专题 16 交叉点），优化器选了后者。
- B：子查询仍走过 50 万个索引项，但不回表，只有最后 10 行回表，比 A 快约 15 倍。检查行数 30 未计入子查询内部扫描（推断；39 ms 耗时说明确实扫描了大量索引项），不能与 A 直接比较。
- C：key_len=12 = user_id 4 字节 + 主键 id 8 字节（二级索引叶子隐含主键，专题 10）；直接定位游标往后读 10 行，**耗时与页码无关**。
- D：语义与 C 相同，但在 8.0.46 上**未转为范围扫描**，从头扫了 50 万个索引项，比 A 还慢。

::: danger 易错点
游标分页要用 C 的 OR 展开写法，并用 EXPLAIN 确认 type=range。行构造器写法在 8.0.46 实测退化为 index 扫描。
:::

### 4.3 选型

| 维度 | LIMIT offset | 延迟关联 | 游标分页 |
| --- | --- | --- | --- |
| 深页性能 | 线性变差 | 线性变差，常数小得多 | 恒定 |
| 跳到任意页 | 支持 | 支持 | **不支持**，只能上一页 / 下一页 |
| 排序键要求 | 无 | 需覆盖索引 | 必须唯一（不唯一时补主键作第二排序列） |
| 翻页期间数据增删 | 可能重复或漏行 | 同左 | 不会（以上一页最后一行为锚点） |
| 适用 | 后台浅分页 | 必须支持跳页的深分页 | 信息流、下拉加载、数据导出 |

工程常见组合：产品层限制最大页数，导出走游标分页。

::: tip 与 Redis 对照
Redis 的 `SCAN` 同样是游标式遍历：返回游标供下次继续，代价是不能随机跳转——与游标分页是同一种取舍。
:::

## 五、在三条主线中的位置

```
A 性能：SQL → 优化器 → [计划：索引顺序 / filesort / 临时表] → 索引 → 页 → …
B 一致性：不涉及
C 诊断：慢日志 Sort_* / Created_tmp_* 计数（专题 18）→ EXPLAIN 的 Using filesort / Using temporary → 本专题
```

## 六、排查要点

| 现象 | 先查什么 | 可能原因 / 对策 |
| --- | --- | --- |
| 列表页 `LIMIT 10` 也很慢 | EXPLAIN 是否 Using filesort；检查行数 | 索引顺序被打断（跳列、IN、方向混合），补索引或改写 |
| 排序很慢、磁盘 I/O 高 | `Sort_merge_passes`、trace 的 `num_initial_chunks_spilled_to_disk` | sort buffer 不够，单条语句 `SET_VAR` 调大或减少排序行数 |
| 分组很慢 | `Using temporary`、`Created_tmp_disk_tables` | 无索引可用；临时表超过 `tmp_table_size` 落盘 |
| 升级 8.0 后分组结果顺序变了 | 是否依赖 GROUP BY 隐式排序 | 8.0 取消隐式排序，补 `ORDER BY` |
| 越往后翻越慢 | offset 大小与检查行数 | 延迟关联或游标分页；限制最大页数 |
| 游标分页仍然慢 | EXPLAIN type | 行构造器写法退化为 index，改用 OR 展开 |

::: tip PG 对照
PostgreSQL 的排序内存参数是 `work_mem`（默认 4 MB），`EXPLAIN ANALYZE` 直接显示 `Sort Method: quicksort Memory` 或 `external merge Disk`，比 MySQL 更直观；PG 的行构造器比较 `(a, b) > (x, y)` 可以用上 B 树索引做范围扫描，这是游标分页在 PG 中的常用写法。
:::

## 七、本地复现（Docker mysql:8.4）

```sql
USE lab;
-- 一、五种写法
EXPLAIN SELECT * FROM t_case WHERE user_id=777 AND status=1 ORDER BY created_at DESC LIMIT 10;
EXPLAIN SELECT * FROM t_case WHERE user_id=777 ORDER BY created_at DESC LIMIT 10;
EXPLAIN SELECT * FROM t_case WHERE user_id=777 AND status IN (1,2) ORDER BY created_at DESC LIMIT 10;
EXPLAIN SELECT * FROM t_case WHERE user_id=777 ORDER BY status ASC, created_at DESC LIMIT 10;
ALTER TABLE t_case ADD INDEX idx_u_c (user_id, created_at),
                   ADD INDEX idx_u_s_cd (user_id, status, created_at DESC);
-- 重新 EXPLAIN 第 2、4 条；实验后 DROP 这两个索引

-- 二、filesort 落盘
SET optimizer_trace='enabled=on'; SET optimizer_trace_max_mem_size=10000000;
SELECT id, remark FROM t_order ORDER BY remark;
SELECT trace FROM information_schema.optimizer_trace\G     -- 找 filesort_summary
SHOW SESSION STATUS LIKE 'Sort_merge_passes';

-- 三、临时表落盘
SET tmp_table_size = 16777216;
SELECT COUNT(*) FROM (SELECT order_no, COUNT(*) c FROM t_order GROUP BY order_no) x;
SHOW SESSION STATUS LIKE 'Created_tmp%';

-- 四、深分页
SELECT * FROM t_order ORDER BY id LIMIT 900000,10;
SELECT user_id, id FROM t_order ORDER BY user_id, id LIMIT 499999,1;   -- 得到游标 a, b
EXPLAIN SELECT * FROM t_order WHERE user_id > a OR (user_id = a AND id > b) ORDER BY user_id, id LIMIT 10;
EXPLAIN SELECT * FROM t_order WHERE (user_id, id) > (a, b) ORDER BY user_id, id LIMIT 10;
```

**预期现象**：一中 ②⑤ 及 IN 写法出现 Using filesort，加索引后消失；二中 256 KB 时 `Sort_merge_passes` > 0；三中 16 MB 时 `Created_tmp_disk_tables` > 0；四中 OR 写法为 range，行构造器写法在 8.4 上是否同样退化以本地实测为准（只在 8.0.46 验证过）。

## 八、与其他专题的关联

- **专题 9 / 11**：叶子层有序与最左前缀决定能否利用索引顺序。
- **专题 10**：二级索引叶子隐含主键，游标分页可用 (user_id, id)。
- **专题 12**：延迟关联、覆盖索引。
- **专题 16**：深分页时优化器在回表与全表扫描之间的选择。
- **专题 17**：`SET_VAR` 调整单条语句的 sort buffer。
- **专题 18**：慢日志中的排序与临时表计数。

## 九、复习 checklist

- [ ] 能说出 ORDER BY 利用索引顺序的三个条件，并举出跳列、IN、方向混合三种打断方式
- [ ] 知道降序索引 8.0 起真正支持，能用它解决方向混合的排序
- [ ] 能解释 sort buffer 落盘、`Sort_merge_passes`、`sort_mode` 的含义
- [ ] 知道 LIMIT 优先队列只省排序、不省扫描
- [ ] 知道 GROUP BY 用索引 vs 临时表的条件，以及 `tmp_table_size` 的作用
- [ ] 知道 8.0 取消了 GROUP BY 隐式排序
- [ ] 能解释深分页线性变慢的原因，对比延迟关联与游标分页的取舍
- [ ] 知道游标分页要用 OR 展开写法并用 EXPLAIN 确认 range
