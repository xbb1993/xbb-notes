# 专题 28–30 · Buffer Pool、redo log 与 WAL、Doublewrite（合并简述）

> 级别：28 ★ / 29 ★ / 30 ☆（按学习者要求简述）· 主线 A / B · 实测版本：沙箱 MySQL 8.0.46

本篇回答：数据页怎样缓存在内存里、满了淘汰谁？脏页何时写回、“抖动”从哪来？为什么提交时不写数据页也不会丢？`innodb_flush_log_at_trx_commit` 三个取值的取舍？页写一半怎么办？

## 模块六大纲

```
一条 UPDATE（专题 4 全景）：
  改内存中的页（Buffer Pool，28）──→ 写 redo（29）──→ 写 binlog（32）──→ 提交
        │ 之后后台刷脏页（28）            │ 宕机时用来重做（33）
        ▼                              │
  页先写 doublewrite 再写数据文件（30）  │
  旧版本写进 undo，供回滚和 MVCC（31）───┘
```

| 层级 | 知识点 | 专题 |
| --- | --- | --- |
| ★ | Buffer Pool 作用、LRU 冷热分区、脏页与刷盘 | 28 |
| ★ | WAL 为什么快且安全；`innodb_flush_log_at_trx_commit`；checkpoint | 29 |
| ★ | undo 两个用途；purge；长事务代价 | 31 |
| ★ | redo 与 binlog 区别；两阶段提交；“双 1” | 32 |
| ★ | 崩溃恢复：如何决定事务提交或回滚 | 33 |
| ☆ | 刷脏抖动；命中率诊断；`innodb_io_capacity`；Doublewrite | 28–30 |
| ○ | Change Buffer（8.4 默认关闭）；多实例与预热；redo 文件组织 | 28、29 |

## 一、Buffer Pool：把数据页放在内存里

冷读与热读相差一个数量级以上（专题 3），InnoDB 在内存中缓存数据页与索引页——**Buffer Pool（缓冲池）**。

| 要点 | 内容 |
| --- | --- |
| 单位 | 页，16 KB（实测 `innodb_page_size = 16384`），与磁盘页一一对应 |
| 大小 | `innodb_buffer_pool_size`，默认 128 MB（沙箱为启动时指定的 512 MB）；专用服务器常设为物理内存较大比例 |
| 读 | 命中直接用；未命中从磁盘读入 |
| 写 | 只改内存中的页，形成**脏页**（专题 4），由后台写回 |
| 预热 | 关闭时保存热页编号、启动时重新加载（`innodb_buffer_pool_dump_at_shutdown` / `load_at_startup`，实测均 ON） |

## 二、淘汰：带冷热分区的 LRU

**LRU（Least Recently Used）**：访问的页移到链表头，满了淘汰尾部。朴素 LRU 下，一次全表扫描读入大量只用一次的页，会把热数据全部挤出。

```
头 [──────── 新区（young），约 63% ────────][──── 老区（old），约 37% ────] 尾
                                            ↑ 新读入的页插在这里（中点）   ↑ 从这里淘汰
老区中的页再次被访问：
  距首次访问 < innodb_old_blocks_time（默认 1000 ms）→ 留在老区
  超过                                             → 移入新区头部
```

| 参数 | 实测默认 | 含义 |
| --- | --- | --- |
| `innodb_old_blocks_pct` | 37 | 老区占比 |
| `innodb_old_blocks_time` | 1000 | 进入老区后至少隔多少毫秒再访问才能移入新区 |

全表扫描时一页上的多行在极短时间内读完，达不到 1 秒间隔，页始终在老区并很快被淘汰。

**实验**：Buffer Pool 128 MB 冷启动；先用其他表填满；热表 `t_user`（207 页）间隔 1.2 秒访问 3 次进入新区；再扫描 `t_s` 与 `t_case` 主键（数据约 160 MB，大于 Buffer Pool）；各设置跑两轮：

| `innodb_old_blocks_time` | 扫描中移入新区次数 | 未移入次数 | 扫描后 t_user 留在内存的页 | 之后查热表的磁盘读 |
| --- | --- | --- | --- | --- |
| 1000（默认） | 16 / 10 | 20643 | **207 / 207** | **0** |
| 0 | 10383 | 0 | **0 / 0** | **226** |

## 三、脏页刷盘与“抖动”

