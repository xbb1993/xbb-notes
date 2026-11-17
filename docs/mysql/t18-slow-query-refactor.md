# 专题 18 · 慢查询基础与查询重构

> 级别 ☆ · 主线 A / C · 实测版本：沙箱 MySQL 8.0.46

本专题回答：怎么**发现**慢 SQL？慢日志里的每个字段说明什么？哪些问题可以靠**换一种写法**解决？

类比：慢查询日志是高速公路测速摄像头，只拍超速的车（单条慢），拍不到“每辆都不超速、但车流量大到堵死”的情况（单条快、频率高）——这是慢日志最大的盲区。

## 一、什么时候会被记录

记录发生在**语句执行结束之后**：还在执行的慢 SQL 不会出现在日志里，要用 `SHOW PROCESSLIST` 查看。

依次满足以下条件才会记录（8.0 手册）：

```
① 不是管理语句（ALTER / OPTIMIZE 等），除非开启 log_slow_admin_statements
② 执行时间 ≥ long_query_time
   或：未使用索引，且开启了 log_queries_not_using_indexes
③ 检查行数 ≥ min_examined_row_limit
④ 未被 log_throttle_queries_not_using_indexes 限流（只针对 ② 中“未使用索引”一类）
```

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `slow_query_log` | OFF | 总开关 |
| `long_query_time` | 10（秒） | 最小 0，精度到微秒；**执行时间不含获取初始锁的时间** |
| `log_output` | FILE | 也可为 TABLE（写入 `mysql.slow_log`） |
| `log_slow_extra` | OFF | 8.0.14 引入；开启后额外记录 Handler、排序、临时表等计数，**只对 FILE 输出生效** |
| `min_examined_row_limit` | 0 | 检查行数低于该值不记录 |
| `log_slow_replica_statements` | OFF | 副本记录复制来的慢语句；**只对 STATEMENT 格式的 binlog 有效** |

::: warning 易错点
- 默认 10 秒对 OLTP 系统等于没开，生产常设 0.1～1 秒。
- `SET GLOBAL long_query_time` 只对之后新建的连接生效，已有连接仍用旧值。
:::

## 二、读懂一条慢日志

沙箱真实记录（开启 `log_slow_extra`，只保留关键字段）：

```
# Query_time: 0.330478  Lock_time: ...  Rows_sent: ...  Rows_examined: 1000005
#   Read_rnd_next: 1000001  Sort_rows: 5  Sort_scan_count: 1
SELECT * FROM t_order ORDER BY remark DESC LIMIT 5;
```

| 字段 | 含义 | 本例说明 |
| --- | --- | --- |
| `Query_time` | 执行耗时（秒） | 0.33 秒 |
| `Lock_time` | 等锁耗时 | 区分“慢在执行”还是“慢在等锁” |
| `Rows_examined` | 存储引擎交给 Server 层检查的行数 | 约 100 万行，只为返回 5 行 |
| `Read_rnd_next` | 按物理顺序读下一行的次数（专题 15 的 Handler 计数） | 约 100 万次 → 全表扫描 |
| `Sort_rows` / `Sort_scan_count` | 排序行数 / 通过全表扫描完成的排序次数 | `remark` 无索引，扫全表后排序（专题 19） |

**核心读法：比较 `Rows_examined` 与 `Rows_sent`**。差几个数量级，说明大量行被扫描后丢弃，是加索引或改写的信号。

另外两条真实记录，用 Handler 计数判断访问方式：

| 语句 | Query_time | 关键计数 | 解读 |
| --- | --- | --- | --- |
| `GROUP BY status ... ORDER BY` | 2.39 s | Read_key 859844，Read_rnd_next 1000007，Created_tmp_tables 1 | 全表扫描 + 内部临时表分组（Read_key 多，推断为临时表上的按键查找） |
| `user_id IN (123, 777)` | 2.88 s | Rows_examined 50026，Read_key 30，Read_next 50057 | 走了索引范围扫描，但大用户 777 有 5 万行，回表代价高 |

::: danger 错误理解 vs 正确理解
- ❌ 走了索引就不会进慢日志。
- ✅ 走索引但命中行多、回表多，照样慢。慢日志只给结果，原因要用 EXPLAIN 分析。
:::

## 三、汇总：mysqldumpslow

