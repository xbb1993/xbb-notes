# 专题 36–38 · Online DDL 与元数据锁、分区表、其他对象与自增 ID（合并）

> 级别：36 ★ / 37 ☆ / 38 ○ · 主线 B / C（衔接 A）· 实测版本：沙箱 MySQL 8.0.46

本篇回答：不停服务地改表结构有哪几种算法，各自代价多大？为什么"在线"的 DDL 也能把整张表堵死？gh-ost / pt-osc 的原理是什么？分区表什么时候有用？自增 ID 为什么不连续、用尽了会怎样？

## 在三条主线中的位置

```
B 一致性：改表期间读写能否继续？MDL（专题 25）在什么时候介入？
C 诊断：DDL 卡住时的 "Waiting for table metadata lock"；DDL 期间业务写入的延迟
A 性能：分区裁剪；用删除分区代替大批量 DELETE
```

## 一、Online DDL（专题 36）

### 1.1 问题：改表结构为什么难

给一张 100 万行的表加一列，最直接的做法：

```
① 按新结构建一张空表
② 把旧表数据逐行复制过去
③ 删除旧表，新表改名为旧表名
复制期间若允许写旧表，新写入的行会在 ② 中漏掉 → 只好复制期间禁止写入
```

这就是 **COPY** 算法：表越大、复制越久，禁止写入的时间就越长。之后演进出两种改进：

| 算法 | 思路 | 是否重建表 | 执行期间能否写入 |
| --- | --- | --- | --- |
| **COPY** | 建新表，逐行复制 | 是 | **不能** |
| **INPLACE** | 在 InnoDB 内部完成（如直接构建新索引）；期间的写入先记入"在线变更日志"，结束前补到新结构上 | 视操作而定 | 大多数可以 |
| **INSTANT** | 只改数据字典里的表定义，不碰已有数据行 | 否 | 可以，几乎瞬间完成 |

**INSTANT 加列的原理**：已有行不改，给表定义增加一个"行版本"；读到旧行时按它所属的版本把新列补成默认值。8.4 手册：INSTANT 是加列、删列的默认算法，可在任意位置加列；行版本数上限 64（9.1.0 起 255），记录在 `INFORMATION_SCHEMA.INNODB_TABLES.TOTAL_ROW_VERSIONS`。用满后再做 INSTANT 加/删列报 ERROR 4092，需用 COPY 或 INPLACE 重建一次表，计数归零。

### 1.2 实验：同一张 100 万行表，不同操作与算法（真实输出）

```
ADD COLUMN c1, ALGORITHM=INSTANT               → 0 rows affected，0.13s   TOTAL_ROW_VERSIONS = 1
ADD COLUMN c2 AFTER user_id, ALGORITHM=INSTANT → 0 rows affected，0.19s   TOTAL_ROW_VERSIONS = 2（中间位置也可以）
ADD COLUMN c3, ALGORITHM=INPLACE               → 0 rows affected，3.91s   TOTAL_ROW_VERSIONS = 0（重建了表，计数归零）
ADD COLUMN c4, ALGORITHM=COPY                  → 1000000 rows affected，6.59s   ← 逐行复制
ADD COLUMN c5（不指定算法）                     → 0.10s                    ← 默认 INSTANT

ADD INDEX, ALGORITHM=INSTANT                   → ERROR 1845: ALGORITHM=INSTANT is not supported for this operation
ADD INDEX, ALGORITHM=INPLACE, LOCK=NONE        → 1.58s
MODIFY user_id INT → BIGINT, ALGORITHM=INPLACE → ERROR 1846: Cannot change column type INPLACE. Try ALGORITHM=COPY.
MODIFY order_no VARCHAR(32) → VARCHAR(40), INPLACE → 0.00s
MODIFY order_no VARCHAR(40) → VARCHAR(80), INPLACE → ERROR 1846
DROP COLUMN c1, ALGORITHM=INSTANT              → 0.02s
```

**为什么 VARCHAR 扩到 40 可以原地、扩到 80 不行**（专题 34 长度前缀规则，utf8mb4 每字符最多 4 字节）：

