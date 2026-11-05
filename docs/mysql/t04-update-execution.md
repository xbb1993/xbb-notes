# 专题 4 · 一条 UPDATE 怎么执行

> 级别 ★（核心）· 主线 B（一致性/可靠性）总览：锁 → undo → Buffer Pool → redo → binlog → 提交 · 实测版本：沙箱 MySQL 8.0.46，数据为专题 1 的 `lab.t_order`

专题 3 讲“读”，本专题讲“写”。全篇使用同一条 SQL：

```sql
UPDATE t_order SET amount = amount + 10 WHERE id = 500000;
```

本专题是总览，各部件的细节在后续专题展开：锁（25–27）、redo（29）、undo（31）、binlog 与两阶段提交（32）、崩溃恢复（33）。

## 一、一条 UPDATE 要满足的四个要求

| 要求 | 含义 | 反例 |
| --- | --- | --- |
| 改得对 | 两个会话同时 +10，结果必须是 +20 | 两个会话都读到 100，各自写回 110，丢失一次更新 |
| 能撤销 | 事务回滚时能恢复原值 | 改到一半出错，无法还原 |
| 不丢失 | 提交成功后立刻断电，数据仍在 | 返回成功，重启后却是旧值 |
| 能传播 | 从库、备份恢复能重放这次修改 | 主库改了，从库不知道 |

## 二、从朴素方案到 InnoDB 的方案

**朴素方案**：找到行所在的页，改掉，提交时把这个 16KB 的页写回磁盘。

| 问题 | 原因 |
| --- | --- |
| 慢 | 每次提交随机写若干个 16KB 的页，随机 I/O 代价高（专题 3） |
| 不安全 | 写页写到一半断电，页会损坏（一半新数据、一半旧数据） |
| 无法回滚 | 原值已被覆盖 |
| 无法复制 | 从库不知道发生了什么修改 |

**InnoDB 的方案**：每个要求由一个专门的部件负责。

| 要求 | 部件 | 作用 |
| --- | --- | --- |
| 改得对 | 行锁 | 修改前锁住这一行，其他要修改它的事务必须等待 |
| 能撤销 | undo log | 修改前记下旧值，用于回滚，也供其他事务读旧版本（MVCC） |
| 不丢失且快 | redo log | 提交时只顺序写一条很小的修改记录，数据页以后再写 |
| 能传播 | binlog | Server 层记录“哪一行从什么改成什么”，供复制和按时间点恢复 |

### 类比：会计改账

| 会计 | InnoDB |
| --- | --- |
| 锁在柜子里的正式账本 | 磁盘上的数据页 |
| 摊在桌上的账本副本 | Buffer Pool 中的页 |
| 改之前在“撤销单”上抄下原值 | undo log |
| 在“流水本”末尾追加一行：“第 X 页第 Y 行改为 114.61” | redo log，只追加，写得快 |
| 给总部的业务流水：“订单 500000 金额由 104.61 改为 114.61” | binlog，逻辑记录，其他人能看懂并照做 |
| 闲时把桌上改过的页誊回正式账本 | 后台刷脏页 |

流水本写好，就算“记上账”了。桌上的副本即使丢了，也能用正式账本加流水本恢复出来。

## 三、完整执行过程

```
① 定位并加锁        沿 PRIMARY 找到 id=500000（读路径同专题 3）
                    读最新版本，并对该行加排他锁（X 锁）
② 写 undo           记下旧值 amount=104.61
③ 改 Buffer Pool    在内存中把 amount 改为 114.61，该页成为脏页
④ 写 redo           生成“某页某位置改成什么”的记录，先放入内存中的 log buffer
──────── 提交（autocommit 下语句结束即提交）────────
⑤ 两阶段提交        redo 写 prepare 并落盘 → binlog 写入并落盘 → redo 标记 commit
⑥ 释放锁，返回客户端
──────── 之后，与本次请求无关 ────────
⑦ 后台刷脏          page cleaner 线程把脏页写回数据文件
```

