# 专题 44–47 · Performance Schema 与 sys、资源模型与指标、参数配置、基准测试（合并）

> 级别：44 ☆ / 45 ★ / 46 ☆ / 47 ☆ · 主线 C（衔接 A）· 实测环境：沙箱 MySQL 8.0.46，2 vCPU / 8 GB，sysbench 1.0.20 与数据库同机；数据 8 张表 × 20 万行，约 377 MB

本篇回答：P_S 怎样把"时间花在哪"变成可查询的表？sys 视图分别回答什么问题？连接、CPU、内存、I/O、锁各看哪些指标、怎样判断饱和？为什么吞吐到顶后加并发只会加延迟？命中率为什么会骗人？哪些参数值得调、8.4 改了哪些默认值？基准测试有哪些常见陷阱？

## 模块九大纲

```
前八个模块：每个机制"出问题时从哪里观察"都零散提过
        ▼
工具（44）：P_S / sys —— 观察点系统化
        ▼
模型（45）：资源有哪些，每种看哪几个指标、怎样判断瓶颈
        ▼
调节（46）：哪些参数值得调
        ▼
验证（47）：基准测试，避免错误结论
        ▼
硬件与系统（48）→ 容量规划（49）→ 综合演练（50）
```

| 层级 | 知识点 | 专题 |
| --- | --- | --- |
| ★ | 资源模型与 USE 方法；各资源关键指标；利特尔法则；计数器做差算速率 | 45 |
| ★ | 生产故障综合演练 | 50 |
| ☆ | P_S 结构（instrument / consumer / 汇总表）；sys 视图与问题的对应 | 44 |
| ☆ | 值得调的参数；8.4 默认值变化 | 46 |
| ☆ | sysbench 用法与基准测试陷阱 | 47 |
| ☆ | 从业务增长推算资源需求 | 49 |
| ○ | CPU、内存、磁盘、文件系统、内核参数 | 48 |

## 在三条主线中的位置

```
C 诊断：现象 →【指标与等待事件：P_S / sys（44）】→【哪种资源饱和（45）】→ SQL → EXPLAIN → 锁 / I/O / CPU / 内存 → 定位 →【调参（46）】→【验证（47）】
A 性能：主线终点 Buffer Pool → 磁盘，在这里变成可测量的指标
```

## 一、Performance Schema 与 sys（专题 44）

### 1.1 要解决的问题

| 已有工具 | 能回答 | 缺口 |
| --- | --- | --- |
| `SHOW GLOBAL STATUS` | 全局计数器 | 不知道是哪条 SQL、哪张表、哪个会话 |
| 慢查询日志 | 超阈值 SQL | 看不到"单次快、次数极多"的 SQL；看不到等什么 |
| `SHOW PROCESSLIST` | 此刻谁在执行 | 瞬间快照，无累计 |

→ 需要在服务器内部关键代码点埋计时器，持续记录并汇总：**Performance Schema（P_S）**。

### 1.2 结构

```
① instrument（探针）：代码里的计时点（读一次数据文件、等一把行锁、执行一条语句…）
        │ 触发时产生 event：开始 / 结束时间、对象、影响行数…
        ▼
② consumer（消费者）：事件存到哪里
     current：每线程当前事件
     history：每线程最近若干事件
     summary：按维度累计（SQL 模板、表、文件、用户…）← 最常用
        ▼
③ performance_schema 库下的内存表，直接 SELECT
```

沙箱默认（真实输出）：

```
setup_instruments：ENABLED=YES 773 个，NO 477 个
setup_consumers（节选）：
  events_statements_current / history   YES
  events_statements_history_long        NO
  events_waits_current / history        NO     ← 细粒度等待默认不逐条记录
  events_stages_*                       NO
  statements_digest                     YES    ← 按 SQL 模板汇总
```

数据在**内存**，重启清空；汇总表是**自启动（或上次 TRUNCATE）以来的累计**。

