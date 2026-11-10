# 专题 6 · 存储引擎对比与选型

> 级别 ☆（高频重点）· 主线 A · 实测版本：沙箱 MySQL 8.0.46，数据为专题 1 的 `lab.t_order`

## 一、存储引擎是什么

Server 层通过统一的 **Handler API** 调用存储引擎（专题 2），所以同一条 SQL 可以落到不同的存储实现上，每张表单独指定：

```sql
CREATE TABLE t (...) ENGINE = InnoDB;   -- 不写时使用 default_storage_engine
```

类比：Server 层是同一个前台和厨师长，后厨可以更换。有的后厨记账严格、能退菜（InnoDB），有的只求出菜快、出了事不负责（MyISAM），有的不留存货（MEMORY）。

## 二、8.0 中的引擎

沙箱 `SHOW ENGINES`（节选）：

```
Engine      Support  Transactions  Comment
InnoDB      DEFAULT  YES           Supports transactions, row-level locking, and foreign keys
MyISAM      YES      NO            MyISAM storage engine
MEMORY      YES      NO            Hash based, stored in memory, useful for temporary tables
CSV         YES      NO            CSV storage engine
ARCHIVE     YES      NO            Archive storage engine
BLACKHOLE   YES      NO            /dev/null storage engine (anything you write to it disappears)
MRG_MYISAM  YES      NO            Collection of identical MyISAM tables
FEDERATED   NO       NULL          Federated MySQL storage engine        ← 默认未启用
```

| 项目 | 沙箱实测 | 说明 |
| --- | --- | --- |
| `default_storage_engine` | InnoDB | 建表默认引擎 |
| `mysql` 系统库引擎分布 | InnoDB 35 张，CSV 2 张 | 8.0 起数据字典与系统表存放在 InnoDB 中（`mysql.ibd`）；CSV 的两张是 `general_log`、`slow_log` |
| `internal_tmp_mem_storage_engine` | TempTable | SQL 执行中产生的内存内部临时表使用 TempTable，而不是 MEMORY |

::: tip 5.7 差异
5.7 的系统表多为 MyISAM，表结构元数据存放在 `.frm` 文件中，DDL 中途崩溃可能造成元数据与数据不一致。8.0 把数据字典放进 InnoDB，DDL 的元数据变更有了事务保护。8.0 中 MySQL 自身已不再使用 MyISAM，遇到它基本是遗留表。
:::

## 三、InnoDB 与 MyISAM

以 100 万行的 `t_order`（InnoDB）及其 MyISAM 副本 `t_order_my` 对比。

### 3.1 总览

| 维度 | InnoDB | MyISAM |
| --- | --- | --- |
| 事务 | 支持 | 不支持，ROLLBACK 无效 |
| 锁粒度 | 行锁 + MVCC，读写互不阻塞 | 表锁，写时整表读写都要等待 |
| 崩溃恢复 | redo + undo 自动恢复到一致状态 | 无日志，表可能损坏，需要 `REPAIR` |
| 数据组织 | 聚簇索引：表就是主键 B+ 树 | 数据文件与索引文件分离，索引存行的位置 |
| 缓存 | Buffer Pool 同时缓存数据与索引 | key buffer 只缓存索引，数据依赖操作系统缓存 |
| 无条件 `COUNT(*)` | 需要扫描索引 | 直接读取表头中保存的行数 |

### 3.2 文件与空间

```
t_order.ibd           121,634,816 字节   ← InnoDB：数据与索引在同一文件
t_order_my.MYD         57,395,320 字节   ← MyISAM：数据文件
t_order_my.MYI         24,644,608 字节   ← MyISAM：索引文件
t_order_my_390.sdi          7,254 字节   ← 8.0 中 MyISAM 表的元数据描述文件

information_schema.TABLES：
t_order     InnoDB   data 72.6 MB   index 32.6 MB
t_order_my  MyISAM   data 54.7 MB   index 23.5 MB
```