| 术语 | 含义 |
| --- | --- |
| 脏页（dirty page） | Buffer Pool 中已修改、尚未写回磁盘的页 |
| 落盘 | 调用 `fsync`，要求操作系统把数据真正写到磁盘，而不只是停留在操作系统缓存 |
| WAL（Write-Ahead Logging，预写日志） | 先把日志写到磁盘，数据页之后再写。redo log 就是 InnoDB 的 WAL |
| 当前读 | 读最新版本并加锁，UPDATE / DELETE 定位行时使用；与普通 SELECT 的快照读相对（专题 3） |

## 四、一条 UPDATE 实际写了什么

在空闲实例上，执行前后取计数差值，三次独立执行的真实输出：

```
                                          第1次    第2次    第3次
Innodb_rows_updated（更新行数）               1        1        1
Innodb_buffer_pool_pages_dirty（脏页数）     0→3      0→5      6→8
Innodb_pages_written（写入数据文件的页数）    0        0        0
Innodb_os_log_written（redo 写入字节数）    1536     2560     1024
Innodb_os_log_fsyncs（redo 落盘次数）         2        2        2
binlog 位置增量（字节）                       377      407      407
```

提交后约 5 秒，脏页数回到 0，`Innodb_pages_written` 增加，说明后台已把脏页写回。

解读：

1. **提交时没有写任何数据页**，只写了约 1–2.5KB 的 redo 和约 400 字节的 binlog。
2. **脏页不止 1 个**：除了数据所在的叶子页，undo 也存放在页中、同样经过 Buffer Pool，也会变脏。
3. **脏页之后由后台写回**：实例空闲时很快写回；繁忙时脏页会在内存中停留更久。
4. **redo 落盘次数**：每次增量都是 2，但 8.0 的后台日志线程也会执行 fsync，单次增量不能逐一归因到具体步骤；规律见第七节的批量对比。

::: warning 易混淆：提交成功意味着什么
| 错误理解 | 正确理解 |
| --- | --- |
| 提交成功 = 数据已写进表文件 | 提交成功 = redo 与 binlog 已落盘（在“双 1”配置下），数据页可能还在内存中 |
| 那断电就会丢数据 | 不会。重启时用 redo 重做尚未写回的修改，即崩溃恢复（专题 33） |
| WAL 多写一份日志，所以更慢 | 用一次小的**顺序写**替代多次 16KB 的**随机写**，整体更快 |
:::

## 五、锁与 undo 的现场

会话 A 执行 `BEGIN; UPDATE ... WHERE id = 500000;` 后不提交，另一会话观察（真实输出）：

```
information_schema.innodb_trx（正在运行的事务）
             trx_id: 10991
          trx_state: RUNNING
trx_isolation_level: REPEATABLE READ
    trx_rows_locked: 1
  trx_rows_modified: 1

performance_schema.data_locks（当前持有的锁）
object_name  index_name  lock_type  lock_mode       lock_status  lock_data
t_order      NULL        TABLE      IX              GRANTED      NULL
t_order      PRIMARY     RECORD     X,REC_NOT_GAP   GRANTED      500000
```

| 锁 | 含义 |
| --- | --- |
| `TABLE IX` | **意向排他锁**，加在表上，表示“表中有行被排他锁定”。想锁整张表的操作（如 `LOCK TABLES ... WRITE`）看一眼表上的意向锁即可判断冲突，不必逐行检查 |
| `RECORD X,REC_NOT_GAP` | 对主键 500000 这一条记录加排他锁，不锁记录之间的间隙。按主键等值修改一行时只需锁这一条 |

行锁持有到事务提交或回滚。专题 3 中 `FOR UPDATE` 等待超时，等的就是这把锁。何时会锁间隙见专题 26。

## 六、redo log 与 binlog

### 6.1 分工

| | redo log | binlog |
| --- | --- | --- |
| 所属层 | InnoDB 引擎层 | Server 层，所有引擎共用 |
| 记录内容 | 物理修改：哪个页、哪个位置、改成什么 | 逻辑修改：哪张表的哪一行，从什么改成什么（ROW 格式） |
| 写法 | 固定容量、循环使用；对应脏页刷盘后，空间可被覆盖 | 只追加；写满开新文件，按策略归档或清理 |
| 用途 | 崩溃恢复 | 主从复制、按时间点恢复 |
| 沙箱实测 | `innodb_redo_log_capacity = 104857600`（100MB） | `binlog_format = ROW`，`binlog_row_image = FULL` |

