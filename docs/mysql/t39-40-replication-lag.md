# 专题 39–40 · 复制原理、复制一致性与延迟（合并）

> 级别：39 ★ / 40 ★ · 主线 B / C（衔接 A）· 实测环境：沙箱两个 MySQL 8.0.46 实例（主 3310、从 3311，GTID 开启）

本篇回答：MySQL 为什么复制 binlog 而不是 redo？复制链路有哪些线程、为什么要 relay log？位点和 GTID 各解决什么问题？异步、半同步（AFTER_SYNC / AFTER_COMMIT）的区别？延迟从哪来、怎么量才准？并行复制怎样判断事务可并行？读写分离如何保证"写后读"？

动画：<a href="/xbb-notes/mysql-t39-replication.html" target="_blank">复制链路与半同步（逐步动画）</a>

## 模块八大纲

```
单机三问题：宕机即停服务；读压力扛不住；坏了没副本
        ▼
复制（39）：把主库变更持续送到从库重放
        ▼
复制的新问题（40）：从库落后多少？读从库会不会读到旧值？怎么追得更快？
        ▼
复制运维（41）：拓扑、中断、修复
        ▼
用复制做高可用（42）：主库挂了谁接替？会不会丢数据、出现两个主库？
        ▼
复制不能替代备份（43）：误删会被立刻复制 → 备份 + 时间点恢复
```

| 层级 | 知识点 | 专题 |
| --- | --- | --- |
| ★ | 复制链路（Dump 线程、接收线程、relay log、回放线程）；位点与 GTID；异步与半同步（AFTER_SYNC） | 39 |
| ★ | 延迟组成与来源；`Seconds_Behind_Source` 含义与陷阱；并行复制（COMMIT_ORDER / WRITESET）；写后读 | 40 |
| ★ | 故障切换流程；数据不丢的条件；脑裂与隔离；MGR / InnoDB Cluster 思路 | 42 |
| ☆ | 一主多从、级联、双主；复制中断（主键冲突、errant GTID）与修复；从库只读 | 41 |
| ☆ | 逻辑 / 物理备份；全量 + binlog 时间点恢复；误删补救 | 43 |
| ○ | 多源复制、延迟复制、过滤复制、Clone 插件 | 41、43 |

## 在三条主线中的位置

```
B 一致性：事务 → redo / binlog（专题 32）→【复制：binlog 送到从库重放】→ 高可用（42）
C 诊断：延迟报警 → GTID 对比 / 心跳 → 卡在接收还是回放 → 大事务 / DDL / 锁 / 串行依赖 → 处理
A 性能：并行复制
```

## 一、为什么复制 binlog（专题 39）

目标：另一台机器上维持一份与主库**持续一致**的数据。

| 朴素方案 | 问题 |
| --- | --- |
| 应用双写两个库 | 一边成功一边失败即不一致；并发写入顺序可能不同 |
| 定期拷贝数据文件 | 拷贝之间的变更会丢；每次全量代价大 |
| **持续传"变更记录"，对方按顺序重放** | ✅ 只传增量，顺序有保证 |

传哪份日志？

| | redo log | binlog |
| --- | --- | --- |
| 归属 | InnoDB 内部 | Server 层 |
| 内容 | 物理："某页某偏移改成什么" | 逻辑：ROW 格式记"某表某行从什么变成什么" |
| 生命周期 | 循环覆盖 | 按文件追加保留（8.4 默认 30 天） |
| 能否发给另一台机器 | 不适合：页号依赖本机物理布局 | **适合**：与引擎、物理布局无关 |

所以复制传 **binlog**。这也是专题 32 两阶段提交的意义：binlog 是从库唯一的数据来源，必须与主库引擎数据严格一致。

## 二、复制链路的推导

**谁发起？** 只有从库知道自己缺什么 → **从库主动连主库**并说明从哪开始；主库为每个从库开一个 **Binlog Dump 线程**持续推送。

**从库能否一个线程边收边执行？** 不能：执行慢于接收，执行卡住时接收也停，未收到的变更只在主库上，主库宕机即丢。→ **接收与执行拆开**：

