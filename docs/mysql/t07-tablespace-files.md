# 专题 7 · 表空间、段、区、页与文件组成

> 级别 ☆（高频重点）· 主线 A（页 → 磁盘）· 实测版本：沙箱 MySQL 8.0.46，数据为专题 1 的 `lab.t_order`

本专题回答两个问题：

1. 100 万行的 `t_order` 在磁盘上如何摆放？
2. 删掉一半数据，`.ibd` 文件为什么一字节都不变小？磁盘告警时该怎么办？

## 一、四级结构：页 → 区 → 段 → 表空间

### 1.1 为什么要成批分配

如果每次需要新页时随便在文件里找空位：

```
文件：[叶1][非叶][叶7][其他索引][叶2][叶5] ...
→ 按主键顺序扫描叶子页，磁盘上却在来回跳 → 顺序扫描退化为随机读
```

专题 3 的预读要求“一个区内顺序访问够 56 页”。这有一个前提：**逻辑上相邻的页，在磁盘上也要尽量相邻**。InnoDB 用“区”和“段”两层成批分配来保证这一点。

### 1.2 层级与规则

```
表空间（tablespace）  一个 .ibd 文件，如 t_order.ibd
 └─ 段（segment）     每个索引 2 个段
     ├─ 叶子段        所有叶子页（即数据本身）
     └─ 非叶子段      根页与中间页
         └─ 区（extent）  连续 64 页 = 1MB（16KB 页）
             └─ 页（page） 16KB，I/O 最小单位
```

| 层级 | 作用 | 官方规则（MySQL 8.4 手册 “File Space Management”） |
| --- | --- | --- |
| 页 | I/O 最小单位 | 默认 16KB，初始化实例时可设为 4/8/32/64KB |
| 区 | 保证物理连续 | 页 ≤ 16KB 时区为 1MB；32KB 页对应 2MB；64KB 页对应 4MB |
| 段 | 同类页集中存放 | 每个索引 2 个段：叶子与非叶子分开，叶子连续存放，范围扫描即顺序 I/O |
| 表空间 | 文件 | `innodb_file_per_table` 开启（默认，沙箱实测为 1）时每表一个 `.ibd` |

**段的空间申请方式**：段刚开始增长时，前 32 页逐页单独分配；之后整区分配，大段一次最多申请 4 个区。小表不必一上来占用 1MB，大表又能获得连续性。

### 1.3 落到 t_order

```
t_order.ibd ≈ 116MB
├── PRIMARY：4647 页（约 73 个区）
│     ├── 叶子段：4608 页   ← 全表扫描按区顺序读，预读生效
│     └── 非叶子段：约 39 页
├── idx_user：2085 页（叶子 1770 页）
└── 管理信息页、尚未使用的空闲区（DATA_FREE）
```

**结论：区让叶子页物理连续，这是顺序读与预读成立的前提。** 页内结构见专题 8。

## 二、数据目录导览

沙箱实例数据目录（大小为实测值）：

| 文件 / 目录 | 实测大小 | 作用 |
| --- | --- | --- |
| `lab/t_order.ibd` | 116MB | 独立表空间：一张表的数据与全部索引 |
| `ibdata1` | 12MB | 系统表空间：主要存放 change buffer；关闭 `innodb_file_per_table` 时表数据也在这里 |
| `mysql.ibd` | 26MB | 数据字典与系统表 |
| `undo_001`、`undo_002` | 65MB、48MB | undo 表空间（专题 31） |
| `#innodb_redo/` | 101MB，32 个文件 | redo log；总容量由 `innodb_redo_log_capacity` 控制（实测 100MB），InnoDB 维持约 32 个文件，各为容量的 1/32，`_tmp` 后缀为备用文件 |
| `#ib_16384_0.dblwr`、`#ib_16384_1.dblwr` | 192KB、8.2MB | Doublewrite Buffer（专题 30），16384 为页大小 |
| `#innodb_temp/temp_N.ibt` | 共 804KB | 会话临时表空间：用户临时表与写到磁盘的内部临时表 |
| `ibtmp1` | 12MB | 全局临时表空间：存放用户临时表修改所需的回滚段，重启时重建 |
| `binlog.000NNN`、`binlog.index` | — | binlog 及其索引（专题 32） |
| `ib_buffer_pool` | — | 关闭时转储的 Buffer Pool 页编号清单（专题 3） |

