# 专题 31–33 · undo 与 purge、binlog 与两阶段提交、崩溃恢复（合并简述）

> 级别：31 ★ / 32 ★ / 33 ★（按学习者要求简述）· 主线 B（衔接 C）· 实测版本：沙箱 MySQL 8.0.46

本篇回答：undo 存在哪、何时清理、长事务代价如何量化？有了 redo 为何还要 binlog？binlog 里记了什么、三种格式怎么选？一个事务写两份日志如何保证一致（两阶段提交）？“双 1”是什么？崩溃重启时 InnoDB 按什么顺序恢复？

**交互图解**：<a href="/xbb-notes/mysql-t32-2pc.html" target="_blank">两阶段提交与崩溃点（在两阶段提交的每两步之间选择崩溃时刻，看主库数据与 binlog 是否一致；可切换为“不用两阶段提交”的两种写法对比）</a>

## 一、undo 与 purge（专题 31）

### 1.1 两个用途（回顾）

| 用途 | 详见 |
| --- | --- |
| 回滚：记录修改前的值，事务失败时恢复（原子性） | 专题 4、23 |
| MVCC：旧版本串成版本链供快照读回溯 | 专题 24 |

### 1.2 存放与清理

- 独立 **undo 表空间**：实测 `innodb_undo_tablespaces = 2`，数据目录 `undo_001`、`undo_002`。
- insert undo 提交后立即丢弃；update undo 要等没有 Read View 需要时，由 **purge** 线程清理（实测 `innodb_purge_threads = 4`），进度受最老 Read View 限制（专题 24）。

### 1.3 长事务代价量化（真实输出）

B 以 `START TRANSACTION WITH CONSISTENT SNAPSHOT` 保持快照，另一连接对 `t_order`、`t_s`、`t_case` 各执行一次全表 UPDATE（约 300 万行，每表一个事务）：

```
开始前：           undo_001 = 64 MB，undo_002 = 64 MB，history_len = 0
UPDATE 共 25.6s
B 快照仍开着：     undo_001 = 96 MB                     history_len = 3
B 提交后：         undo_001 = 96 MB                     history_len = 3（随后被 purge）
```

1. **history list length 统计的是事务个数，不是行数**：300 万行只记 3；专题 23 中 5000 次自动提交单行 UPDATE 记 5000。需结合事务大小判断。
2. **undo 文件长大后不自动缩小**：purge 后空间在文件内重用；只有超过 `innodb_max_undo_log_size`（实测 1 GB）且 `innodb_undo_log_truncate`（实测 ON）时才截断。

长事务的三重代价：undo 膨胀；旧快照沿长版本链回溯（专题 24：10 万版本约 48 ms，正常约 0.09 ms）；若持锁还会阻塞他人（专题 22、25）。

## 二、binlog（专题 32）

### 2.1 有了 redo 为何还要 binlog

redo 是 InnoDB 的物理日志，只供 InnoDB 崩溃恢复。**复制**与**时间点恢复**需要一份不依赖引擎、能被重新执行的修改记录——Server 层的 **binlog（二进制日志）**；手册列出的用途即复制与数据恢复。SELECT、SHOW 等不修改数据的语句不记录。

| | redo log | binlog |
| --- | --- | --- |
| 层级 | InnoDB | Server 层（所有引擎共用） |
| 内容 | 物理：某页某位置改成什么 | 逻辑：行前后值（ROW）或 SQL 原文（STATEMENT） |
| 写法 | 固定容量循环覆盖（专题 29） | 追加，写满（`max_binlog_size` 实测 100 MB）换新文件，按 `binlog_expire_logs_seconds`（实测 2592000 秒 = 30 天）过期 |
| 写入时机 | 执行中不断写 log buffer | 执行中先进会话 binlog cache，**提交时一次性写入** |
| 用途 | 崩溃恢复 | 复制、时间点恢复 |

### 2.2 binlog 里记了什么（真实输出）