```
VARCHAR(40) 最大 160 字节 ≤ 255 → 长度前缀 1 字节
VARCHAR(80) 最大 320 字节 > 255 → 长度前缀 2 字节
前缀字节数变了 → 每行存储格式都变 → 只能重建
```

> **建议**：DDL 显式写 `ALGORITHM=...` 与 `LOCK=...`。不支持时直接报错（上面的 1845 / 1846），而不是悄悄退化成锁表的 COPY。

常见操作支持情况（8.4 手册 Online DDL Operations）：

| 操作 | INSTANT | INPLACE | 重建表 | 允许并发 DML |
| --- | --- | --- | --- | --- |
| 加列 | 是（默认） | 是 | INSTANT 不重建 | 是（加自增列除外） |
| 删列 | 是（默认） | 是 | INPLACE 会重建 | 是 |
| 重命名列 | 是 | 是 | 否 | 是 |
| **修改列数据类型** | 否 | **否** | 是 | **否** |
| 扩大 VARCHAR 长度 | 否 | 是（前缀字节数不变时） | 否 | 是 |
| 创建二级索引 | 否 | 是 | 否 | 是 |
| 删除索引 | 否 | 是 | 否 | 是 |
| 增加主键 | 否 | 是（有条件） | 是 | 是 |

### 1.3 实验：DDL 期间业务写入受多大影响（真实输出）

一个线程持续执行单行 UPDATE，另一个线程执行 DDL：

| DDL | DDL 耗时 | 期间完成 UPDATE 次数 | UPDATE 最大延迟 | UPDATE p99 |
| --- | --- | --- | --- | --- |
| `ADD INDEX ... ALGORITHM=INPLACE, LOCK=NONE` | 3.01 s | 2210 | 164 ms | 9.5 ms |
| `MODIFY user_id BIGINT ... ALGORITHM=COPY` | 14.07 s | 789 | **14067 ms** | 6.3 ms |
| `ADD COLUMN ... ALGORITHM=INSTANT` | 0.16 s | 769 | 160 ms | 8.1 ms |

COPY 期间有一条 UPDATE 等满了整个复制过程（14 秒）；INPLACE、INSTANT 期间写入基本不受影响。

### 1.4 关键：Online ≠ 不加锁 —— 与 MDL 的关系

INPLACE 和 INSTANT 在**开始和结束**时仍需短暂获取该表的**排他 MDL**（专题 25），用来切换表定义：

```
INPLACE：[开始：短暂排他 MDL] → [主阶段：降为 SHARED_UPGRADABLE，允许读写] → [结束：短暂排他 MDL]
INSTANT：[短暂排他 MDL：改数据字典]
```

"短暂"的前提是**能立刻拿到锁**。专题 25 事故实验中被卡住的 `ALTER TABLE t_acct ADD COLUMN note ...` 在 8.0.46 上默认就是 INSTANT：它因一个未提交事务排队，又挡住了后面所有 SELECT / UPDATE。

> **错误理解 vs 正确理解**
>
> - ❌ INSTANT / INPLACE 是在线的，随时执行都没问题。
> - ✅ 它们缩短的是"持有排他锁的时间"，**拿锁前的排队**照样发生。执行前三件事：
>   1. 查 `information_schema.innodb_trx`，确认没有长事务；
>   2. 设置较短的 `lock_wait_timeout`，拿不到就放弃并重试；
>   3. 业务低峰执行。

另外两点：

- INPLACE 期间的并发写入记在在线变更日志，上限 `innodb_online_alter_log_max_size`，超出则 DDL 失败。
- 有复制时，DDL 在从库上重放一遍；从库执行长 DDL 期间后续复制被拖住，产生主从延迟（专题 40）。

### 1.5 大表变更工具：影子表

必须 COPY 的操作（如改列类型）或对锁极其敏感时，用外部工具。共同思路：**不在原表做 DDL，建影子表，边复制边同步增量，最后切换。**

```
① 按新结构建影子表 _t_new
② 分批复制原表数据（每批一小段主键范围，可限速）
③ 复制期间同步原表的新写入：
     pt-online-schema-change：原表建触发器，写原表时同时写影子表
     gh-ost：不用触发器，读 binlog（要求 ROW 格式，专题 32），把行变化应用到影子表
④ 追平后短暂加锁，RENAME TABLE 原子交换表名
```