```
主库                                      从库
┌────────────┐   binlog event   ┌─────────────────────┐
│ binlog 文件 │ ───────────────▶ │ 接收线程 replica_io   │ 只负责快速收下并落盘
│     ▲       │  Binlog Dump 线程 │        ▼             │
│ 事务提交写入 │                  │ relay log（中继日志） │ = 从库本地的一份 binlog
└────────────┘                   │        ▼             │
                                 │ 协调线程 replica_sql  │ 读 relay log，分发事务
                                 │        ▼             │
                                 │ worker 线程 × 4       │ 并行回放（第六节）
                                 └─────────────────────┘
```

沙箱线程（真实输出）：

```
主库：id=10  Binlog Dump GTID   Source has sent all binlog to replica; waiting for more updates
从库：thread/sql/replica_io      Waiting for source to send event
      thread/sql/replica_sql     Replica has read all relay log; waiting for more updates
      thread/sql/replica_worker  Waiting for an event from Coordinator     ×4
```

> **术语**：8.0.22–8.0.26 把 master/slave 改称 source/replica。**8.4.0 已删除旧语句**：`START SLAVE`、`SHOW SLAVE STATUS`、`CHANGE MASTER TO`、`RESET MASTER`、`SHOW MASTER STATUS`（改为 `SHOW BINARY LOG STATUS`）等（8.4.0 release notes）。

### 跟踪一个事务（真实输出）

主库 `UPDATE lab.t_acct SET balance = balance - 100 WHERE id = 1`（1000 → 900）：

```
① 主库 binlog：
SET @@SESSION.GTID_NEXT= 'a3472df6-e4ba-11f1-bdd4-02fc00000001:6'
#261120 16:18:16 server id 1 ... Update_rows
### UPDATE `lab`.`t_acct`  WHERE @1=1 @2=1000  SET @1=1 @2=900
#261120 16:18:16 server id 1 ... Xid = 34
② 从库 relay log：内容相同，server id 1，GTID …:6
③ 从库自己的 binlog：GTID 仍为 …:6，server id 仍为 1
从库：id=1 balance=900，@@gtid_executed = …:1-6
```

- 从库回放时也写自己的 binlog（`log_replica_updates`，实测 ON）→ 可级联、可直接升为新主库（41、42）。
- 事务"身份"（GTID、原始 server id）在整个链路上不变。

## 三、位点 → GTID

**位点（file + position）**：如"`binlog.000002` 第 706 字节"。问题：**位点只在一台服务器上有意义**——同一事务在 A 与 B 的 binlog 中位置不同，换主库要人工换算。

**GTID（Global Transaction Identifier）**：

```
GTID = 事务首次提交所在服务器的 server_uuid : 该服务器上的事务序号
例：a3472df6-e4ba-11f1-bdd4-02fc00000001:6
```

| 集合 | 含义 | 在哪看 |
| --- | --- | --- |
| `gtid_executed` | 本机已执行（提交）的全部事务 | `SELECT @@gtid_executed` |
| `Retrieved_Gtid_Set` | 从库**已收到**、写入 relay log 的 | `SHOW REPLICA STATUS` |
| `Executed_Gtid_Set` | 从库**已执行**的 | `SHOW REPLICA STATUS` |

断点续传 / 换主库：从库把 `gtid_executed` 发给主库，主库补发缺少的事务（`SOURCE_AUTO_POSITION=1`），无需位点换算。

> **错误 vs 正确**
> - ❌ Retrieved 里有了 = 数据已同步。
> - ✅ Retrieved 只是收到；Executed 才是生效。两者之差 = 已收到未回放的积压。

`gtid_mode` 在 8.0、8.4 **默认 OFF**；开启前需 `enforce_gtid_consistency=ON`，且只能 OFF → OFF_PERMISSIVE → ON_PERMISSIVE → ON 逐步切换（8.4 手册）。

## 四、异步与半同步

### 4.1 异步（默认）

主库提交不等从库：

```
binlog 落盘 → 引擎提交 → 返回成功 ……→ event 才到从库
                          ↑ 此时主库宕机并切到从库 → 已确认成功的事务在新主库上不存在
```

### 4.2 半同步

返回成功前等至少一个从库 **ACK**（已收到并写入 relay log）；数量由 `rpl_semi_sync_source_wait_for_replica_count` 决定，默认 1。

```
AFTER_COMMIT（旧）：binlog 刷盘 → 引擎提交（他人已可见）→ 等 ACK → 返回
AFTER_SYNC（默认）：binlog 刷盘 → 等 ACK → 引擎提交 → 返回
```

等 ACK 期间另一会话在**主库**读同一行（真实输出）：

