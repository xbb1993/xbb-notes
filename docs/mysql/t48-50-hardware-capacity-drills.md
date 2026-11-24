# 专题 48–50 · 硬件与操作系统、容量规划、生产问题综合演练（合并）

> 级别：48 ○ / 49 ☆ / 50 ★ · 主线 C（衔接 A / B）· 实测环境：沙箱 MySQL 8.0.46，2 vCPU / 8 GB，sysbench 与数据库同机；数据 8 张表 × 20 万行

本篇回答：硬件各部分分别决定什么？业务增长后需要多少 CPU、连接、内存、磁盘，什么时候必须改架构？慢 SQL 打满 CPU、连接数打满、热点行锁风暴、长事务拖住 purge，各自怎样从现象一路定位到根因并验证修复？

## 在三条主线中的位置

```
C 诊断（完整走一遍）：问题 → 现象 → 指标 → SQL → EXPLAIN → 锁 / I/O / CPU / 内存 → 定位 → 优化 → 验证
A 性能 + B 可靠性：容量规划 = 算清"单机能扛多少"与"故障时还剩多少"
```

## 一、硬件与操作系统（专题 48）

| 方面 | 要点 | 关联 |
| --- | --- | --- |
| **CPU** | 一条 SQL 基本只用一个核（8.0 部分并行读除外）→ 单条慢 SQL 看**单核性能**，并发吞吐看**核数** | 45 实验一 |
| **内存** | 决定 BP 能装多少热数据；被换出到 swap 比少几 GB BP 更糟 | 28、45 实验二 |
| **存储** | 关注 IOPS 与单次延迟；本地 NVMe 通常远低于网络云盘。双 1 下每次提交都 fsync → **写延迟直接决定提交速度** | 29、44（COMMIT 耗时最多） |
| **NUMA** | 多路服务器每颗 CPU 访问本地内存更快；8.4 `innodb_numa_interleave` 默认 ON，BP 在各节点交错分配（8.4 手册） | 46 |
| **Linux** | 降低 swappiness；数据文件 O_DIRECT 避免 BP 与页缓存重复缓存（8.4 Linux 默认 O_DIRECT）；常用 XFS / ext4 | 45 实验二 |

## 二、容量规划（专题 49）

问题："业务翻两倍，撑不撑得住？要多大机器？何时拆库？"——把专题 45 的资源逐个换算，每步需要**业务增长数据**与**单位资源能力**（基准测试或生产监控）。以下业务数字为**假设**，单位能力取自沙箱实测。

### 2.1 逐项推算

**① CPU**

```
所需核数 = 峰值 QPS ÷ 单核能承受的 QPS ÷ 目标使用率
单核能力（沙箱）：oltp_read_only 2 vCPU 封顶约 2500 TPS × 16 条/事务 ≈ 4 万 QPS → 约 2 万 QPS/核（含 sysbench 开销，偏保守）
目标使用率 60%（留尖峰与故障切换余量）
假设峰值 3 万 QPS：3 万 ÷ 2 万 ÷ 0.6 = 2.5 → 至少 4 核
```

- 单核能力强烈依赖 SQL 构成：一条扫 20 万行的查询抵几千次主键查询（演练一）→ 用自己业务的 SQL 压测，或取生产"每核实际 QPS"。
- 读写分离按 **N+1**：一台从库故障后其余要接住其流量。

**② 连接数（利特尔法则 L = λ × W）**

```
同时在库内执行的请求数 = QPS × 每条 SQL 库内平均耗时
假设 3 万 QPS × 0.5 ms = 15 → 连接池总和几十即可
max_connections = 所有应用连接池上限之和 + 管理余量
```

**③ 内存**：BP 装下**热数据**而非全部；观测 `Innodb_buffer_pool_reads`/s 稳定在低位；热数据通常随活跃用户增长。

**④ 磁盘**

```
总空间 ≈ 数据 × (1 + 索引占比) × 增长倍数
       + binlog 日写入量 × 保留天数（binlog_expire_logs_seconds 默认 30 天）
       + undo 膨胀（演练四：长事务 60 秒积压 34 万条）
       + COPY DDL / gh-ost 影子表的额外一份表空间（36）
       + 本机备份（若有）
```