| | 原生 Online DDL | pt-online-schema-change | gh-ost |
| --- | --- | --- | --- |
| 增量同步方式 | InnoDB 在线变更日志 | 触发器 | 解析 binlog |
| 对原表写入的额外开销 | 小 | 每次写入多执行一次触发器 | 小（异步） |
| 能否暂停、限速 | 不能 | 能 | 能（可按从库延迟自动限速） |
| 切换时是否需要 MDL | 需要 | 需要（RENAME） | 需要 |

工具同样逃不开最后切换时的 MDL，1.4 的三项检查仍然适用。

## 二、分区表（专题 37）

**分区**：按规则把一张表的数据拆到多个物理分区，对 SQL 仍是一张表。常用规则：`RANGE`（范围，常用于时间）、`LIST`（枚举）、`HASH` / `KEY`（哈希打散）。

实验（真实输出），按年份 RANGE 分区：

```
CREATE TABLE t_part (id BIGINT, created_at DATETIME, amount DECIMAL(10,2), PRIMARY KEY (id, created_at))
PARTITION BY RANGE (YEAR(created_at)) (p2025 < 2026, p2026 < 2027, pmax);
各分区行数（统计值）：p2025 = 140182，p2026 = 859818，pmax = 0

WHERE created_at >= '2026-03-01' AND created_at < '2026-04-01'  → partitions: p2026              ← 分区裁剪
WHERE DATE_FORMAT(created_at,'%Y') = '2026'                     → partitions: p2025,p2026,pmax   ← 列上套函数，无法裁剪
WHERE id = 500000                                               → partitions: p2025,p2026,pmax   ← 无分区键，每个分区都查

主键不含分区列：
  ERROR 1503: A PRIMARY KEY must include all columns in the table's partitioning function

删除 2025 年的 14 万行：
  DELETE ... WHERE created_at < '2026-01-01'  → 0.48s
  ALTER TABLE t_part DROP PARTITION p2025      → 0.08s
```

| 适合 | 不适合 / 需注意 |
| --- | --- |
| 按时间归档、定期删旧数据（`DROP PARTITION` 快，不产生逐行 undo 与 binlog） | 查询不带分区键时每个分区都查一遍，反而更慢 |
| 查询绝大多数带时间范围 | 主键、唯一键必须包含分区列，唯一性只在含分区列的组合上保证 |
| — | **分区 ≠ 分库**：所有分区在同一实例上，共享 CPU、内存、磁盘，解决不了单机容量（模块九） |

## 三、其他对象与自增 ID（专题 38）

| 对象 | 要点 | 工程常见做法 |
| --- | --- | --- |
| **视图** | 保存的查询，使用时展开执行；MySQL **没有**物化视图 | 用于权限隔离、简化查询；需要预计算结果时自建汇总表（专题 35） |
| **存储过程 / 函数** | 业务逻辑在数据库执行 | 难调试、难版本管理、难横向扩展，互联网业务少用 |
| **触发器** | 同一事务内自动执行，逻辑隐藏 | 少用；pt-osc 正是靠它做增量同步 |
| **事件** | 数据库内置定时任务 | 改用外部调度系统，便于统一监控 |
| **外键** | 自动保证引用完整性；检查时对父表记录加共享锁（专题 25） | 高并发系统常在应用层保证，不建外键，避免额外锁与级联；代价是数据库不再兜底 |
| **临时表** | `CREATE TEMPORARY TABLE` 仅当前连接可见，断开自动删除；与执行计划里的"内部临时表"（专题 19）不是一回事 | 复杂计算的中间结果 |

### 自增 ID

**锁模式**：`innodb_autoinc_lock_mode` 沙箱实测为 2（交错模式）。并发插入不必持有表级自增锁到语句结束，批量插入时 ID 可能在会话间交错；要求 binlog 为 ROW 格式（8.0 默认）才能保证从库 ID 一致。

**ID 不连续是正常的**（真实输出）：

```
插入 1、2；BEGIN; 插入一行; ROLLBACK; 再插入一行
→ id 为 1、2、4         ← 回滚的那行占掉了 3，不会退回
删除 id = 4 后，下一个自增值仍是 5
```