::: warning 版本差异（8.0 手册）
| 内容 | 旧 | 新 | 版本 |
| --- | --- | --- | --- |
| redo log | `ib_logfile0`、`ib_logfile1`；大小 = `innodb_log_file_size` × `innodb_log_files_in_group`，只能启动时设置 | `#innodb_redo/` 目录；`innodb_redo_log_capacity` 可运行时修改 | 8.0.30 |
| Doublewrite Buffer | 系统表空间 `ibdata1` | 独立 `.dblwr` 文件 | 8.0.20 |
| 表结构元数据 | 每表一个 `.frm`（5.7） | `mysql.ibd` 中的数据字典 | 8.0 |
:::

## 三、空间回收

### 3.1 实验设计

从 `t_order` 复制两张相同的表（各 100 万行），用两种方式各删一半：

| 表 | 删除方式 | 对应的业务场景 |
| --- | --- | --- |
| `t_sp_range` | `DELETE WHERE id <= 500000`（连续的前一半） | 按时间清理历史数据 |
| `t_sp_odd` | `DELETE WHERE id % 2 = 1`（隔行删除） | 零散删除，如注销、作废 |

指标：

| 指标 | 来源 | 含义 |
| --- | --- | --- |
| 文件大小 | 操作系统 | `.ibd` 的实际大小 |
| DATA_FREE | `information_schema.TABLES` | 表空间中**确定完全空闲的区**，不含页内空闲空间，也不含 InnoDB 为内部用途保留的区 |
| 主键叶子页 / 总页数 | `mysql.innodb_index_stats`（`ANALYZE TABLE` 后） | 总页数为分配给该索引的页，含非叶子页与已分配未使用的页 |

被删除的行要由后台 **purge** 线程真正移除（专题 31）。实验等待 undo 历史长度降为 0（约 54 秒）后再测量。

### 3.2 沙箱真实输出

```
阶段               表           行数      文件MB  DATA_FREE_MB  主键叶子页  主键总页数
0 初始             t_sp_range   1000000   116.0     6.0          4608        4647
                   t_sp_odd     1000000   116.0     6.0          4608        4647
1 删除一半后        t_sp_range    500000   116.0    42.0          2308        2373
                   t_sp_odd      500000   116.0     8.0          2304        4628
2 再插入 30 万行后  t_sp_range    800000   116.0    20.0          3726        3783
                   t_sp_odd      800000   116.0     8.0          3722        4630
3 OPTIMIZE 后      t_sp_range    800000    88.0     2.0          3725        4262
                   t_sp_odd      800000    88.0     2.0          3722        4262
```

### 3.3 解读

**阶段 1：删了一半，文件都还是 116MB。**

::: warning 易错
| 错误理解 | 正确理解 |
| --- | --- |
| DELETE 会让文件变小 | DELETE 只把空间标记为可复用，文件大小不变，空间不还给操作系统 |
:::

两张表内部状态不同：

```
t_sp_range（删连续的前一半）
  叶子页：[空][空]…[空][满][满]…[满]
  → 整页清空，所在的区整区空出，归还给表空间
  → DATA_FREE 6MB → 42MB；主键总页数 4647 → 2373

t_sp_odd（隔行删除）
  每页只剩一半：[半][半][半]…
  → 页填充率低于阈值，InnoDB 合并相邻页，叶子页降到 2304
  → 合并后空出的页分散在各区中，没有区完全空闲
  → 这些页仍留在段内：DATA_FREE 仅 8MB，主键总页数仍为 4628
```

“阈值”指索引的 `MERGE_THRESHOLD`，默认 50%：删除后页填充率低于它时，InnoDB 尝试与相邻页合并。手册的表述是：删除释放的空间能否被其他对象使用，**取决于删除模式释放的是零散的页还是完整的区**。

**阶段 2：再插入 30 万行，文件仍是 116MB。**

- `t_sp_range`：新行主键递增，写在 B+ 树末尾，使用之前空出的区，DATA_FREE 42MB → 20MB。
- `t_sp_odd`：主键总页数 4628 → 4630，几乎不变，新数据使用段内的空闲页。

**删除释放的空间可被同一张表后续写入复用，只是不还给操作系统。** 对“边删边写、总量稳定”的表，文件会稳定在某个大小，不是问题。

**阶段 3：OPTIMIZE TABLE，116MB → 88MB。**