`UPDATE t_order SET amount = amount + 0.01 WHERE id <= 300000`（语句 1.78 秒完成），之后每秒观察：

```
时间    脏页数   累计写出页   写入 doublewrite 的页   redo 写入量   checkpoint 落后
t+0s    2128      216            75                  30 MB        29 MB
t+1s    1908      438           297                  30 MB        27 MB
t+4s    1320     1026           885                  30 MB        19 MB
t+8s     520     1826          1685                  30 MB         8 MB
t+12s      0     2346          2205                  30 MB         0 MB
```

1. **语句结束时数据页几乎没写**：还有 2128 个脏页，redo 已写 30 MB——WAL 的效果。
2. **后台约每秒 200 页**：由 `innodb_io_capacity` 决定，8.0 默认 **200**（实测），**8.4 默认 10000**；SSD 上 8.0 默认偏保守。
3. **触发刷盘**：后台按 io_capacity 持续刷；脏页比例超过 `innodb_max_dirty_pages_pct_lwm`（实测 10%）开始预刷、接近 `innodb_max_dirty_pages_pct`（实测 90%）时加快；redo 快满时被迫加快；需要空闲页时从 LRU 尾刷。`innodb_adaptive_flushing`（实测 ON）按 redo 增长速度自动调节。

**抖动**：redo 空间快用完或没有空闲页时，后台来不及，前台查询被迫参与刷盘或等待，表现为 SQL 偶发变慢。对策：给足 redo 容量；`innodb_io_capacity` 设到磁盘真实能力。

## 四、redo log 与 WAL

### 4.1 为什么提交时不写数据页

提交时写回数据页 = 随机写、每页 16 KB（实际改动可能几十字节）。**WAL（Write-Ahead Logging）**：提交时只把“哪个页、哪个位置、改成什么”顺序追加到 **redo log** 并刷盘，数据页由后台慢慢写；宕机后用 redo 重做（专题 33）。

| | 提交时写数据页 | WAL |
| --- | --- | --- |
| 位置 | 随机写 | 日志末尾顺序追加 |
| 量 | 整页 16 KB | 只写改动 |
| 安全 | 有 | 有（靠 redo 重做） |

### 4.2 `innodb_flush_log_at_trx_commit`

redo 先写入 **log buffer**（`innodb_log_buffer_size`：8.0 实测 16 MB，8.4 默认 64 MB）。

| 取值 | 提交时（手册） | MySQL 进程崩溃 | 操作系统崩溃 / 断电 |
| --- | --- | --- | --- |
| **1（默认）** | 写入文件并刷盘 | 不丢 | 不丢 |
| 2 | 只写入文件（进入 OS 缓存），每秒刷盘 | 不丢 | 可能丢约最近 1 秒 |
| 0 | 每秒写入并刷盘 | 可能丢约 1 秒 | 可能丢约 1 秒 |

间隔由 `innodb_flush_log_at_timeout`（实测 1）控制。3000 次自动提交单行 UPDATE：

| 取值 | 耗时 | 每秒提交 | redo 刷盘次数 |
| --- | --- | --- | --- |
| 1 | 2.02 s | 1487 | **+3579** |
| 2 | 1.31 s | 2293 | +4 |
| 0 | 1.30 s | 2314 | +4 |

沙箱为带缓存的云盘，差距约 1.5 倍；无写缓存的磁盘差距可能大得多，以本地实测为准。

::: danger 错误理解 vs 正确理解
- ❌ 设成 2 只是更快，没有风险。
- ✅ 进程崩溃不丢，但**断电 / OS 崩溃**可能丢最近约 1 秒已提交事务。与 `sync_binlog`（实测 1）合称“双 1”（专题 32）。
:::

### 4.3 容量与 checkpoint

```
redo（循环使用）：
  [可覆盖 ...][ checkpoint ──── 仍需要的 redo ────→ 当前写入位置 LSN ][空闲…]
                ↑ 之前的脏页都已写回                ↑ LSN：日志序列号
  checkpoint 落后 = 当前 LSN − checkpoint = 未写回修改对应的 redo 量
```

- 第三节表中“checkpoint 落后”从 29 MB 降到 0，取自 INNODB STATUS 的 `Log sequence number` − `Last checkpoint at`。
- 8.0.30 起容量为 `innodb_redo_log_capacity`（实测 100 MB），文件在数据目录 `#innodb_redo`（实测可见 `#ib_redo198` 等）；此前为 `innodb_log_file_size` × 文件数。
- checkpoint 落后接近容量 → 被迫加速刷脏 → 前台变慢；写多的系统要给足 redo 容量。