**⑤ 写入天花板**：写只能在主库；**同一行更新只能串行**：

```
同一行每秒最多更新次数 ≈ 1 ÷ 每次持锁时间
演练三：1731 TPS → 每次持锁约 0.58 ms（锁持有到提交，提交含刷盘）
与核数无关，加机器无效，只能设计上拆热点
```

### 2.2 何时改架构

| 瓶颈 | 先做 | 再做（模块十） |
| --- | --- | --- |
| 读 QPS 不够 | SQL / 索引优化 → 从库读写分离（40）→ 缓存（Redis） | — |
| 写 QPS 不够 | 批量写、减少每事务语句数、优化热点行 | 分库分表 |
| 单表太大 | 归档、分区（37） | 分库分表 |
| 单机存储不够 | 归档、压缩 | 分库分表 |

## 三、生产问题综合演练（专题 50）

### 3.0 通用流程

```
① 止血：先恢复业务（KILL、限流、切流、扩容），不追根因
② 定位：现象 → 哪种资源饱和（45）→ 哪类 SQL / 会话（44）→ 为什么（EXPLAIN / 锁 / 事务）
③ 修复：根治（加索引、改 SQL、改设计）
④ 验证：同样的指标回到正常
⑤ 复盘：怎样提前发现（告警）、怎样避免再发生（规范、评审）
```

### 演练一：慢 SQL 打满 CPU（真实输出）

场景：4 并发主键点查（`oltp_point_select`）；新功能上线，6 个会话循环执行无索引查询 `SELECT COUNT(*) FROM sbtest.sbtest1 WHERE c = '...'`。

```
① 现象
【基线】  point_select 4thr: TPS=67884  avg=0.06ms  p95=0.14ms
【注入后】point_select 4thr: TPS=27415  avg=0.15ms  p95=0.22ms        ← 无关的主键查询也变慢
          Threads_running(avg)=7.6  cpu user=90% sys=6% idle=0%  bp_reads(disk)=0

② 定位
processlist：24304  0  executing  SELECT COUNT(*) FROM sbtest.sbtest1 WHERE c = 'not-exist-6' ...
Top SQL（digest 汇总，取自本演练第一次运行）：
digest                                                       calls  total_s  avg_ms  exam_per_call  sent_per_call  no_idx
SELECT COUNT ( * ) FROM `sbtest` . `sbtest1` WHERE `c` = ?   949    120.2    126.6   200000         1              949
EXPLAIN：type=ALL  key=NULL  rows=197352  Extra=Using where

③ 处置：ALTER TABLE sbtest.sbtest1 ADD INDEX idx_c(c), ALGORITHM=INPLACE, LOCK=NONE  → 1.7s
   EXPLAIN：type=ref  key=idx_c  rows=1  Extra=Using where; Using index

④ 验证（坏查询仍在循环）
point_select 4thr: TPS=80712  avg=0.05ms  p95=0.08ms
坏查询：calls=4043（4 秒内） avg_ms=0.171  exam_per_call=0   Threads_running(avg)=2.2
```

- CPU 饱和（idle=0、Threads_running ≫ 2 核），I/O 与锁正常 → 去 Top SQL。
- 单次一百多毫秒，远低于慢日志默认 10 秒，processlist 中 `time` 都是 0 → **只看慢日志 / processlist 会漏掉**；digest 一眼看出：949 次累计 120 秒、每次扫 20 万行返回 1 行、`no_idx` = 调用次数。
- 止血也可 `KILL QUERY` 或下线功能；加索引是根治。修复后 TPS 略高于基线属于专题 47 的波动。

### 演练二：连接数打满（真实输出）

```
max_connections=30，应用 40 个连接压测：
FATAL: error 1040: Too many connections
Connection_errors_max_connections = 11
Max_used_connections              = 31
Aborted_connects                  = 2
先占满 30 个普通连接：
  普通用户：ERROR 1040 (08004): Too many connections
  root：    连接成功，Threads_connected=31        ← 管理员仍可多连 1 个
连接在干什么（按 user / command / state 分组）：
  sb  Query  User sleep  30  max_time=2
```