```
OPTIMIZE TABLE t_sp_range;
note    Table does not support optimize, doing recreate + analyze instead
status  OK
耗时：t_sp_range 3.24 秒，t_sp_odd 3.43 秒（80 万行）
```

这条 note 是正常提示，不是错误。手册说明：

- 对 InnoDB 表，`OPTIMIZE TABLE` 映射为 `ALTER TABLE ... FORCE`，即**重建整张表**并更新统计信息，效果同 `ALTER TABLE t ENGINE = InnoDB`。
- 重建使用 **Online DDL**：期间允许其他会话读写，只在准备阶段与提交阶段短暂持有排他的表锁。
- 例外：表上有 FULLTEXT 索引时改用复制表的方式，期间锁表。

**附加对比：DELETE 全部与 TRUNCATE**

```
DELETE FROM t_sp_odd;        文件仍为 92,274,688 字节
TRUNCATE TABLE t_sp_odd;     文件变为 131,072 字节
```

`TRUNCATE` 相当于删表重建，独立表空间的表在 TRUNCATE 或 DROP 时把空间还给操作系统。它不能带 WHERE，也不能回滚。

### 3.4 OPTIMIZE 的代价

| 代价 | 说明 |
| --- | --- |
| 磁盘空间 | 重建时会创建中间表，**需要额外约一张表大小的空闲磁盘**；磁盘快满时恰恰最难执行 |
| I/O 与时间 | 本例 80 万行约 3 秒；数亿行的大表需按小时计，期间持续大量读写 |
| 短暂排他锁 | 开始与结束时要获取元数据锁；若有长事务正在使用该表，DDL 会一直等待，其后所有访问该表的语句也排在它后面（专题 25、36） |
| 主从延迟 | 从库要重放同一 DDL，期间落后于主库（专题 40） |

### 3.5 磁盘告警的处理思路

```
磁盘告警
 ├─ 先确认谁占空间：数据文件？binlog？undo？临时表空间？（第二节的文件表）
 ├─ DELETE 行                       → 不会立即释放磁盘
 ├─ DROP / TRUNCATE 整表            → 立即还给操作系统
 ├─ DROP PARTITION 整个分区          → 立即还给操作系统（专题 37）
 └─ DELETE 后 OPTIMIZE              → 能回收，但需先有约一张表大小的空闲空间
```

**架构层面**：会按时间清理的大表（日志、流水、历史订单），建表时就按时间分区，清理时直接 `DROP PARTITION`，而不是 `DELETE` 后再 `OPTIMIZE`。

::: warning 易错：ibdata1 只增不减
系统表空间 `ibdata1` 不支持缩小，手册给出的唯一办法是把数据恢复到新初始化的实例。早年关闭 `innodb_file_per_table` 时，所有表都在 `ibdata1` 中，删表也无法释放空间，这是独立表空间成为默认值的原因之一。
:::

::: tip PG 对照
PostgreSQL 的 `VACUUM` 类似 purge 加段内复用：标记可复用，不还给操作系统。`VACUUM FULL` 类似 `OPTIMIZE TABLE`，重写整表，但全程持有 `ACCESS EXCLUSIVE` 锁，表不可读写，所以 PG 生产常用 pg_repack 在线重建。MySQL 的 `OPTIMIZE TABLE` 本身是在线的。
:::

::: tip 与 Redis 的对照
Redis 删除 key 后，内存分配器也未必把内存还给操作系统，表现为 `mem_fragmentation_ratio` 偏高，需要 `activedefrag` 整理。“逻辑删除”与“物理归还”之间的差距是存储系统的共性问题。
:::

## 四、在三条主线中的位置

```
A 性能：… → 索引 → [页 → 区 → 段 → 表空间文件] → 磁盘
         区保证叶子页物理连续，是顺序扫描与预读的基础
B 一致性：数据目录中的 redo、undo、doublewrite 文件分别在专题 29、31、30 展开
C 诊断：见第五节
```

## 五、诊断要点

| 观察点 | 回答的问题 |
| --- | --- |
| 数据目录各文件大小（`du`） | 空间被哪一类文件占用 |
| `information_schema.TABLES`：DATA_LENGTH、INDEX_LENGTH、DATA_FREE | 表的数据量、索引量、完全空闲的区 |
| `information_schema.INNODB_TABLESPACES`：FILE_SIZE、ALLOCATED_SIZE | 表空间文件的逻辑大小与实际分配大小 |
| `mysql.innodb_index_stats`：size、n_leaf_pages | 每个索引分配了多少页、其中叶子页多少 |
| `INNODB_METRICS` 中的 `trx_rseg_history_len` | undo 历史长度；长期不降说明 purge 跟不上或被长事务卡住（专题 31） |