**sys schema**：建在 P_S（与 information_schema）上的视图，纳秒→ms/s、字节→MiB，预写好常用关联；每个视图有 `x$` 前缀版本输出原始数值。

**类比**：P_S = 黑匣子 + 传感器网络；sys = 驾驶舱仪表盘。

### 1.3 问题 → 视图 / 表

| 问题 | sys 视图 | 底层 P_S 表 | 专题 |
| --- | --- | --- | --- |
| 此刻每个会话在做什么 | `sys.session` | `threads`、`events_statements_current` | 25、27 |
| 哪类 SQL 总耗时最多 | `sys.statement_analysis` | `events_statements_summary_by_digest` | 22 |
| 全表扫描、磁盘临时表、排序的 SQL | `sys.statements_with_full_table_scans` 等 | 同上 | 19、22 |
| 哪张表读写最多 | `sys.schema_table_statistics` | `table_io_waits_summary_by_table` | — |
| 从没用过的索引 | `sys.schema_unused_indexes` | `table_io_waits_summary_by_index_usage` | 12 |
| 谁在等锁 | `sys.innodb_lock_waits`、`sys.schema_table_lock_waits` | `data_lock_waits`、`metadata_locks` | 25–27 |
| 内存被谁占 | `sys.memory_global_by_current_bytes` | `memory_summary_global_by_event_name` | 45 |
| 文件 I/O 次数与延迟 | `sys.io_global_by_file_by_latency` | `file_summary_by_instance` | 45 |
| 等待事件排行 | `sys.waits_global_by_latency` | `events_waits_summary_global_by_event_name` | 45 |
| 复制回放状态 | — | `replication_applier_status_by_worker` | 40、41 |

### 1.4 实验：sysbench 读写负载下（真实输出）

```
① sys.session（负载中）
thd_id conn_id user          command  state                       stmt
51     13      sb@localhost  Execute  closing tables              SELECT c FROM sbtest5 WHERE id=100498
52     14      sb@localhost  Execute  waiting for handler commit  COMMIT

② digest 汇总
  sysbench 默认服务端预处理语句时：只看到 BEGIN  10779 次  0.9s
  改 --db-ps-mode=disable 后：
digest                                     calls  total_s  avg_ms  rows_exam  rows_sent
COMMIT                                     9488   22.24    2.344   0          0
SELECT `c` FROM `sbtest5` WHERE `id` = ?   12130  1.41     0.117   12130      12130
SELECT `c` FROM `sbtest8` WHERE `id` = ?   12370  1.40     0.113   12370      12370

③ sys.schema_table_statistics
sbtest3  rows_fetched=552659 rows_inserted=1408 rows_updated=2681 rows_deleted=1408 io_read_requests=1372

④ sys.schema_unused_indexes（排除系统库）：sbtest1.k_1 … sbtest8.k_8

⑤ 内存：total_allocated 864.39 MiB
memory/innodb/buf_buf_pool                                      523.52 MiB
memory/performance_schema/events_statements_summary_by_digest    40.28 MiB
memory/innodb/log_buffer_memory                                   16.00 MiB

⑥ 等待事件
wait/io/table/sql/handler              4495262  9.31 s  2.07 us
wait/io/file/innodb/innodb_log_file      58100  7.42 s  127.76 us   ← redo
wait/io/file/sql/binlog                  18403  4.98 s  270.52 us   ← binlog
wait/io/file/innodb/innodb_data_file     25198  4.25 s  168.68 us
wait/io/file/innodb/innodb_dblwr_file     3878  1.20 s  310.57 us   ← doublewrite
```

- **digest**：常量替换为 `?` 的 SQL 模板，同模板合并统计 → 能抓到"单次快、次数多"的 SQL，补慢日志的缺口。
- **COMMIT 占总耗时最多**（平均 2.3 ms vs 主键查询 0.11 ms），等待事件中 redo + binlog 文件等待约 12.4 秒，互相印证：瓶颈在双 1 提交刷盘（专题 29、32），不在 SQL。
- **预处理语句的坑**：服务端预处理语句时 digest 表里只看到 BEGIN（实测）；其执行统计应查 `performance_schema.prepared_statements_instances`（此为按表设计的理解，沙箱中会话结束后该表为空，未完整验证）。
- **未用索引的坑**：统计自启动以来；刚重启或月度报表才用的索引也会列出 → 确认统计覆盖足够长业务周期，或先 INVISIBLE 观察（专题 14）。