自增值只增不减。8.0 起持久化（写入 redo），重启不回退；5.7 重启后按"当前最大 id + 1"重算，可能复用已删除行的 ID。

**用尽时**（真实输出）：

```
id INT AUTO_INCREMENT，起始 2147483646
插入 → 2147483646；插入 → 2147483647（INT 最大值）
再插入 → ERROR 1062: Duplicate entry '2147483647' for key 't_ai.PRIMARY'
```

到达类型上限后自增值不再增长，下次插入拿到同一个值 → 主键冲突，**表从此无法插入**。预防：主键用 `BIGINT UNSIGNED`（专题 34），监控 `information_schema.TABLES.AUTO_INCREMENT` 距上限的余量。

## 四、串联图

```
要改表结构：
  先查长事务 → 设置短的 lock_wait_timeout → 显式指定 ALGORITHM / LOCK
    ├─ INSTANT（加列、删列、重命名列）：只改数据字典，瞬间完成
    ├─ INPLACE（加索引、前缀不变时扩 VARCHAR）：主阶段允许读写
    └─ COPY（改列类型等）：全程禁止写入 → 改用 gh-ost / pt-osc（影子表 + 增量同步 + RENAME）
  所有方式开始或结束时都需短暂排他 MDL → 一个长事务就能让它排队并挡住整张表

表很大、按时间增长：分区（裁剪、快速删旧数据）；它不是分库
主键：BIGINT UNSIGNED 自增；接受 ID 不连续；监控距上限的余量
```

## 五、诊断实践

| 现象 | 看什么 | 处置 |
| --- | --- | --- |
| DDL 执行后整张表不可用 | `Waiting for table metadata lock`，`sys.schema_table_lock_waits`（专题 25） | KILL 阻塞的长事务或放弃 DDL；以后执行前做 1.4 的三项检查 |
| DDL 期间业务写入全部卡住 | 实际算法是否为 COPY | 显式指定 `ALGORITHM=INPLACE / INSTANT`；做不到的改用工具 |
| INSTANT 加列报 ERROR 4092 | `TOTAL_ROW_VERSIONS` 是否已满 | 低峰期用 INPLACE / COPY 重建一次表 |
| 主库 DDL 后从库延迟飙升 | 从库是否正在执行同一条 DDL | 大表变更用 gh-ost 等工具（专题 40） |
| 插入报主键冲突，冲突值等于类型上限 | `AUTO_INCREMENT` 与列类型 | 主键改 `BIGINT`（属于改列类型，需 COPY 或工具） |
| 分区表查询反而变慢 | EXPLAIN 的 `partitions` 列是否含所有分区 | 查询带分区键，且不在分区键上套函数 |

## 六、本地复现（Docker mysql:8.4）