- 预留的管理连接是止血通道 → **应用不要用有管理权限的账号**。
- 按 `user / command / state` 分组最直观，三种常见原因：大量 `Sleep`（连接池过大 / 泄漏）；大量执行中且增长（库变慢 → 请求积压 → 不断新建连接的雪崩）；某刻突然暴涨（扩容、重启、缓存失效流量打到库）。
- 根治：按利特尔法则设连接池；`max_connections` = 连接池上限之和 + 余量。

> **错误 vs 正确**
> - ❌ 连接满了就调大 `max_connections`。
> - ✅ 若根因是库变慢，调大只会挤进更多请求（45 实验一：64 线程吞吐低于 8 线程、延迟高 8 倍）→ 先找变慢原因。

### 演练三：热点行锁风暴（真实输出）

16 线程单行更新（`oltp_update_non_index`），运行时 `--table-size` 控制更新落在多少行：

```
【基线】分布在 20 万行：TPS=6559  avg=2.44ms  p95=3.96ms   row_lock_waits=25/s
【现象】全部同一行：    TPS=1731  avg=9.24ms  p95=12.52ms  row_lock_waits=1744/s
   sys.innodb_lock_waits：waiting=55  locked_table=`sbtest`.`sbtest1`  locked_index=PRIMARY
   innodb_trx 中 LOCK WAIT：15
   Innodb_row_lock_time_avg = 8 ms
【处置示意】分散到 16 行：TPS=2648  avg=6.04ms  p95=12.08ms  row_lock_waits=1968/s
```

- 16 个线程 15 个在 LOCK WAIT：同一时刻只有 1 个在干活；CPU 不忙，瓶颈是锁。
- **易混**：`sys.innodb_lock_waits` 每行是一对"等待者–阻塞者"，一个事务可能被多个前序事务挡住，所以 55 行 ≠ 55 个等待者；数等待人数看 `innodb_trx` 的 `LOCK WAIT`。
- 同一行吞吐上限 ≈ 1 ÷ 持锁时间，与核数无关。

| 处置 | 原理 | 代价 |
| --- | --- | --- |
| 拆分热点行（分桶） | 计数器拆 N 行，随机更新其一，读时求和（16 桶：1731 → 2648） | 读复杂；16 线程随机落 16 桶仍有冲突 |
| 缩短持锁 | 热点 UPDATE 放事务最后一步，提交前不做耗时操作（26、27） | 调整业务代码顺序 |
| 库外排队 / 合并 | 应用层或 Redis 先合并扣减，再批量写库 | 一致性设计更复杂 |

### 演练四：长事务拖住 purge（真实输出）

一个会话 `START TRANSACTION WITH CONSISTENT SNAPSHOT` 后不提交；8 线程持续更新 sbtest1：

```
[t=0]   history list length = 0
[t=15s] history list length = 76988
[t=30s] history list length = 165824
[t=45s] history list length = 259025
[t=60s] history list length = 339912          ← 只增不减
最老事务：thread=43485  age_s=60  trx_state=RUNNING  trx_rows_modified=0  REPEATABLE READ
同一条 SELECT SUM(k) FROM sbtest1：
  长事务开始时 0.05 sec → 60 秒后在长事务里 0.31 sec（沿 undo 链回溯旧版本）→ 新事务中 0.03 sec
提交后：339912 → 5 秒后 0
```

- 长事务的 Read View 仍需看到 60 秒前的版本 → 这期间的 undo 都不能 purge（24、31）。
- **只读事务也会造成**：`trx_rows_modified=0` 不代表无害，持有老 Read View 就够了。
- 后果：长事务自身查询越来越慢；undo 表空间膨胀；purge 欠账拖慢整个实例。提交后 purge 很快追上。
- 预防：监控 `trx_rseg_history_len` 与 `innodb_trx` 最长存活时间；事务内不做远程调用 / 等用户；报表放从库（从库长事务同样拖住从库 purge）。

### 演练五：复制延迟

见专题 39–40 笔记第九节：GTID 对比 / 心跳确认 → 判断卡在接收还是回放 → 大事务、DDL、从库锁、依赖串行对号入座。

## 四、故障速查表