```
AFTER_SYNC  : before=1100; ... another session on SOURCE reads 1100
AFTER_COMMIT: before=2100; ... another session on SOURCE reads 3100
```

AFTER_COMMIT 下别人已读到新值，若此时主库宕机且从库未收到，切换后"被人看见过的数据"消失；AFTER_SYNC 下丢的只是无人见过、客户端也未被告知成功的事务 → 称为无损半同步，是默认值（8.4 手册）。

### 4.3 半同步会退化（真实输出，timeout 设 3000 ms；默认 10000 ms）

```
1) replica online (semi-sync)              commit took     7 ms | status=ON
2) replica receiver stopped, 1st commit    commit took  3007 ms | status=OFF
3) 2nd commit (already fell back to async) commit took     7 ms | status=OFF
4) receiver restarted and caught up        commit took     9 ms | status=ON
错误日志：[Warning] [MY-011153] [Repl] Timeout waiting for reply of binlog ...
```

> **错误 vs 正确**
> - ❌ 开了半同步就不丢数据。✅ 只有状态 ON 期间的事务受保护；监控 `Rpl_semi_sync_source_status`、`Rpl_semi_sync_source_no_tx`。
> - ❌ 半同步保证从库已执行。✅ 只保证**收到并写入 relay log**，从库仍可能读到旧值。

传统复制没有"全同步"模式；更强一致性见 MGR（专题 42）。

### 4.4 两个危险默认值

| 项目 | 默认 | 后果 | 做法 |
| --- | --- | --- | --- |
| 从库 `read_only` / `super_read_only` | 实测 **0**（可写） | 误写从库 → 主从分叉、主键冲突中断、errant GTID（41） | 从库 `super_read_only=ON` |
| `relay_log_recovery` | **OFF**（8.4 手册） | 手册：保证从库 crash-safe 必须开启 | 从库 `relay_log_recovery=ON` |

## 五、延迟：组成、度量与来源（专题 40）

```
主库提交 ──①发送──▶ 收到并写 relay log ──②排队──▶ 开始回放 ──③执行──▶ 从库提交
          通常毫秒级                    积压越多越久          与事务大小相关
```

延迟几乎都在 ②③（回放跟不上）。判断：Retrieved 有、Executed 没有 → 卡在回放；Retrieved 也没有 → 卡在接收。

### 5.1 实验：从库行锁挡住回放（真实输出）

```
[ 0.0s] source committed: id=2 balance = 1100
[ 1.5s] replica read id=2 -> 1050 | Seconds_Behind_Source=2 | Retrieved=1-8 Executed=1-7
        applier worker state: Applying batch of row changes (update)
[ 4.6s] replica read id=2 -> 1050 | Seconds_Behind_Source=5 | Retrieved=1-8 Executed=1-7
[ 7.6s] replica read id=2 -> 1100 | Seconds_Behind_Source=0 | Retrieved=1-8 Executed=1-8
```

收到未执行；worker 和普通事务一样要加锁，被从库查询挡住；延迟期间从库读到旧值。

### 5.2 `Seconds_Behind_Source` 的陷阱

手册定义：回放线程落后于处理主库 binlog 的秒数。event 头部带主库时间戳，可理解为"从库当前时间 − 正在回放事务的主库时间戳"（此为根据 event 结构与实验现象的理解，手册仅给出上述定义）。

| 现象 | 原因 | 佐证 |
| --- | --- | --- |
| 主库执行大事务时为 **0** | binlog 提交时才写，从库什么也没收到 | 5.3 实验前 2 秒为 0 |
| 大事务提交后**突然跳到**几秒 | 时间戳是事务开始执行时间 | 5.3 提交后立刻显示 3 |
| 回放线程停止时为 **NULL** | 无正在回放的事务 | 实测 `Replica_SQL_Running: No` 时 NULL |
| 网络断但未察觉时为 **0** | 无新 event，以为已追上 | 手册："not strictly true"，持续时间受 `replica_net_timeout` 限制 |

更可靠：**GTID 对比**（`GTID_SUBSET(主库 gtid_executed, 从库 gtid_executed)`）；**心跳表**（主库每秒写当前时间，从库读出相减，如 pt-heartbeat）。

### 5.3 来源一：大事务（真实输出，50 万行全表 UPDATE）