InnoDB 更大，原因包括：每行带有 6 字节事务 ID 与 7 字节回滚指针两个隐藏列，页内为后续写入预留空间（专题 8 有逐字节的计算）。

### 3.3 事务：ROLLBACK 无效

```
SELECT amount FROM t_order_my WHERE id = 1;     → 5.16
BEGIN;
UPDATE t_order_my SET amount = 0 WHERE id = 1;
ROLLBACK;
Warning 1196  Some non-transactional changed tables couldn't be rolled back
SELECT amount FROM t_order_my WHERE id = 1;     → 0.00
```

::: warning 易错
MyISAM 每条语句执行完立即生效，`ROLLBACK` 只产生警告，应用通常不检查警告。一个事务同时修改 InnoDB 表和 MyISAM 表时，回滚后两者不一致。
:::

### 3.4 锁粒度：表锁

会话 A 执行约 2 秒的 UPDATE（只改 `id <= 200`），会话 B 同时读无关的 `id = 999999`：

```
[MyISAM] 会话 B 状态：Waiting for table level lock    耗时 1.54 s
[InnoDB] 会话 B 立即返回（快照读不受行锁影响）
```

### 3.5 崩溃：kill -9 的后果

两张空表同时执行 `INSERT ... SELECT * FROM t_order`，1.5 秒后 `kill -9` mysqld 并重启：

```
SELECT COUNT(*) FROM t_crash_inno;   → 0              ← 未提交事务被完整回滚

SELECT COUNT(*) FROM t_crash_my;     → 0
CHECK TABLE t_crash_my;
  warning  1 client is using or hasn't closed the table properly
  warning  Size of datafile is: 12024120       Should be: 0
  error    Record-count is not ok; is 213473   Should be: 0
  error    Corrupt

REPAIR TABLE t_crash_my;
  warning  Number of rows changed from 0 to 213473
SELECT COUNT(*) FROM t_crash_my;     → 213473         ← 留下“执行了一半”的结果
```

| | InnoDB | MyISAM |
| --- | --- | --- |
| 崩溃后状态 | 自动恢复一致，未提交修改全部撤销 | 表标记为损坏，需人工修复 |
| 一条语句执行一半 | 不存在，要么全有要么全无 | 修复后留下不完整的结果 |
| 依靠 | redo、undo（专题 4、33） | 没有日志，无法得知崩溃时进行到哪一步 |

**这是生产环境不使用 MyISAM 的根本原因**：性能可以调优，数据损坏无法挽回。

### 3.6 COUNT(*)

服务端耗时（`performance_schema`，第二次执行）：

```
                                         InnoDB       MyISAM
SELECT COUNT(*) FROM 表                   107.53 ms     0.12 ms
SELECT COUNT(*) FROM 表 WHERE status = 1  133.12 ms  1009.52 ms
```

- 无 WHERE：MyISAM 直接读取表头中的行数，EXPLAIN 显示 `Select tables optimized away`；InnoDB 扫描最小的索引 `idx_user`，`Handler_read_next = 1000000`。
- 带 WHERE：MyISAM 的优势消失，本次反而慢得多。已知差异之一是 MyISAM 只缓存索引、数据依赖操作系统缓存；本实验未进一步拆解差距的全部原因。

**InnoDB 为什么不保存总行数**：MVCC 下，同一时刻不同事务看到的行数可以不同。事务 A 插入 10 行未提交，A 看到 1000010 行，其他事务看到 1000000 行，不存在对所有事务都正确的计数。

::: warning 易混淆
| 错误理解 | 正确理解 |
| --- | --- |
| MyISAM 的 COUNT(*) 快，所以 MyISAM 查询更快 | 只有无条件 COUNT(*) 快，因为它保存了计数器 |
| InnoDB 的 COUNT(*) 慢是设计缺陷 | 是支持 MVCC 的代价 |
| `COUNT(1)` 比 `COUNT(*)` 快 | 在 InnoDB 中两者执行方式相同 |
:::

频繁需要大表总数时，可单独维护计数表，或接受近似值：`information_schema.TABLES.TABLE_ROWS` 是估算值（本例显示 995788，实际 1000000）。