### 1.5 局限

- 有开销：默认配置可长期开；`events_waits_*`、`events_stages_*` 排查时临时开。
- 累计值：看最近 N 分钟需先 TRUNCATE 或定时采样相减。
- 容量有限：digest 表行数有上限（`performance_schema_digests_size`），模板过多会并入"其他"。
- 仅内存：长期趋势靠外部监控采集。

## 二、资源模型与指标（专题 45）

### 2.1 类比

```
顾客入座   = 连接（Threads_connected），座位上限 = max_connections
正在做的菜 = 正在执行的线程（Threads_running）
灶台       = CPU 核：同时炒的菜 ≤ 灶台数
冰箱/仓库  = Buffer Pool / 磁盘
共用的锅   = 锁
```

### 2.2 USE 方法

| 字母 | 含义 | 问题 |
| --- | --- | --- |
| **U**tilization | 使用率 | 资源多忙？ |
| **S**aturation | 饱和度 | 多少工作在排队等它？ |
| **E**rrors | 错误 | 有没有因它失败？ |

使用率高不一定有问题；**饱和（排队）**才导致延迟上升。

### 2.3 各资源看什么

`SHOW GLOBAL STATUS` 多数为累计值 → 间隔采样两次，相减除以间隔得每秒速率。

| 资源 | U | S | E | 专题 |
| --- | --- | --- | --- | --- |
| 连接 | `Threads_connected` / `max_connections`；`Max_used_connections` | 连接池排队 | `Aborted_connects`；ERROR 1040 | 50 |
| CPU | OS user + sys | **`Threads_running` / 核数** | — | 21、22 |
| 内存 | `sys.memory_global_total`；OS 可用内存 | swap、换页 | OOM | 2.6 |
| BP → 磁盘 | `Innodb_buffer_pool_reads`/s；P_S 文件读延迟 | 磁盘队列、iowait | I/O 错误 | 28 |
| 写入 / 日志 | `Innodb_os_log_written`/s；脏页比例；checkpoint age | `Innodb_log_waits` | — | 29 |
| 锁 | `Innodb_row_lock_waits`/s、`Innodb_row_lock_time` | `sys.innodb_lock_waits` 等待数 | 1205、1213 | 25–27 |
| SQL 执行方式 | `Created_tmp_disk_tables`、`Sort_merge_passes`、`Select_full_join` | — | — | 19、20 |
| 后台清理 | — | history list length | — | 31 |
| 复制 | — | 延迟（GTID 对比 / 心跳） | 复制中断 | 40、41 |

### 2.4 实验一：并发 1 → 64（CPU 受限，真实输出）

`oltp_read_only`，数据全在 BP（命中 100%），预热后每档 20 秒：

```
threads=1   TPS=815   avg=1.23ms  p95=1.39ms   Threads_running=2.5   cpu idle=50%
threads=2   TPS=3711  avg=0.54ms  p95=0.75ms   Threads_running=3.6   cpu idle=0%
threads=4   TPS=2440  avg=1.64ms  p95=3.07ms   Threads_running=4.3   cpu idle=0%
threads=8   TPS=2138  avg=3.74ms  p95=6.91ms   Threads_running=7.2   cpu idle=0%
threads=16  TPS=2575  avg=6.21ms  p95=10.65ms  Threads_running=13.8  cpu idle=0%
threads=32  TPS=2586  avg=12.36ms p95=20.74ms  Threads_running=26.2  cpu idle=0%
threads=64  TPS=2205  avg=28.99ms p95=51.02ms  Threads_running=51.8  cpu idle=0%
```