## 六、本地复现脚本

在专题 1 的 Docker 环境（`mysql:8.4`）中执行。

```sql
USE lab;
SELECT @@innodb_file_per_table, @@innodb_redo_log_capacity;

CREATE TABLE t_sp_range LIKE t_order;  INSERT INTO t_sp_range SELECT * FROM t_order;
CREATE TABLE t_sp_odd   LIKE t_order;  INSERT INTO t_sp_odd   SELECT * FROM t_order;

-- 每个阶段对两张表各执行一次
ANALYZE TABLE t_sp_range;
SELECT TABLE_NAME, TABLE_ROWS, ROUND(DATA_FREE/1048576,1) AS data_free_mb
FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'lab' AND TABLE_NAME = 't_sp_range';
SELECT index_name, stat_name, stat_value FROM mysql.innodb_index_stats
WHERE database_name = 'lab' AND table_name = 't_sp_range' AND index_name = 'PRIMARY'
  AND stat_name IN ('size', 'n_leaf_pages');

-- 阶段 1：删除
DELETE FROM t_sp_range WHERE id <= 500000;
DELETE FROM t_sp_odd   WHERE id % 2 = 1;
-- 等 purge 完成：反复查询，直到接近 0
SELECT COUNT FROM information_schema.INNODB_METRICS WHERE NAME = 'trx_rseg_history_len';

-- 阶段 2：再插入 30 万行
INSERT INTO t_sp_range (user_id, status, amount, order_no, created_at, remark)
  SELECT user_id, status, amount, CONCAT('N2', order_no), created_at, remark FROM t_order WHERE id <= 300000;
INSERT INTO t_sp_odd (user_id, status, amount, order_no, created_at, remark)
  SELECT user_id, status, amount, CONCAT('N2', order_no), created_at, remark FROM t_order WHERE id <= 300000;

-- 阶段 3：重建
OPTIMIZE TABLE t_sp_range;
OPTIMIZE TABLE t_sp_odd;

-- 附加：DELETE 全部与 TRUNCATE
DELETE FROM t_sp_odd;
TRUNCATE TABLE t_sp_odd;
```

宿主机上查看文件大小：

```bash
docker exec mysql84 ls -l /var/lib/mysql/lab/ | grep t_sp_
docker exec mysql84 sh -c 'cd /var/lib/mysql && du -sh ibdata1 mysql.ibd undo_00* ibtmp1 "#innodb_redo" "#innodb_temp"'
```

**预期现象**：DELETE 后文件大小不变；连续删除时 DATA_FREE 明显增加，隔行删除时基本不变但叶子页减半；再插入后文件不增长；OPTIMIZE 输出 `doing recreate + analyze instead`，之后文件变小；TRUNCATE 后文件只剩很小的初始大小。

## 七、与其他专题的关联

- **专题 3**：预读以区为单位，依赖本专题的连续分配。
- **专题 8**：页内结构、行格式与页的填充率。
- **专题 9**：页分裂与页合并（`MERGE_THRESHOLD`）。
- **专题 25、36**：OPTIMIZE / ALTER 与元数据锁、Online DDL。
- **专题 29、30、31**：redo、doublewrite、undo 文件。
- **专题 37**：按时间分区与 `DROP PARTITION`。
- **Redis**：内存碎片与 `activedefrag`。

## 八、复习 checklist

- [ ] 能画出表空间、段、区、页的层级，说出区的大小与每个索引的段数
- [ ] 能解释区为什么是顺序读与预读的前提，以及段的“先逐页、后整区”分配策略
- [ ] 能说出数据目录中各类文件的作用，以及 8.0.20、8.0.30 的两处文件变化
- [ ] 能解释 DELETE 后文件不变小的原因，以及 DATA_FREE 统计的是什么
- [ ] 能说明连续删除与零散删除在空间回收上的差异
- [ ] 知道 OPTIMIZE TABLE 对 InnoDB 的真实含义与四项代价
- [ ] 能给出磁盘告警时的处理思路，以及按时间分区的架构建议
- [ ] 知道 ibdata1 为什么不能缩小