## 四、其他引擎

| 引擎 | 特点 | 沙箱实测 / 说明 | 适用 |
| --- | --- | --- | --- |
| MEMORY | 数据只在内存，默认哈希索引 | 插入 3 行后重启，行数为 0（表结构保留）；不支持 TEXT/BLOB（ERROR 1163）；单表上限 `max_heap_table_size` 默认 16MB；表级锁 | 几乎没有，需要内存存储时用 Redis |
| CSV | 数据为 CSV 文本文件 | 系统的 `general_log`、`slow_log` 使用 | 与外部工具交换数据 |
| ARCHIVE | 仅支持插入与查询，压缩存储 | 不支持 UPDATE / DELETE | 只追加的历史数据，现已少用 |
| BLACKHOLE | 写入即丢弃，但记录 binlog | 特殊复制拓扑 | 极少 |
| FEDERATED | 访问远程 MySQL 表 | 默认未启用 | 不推荐 |
| MRG_MYISAM | 合并多张同结构 MyISAM 表 | 依附 MyISAM | 已被分区表取代（专题 37） |

Oracle MySQL 之外：**MyRocks**（Percona Server、MariaDB，基于 RocksDB 的 LSM 树，写入放大小、压缩率高，适合写多读少且对存储成本敏感的场景）；**NDB**（MySQL Cluster 的分布式内存引擎，独立产品体系）。

## 五、选型结论

**默认使用 InnoDB。** 需要其他特性时，通常换一个系统，而不是换一个 MySQL 引擎：

| 需求 | 不推荐 | 推荐 |
| --- | --- | --- |
| 内存级读写 | MEMORY | Redis |
| 大数据量统计分析 | MyISAM | 列式数据库（如 ClickHouse），由 MySQL 同步数据 |
| 历史归档省空间 | ARCHIVE | InnoDB 压缩、按时间分区后迁移冷数据、归档到对象存储 |
| 遗留 MyISAM 表 | 继续使用 | `ALTER TABLE t ENGINE = InnoDB` 迁移；大表会重建整表，需评估耗时与锁影响（专题 36） |

查找非 InnoDB 表：

```sql
SELECT TABLE_SCHEMA, TABLE_NAME, ENGINE
FROM information_schema.TABLES
WHERE ENGINE <> 'InnoDB'
  AND TABLE_SCHEMA NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys');
```

::: tip PG 对照
PostgreSQL 只有一种主要的表存储（heap）。PG 12 起有表访问方法接口，可接入其他存储实现，但实际少用。“存储引擎选型”是 MySQL 特有的话题。
:::

::: tip 与 Redis 的对照
MEMORY 引擎重启丢数据、表级锁、只有表一种结构，各方面都不如 Redis。在数据库里勉强实现缓存，不如使用专门的缓存系统。
:::

## 六、在三条主线中的位置

```
A 性能：SQL → 优化器 → 执行计划 → [引擎决定：索引结构、缓存内容、锁粒度] → 页 → 磁盘
B 一致性：只有 InnoDB 在主线 B 上：事务、MVCC、redo、undo、崩溃恢复都由 InnoDB 提供
C 诊断：见第七节
```

## 七、排查清单

| 现象 | 可能原因 | 检查 |
| --- | --- | --- |
| PROCESSLIST 出现 `Waiting for table level lock` | MyISAM / MEMORY 表的表锁 | `SHOW CREATE TABLE` 查看引擎 |
| 应用日志出现 Warning 1196 | 事务中混用了非事务表 | 第五节的查询 |
| 崩溃后有表报告 `Corrupt` | 非 InnoDB 表 | `CHECK TABLE` |
| 重启后表数据消失 | MEMORY 表 | `SHOW CREATE TABLE` |

## 八、本地复现脚本

在专题 1 的 Docker 环境（`mysql:8.4`）中执行。