redo 循环覆盖且记录页级细节，无法供从库使用；binlog 不了解页的状态，无法用于崩溃恢复。所以两者都需要。

### 6.2 binlog 中记录了什么

`mysqlbinlog --base64-output=DECODE-ROWS -v` 解码这次 UPDATE（真实输出节选）：

```
Table_map: `lab`.`t_order` mapped to number 85
Update_rows: table id 85
### UPDATE `lab`.`t_order`
### WHERE                       ← 修改前的整行（before image）
###   @1=500000
###   @2=41847
###   @3=0
###   @4=104.61
###   @5='NO000000500000'
###   @6='2026-07-06 15:42:31'
###   @7=NULL
### SET                         ← 修改后的整行（after image）
###   @1=500000
###   ...
###   @4=114.61
###   ...
Xid = 2208
COMMIT
```

- ROW 格式记录行的前后镜像，不是 SQL 原文；`@1`…`@7` 依次对应表的 7 个列。
- `binlog_row_image = FULL`（默认）时，前后镜像都包含全部列，所以只改 1 列也记录了 7 列。
- `Xid` 是事务编号，两阶段提交和崩溃恢复时用它把 redo 与 binlog 中的同一事务对应起来。

### 6.3 为什么需要两阶段提交

两份日志必须一致：要么都包含这次修改，要么都不包含。若简单地先后各写一份，中途崩溃会导致主从不一致：

```
先写 redo、后写 binlog，中间崩溃：
  主库重启 → redo 恢复出 114.61；binlog 无此修改 → 从库仍为 104.61

先写 binlog、后写 redo，中间崩溃：
  binlog 已有此修改 → 从库变为 114.61；主库重启 → redo 无此修改 → 主库仍为 104.61
```

两阶段提交：redo 先写“准备完成”（prepare）标记，再写 binlog，最后 redo 标记“已提交”（commit）。崩溃恢复时，对处于 prepare 状态的事务，到 binlog 中查找相同的 Xid：找到就提交，找不到就回滚。这样两份日志总能对上。完整流程与各崩溃点的处理见专题 32、33（届时配交互动画）。

::: tip PG 对照
PostgreSQL 只有一份 WAL，同时用于崩溃恢复和流复制，因此不需要在两份日志之间做两阶段提交。PG 也没有 undo log：UPDATE 在表中写入新的行版本，旧版本留在原处，由 VACUUM 清理。这是两者 MVCC 实现最大的差异（专题 24）。
:::

## 七、每次提交的代价

### 7.1 “双 1”

| 参数 | 沙箱实测值 | 含义 |
| --- | --- | --- |
| `innodb_flush_log_at_trx_commit` | 1 | 每次提交，redo 都落盘 |
| `sync_binlog` | 1 | 每次提交，binlog 都落盘 |

两个参数都为 1，俗称“双 1”，是不丢失已提交数据的配置，代价是每次提交都要等待落盘。其他取值及其风险见专题 29、32。

### 7.2 批量对比

同样更新 1000 行，两种写法的真实输出：

```
                          redo 落盘次数   redo 写入量    binlog 增量    耗时
1000 条，每条自动提交          1242       1,198,592 B    403,460 B    1.05 s
1000 条，放在一个事务中         163         193,024 B    211,074 B    0.26 s
```

- 事务数从 1000 降到 1，redo 落盘次数降到约 1/8，耗时降到约 1/4。
- 单事务仍有 163 次落盘：redo 持续写入时后台日志线程也会 fsync。这些落盘不阻塞每条语句，需要等待的只有提交那一次。
- 每个事务都有固定的开头、结尾记录开销，所以合并后 redo、binlog 的写入量也小得多。