## 五、Doublewrite：防止“页写一半”

InnoDB 页 16 KB，操作系统 / 磁盘原子写入单位通常更小（常见 4 KB），写页中途断电会形成**残缺页**（torn page）。redo 记录“在某页上做什么修改”，前提是页本身完整，修不了残缺页。

```
刷脏页：① 先顺序写入 doublewrite 文件并刷盘  ② 再写到数据文件的真正位置
恢复：  页校验和不对 → 用 doublewrite 中的完整副本覆盖 → 再用 redo 重做
```

- 实测 `Innodb_dblwr_pages_written` 2205 对 `Innodb_pages_written` 2346，绝大多数写出的页先经过 doublewrite；`Innodb_dblwr_writes` 553 次，平均每批约 4 页，对应 8.0 `innodb_doublewrite_pages = 4`（实测），8.4 默认 128。
- 8.0.20 起为独立文件（实测 `#ib_16384_0.dblwr`、`#ib_16384_1.dblwr`）；开关 `innodb_doublewrite`（实测 ON）。
- 代价：每页多写一次，但为顺序批量写；存储能保证 16 KB 原子写入时可评估关闭。

## 六、几句话带过

- **Change Buffer**：修改普通二级索引而目标页不在内存时，先记下改动、以后读入时合并，省一次随机读。`innodb_change_buffering` 8.0 实测 `all`，**8.4 默认 `none`**。
- **多实例**：`innodb_buffer_pool_instances` 分片减少锁竞争；8.0 小于 1 GB 时为 1、否则默认 8，8.4 按内存与 CPU 计算。
- **8.4 默认值变化**（手册 What's New）：`innodb_io_capacity` 200 → 10000；`innodb_log_buffer_size` 16 MB → 64 MB；`innodb_change_buffering` all → none；`innodb_adaptive_hash_index` ON → OFF；Linux 上 `innodb_flush_method` fsync → O_DIRECT；`innodb_doublewrite_pages` 4 → 128；`innodb_page_cleaners` 4 → 与实例数相同；`innodb_use_fdatasync` OFF → ON。

## 七、串联图

```
读：页在 Buffer Pool？─是→ 直接用
       └否→ 从磁盘读入，插入 LRU 老区头部 → 隔 1 秒以上再访问才进新区（扫描页进不了新区）
写：改内存页（脏页）→ redo 进 log buffer → 提交按 flush_log_at_trx_commit 刷盘（WAL）
    → 后台按 io_capacity 刷脏：先 doublewrite，再数据文件
    → 脏页写回 → checkpoint 前移 → redo 空间可重用
    → redo 快满 / 无空闲页 → 被迫加速刷盘 → 抖动
```

## 八、在三条主线中的位置

```
A 性能：SQL → 优化器 → 索引 → 页 → [Buffer Pool → 磁盘]
B 一致性：事务 → MVCC → 锁 → [redo → doublewrite] → binlog → 崩溃恢复
C 诊断：命中率、PAGES_MADE_YOUNG、脏页比例、checkpoint 落后、Innodb_os_log_fsyncs
```

## 九、诊断要点

| 现象 | 看什么 | 方向 |
| --- | --- | --- |
| 读多系统磁盘读高 | 命中率 = 1 − Δ`Innodb_buffer_pool_reads` ÷ Δ`Innodb_buffer_pool_read_requests`（取增量，专题 3） | Buffer Pool 太小？有大扫描？ |
| 每跑完报表线上就变慢 | `INNODB_BUFFER_POOL_STATS.PAGES_MADE_YOUNG` 暴涨 | `innodb_old_blocks_time` 是否被改小 |
| 写入时延周期性尖刺 | checkpoint 落后是否接近 redo 容量；脏页比例 | 增大 `innodb_redo_log_capacity`；`innodb_io_capacity` 设到磁盘真实能力 |
| 每秒提交数上不去 | `Innodb_os_log_fsyncs` 增速 | 磁盘刷盘能力；业务允许时评估取值 2；合并小事务 |

## 十、本地复现（Docker mysql:8.4）