```
[  1.0s] source running   Seconds_Behind_Source=0
[  2.0s] source running   Seconds_Behind_Source=0
[  3.0s] source committed Seconds_Behind_Source=3
[  6.1s] source committed Seconds_Behind_Source=6
[  7.1s] source committed Seconds_Behind_Source=0  -> replica caught up
source exec 2.6s ; replica caught up ~4.5s after source commit
```

提交后才开始传；单个事务只能由一个 worker 回放；后面的事务要等它（提交顺序保证）。

### 5.4 来源二：DDL（真实输出）

```
ALTER ... MODIFY k BIGINT, ALGORITHM=COPY：source exec 1.8s；replica caught up ~2.2s after commit
DDL 后紧跟一条单行 UPDATE：
  source: DDL 1.62s, then small UPDATE committed at 1.63s
  replica: small UPDATE visible at 3.18s (= 1.55s after its source commit)
```

DDL 在从库完整重放且不与其他事务并行，挡住后续事务 → gh-ost 按从库延迟限速（专题 36）。

### 5.5 来源三：从库资源 / 干扰

从库慢查询、长事务抢资源或持锁（5.1）；硬件弱或 `innodb_flush_log_at_trx_commit`、`sync_binlog` 配置不同。

## 六、并行复制

前提：**改同一行的两个事务，从库执行顺序必须与主库一致。** 问题：怎么知道哪些可并行？

| 方案 | 判断依据 | 局限 |
| --- | --- | --- |
| 按库（5.6） | 不同库可并行 | 多数业务只有一个库 |
| **COMMIT_ORDER**（逻辑时钟，8.0 默认） | 主库上同时处于提交阶段的事务 | 依赖主库并发；单连接顺序写 → 串行 |
| **WRITESET** | 修改行的主键 / 唯一键哈希无交集 | 需 ROW 格式；大事务仍单线程 |

**COMMIT_ORDER 推理**：

```
两个事务同时处于提交阶段 → 都已拿到各自全部行锁（锁持有到提交，专题 25）
→ 若改了同一行，必有一个在等锁，不可能同时进入提交阶段
→ 同时处于提交阶段 ⇒ 无行冲突 ⇒ 可并行回放
```

binlog 头记两个数：`sequence_number`（本事务提交序号）、`last_committed`（本事务进入提交阶段时已提交的最后序号）。规则：**序号 ≤ 自己 `last_committed` 的事务都已提交，即可开始回放**。

真实 binlog（8 客户端并发）：

```
last_committed=24007  sequence_number=24008
last_committed=24007  sequence_number=24009     ← 与上一行相同 → 可并行
最近 12000 个事务：3562 组，平均每组 3.4 个
```

实验（真实输出）：

```
积压 12000 个事务（8 客户端产生）：
  workers=4 → replica applied backlog in 3.8s
  workers=1 → replica applied backlog in 7.8s

单客户端顺序 6000 个事务（各改不同行），workers=4：
  COMMIT_ORDER：4.3s   avg(sequence_number-last_committed)=1.0  max=1      ← 串行
  WRITESET    ：2.3s   avg(sequence_number-last_committed)=3000.5 max=6000 ← 全部可并行
```

| 项目 | 8.0 | 8.4 |
| --- | --- | --- |
| `binlog_transaction_dependency_tracking` | 默认 COMMIT_ORDER（实测），可设 WRITESET；8.0.35 起弃用 | **已删除**；多线程从库时主库总用 writeset，等同以前的 WRITESET |
| `replica_parallel_workers` | 8.0.27 起默认 4 | 同 |
| `replica_parallel_type` | 8.0.27 起默认 LOGICAL_CLOCK | 同 |
| `replica_preserve_commit_order` | 8.0.27 起默认 1 | 同 |

**为何保留提交顺序**：否则从库可能先提交 T2 后提交 T1，间隙里读到主库从未出现过的状态，`gtid_executed` 也会出现空洞。代价：先执行完的也要等前面的提交。

> **错误 vs 正确**
> - ❌ 开了并行复制就不会有延迟。✅ 并行只在事务之间；大事务、DDL 仍串行并挡住后面的事务。

## 七、读写分离的"写后读"

用户改昵称（写主库）后立即刷新（读从库）看到旧值 = 5.1 实验的业务版本。**半同步不能解决**（只保证收到）。