::: warning 局限：事务不是越大越好
事务越大，持有锁越久、undo 越多、从库重放越慢。专题 1 一次插入 100 万行时，错误日志出现 `Consider increasing innodb_redo_log_capacity`，就是大事务的后果之一。批量写入应分批提交，大事务的危害见专题 31。
:::

::: tip 与 Redis 的对照
Redis AOF 的 `appendfsync always / everysec / no` 与这两个参数是同一类取舍：每次落盘最安全也最慢；每秒落盘可能丢失最近约 1 秒；交给操作系统最快但最不可控。
:::

## 八、改到索引列时

本例修改的 `amount` 没有索引，只涉及聚簇索引。若修改 `user_id`，`idx_user` 也要随之变化：把旧条目 `(旧 user_id, 500000)` 标记删除，再插入新条目 `(新 user_id, 500000)`。

二级索引页不在 Buffer Pool 中时，启用 **change buffer** 的情况下，这次修改会先暂存在 change buffer 中，等该页以后被读入时再合并，从而省去一次随机读。

::: warning 版本差异
| 项目 | 8.0 | 8.4 |
| --- | --- | --- |
| `innodb_change_buffering` 默认值 | `all`（启用） | `none`（不启用） |
| 查看当前 binlog 文件与位置 | `SHOW MASTER STATUS` | `SHOW BINARY LOG STATUS`（8.2 起提供；8.4 不再支持 `SHOW MASTER STATUS`） |
:::

## 九、在三条主线中的位置

```
B 一致性：事务 → MVCC → [undo → 锁 → redo → binlog] → 崩溃恢复 → 复制
                         └───── 本专题：总览 ─────┘
A 性能：写入的主要代价是“提交时等待落盘”和“持锁时间”，而不是修改数据页本身
C 诊断：见第十节
```

## 十、诊断实践

### 10.1 UPDATE 慢或卡住，从哪里看

| 观察点 | 回答的问题 |
| --- | --- |
| `performance_schema.data_locks`、`information_schema.innodb_trx` | 谁持有锁、谁在等待、事务开了多久、改了多少行 |
| `sys.innodb_lock_waits` | 等待者与阻塞者的对应关系，以及阻塞者的连接 ID |
| PROCESSLIST 的 State | `waiting for handler commit` 表示卡在提交落盘 |
| `Innodb_os_log_fsyncs` 增量与提交频率 | 是否提交过于频繁 |
| `Innodb_buffer_pool_pages_dirty` | 脏页是否持续堆积（专题 28、29） |

### 10.2 病例一：UPDATE 一直不返回

1. **现象**：一条按主键更新的 UPDATE 长时间不返回，最终报 `ERROR 1205 Lock wait timeout exceeded`。
2. **指标**：`data_locks` 中该行的锁请求状态为 `WAITING`。
3. **定位**：

```sql
SELECT waiting_pid, waiting_query, blocking_pid, blocking_query, wait_age
FROM sys.innodb_lock_waits;
```

阻塞者常常是一个开启事务后没有提交的连接，`blocking_query` 可能为空（它当前没有在执行语句，只是事务未结束）。再到 `innodb_trx` 查看该事务的开始时间 `trx_started`。

4. **处置**：找到应用中未提交事务的原因（如异常分支未回滚、事务内调用远程接口）；紧急时可 `KILL` 阻塞者的连接，其事务会被回滚。

### 10.3 病例二：批量写入很慢

1. **现象**：导入或批处理逐条写入，吞吐很低，CPU 不高。
2. **指标**：`Innodb_os_log_fsyncs` 增量与写入行数接近；PROCESSLIST 中常见 `waiting for handler commit`。
3. **定位**：每行一个事务，时间主要花在每次提交的落盘等待上。
4. **处置**：按几百到几千行分批提交；不要为提速而随意关闭“双 1”，那是以丢数据风险换性能。

## 十一、本地复现脚本

在专题 1 的 Docker 环境（`mysql:8.4`）中用命令行客户端执行。