一笔转账（A 扣 100、B 加 100），ROW 格式（实测默认）：

```
SHOW BINLOG EVENTS：
  Query        BEGIN
  Table_map    table_id: 87 (lab.t_acct)
  Update_rows  table_id: 87 flags: STMT_END_F
  Table_map    table_id: 87 (lab.t_acct)
  Update_rows  table_id: 87 flags: STMT_END_F
  Xid          COMMIT /* xid=28 */          ← 事务结束标记，带事务编号 XID

mysqlbinlog -vv 解码第一个 Update_rows：
  ### UPDATE `lab`.`t_acct`
  ### WHERE  @1=1  @2='A'  @3=1000          ← 修改前整行（binlog_row_image 实测 FULL）
  ### SET    @1=1  @2='A'  @3=900           ← 修改后整行
```

会话切换为 STATEMENT 后，binlog 记录 SQL 原文：`UPDATE t_acct SET balance = balance + 0 WHERE id = 1`。

| 格式 | 记录 | 优点 | 缺点 |
| --- | --- | --- | --- |
| **ROW（默认）** | 每行前后值 | 精确，从库照改、不重新执行 WHERE；RC 下只能用它（专题 26 ERROR 1665） | 一条语句改 100 万行就记 100 万行前后值 |
| STATEMENT | SQL 原文 | 日志小 | 含不确定因素的语句（`NOW()`、无 `ORDER BY` 的 `LIMIT`）在从库可能得到不同结果 |
| MIXED | 一般 STATEMENT，不安全时自动 ROW | 折中 | 行为不直观 |

8.0 中设置 `binlog_format` 出现弃用警告（专题 26 实测）。

## 三、两阶段提交与“双 1”（专题 32）

### 3.1 问题：两份日志之间宕机

| 写入顺序 | 两者之间宕机 | 结果 |
| --- | --- | --- |
| 先 redo 后 binlog | redo 已提交、binlog 没有 | 主库有、从库没有 → **不一致** |
| 先 binlog 后 redo | binlog 有、redo 没有 | 主库回滚、从库执行 → **不一致** |

### 3.2 方案

```
① 执行：写 undo，改内存页，redo 写入 log buffer
② prepare：redo 刷盘，事务在 redo 中标记 prepare，带 XID
③ 写 binlog：binlog 写入并刷盘（sync_binlog=1），末尾 Xid 事件带同一 XID
④ commit：redo 中标记 commit
⑤ 返回客户端
```

| 崩溃发生在 | redo 状态 | binlog 有该 XID？ | 处理 |
| --- | --- | --- | --- |
| ② 之前 | 无 prepare | 无 | 回滚 |
| ② 与 ③ 之间 | prepare | **无** | **回滚** |
| ③ 与 ④ 之间 | prepare | **有** | **提交** |
| ④ 之后 | commit | 有 | 已提交 |

**binlog 中有没有这个事务是最终裁决标准**，保证主库数据与 binlog（从库收到的内容）一致。手册：崩溃重启时先回滚事务，再扫描最新 binlog 文件收集 XID、计算最后有效位置，让 InnoDB 完成已成功写入 binlog 的 prepare 事务，并把 binlog 截断到最后有效位置，使从库不会收到已回滚的语句。2.2 节的 `Xid = 28` 即 binlog 一侧的裁决编号。

在 ② 与 ③ 之间精确制造崩溃需调试版 MySQL，沙箱为发行版，此段依据手册原文与配套动画；第四节崩溃实验验证恢复的其他步骤。

### 3.3 “双 1”

| 参数 | 实测默认 | 设为 1 | 放宽后风险（断电 / OS 崩溃） |
| --- | --- | --- | --- |
| `innodb_flush_log_at_trx_commit` | 1 | 每次提交 redo 刷盘 | 可能丢最近约 1 秒已提交事务（专题 29） |
| `sync_binlog` | 1 | 每次提交 binlog 刷盘（手册：最安全也最慢） | binlog 末尾事务可能丢失，从库少数据或与主库对不上 |