| 方案 | 做法 | 优点 | 代价 |
| --- | --- | --- | --- |
| 关键读走主库 | 一致性敏感查询直接读主库 | 简单可靠 | 主库读压力 |
| 写后 N 秒读主库 | 用户写后 N 秒内其读请求发主库 | 实现简单 | N 是估计值 |
| **等 GTID** | 写后拿本事务 GTID，读从库前等其执行完 | 精确 | 需中间件 / 驱动支持；延迟大时阻塞 |
| 按延迟路由 | 延迟超阈值切主库 | 自动 | 依赖延迟指标准确性 |

实验（真实输出）：

```
[0.0s] source: balance=3101  gtid_executed after commit = a3472df6-...:1-36021
[0.0s] replica plain read: balance=3100
[2.0s] replica WAIT_FOR_EXECUTED_GTID_SET(...,2) returned 1  (1 = timed out)
[4.5s] replica WAIT_FOR_EXECUTED_GTID_SET(...,10) returned 0  (0 = reached); now read: balance=3101
```

取本事务 GTID 更精确的做法：`session_track_gtids=OWN_GTID`（实测默认 OFF），服务器在提交响应包中带回本事务 GTID，由驱动 / 中间件读取；`@@gtid_executed` 是全实例集合，会多等别人的事务。

## 八、串联图

```
主库提交：redo prepare → binlog 刷盘 → [AFTER_SYNC 等 ACK] → redo commit → 返回成功
   │ Binlog Dump 线程
   ▼
从库接收线程 → relay log（Retrieved）→ [回 ACK] → 协调线程 → worker × 4 → 提交（Executed）+ 写自己的 binlog
断点续传 / 换主库：GTID 集合自动补齐

延迟 = 发送（小）+ 排队 + 回放（主要）
  量：GTID 对比 / 心跳；Seconds_Behind_Source 有 0、跳变、NULL 陷阱
  源：大事务、DDL、从库锁 / 资源、依赖串行
  并行：按库 → COMMIT_ORDER → WRITESET（8.4 固定）；提交按主库顺序
写后读：关键读走主库 / 写后 N 秒读主库 / GTID 等待
半同步解决"主库宕机丢数据"，不解决"从库读到旧值"
```

## 九、诊断实践：复制延迟报警

```
① 确认真延迟：GTID_SUBSET 对比或心跳表，不只看 Seconds_Behind_Source
② 判断卡在哪段：Retrieved 落后主库 → 接收（网络 / Dump 线程）；Executed 落后 Retrieved → 回放（多数）
③ 看 worker：
     SELECT * FROM performance_schema.replication_applier_status_by_worker;   -- 正在回放的 GTID、开始时间、错误
     SELECT NAME, PROCESSLIST_STATE FROM performance_schema.threads WHERE NAME LIKE 'thread/sql/replica%';
④ 对号入座：
     某 GTID 回放很久 → 主库 binlog 中找该 GTID：大事务还是 DDL？
     worker 等锁 → 从库 sys.innodb_lock_waits（专题 27）找挡路查询
     worker 多数空闲仍追不上 → 依赖太串行（8.0 考虑 WRITESET）或从库 I/O 不足
⑤ 处理与预防：拆大事务；大表变更用工具并按延迟限速；从库只读并控制慢查询；读写分离加写后读策略
```

## 十、本地复现（Docker mysql:8.4）

```bash
# 密码只放环境变量
export MYSQL_PWD='<自己设置>'
docker network create rpl
for n in src rep; do
  id=1; [ $n = rep ] && id=2
  docker run -d --name $n --network rpl -e MYSQL_ROOT_PASSWORD="$MYSQL_PWD" mysql:8.4 \
    --server-id=$id --gtid-mode=ON --enforce-gtid-consistency=ON
done
sleep 30
docker exec -e MYSQL_PWD src mysql -uroot -e "CREATE USER 'repl'@'%' IDENTIFIED BY '$MYSQL_PWD'; GRANT REPLICATION SLAVE ON *.* TO 'repl'@'%';"
docker exec -e MYSQL_PWD rep mysql -uroot -e "CHANGE REPLICATION SOURCE TO SOURCE_HOST='src', SOURCE_USER='repl', SOURCE_PASSWORD='$MYSQL_PWD', SOURCE_AUTO_POSITION=1, GET_SOURCE_PUBLIC_KEY=1; START REPLICA;"
docker exec -e MYSQL_PWD rep mysql -uroot -e "SHOW REPLICA STATUS\G" | grep -E "Running:|Seconds_Behind|Gtid_Set"
```