```sql
-- 0. 相关参数
SELECT @@log_bin, @@binlog_format, @@binlog_row_image, @@sync_binlog,
       @@innodb_flush_log_at_trx_commit, @@innodb_redo_log_capacity, @@innodb_change_buffering;
SHOW BINARY LOG STATUS;          -- 8.4 写法；8.0 用 SHOW MASTER STATUS

-- 1. 单条 UPDATE 的写入量：前后各执行一次以下两句，计算差值
SELECT VARIABLE_NAME, VARIABLE_VALUE FROM performance_schema.global_status
WHERE VARIABLE_NAME IN ('Innodb_rows_updated','Innodb_buffer_pool_pages_dirty','Innodb_pages_written',
                        'Innodb_os_log_written','Innodb_os_log_fsyncs');
SHOW BINARY LOG STATUS;
UPDATE t_order SET amount = amount + 10 WHERE id = 500000;
-- 几秒后再查 Innodb_buffer_pool_pages_dirty，观察脏页被后台写回

-- 2. 锁与事务现场：窗口 A
BEGIN;
UPDATE t_order SET amount = amount + 10 WHERE id = 500000;
--    窗口 B
SELECT trx_id, trx_state, trx_rows_locked, trx_rows_modified FROM information_schema.innodb_trx\G
SELECT object_name, index_name, lock_type, lock_mode, lock_status, lock_data FROM performance_schema.data_locks;
--    窗口 A
ROLLBACK;

-- 3. binlog 内容
FLUSH BINARY LOGS;
UPDATE t_order SET amount = amount + 10 WHERE id = 500000;
SHOW BINARY LOG STATUS;          -- 记下 File
```

```bash
# 把文件名换成上一步的 File
docker exec mysql84 mysqlbinlog --base64-output=DECODE-ROWS -v /var/lib/mysql/binlog.000005
```

批量对比的 SQL 可用 Python 生成：

```bash
python3 -c "print(''.join(f'UPDATE t_order SET amount=amount+1 WHERE id={600000+i};' for i in range(1000)))" > auto.sql
python3 -c "print('BEGIN;'+''.join(f'UPDATE t_order SET amount=amount+1 WHERE id={700000+i};' for i in range(1000))+'COMMIT;')" > txn.sql
# 分别执行，执行前后记录 Innodb_os_log_fsyncs，并计时
```

**预期现象**：提交时 `Innodb_pages_written` 增量为 0、redo 有写入；锁为表上 `IX` 加记录上 `X,REC_NOT_GAP`；binlog 中可见前后两个整行镜像；单事务批量的落盘次数和耗时明显少于逐条提交。具体数值因机器而异。

## 十二、与其他专题的关联

- **专题 3**：UPDATE 定位行的路径与 SELECT 相同，区别在于读最新版本并加锁（当前读 vs 快照读）。
- **专题 25–27**：意向锁、记录锁、间隙锁与锁诊断。
- **专题 28、29**：Buffer Pool 刷脏、redo 的容量与 `innodb_flush_log_at_trx_commit` 的取值。
- **专题 30**：Doublewrite Buffer，解决“写页写到一半”的问题。
- **专题 31**：undo、purge 与大事务的危害。
- **专题 32、33**：binlog、两阶段提交与崩溃恢复。
- **专题 39、40**：从库如何重放 binlog。
- **Redis**：AOF 的落盘策略。

## 十三、复习 checklist

- [ ] 能说出一条 UPDATE 要满足的四个要求，以及分别由哪个部件负责
- [ ] 能按顺序描述 UPDATE 的执行步骤，指出提交发生在哪一步
- [ ] 能解释“提交时没有写数据页”为什么仍然不会丢数据
- [ ] 能解释 WAL 为什么比直接写数据页更快
- [ ] 能读懂 `data_locks` 中的 `IX` 与 `X,REC_NOT_GAP`
- [ ] 能从层级、内容、写法、用途四方面对比 redo 与 binlog
- [ ] 能说明不做两阶段提交时，两种写入顺序各自如何导致主从不一致
- [ ] 知道“双 1”的含义与代价，能解释分批提交为何更快、为何不能无限合并
- [ ] 知道 8.0 与 8.4 在 `innodb_change_buffering` 默认值、查看 binlog 位置语句上的差异