1. 2 线程起 CPU 空闲为 0，吞吐不再随线程增长（2 vCPU，sysbench 也占一部分）。
2. 饱和后加线程只加延迟：4 → 64 线程，平均延迟涨约 18 倍，吞吐无提升；`Threads_running` 52 ≫ 核数 2。
3. **利特尔法则（Little's Law）**：系统内平均请求数 = 吞吐 × 平均停留时间，**L = λ × W** → W = L ÷ λ：

| L（线程） | λ（TPS） | L ÷ λ | 实测平均延迟 |
| --- | --- | --- | --- |
| 16 | 2575 | 6.21 ms | 6.21 ms |
| 32 | 2586 | 12.37 ms | 12.36 ms |
| 64 | 2205 | 29.02 ms | 28.99 ms |

工程含义：**吞吐到顶后，并发翻倍 ⇒ 延迟翻倍** → 连接池不应过大（49、50）。

噪声说明：1 线程延迟反高于 2 线程（重复两轮稳定出现，原因未查清，可能与单客户端线程休眠唤醒调度有关）；8 线程三轮 TPS 为 2138 / 1814 / 3349 → 读法只依赖"吞吐封顶、延迟随线程线性增长"这一稳健趋势。

### 2.5 实验二：BP 放得下 vs 放不下（真实输出）

`innodb_flush_method=O_DIRECT`（绕过 OS 页缓存，使未命中真的读磁盘），数据 377 MB，8 线程，预热 20 秒后测 30 秒：

```
BP=64M   TPS=1683  avg=4.75ms p95=8.74ms  bp_reads(disk)=4665/s  hit=96.90%  iowait=1%
BP=512M  TPS=1924  avg=4.16ms p95=7.56ms  bp_reads(disk)=37/s    hit=99.98%  iowait=0%
BP=64M 时：wait/io/file/innodb/innodb_data_file  COUNT_READ=64840（15 秒）  avg_read_us=236.4
```

1. **命中率会骗人**：96.90% 换算为每秒 4665 次磁盘读；应看**每秒未命中绝对次数**并与存储能力比较。
2. 沙箱磁盘快（236 µs），TPS 只降 13%。I/O 等待占用：

```
每秒 I/O 等待时间 ≈ 4665 × 0.236 ms ≈ 1.1 秒 → 平均约 1.1 个线程时刻在等磁盘
若单次读约 1 ms 的云盘：4665 × 1 ms ≈ 4.7 秒 → 8 线程中平均 4.7 个在等（推算，非实测）
```

> **错误 vs 正确**
> - ❌ 命中率 99% 以上就不用管。✅ 看未命中次数 × 单次延迟；命中率 99.9% → 99%，未命中次数涨 10 倍。
> - ❌ CPU 100% 就是 CPU 不够。✅ 先看谁在耗 CPU：全表扫描等低效 SQL（21、22）加 CPU 无用；请求本身多（实验一）才是容量不足。

### 2.6 内存模型

```
MySQL 内存 ≈ 全局部分：Buffer Pool + log buffer + P_S + 各种缓存
           + 会话部分（按需分配、用完释放）：sort_buffer、join_buffer、read_buffer、内存临时表…
```

> **错误 vs 正确**
> - ❌ 内存上限 = BP + max_connections × 全部会话 buffer → 得出离谱数字，不敢设大 BP。
> - ✅ 会话 buffer 按需分配，多数连接多数时间空闲；以 `sys.memory_global_total` 与 OS 观测为准（512 MB BP → 总分配 864 MiB）。
> - ⚠ 会话 buffer 调得很大时，高并发大排序会让内存突增甚至 OOM → 保持默认，个别会话临时调大。

## 三、服务器参数配置（专题 46）

原则：多数默认值合理，只调十几个；一次改一个并用基准测试验证；不照抄"万能模板"。

"编译默认值"取自沙箱 8.0.46 `mysqld --no-defaults --verbose --help` 真实输出：