```sql
USE lab;
CREATE TABLE t_ddl LIKE t_order; INSERT INTO t_ddl SELECT * FROM t_order;

-- 一、三种算法
ALTER TABLE t_ddl ADD COLUMN c1 INT NULL, ALGORITHM=INSTANT;
SELECT NAME, TOTAL_ROW_VERSIONS FROM information_schema.INNODB_TABLES WHERE NAME = 'lab/t_ddl';
ALTER TABLE t_ddl ADD COLUMN c3 INT NULL, ALGORITHM=INPLACE;
ALTER TABLE t_ddl ADD COLUMN c4 INT NULL, ALGORITHM=COPY;
ALTER TABLE t_ddl ADD INDEX idx_amt (amount), ALGORITHM=INSTANT;                        -- ERROR 1845
ALTER TABLE t_ddl MODIFY user_id BIGINT UNSIGNED NOT NULL, ALGORITHM=INPLACE;           -- ERROR 1846
ALTER TABLE t_ddl MODIFY order_no VARCHAR(40) NOT NULL, ALGORITHM=INPLACE, LOCK=NONE;   -- 成功（若原长度 ≤ 63）
ALTER TABLE t_ddl MODIFY order_no VARCHAR(80) NOT NULL, ALGORITHM=INPLACE, LOCK=NONE;   -- ERROR 1846

-- 二、DDL 期间的写入：另一窗口循环执行 UPDATE t_ddl ... WHERE id = ?，
--    分别执行 ADD INDEX ... ALGORITHM=INPLACE, LOCK=NONE 与 MODIFY ... ALGORITHM=COPY，观察 UPDATE 是否卡住

-- 三、MDL：窗口 1：BEGIN; SELECT * FROM t_ddl WHERE id = 1;（不提交）
--    窗口 2：SET SESSION lock_wait_timeout = 3; ALTER TABLE t_ddl ADD COLUMN c9 INT NULL, ALGORITHM=INSTANT;   -- 3 秒后 ERROR 1205

-- 四、分区
CREATE TABLE t_part (id BIGINT NOT NULL, created_at DATETIME NOT NULL, amount DECIMAL(10,2), PRIMARY KEY (id, created_at))
PARTITION BY RANGE (YEAR(created_at)) (PARTITION p2025 VALUES LESS THAN (2026), PARTITION p2026 VALUES LESS THAN (2027), PARTITION pmax VALUES LESS THAN MAXVALUE);
INSERT INTO t_part SELECT id, created_at, amount FROM t_order;
EXPLAIN SELECT SUM(amount) FROM t_part WHERE created_at >= '2026-03-01' AND created_at < '2026-04-01';
EXPLAIN SELECT SUM(amount) FROM t_part WHERE DATE_FORMAT(created_at,'%Y') = '2026';
CREATE TABLE t_part2 (id BIGINT PRIMARY KEY, created_at DATETIME NOT NULL)
PARTITION BY RANGE (YEAR(created_at)) (PARTITION p VALUES LESS THAN MAXVALUE);           -- ERROR 1503

-- 五、自增 ID
CREATE TABLE t_ai (id INT AUTO_INCREMENT PRIMARY KEY, v INT) AUTO_INCREMENT = 2147483646;
INSERT INTO t_ai(v) VALUES (1); INSERT INTO t_ai(v) VALUES (2); INSERT INTO t_ai(v) VALUES (3);  -- 第三条 ERROR 1062
```

**预期现象**：与上文真实输出一致，耗时以本地为准。`VARCHAR(40)` 能否原地扩展取决于原列长度与字符集（判断依据：长度前缀字节数是否变化），本地 `order_no` 定义不同时结果可能不同。

::: tip PG 对照
- PG 11 起加带常量默认值的列只改元数据（≈ INSTANT）；但很多 `ALTER TABLE` 需要 `ACCESS EXCLUSIVE` 锁，排队时同样挡住后续查询，常规做法也是先 `SET lock_timeout`。
- `CREATE INDEX CONCURRENTLY` ≈ INPLACE 在线建索引。
- PG 声明式分区同样要求唯一约束包含分区键。
- 序列（sequence）≈ 自增 ID：不回退、有空洞；`int` 用尽同样报错，同样推荐 `bigint`。
:::

## 七、与其他专题的关联

- **专题 25**：MDL 类型与排队优先级；DDL 卡死事故。
- **专题 32**：binlog ROW 格式（gh-ost、自增锁模式 2 的前提）。
- **专题 34**：VARCHAR 长度前缀；主键用 BIGINT。
- **专题 35**：MySQL 无物化视图，需自建汇总表。
- **专题 40**：从库重放大 DDL 导致复制延迟。
- **模块九**：分区与分库分表的区别。

## 八、复习 checklist

- [ ] 能说出 COPY / INPLACE / INSTANT 的原理、是否重建、是否允许并发 DML，并举出各自典型操作
- [ ] 知道 INSTANT 行版本上限与 ERROR 4092 的处理
- [ ] 能用长度前缀规则解释 VARCHAR 扩容何时可以 INPLACE
- [ ] 知道显式写 ALGORITHM / LOCK 的保护作用
- [ ] 能解释为什么 Online DDL 仍会被长事务通过 MDL 卡住，并说出执行前三项检查
- [ ] 能说出 pt-osc 与 gh-ost 的增量同步方式差异及共同的切换步骤
- [ ] 知道分区裁剪的条件、主键必须含分区列、DROP PARTITION 的优势，以及分区 ≠ 分库
- [ ] 知道自增锁模式 2、ID 不连续的原因、8.0 持久化、用尽时报 1062 及预防方法