| 现象 | 第一眼看 | 常见根因 | 止血 | 根治 | 专题 |
| --- | --- | --- | --- | --- | --- |
| CPU 打满，整体变慢 | `Threads_running`；digest 按总耗时排序 | 缺索引 SQL、计划突变 | KILL / 下线功能 | 加索引、改写、固定计划 | 12、15、21、演练一 |
| ERROR 1040 | processlist 按 user/command/state 分组 | 连接泄漏、池过大、变慢引发雪崩 | KILL Sleep；找变慢原因 | 按利特尔法则设连接池 | 45、演练二 |
| 写 TPS 骤降、CPU 不高 | `Innodb_row_lock_waits`/s；`innodb_trx` LOCK WAIT | 热点行、长事务持锁 | KILL 阻塞者 | 拆热点、缩短事务 | 25–27、演练三 |
| 查询越来越慢、undo 膨胀 | history list；最老事务存活时间 | 长事务（含只读） | KILL 长事务 | 监控事务时长、规范边界 | 24、31、演练四 |
| 磁盘读暴涨 | `Innodb_buffer_pool_reads`/s；P_S 文件延迟 | 热数据超出 BP、大查询扫冷数据 | 限制大查询 | 加内存、优化 SQL、冷热分离 | 28、45 |
| DDL 后整表卡死 | `Waiting for table metadata lock` | 长事务挡住 MDL | KILL 长事务 / 放弃 DDL | DDL 前三项检查 | 25、36 |
| 从库延迟 | GTID 对比、worker 状态 | 大事务、DDL、锁、依赖串行 | — | 拆小事务、限速、并行复制 | 40 |
| 提交慢 | COMMIT digest 耗时；redo / binlog 文件等待 | 存储写延迟高 | — | 更快存储、组提交 | 29、32、44 |

## 五、串联图

```
硬件（48）：单核性能 → 单条 SQL 速度；核数 → 吞吐；内存 → 热数据命中；存储写延迟 → 提交速度
容量规划（49）：CPU = 峰值 QPS ÷ 单核能力 ÷ 目标使用率；连接 = QPS × 耗时
               内存看热数据；磁盘算 binlog、undo、DDL 余量；写入受单主库与热点行限制 → 何时拆库
综合演练（50）：止血 → 定位 → 修复 → 验证 → 复盘
  CPU 满 → digest 找"单次快但扫描多" → 加索引
  1040   → 看连接在干什么 → 按利特尔法则设池，不盲目调大
  锁风暴 → LOCK WAIT 计数 → 拆热点、缩短持锁
  长事务 → history list 与最老事务 → KILL 并监控
  复制延迟 → 专题 40
```

## 六、诊断实践：值班检查单

```
□ 吞吐 / 延迟（p95、p99）是否异常？从什么时刻开始？同时发生了什么变更（发布、DDL、扩容）？
□ CPU：idle 与 Threads_running / 核数
□ 连接：Threads_connected vs max_connections，processlist 分组
□ 锁：Innodb_row_lock_waits/s，innodb_trx 中 LOCK WAIT 与最老事务
□ I/O：Innodb_buffer_pool_reads/s，P_S 文件延迟，COMMIT 耗时
□ 后台：history list length，复制延迟
□ Top SQL：digest 按总耗时 / 扫描行数排序 → EXPLAIN
□ 止血后保留现场（digest、processlist、innodb_trx、锁视图的输出）再做根治
```

## 七、本地复现（Docker mysql:8.4 + sysbench）