| 类别 | 参数 | 编译默认值 | 建议 |
| --- | --- | --- | --- |
| 内存 | `innodb_buffer_pool_size` | 134217728（**128 MB**） | 专用服务器一般 50%–75% 物理内存，最重要 |
| 持久性 | `innodb_flush_log_at_trx_commit` / `sync_binlog` | 1 / 1 | 保持双 1（29、32） |
| redo | `innodb_redo_log_capacity` | 104857600（100 MB） | 写多时调大（29） |
| I/O | `innodb_io_capacity` | 8.0：200；8.4：10000 | 按存储实际 IOPS（28） |
| 连接 | `max_connections` | 151 | 按连接池总数，不宜过大（45 实验一） |
| 连接 | `thread_cache_size` | 自动计算（沙箱 9） | 观察 `Threads_created` 是否持续增长 |
| 表缓存 | `table_open_cache` | 4000 | 观察 `Table_open_cache_misses` |
| 会话级 | `sort_buffer_size` / `join_buffer_size` / `tmp_table_size` | 256 KB / 256 KB / 16 MB | 一般保持默认 |
| 超时 | `innodb_lock_wait_timeout` / `lock_wait_timeout` / `wait_timeout` | 50 s / 31536000 s / 28800 s | DDL 前临时调小 `lock_wait_timeout`（25、36） |
| 慢日志 | `long_query_time` | 10 s | 生产常 0.5–1 s（18） |

**8.4 InnoDB 默认值变化**（8.4 手册 Table 1.1）：

| 参数 | 8.0 | 8.4 | 专题 |
| --- | --- | --- | --- |
| `innodb_adaptive_hash_index` | ON | **OFF** | 9 |
| `innodb_change_buffering` | all | **none** | 28 |
| `innodb_flush_method`（Linux） | fsync | **O_DIRECT**（支持时） | 28 |
| `innodb_io_capacity` | 200 | **10000** | 28 |
| `innodb_io_capacity_max` | 2 × io_capacity，最小 2000 | 2 × io_capacity | 28 |
| `innodb_log_buffer_size` | 16 MiB | **64 MiB** | 29 |
| `innodb_buffer_pool_instances` | 8（BP < 1 GiB 时 1） | BP ≤ 1 GiB 为 1，否则按 BP 与 CPU 计算 | 28 |
| `innodb_doublewrite_pages` | = innodb_write_io_threads（默认 4） | 128 | 30 |
| `innodb_doublewrite_files` | BP instances × 2 | 2 | 30 |
| `innodb_use_fdatasync` | OFF | ON | 29 |
| `innodb_read_io_threads` | 4 | 逻辑 CPU / 2，最少 4 | — |
| `innodb_purge_threads` | 4 | 逻辑 CPU ≤ 16 为 1，否则 4 | 31 |
| `innodb_page_cleaners` | 4 | = innodb_buffer_pool_instances | 28 |
| `temptable_max_ram` | 1 GiB | 物理内存 3%，范围 1–4 GiB | 19 |
| `temptable_max_mmap` | 1 GiB | 0（关闭） | 19 |

**`innodb_dedicated_server`**：默认 OFF；开启后由 InnoDB 按机器资源自动设置 `innodb_buffer_pool_size`、`innodb_redo_log_capacity` 等，适合独占整机。8.4 中 redo 容量计算依据由内存改为 CPU，且不再修改 `innodb_flush_method`（8.4 手册）。

## 四、基准测试（专题 47）

**基准测试（benchmark）**：可重复的人造负载测量系统能力。用途：验证调参 / 换硬件 / 升级是否变好；找饱和点；为容量规划提供数据。

```bash
sysbench oltp_read_write --mysql-socket=... --mysql-user=... --mysql-db=sbtest --tables=8 --table-size=200000 prepare
sysbench oltp_read_write ... --threads=8 --time=60 --report-interval=10 --percentile=95 run
sysbench oltp_read_write ... cleanup
```