**组提交**：多个事务的刷盘合并为一次，降低“双 1”代价；binlog 中 `last_committed`、`sequence_number` 字段与之相关，从库并行回放会用到（模块八）。

## 四、崩溃恢复（专题 33）

### 4.1 实验：kill -9（真实输出）

```
初始：id=1 → 1000，id=2 → 1000
A：BEGIN; UPDATE id=1 → 0                      （未提交）
B：UPDATE id=2 → +1                            （已提交）
C：UPDATE t_order 20 万行 amount +1             （已提交）
崩溃前脏页数：1233                              ← C 的修改大多未写回
kill -9 mysqld，重启（log_error_verbosity = 3）
```

### 4.2 错误日志中的恢复过程（节选）

```
① 从 checkpoint 开始重做 redo
[InnoDB] The latest found checkpoint is at lsn = 3873713298 ...
[InnoDB] Starting crash recovery.
[InnoDB] Doing recovery: scanned up to log sequence number 3893762890
[InnoDB] Applying a batch of 1430 redo log records ...

② 打开 undo，找出崩溃时未结束的事务
[InnoDB] Opened 2 existing undo tablespaces.
[InnoDB] Transaction ID: 248337 found for resurrecting updates
[InnoDB] 1 transaction(s) which must be rolled back or cleaned up in total 1 row operations to undo

③ 结合 binlog 处理 prepare 事务
[Server] Recovering after a crash using binlog
[Server] Starting XA crash recovery...
[Server] Crash recovery finished in InnoDB engine. No attempts to commit, rollback or prepare any transactions.
[Server] XA crash recovery finished.

④ 后台回滚未提交事务
[InnoDB] Starting in background the rollback of uncommitted transactions
[InnoDB] Rolling back trx with id 248337, 1 rows to undo
[InnoDB] Rollback of trx with id 248337 completed
```

恢复后：`id=1 → 1000`（A 回滚）；`id=2 → 1001`（B 保留）；`t_order` 20 万行 amount 合计增加 200000.00（C 已提交，大多数脏页未写回，靠 redo 重做恢复）。

### 4.3 顺序与原理

```
① redo 前滚：从 checkpoint 重做 → 数据页恢复到崩溃时刻（含未提交事务的修改）
             遇到残缺页先用 doublewrite 副本修复（专题 30）
② 找出未结束的事务（日志称 resurrect）
③ 处理 prepare 事务：binlog 有 XID → 提交；无 → 回滚（本实验无 prepare 事务）
④ undo 回滚未提交事务：后台进行，服务器无需等待即可接受连接
```

::: danger 错误理解 vs 正确理解
- ❌ 崩溃恢复只需要 redo。
- ✅ redo 只负责前滚（重建包括未提交修改在内的崩溃时状态），还需 undo 撤销未提交事务、binlog 裁决 prepare 事务，三种日志缺一不可。
:::

## 五、三种日志串联图

```
执行时：      undo（旧值）+ 改内存页 + redo（log buffer）+ binlog cache
提交时：      redo prepare 刷盘 → binlog 写入并刷盘（XID）→ redo commit
平时：        后台刷脏（先 doublewrite）→ checkpoint 前移；purge 清理 undo（受最老 Read View 限制）
崩溃后：      redo 前滚 → 找未结束事务 → binlog 裁决 prepare 事务 → undo 回滚
复制 / 恢复： binlog（模块八）
```

## 六、在三条主线中的位置

```
B 一致性：事务 → MVCC → [undo] → 锁 → redo → [binlog → 两阶段提交] → [崩溃恢复] → 复制
C 诊断：history list length、undo 表空间大小、binlog 内容、错误日志中的恢复记录
```

## 七、诊断要点