单条记录没有统计意义，需要归并同类语句。`mysqldumpslow`（MySQL 自带）把数字替换为 `N`、字符串替换为 `'S'`，归并成同一“指纹”。沙箱真实输出（`-s t` 按总耗时排序）：

```
Count: 3  Time=1.06s (3s)  Lock=0.00s (0s)  Rows=1.0 (3), root[root]@localhost
  SELECT SUM(amount) FROM t_case WHERE user_id IN (N, N)
Count: 3  Time=0.93s (2s)  ...
  SELECT status, COUNT(*) FROM t_order WHERE created_at >= 'S' GROUP BY status ORDER BY N DESC
Count: 1  Time=1.74s (1s)  ...
  SELECT COUNT(*) FROM t_user u JOIN t_order o ON o.user_id = u.id WHERE o.amount > N AND u.city = 'S'
```

`Time=平均 (总和)`。**优化优先级看总和**：平均 50 ms、每天一百万次的 SQL，总耗时远高于每天一次的 10 秒报表。

| 工具 | 定位 |
| --- | --- |
| `mysqldumpslow` | 自带，统计维度少 |
| `pt-query-digest`（Percona Toolkit） | 常用，输出耗时分布、占比、样例语句 |
| `performance_schema.events_statements_summary_by_digest` | 按指纹统计**所有语句**，不受 `long_query_time` 限制，补上“单条快、总量大”的盲区（专题 22 细讲） |

## 四、查询重构

思路：**结果不变，只改语句形状**，让 MySQL 少扫描、少持锁、少占资源。

| 类别 | 做法 | 解决的问题 |
| --- | --- | --- |
| ① 减少扫描 | 只取需要的列和行；覆盖索引、延迟关联（专题 12） | Rows_examined 远大于 Rows_sent |
| ② 拆分大语句 | 大批量 DELETE / UPDATE 拆成小批次 | 长时间持锁、大事务、复制延迟 |
| ③ 分解关联 | 复杂多表 join 改为多条单表查询，应用层拼接 | join 顺序难控制；可利用应用缓存；便于将来分库 |

### 实验：一次删 50 万行 vs 每批 1 万行分 50 批

在 `t_order` 副本 `t_del`（100 万行）上删除 `id <= 500000`。删除开始 1 秒后，另一会话执行 `UPDATE t_del SET amount = amount WHERE id = 100` 模拟业务写入。真实输出：

```
single total=2.98s  concurrent UPDATE(id=100) waited=1.98s  max trx_rows_locked=477833
batch  total=5.08s  concurrent UPDATE(id=100) waited=0.01s  max trx_rows_locked=10046
```

```
单条大 DELETE（一个事务）
0s ─────────────── 1s ──────────────────── 2.98s 提交
   [持有的行锁越来越多，最多约 48 万行]
                    ↑ 业务 UPDATE(id=100) 到达
                    └──── 等待 1.98s，直到大事务提交 ────┘

分批 DELETE（每批一个自动提交事务）
   [1万][1万][1万]...  每批提交后立即释放锁
                    ↑ 业务 UPDATE 到达，id=100 所在批次早已提交，几乎不等
```

| 维度 | 单条 | 分批 | 说明 |
| --- | --- | --- | --- |
| 总耗时 | 2.98 s | 5.08 s | 分批更慢。推断原因：`innodb_flush_log_at_trx_commit=1`，50 次提交即 50 次 redo 刷盘，且每批要重新定位起点 |
| 并发写入等待 | 1.98 s | 0.01 s | 分批的真正收益 |
| 同时持有的最多行锁 | 477833 | 10046 | 约降低 47 倍 |

::: danger 错误理解 vs 正确理解
- ❌ 分批是为了删得更快。
- ✅ 分批往往总耗时更长，换来的是**对其他会话影响更小**。未实测但由机制决定的收益：小事务 undo 少，回滚代价可控；binlog 在提交时整体写入、副本按事务回放，大事务会让副本整体落后（模块八讲复制）。
:::

分批写法要点：

- 按主键范围切分（`id > lo AND id <= hi`），每批是聚簇索引上的范围扫描。避免反复执行 `DELETE ... LIMIT 10000`：WHERE 条件不走索引时，每批都从头扫描，越往后跳过的行越多。
- 批次间可 sleep，摊开复制延迟与 I/O 压力。
- 局限：整体不再原子，中途失败会留下“删了一半”的状态，脚本必须可重入（重复执行结果相同）。