内置负载：`oltp_read_only`、`oltp_read_write`、`oltp_point_select`、`oltp_update_index`、`oltp_insert` 等；看 `transactions`（TPS）、`queries`（QPS）、`latency` 的 avg 与 95th。

冷启动预热曲线（真实输出，8 线程，每 2 秒一行，节选）：

```
[ 2s ] tps: 1856.88  (ms,95%): 7.56
[ 4s ] tps: 2216.45  (ms,95%): 6.79
[ 6s ] tps: 3010.59  (ms,95%): 3.96
[10s ] tps: 2261.28  (ms,95%): 6.21
...
[40s ] tps: 2764.89  (ms,95%): 5.09
```

| 陷阱 | 沙箱证据 | 正确做法 |
| --- | --- | --- |
| 只跑一次 | 同配置 8 线程 5 次：2138、1814、3349、1924、约 2400 | 每组 ≥ 3 次，报中位数与波动范围 |
| 客户端与数据库同机 | 2 vCPU 被 sysbench 与 mysqld 共用 | 客户端放另一台；至少记录客户端 CPU |
| 不预热 | 冷启动前 2 秒 1857，之后 2200–2700 | 预热到 BP 装满或 TPS 稳定再计时 |
| 数据量与生产不一致 | 377 MB 进 512 MB BP 是 CPU 受限；进 64 MB 每秒 4665 次磁盘读 | 数据 / BP 比例接近生产 |
| 只看平均值 | 64 线程平均 29 ms，p95 51 ms | 报 p95 / p99 |
| 持久性配置不同 | COMMIT 占总耗时最多 | 对比时双 1 必须一致 |
| 时间太短 | — | 至少几分钟；写入负载跑到 checkpoint / purge 稳态 |

**结论只在同样数据量、配置、环境下成立；报告必须写明测试条件。**

## 五、串联图

```
P_S（44）：instrument → event → consumer（current / history / summary）→ 表；sys 整理成可读视图
   ↓ 提供数据
资源模型（45）：连接、CPU、内存、I/O、锁 × USE
   累计计数器 → 采样做差 → 每秒速率
   CPU 受限：吞吐到顶后 L = λ × W，并发翻倍延迟翻倍
   I/O 受限：每秒未命中 × 单次延迟，不只看命中率
   内存：全局 + 按需分配的会话部分
   ↓ 找到瓶颈
参数（46）：只调少数几个；注意 8.4 默认值变化
   ↓ 验证
基准测试（47）：重复、预热、数据量贴近生产、看 p95、写明条件
```

## 六、诊断实践：先看哪几个数

```
① 吞吐与延迟：QPS / TPS 是否下降？p95 / p99 是否上升？
② CPU：使用率 + Threads_running / 核数
     Threads_running ≫ 核数且 CPU 满 → Top SQL（44）是否扫描大量行
③ I/O：Innodb_buffer_pool_reads/s 与 P_S 文件延迟；写侧 redo 写入量、脏页比例
④ 锁：Innodb_row_lock_waits/s、sys.innodb_lock_waits（27）
⑤ 连接：Threads_connected vs max_connections、Aborted_connects
⑥ 内存：sys.memory_global_by_current_bytes、OS 可用内存与 swap
⑦ 后台：history list length（31）、复制延迟（40）
找到饱和资源 → Top SQL → EXPLAIN（15）→ 索引（12）
```

采样做差示例（与沙箱 `samp.py` 思路一致）：

```sql
-- 间隔 N 秒执行两次，相减后除以 N
SELECT VARIABLE_NAME, VARIABLE_VALUE FROM performance_schema.global_status
WHERE VARIABLE_NAME IN ('Questions','Threads_running','Innodb_buffer_pool_read_requests',
  'Innodb_buffer_pool_reads','Innodb_row_lock_waits','Innodb_os_log_written','Created_tmp_disk_tables');
```

## 七、本地复现（Docker mysql:8.4 + sysbench）