```sql
-- 一、跟踪一个事务（主库）
CREATE DATABASE lab; CREATE TABLE lab.t_acct(id INT PRIMARY KEY, balance INT NOT NULL);
INSERT INTO lab.t_acct VALUES (1,1000),(2,1000);
UPDATE lab.t_acct SET balance = balance - 100 WHERE id = 1;
SELECT @@gtid_executed;           -- 主从对比；容器内用 mysqlbinlog -v 解码 binlog 与 relay log

-- 二、回放被锁挡住：从库窗口 1  BEGIN; SELECT * FROM lab.t_acct WHERE id = 2 FOR UPDATE;（不提交）
--   主库：UPDATE lab.t_acct SET balance = balance + 50 WHERE id = 2;
--   从库窗口 2：SHOW REPLICA STATUS\G 看 Retrieved / Executed / Seconds_Behind_Source；读 id=2 为旧值
--   从库窗口 1：COMMIT; 之后立刻追上

-- 三、大事务：主库建 50 万行表后 UPDATE 全表，每秒在从库看 Seconds_Behind_Source

-- 四、半同步
-- 主库：INSTALL PLUGIN rpl_semi_sync_source SONAME 'semisync_source.so';
--       SET GLOBAL rpl_semi_sync_source_enabled = 1; SET GLOBAL rpl_semi_sync_source_timeout = 3000;
-- 从库：INSTALL PLUGIN rpl_semi_sync_replica SONAME 'semisync_replica.so';
--       SET GLOBAL rpl_semi_sync_replica_enabled = 1; STOP REPLICA IO_THREAD; START REPLICA IO_THREAD;
-- 从库 STOP REPLICA IO_THREAD 后主库连续提交两次，观察耗时与 Rpl_semi_sync_source_status

-- 五、GTID 等待（从库）
SELECT WAIT_FOR_EXECUTED_GTID_SET('<主库提交后的 gtid_executed>', 2);
```

**预期现象**：与上文真实输出一致，耗时以本地为准。8.4 无 `binlog_transaction_dependency_tracking`，主库固定 writeset，单客户端也能并行回放，无法复现 COMMIT_ORDER 对照组。

::: tip 与 Redis、PG 对照
- **Redis**：默认异步，用复制偏移量（offset）表示进度（≈ 位点）；`WAIT numreplicas timeout` ≈ 半同步；切换后续传依赖 replication ID，MySQL 用 GTID 集合。
- **PG 流复制**：传 WAL（物理，≈ redo），从库物理上与主库相同且天然只读（hot standby）；MySQL 传逻辑 binlog，从库默认可写。`synchronous_commit=remote_apply` 等从库**执行完**才返回，可直接解决写后读，MySQL 传统半同步没有此级别。
:::

## 十一、与其他专题的关联

- **专题 25–27**：从库回放同样加锁，会被从库查询挡住；用锁诊断方法排查。
- **专题 31**：大事务的危害（回滚段、复制延迟）。
- **专题 32–33**：binlog 格式、两阶段提交、XID；半同步 AFTER_SYNC 插在两阶段提交中间。
- **专题 36**：DDL 在从库重放导致延迟；gh-ost 依赖 ROW binlog 并按延迟限速。
- **专题 41–42**：从库只读、errant GTID、故障切换与数据不丢条件。

## 十二、复习 checklist

- [ ] 能说明复制 binlog 而非 redo 的原因
- [ ] 能画出复制链路，并解释为什么接收与回放要拆开、relay log 的作用
- [ ] 能区分 `gtid_executed`、Retrieved、Executed，说出 GTID 相比位点解决的问题
- [ ] 能对比异步、半同步 AFTER_SYNC、AFTER_COMMIT 在主库宕机时的数据风险，并说出半同步退化条件
- [ ] 知道从库默认可写、`relay_log_recovery` 默认关闭的风险
- [ ] 能拆解延迟的组成，说出 `Seconds_Behind_Source` 的四个陷阱和更可靠的度量方式
- [ ] 能解释大事务、DDL 导致延迟的机制
- [ ] 能推导 COMMIT_ORDER 为何可并行，解释 `last_committed` / `sequence_number`，并说明 WRITESET 的改进与 8.4 变化
- [ ] 知道 `replica_preserve_commit_order` 的作用与代价
- [ ] 能给出写后读的几种方案及取舍，并会用 `WAIT_FOR_EXECUTED_GTID_SET`