```sql
USE lab;
SHOW ENGINES;
SELECT @@default_storage_engine, @@internal_tmp_mem_storage_engine;
SELECT ENGINE, COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'mysql' GROUP BY ENGINE;

CREATE TABLE t_order_my LIKE t_order;
ALTER TABLE t_order_my ENGINE = MyISAM;
INSERT INTO t_order_my SELECT * FROM t_order;
SELECT TABLE_NAME, ENGINE, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH FROM information_schema.TABLES
WHERE TABLE_SCHEMA = 'lab' AND TABLE_NAME IN ('t_order', 't_order_my');

-- 1. 事务
BEGIN; UPDATE t_order_my SET amount = 0 WHERE id = 1; ROLLBACK; SHOW WARNINGS;
SELECT amount FROM t_order_my WHERE id = 1;

-- 2. COUNT(*)
EXPLAIN SELECT COUNT(*) FROM t_order;
EXPLAIN SELECT COUNT(*) FROM t_order_my;
SELECT COUNT(*) FROM t_order WHERE status = 1;
SELECT COUNT(*) FROM t_order_my WHERE status = 1;

-- 3. 表锁：窗口 A（约 2 秒）
UPDATE t_order_my SET amount = amount WHERE id <= 200 AND SLEEP(0.01) = 0;
--    窗口 B（A 运行期间）
SELECT amount FROM t_order_my WHERE id = 999999;
--    窗口 C
SELECT state, info FROM performance_schema.processlist WHERE command <> 'Sleep';
--    换成 t_order 再做一遍

-- 4. MEMORY
CREATE TABLE t_mem (id INT PRIMARY KEY, v VARCHAR(10)) ENGINE = MEMORY;
INSERT INTO t_mem VALUES (1,'a'), (2,'b'), (3,'c');
-- docker restart mysql84 后
SELECT COUNT(*) FROM t_mem;    -- 预期 0
```

崩溃实验（会强制杀掉 MySQL 进程，仅限实验容器）：先建好空表 `t_crash_my`（MyISAM）与 `t_crash_inno`（InnoDB），在两个窗口分别执行 `INSERT ... SELECT * FROM t_order`，插入过程中在宿主机执行 `docker kill --signal=KILL mysql84`，再 `docker start mysql84`，然后对两表 `COUNT(*)`，并对 MyISAM 表执行 `CHECK TABLE`、`REPAIR TABLE`。

**预期现象**：MyISAM 的 ROLLBACK 产生 Warning 1196 且值未恢复；无条件 COUNT(*) 在 MyISAM 上显示 `Select tables optimized away`；表锁实验中读会话出现 `Waiting for table level lock`；MEMORY 表重启后为空；崩溃后 InnoDB 表为 0 行，MyISAM 表报告损坏，修复后留下部分行。

## 九、与其他专题的关联

- **专题 2**：Handler API 是可插拔引擎的基础。
- **专题 3、4**：快照读与行锁是 InnoDB 读写不互相阻塞的原因。
- **专题 8**：InnoDB 行的隐藏列与页内预留空间，解释了空间差异。
- **专题 33**：崩溃恢复的完整流程。
- **专题 36**：大表 `ALTER TABLE ... ENGINE = InnoDB` 的在线 DDL 与锁。
- **专题 37**：分区表取代 MRG_MYISAM。
- **Redis**：MEMORY 引擎与专门缓存系统的对比。

## 十、复习 checklist

- [ ] 能解释存储引擎可插拔的原理（Handler API）
- [ ] 知道 8.0 中系统表与数据字典使用 InnoDB，内部临时表使用 TempTable
- [ ] 能从事务、锁、崩溃恢复、数据组织、缓存五方面对比 InnoDB 与 MyISAM
- [ ] 能描述 kill -9 后两种引擎的不同结果，并说明生产不用 MyISAM 的根本原因
- [ ] 能解释 InnoDB 不保存总行数的原因（MVCC）
- [ ] 知道 MEMORY 引擎的限制，以及为什么用 Redis 更合适
- [ ] 能写出查找非 InnoDB 表的 SQL