## 五、在三条主线中的位置

```
C 诊断：[问题 → 现象：慢日志 / 汇总工具发现慢 SQL] → EXPLAIN（专题 15）→ … → 优化（含查询重构）→ 验证
A 性能：重构改变语句形状，减少扫描行数与回表
B 一致性：拆分大事务影响锁持有时间、undo 与复制（模块五、八）
```

## 六、排查要点

| 现象 | 先查什么 | 可能原因 / 对策 |
| --- | --- | --- |
| 明明有慢 SQL，慢日志却是空的 | `slow_query_log`、`long_query_time`、`min_examined_row_limit` | 未开启；阈值 10 秒太大；修改后未重建连接 |
| 慢日志里看不到正在卡住的 SQL | `SHOW PROCESSLIST` | 语句执行结束后才记录 |
| `Rows_examined` 远大于 `Rows_sent` | EXPLAIN | 缺索引、索引无法过滤或排序需要扫描全表 |
| `Query_time` 大但 EXPLAIN 看起来正常 | `Lock_time`、锁等待视图 | 等锁或资源争用，不是计划问题（模块五） |
| 单条都不慢，数据库却很忙 | `events_statements_summary_by_digest` | 高频小查询总量大，慢日志的盲区 |
| 大批量删除 / 更新期间业务写入卡住 | `information_schema.innodb_trx` 的 `trx_rows_locked` | 大事务持锁，拆为按主键范围的小批次 |

::: tip PG 对照
PostgreSQL 用 `log_min_duration_statement` 记录慢语句（默认 -1 关闭），`auto_explain` 扩展可自动记录慢语句的执行计划；按指纹统计用 `pg_stat_statements`，对应 MySQL 的 `events_statements_summary_by_digest`。
:::

## 七、本地复现（Docker mysql:8.4）

```sql
SET GLOBAL slow_query_log = ON;
SET GLOBAL long_query_time = 0.1;      -- 只对之后新建的连接生效
SET GLOBAL log_slow_extra = ON;
SELECT @@slow_query_log_file;
-- 新开连接后执行：
SELECT * FROM lab.t_order ORDER BY remark DESC LIMIT 5;
```

```bash
docker exec -it 容器名 tail -n 20 /var/lib/mysql/主机名-slow.log
docker exec -it 容器名 mysqldumpslow -s t /var/lib/mysql/主机名-slow.log
```

分批删除：`CREATE TABLE t_del LIKE t_order; INSERT INTO t_del SELECT * FROM t_order;`

- 会话 A：`DELETE FROM t_del WHERE id <= 500000;`
- 会话 B：A 执行期间执行 `UPDATE t_del SET amount = amount WHERE id = 100;` 并计时
- 重建 `t_del`，会话 A 改为循环按 1 万行一批删除，重复上述步骤

**预期现象**：单条删除时 B 等到 A 提交才返回；分批时 B 几乎不等，但 A 总耗时更长。

## 八、与其他专题的关联

- **专题 12**：覆盖索引、延迟关联——减少扫描类重构。
- **专题 15**：慢日志的 Handler 计数与 EXPLAIN ANALYZE 互相印证。
- **专题 17**：`MAX_EXECUTION_TIME` 给慢查询设上限。
- **专题 19**：慢日志中的 `Sort_*`、`Created_tmp_tables` 来源。
- **专题 22**：慢 SQL 定位完整流程，`events_statements_summary_by_digest`。
- **模块五 / 八**：大事务对锁、undo、复制的影响。

## 九、复习 checklist

- [ ] 能说出语句进入慢日志的四个条件，以及 `long_query_time` 默认值与“不含初始锁时间”
- [ ] 知道慢日志在执行结束后才写，正在执行的要看 PROCESSLIST
- [ ] 会读 `Query_time / Lock_time / Rows_sent / Rows_examined` 和 `log_slow_extra` 的 Handler 计数
- [ ] 会用 mysqldumpslow 汇总，并按总耗时而非单次耗时排优先级
- [ ] 知道慢日志的盲区及 `events_statements_summary_by_digest` 的作用
- [ ] 能说出查询重构的三类做法
- [ ] 能解释分批删除“总耗时更长但影响更小”，以及按主键范围切分和可重入的要求