```sql
SHOW VARIABLES WHERE Variable_name IN ('innodb_buffer_pool_size','innodb_old_blocks_pct','innodb_old_blocks_time',
  'innodb_io_capacity','innodb_max_dirty_pages_pct','innodb_redo_log_capacity','innodb_log_buffer_size',
  'innodb_flush_log_at_trx_commit','innodb_doublewrite','innodb_doublewrite_pages','innodb_change_buffering');

-- 一、LRU：以 --innodb-buffer-pool-size=128M --innodb-buffer-pool-load-at-startup=OFF
--    --innodb-old-blocks-time=1000（第二轮 0）启动后：
SELECT SUM(id) FROM t_order FORCE INDEX (PRIMARY);             -- 先填满
SELECT SUM(level) FROM t_user;   -- 执行 3 次，每次间隔 1 秒以上
SELECT COUNT(*) FROM information_schema.INNODB_BUFFER_PAGE_LRU WHERE TABLE_NAME = '`lab`.`t_user`';
SELECT SUM(id) FROM t_s FORCE INDEX (PRIMARY); SELECT SUM(id) FROM t_case FORCE INDEX (PRIMARY);
SELECT COUNT(*) FROM information_schema.INNODB_BUFFER_PAGE_LRU WHERE TABLE_NAME = '`lab`.`t_user`';
SELECT SUM(PAGES_MADE_YOUNG), SUM(PAGES_NOT_MADE_YOUNG) FROM information_schema.INNODB_BUFFER_POOL_STATS;

-- 二、脏页与 checkpoint：批量更新后每秒查
UPDATE t_order SET amount = amount + 0.01 WHERE id <= 300000;
SHOW GLOBAL STATUS WHERE Variable_name IN ('Innodb_buffer_pool_pages_dirty','Innodb_pages_written','Innodb_dblwr_pages_written');
SHOW ENGINE INNODB STATUS\G     -- LOG 段：Log sequence number − Last checkpoint at

-- 三、flush_log_at_trx_commit：分别设 1 / 2 / 0，脚本跑 3000 次自动提交单行 UPDATE，对比耗时与 Innodb_os_log_fsyncs；实验后改回 1
SET GLOBAL innodb_flush_log_at_trx_commit = 2;
```

**预期现象**：`old_blocks_time = 0` 时大扫描后热表被挤出，1000 时保留；批量更新后脏页逐渐减少、checkpoint 落后归零（8.4 io_capacity 默认 10000，刷盘远快于沙箱的每秒 200 页）；取值 1 时每次提交刷盘、耗时最长。数值以本地为准。

::: tip PG 与 Redis 对照
- **PG**：`shared_buffers` ≈ Buffer Pool，但依赖 OS 缓存双层缓存；WAL ≈ redo；`synchronous_commit` ≈ `flush_log_at_trx_commit`；`full_page_writes`（checkpoint 后页首次修改时整页写进 WAL）解决与 Doublewrite 相同的残缺页问题。
- **Redis**：AOF `appendfsync always / everysec / no` 与取值 1 / 2 / 0 是同一种安全与性能取舍；Redis 的 LRU 为近似采样淘汰，无冷热分区。
:::

## 十一、与其他专题的关联

- **专题 3**：冷热读差距、命中率计算。
- **专题 4**：UPDATE 只改内存页、写 redo 的全景。
- **专题 7**：redo、doublewrite 等文件的位置。
- **专题 31–33**：undo、binlog 与两阶段提交、崩溃恢复。

## 十二、复习 checklist

- [ ] 能说出 Buffer Pool 的作用、单位、读写流程与预热
- [ ] 能解释朴素 LRU 的问题、冷热分区与 `innodb_old_blocks_time` 的作用，并复述实验结论
- [ ] 知道脏页的几种刷盘触发条件、`innodb_io_capacity` 的 8.0 / 8.4 默认值差异，以及抖动的成因与对策
- [ ] 能说明 WAL 为什么快且安全
- [ ] 能说出 `innodb_flush_log_at_trx_commit` 三个取值在进程崩溃与断电下的差别
- [ ] 能解释 LSN、checkpoint、checkpoint 落后，以及 redo 容量不足的后果
- [ ] 能说明残缺页问题、redo 为何修不了、Doublewrite 的流程与代价
- [ ] 知道 Change Buffer 的作用及 8.4 默认关闭，并能列出主要的 8.4 默认值变化