```bash
# 沿用专题 44–47 的 perf 容器与 sbtest 数据；密码只放环境变量
SB="sysbench --mysql-host=127.0.0.1 --mysql-user=root --mysql-password=$MYSQL_PWD --mysql-db=sbtest --tables=8 --table-size=200000"
q(){ mysql -h127.0.0.1 -uroot -e "$1"; }

# 演练一：慢 SQL 打满 CPU
$SB oltp_point_select --threads=4 --time=15 run | grep -E "transactions:|avg:"
for i in 1 2 3 4 5 6; do ( for j in $(seq 1 300); do q "SELECT COUNT(*) FROM sbtest.sbtest1 WHERE c='x$i'" >/dev/null; done ) & done
$SB oltp_point_select --threads=4 --time=15 run | grep -E "transactions:|avg:"
q "SELECT LEFT(DIGEST_TEXT,60), COUNT_STAR, ROUND(AVG_TIMER_WAIT/1e9,1) avg_ms, SUM_ROWS_EXAMINED/COUNT_STAR, SUM_NO_INDEX_USED FROM performance_schema.events_statements_summary_by_digest ORDER BY SUM_TIMER_WAIT DESC LIMIT 3"
q "ALTER TABLE sbtest.sbtest1 ADD INDEX idx_c(c), ALGORITHM=INPLACE, LOCK=NONE"
$SB oltp_point_select --threads=4 --time=15 run | grep -E "transactions:|avg:"
wait; q "ALTER TABLE sbtest.sbtest1 DROP INDEX idx_c"

# 演练二：连接打满
q "SET GLOBAL max_connections=30"; $SB oltp_read_only --threads=40 --time=10 run 2>&1 | grep -m1 1040
q "SHOW GLOBAL STATUS WHERE Variable_name IN ('Max_used_connections','Connection_errors_max_connections')"
q "SET GLOBAL max_connections=151"

# 演练三：热点行（运行时 --table-size=1 让所有更新落到 id=1）
for rows in 200000 1 16; do
  sysbench oltp_update_non_index --mysql-host=127.0.0.1 --mysql-user=root --mysql-password=$MYSQL_PWD --mysql-db=sbtest \
    --tables=1 --table-size=$rows --threads=16 --time=20 run | grep -E "transactions:|avg:"
done

# 演练四：长事务
# 窗口 1：START TRANSACTION WITH CONSISTENT SNAPSHOT; SELECT SUM(k) FROM sbtest.sbtest1;（不提交）
sysbench oltp_update_non_index --mysql-host=127.0.0.1 --mysql-user=root --mysql-password=$MYSQL_PWD --mysql-db=sbtest --tables=1 --table-size=200000 --threads=8 --time=60 run >/dev/null &
for i in 1 2 3 4; do sleep 15; q "SELECT COUNT FROM information_schema.INNODB_METRICS WHERE NAME='trx_rseg_history_len'"; done
# 窗口 1 再执行同一 SELECT 对比耗时，然后 COMMIT，观察回落
```

**预期现象**：趋势与上文一致——注入后点查吞吐明显下降、加索引后恢复；1040 且 root 可多连 1 个；同一行时吞吐骤降、LOCK WAIT 增多；history list 只增不减、提交后迅速回落。8.4 `innodb_purge_threads` 默认值不同（46），回落速度可能不同。

::: tip 与 Redis、架构师笔记对照
- 演练二"库变慢 → 连接堆积 → 雪崩"与 Redis 缓存雪崩是同一故障链两端。
- 演练三热点行对应 Redis 秒杀"库存先在 Redis 扣减、再异步落库"的动机。
- 3.0 流程与架构师笔记第 9 章（可靠性）故障管理一致。
:::

## 八、与其他专题的关联

- **专题 12、15、21、22**：索引、EXPLAIN、慢 SQL 成因与定位流程（演练一）。
- **专题 24、31**：Read View 与 purge（演练四）。
- **专题 25–27**：锁与锁诊断（演练三）。
- **专题 36**：在线加索引。
- **专题 40**：复制延迟（演练五）。
- **专题 44–47**：P_S / sys、USE、利特尔法则、基准测试波动。
- **模块十**：容量规划的尽头是分库分表。

## 九、复习 checklist

- [ ] 能说出单核性能、核数、内存、存储写延迟分别决定什么
- [ ] 能按 CPU、连接、内存、磁盘、写入五项做容量推算，并说出 N+1 与目标使用率的意义
- [ ] 能解释同一行更新吞吐上限 ≈ 1 ÷ 持锁时间，以及为何加机器无效
- [ ] 能复述"止血 → 定位 → 修复 → 验证 → 复盘"
- [ ] 能解释为何单次快但扫描多的 SQL 会被慢日志漏掉，并用 digest 找出来
- [ ] 能分析 ERROR 1040 的三类原因，并说明为何不能盲目调大 max_connections
- [ ] 能识别热点行锁风暴，区分 `sys.innodb_lock_waits` 行数与等待者数，并说出三种处置
- [ ] 能解释只读长事务为何也会让 history list 暴涨，以及其三种后果与预防