```bash
export MYSQL_PWD='<自己设置>'
docker run -d --name perf -e MYSQL_ROOT_PASSWORD="$MYSQL_PWD" -p 3306:3306 mysql:8.4 --innodb-buffer-pool-size=512M
# sysbench 装在宿主机或 WSL Ubuntu：sudo apt install sysbench
mysql -h127.0.0.1 -uroot -e "CREATE DATABASE sbtest"
SB="sysbench --mysql-host=127.0.0.1 --mysql-user=root --mysql-password=$MYSQL_PWD --mysql-db=sbtest --tables=8 --table-size=200000"
$SB oltp_read_write --threads=4 prepare

# 45 实验一：线程扩展；用 线程数 ÷ TPS ≈ 平均延迟 检验利特尔法则
for n in 1 2 4 8 16 32 64; do $SB oltp_read_only --threads=$n --time=20 --percentile=95 run | grep -E "transactions:|avg:|95th"; done

# 45 实验二：另起一个 --innodb-buffer-pool-size=64M 的容器对比（8.4 Linux 默认已 O_DIRECT）
mysql -h127.0.0.1 -uroot -e "SHOW GLOBAL STATUS LIKE 'Innodb_buffer_pool_read%'"   # 压测前后各一次相减

# 44：P_S / sys
$SB oltp_read_write --threads=4 --time=20 --db-ps-mode=disable run >/dev/null
mysql -h127.0.0.1 -uroot -e "SELECT LEFT(query,50), exec_count, total_latency FROM sys.statement_analysis WHERE db='sbtest' LIMIT 5;
  SELECT * FROM sys.waits_global_by_latency LIMIT 6; SELECT * FROM sys.memory_global_by_current_bytes LIMIT 5;
  SELECT * FROM sys.schema_unused_indexes WHERE object_schema='sbtest';"
```

**预期现象**：吞吐在线程数约等于核数时封顶，之后延迟随线程线性增长且满足 L ≈ λ × W；64 MB BP 下每秒磁盘读明显增加；COMMIT 与日志文件等待排在前列。具体数值取决于本地硬件。

::: tip 与 Redis、PG 对照
- **Redis**：`INFO` ≈ `SHOW GLOBAL STATUS`（同为累计值需做差）；`SLOWLOG` ≈ 慢日志；`LATENCY` ≈ 等待事件；单线程执行命令 = 只有一个灶台。
- **PG**：`pg_stat_statements` ≈ digest；`pg_stat_activity` ≈ `sys.session`；`pgbench` ≈ sysbench。PG 依赖 OS 页缓存（shared_buffers 通常不设很大），MySQL 倾向大 BP + O_DIRECT 自管缓存，内存参数不能照搬。
:::

## 八、与其他专题的关联

- **专题 12、14**：未用索引与 INVISIBLE 索引。
- **专题 18、22**：慢日志与 digest 互补；慢 SQL 定位流程。
- **专题 25–27**：锁等待视图。
- **专题 28–32**：BP、redo、doublewrite、binlog 刷盘在等待事件中的体现；8.4 默认值变化。
- **专题 49–50**：饱和点、利特尔法则用于容量规划与故障演练。

## 九、复习 checklist

- [ ] 能说出 P_S 的 instrument / consumer / 汇总表结构，以及 sys 与 `x$` 视图的关系
- [ ] 能把常见诊断问题对应到 sys 视图 / P_S 表
- [ ] 知道 digest 的含义、预处理语句与未用索引统计的坑、P_S 的局限
- [ ] 能用 USE 方法分析连接、CPU、内存、I/O、锁，并说出各自关键指标
- [ ] 会用计数器采样做差算速率
- [ ] 能用利特尔法则解释吞吐封顶后延迟随并发线性增长
- [ ] 能解释命中率为何会骗人，并用"未命中次数 × 单次延迟"估算 I/O 占用
- [ ] 能说出内存的全局 / 会话两部分及常见误算
- [ ] 能列出值得调的参数与 8.4 主要默认值变化
- [ ] 能说出 sysbench 三步与基准测试的常见陷阱