| 现象 | 看什么 | 方向 |
| --- | --- | --- |
| undo 表空间持续增长 | `innodb_trx` 最老事务；history list length | 结束长事务（含只读）；history list length 是事务个数，结合事务大小判断 |
| 主从数据不一致 | `sync_binlog`、`innodb_flush_log_at_trx_commit` 是否为 1；是否宕机过 | 恢复“双 1”，必要时重建从库 |
| 宕机后启动慢或数据可疑 | 错误日志 recovery / rollback（可临时 `log_error_verbosity = 3`） | redo 重做量、回滚了哪些事务 |
| binlog 增长很快 | 是否有大批量 UPDATE / DELETE（ROW 记录每行） | 分批执行（专题 18）；评估 `binlog_row_image` |

## 八、本地复现（Docker mysql:8.4）

```sql
-- 一、undo：会话 1 START TRANSACTION WITH CONSISTENT SNAPSHOT; 保持；会话 2 UPDATE t_order SET amount = amount + 0.01;
SELECT NAME, FILE_SIZE FROM information_schema.INNODB_TABLESPACES WHERE SPACE_TYPE = 'Undo';
SELECT COUNT FROM information_schema.INNODB_METRICS WHERE NAME = 'trx_rseg_history_len';

-- 二、binlog 内容
FLUSH BINARY LOGS;
SHOW BINARY LOG STATUS;     -- 8.4 写法（8.0 为 SHOW MASTER STATUS），记下文件名
BEGIN; UPDATE t_acct SET balance = balance - 100 WHERE id = 1; UPDATE t_acct SET balance = balance + 100 WHERE id = 2; COMMIT;
SHOW BINLOG EVENTS IN 'binlog.0000xx';
```

```bash
docker exec 容器名 mysqlbinlog --base64-output=DECODE-ROWS -vv /var/lib/mysql/binlog.0000xx
# 三、崩溃恢复：客户端制造“未提交 + 已提交”状态后
docker kill -s KILL 容器名
docker start 容器名
docker logs 容器名 | grep -i -E "recovery|roll|resurrect|XA"
# 更详细的恢复日志：容器启动参数加 --log-error-verbosity=3
```

**预期现象**：长事务开着时 undo 表空间变大且之后不自动缩小；binlog 可见 `BEGIN / Table_map / Update_rows / Xid` 及行前后值；崩溃重启后未提交修改被回滚、已提交修改保留，错误日志有 redo 重做与回滚记录。LSN、事务号等数值会不同。

::: tip PG 与 Redis 对照
- **PG**：无独立 binlog，复制传 WAL（物理）或用逻辑解码提取行变化（逻辑复制），因此无需两份日志间的两阶段提交；PG 旧版本在表中、无 undo，崩溃恢复只需 WAL 前滚，未提交版本对所有人不可见，由 VACUUM 清理。
- **Redis**：AOF 记录命令（类似 STATEMENT），RDB 为快照；主从复制传输命令流。
:::

## 九、与其他专题的关联

- **专题 4**：一条 UPDATE 中 undo、redo、binlog 的位置。
- **专题 23 / 24**：长事务、purge 与 Read View。
- **专题 26**：RR 与 STATEMENT 格式、ERROR 1665。
- **专题 28–30**：redo、checkpoint、doublewrite 与恢复的关系。
- **模块八**：binlog 驱动的复制、时间点恢复。

## 十、复习 checklist

- [ ] 能说出 undo 的两个用途、存放位置、insert / update undo 的清理时机
- [ ] 知道 history list length 统计事务个数，undo 文件不会自动缩小及截断条件
- [ ] 能对比 redo 与 binlog 的层级、内容、写法、写入时机与用途
- [ ] 能读懂 binlog 事件与 ROW 格式的行前后值，说出三种格式的取舍
- [ ] 能说明两份日志先后写入都会不一致，以及两阶段提交的步骤与崩溃时的裁决规则
- [ ] 能说出“双 1”的含义及放宽后的风险，知道组提交
- [ ] 能按错误日志复述崩溃恢复的四个阶段，并解释为何 redo、undo、binlog 缺一不可
