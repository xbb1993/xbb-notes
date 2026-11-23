# 专题 27 · 锁诊断与死锁处理

> 级别 ★ · 主线 B / C · 实测版本：沙箱 MySQL 8.0.46

本专题回答：等待与死锁有什么不同？InnoDB 怎样发现死锁、回滚谁？死锁和锁等待超时分别回滚什么？怎样读死锁日志？锁等待的排查路径是什么？常见死锁模式如何预防？

## 一、等待与死锁

- **等待**：A 持锁，B 排队；A 提交后 B 继续，早晚结束。
- **死锁**：多个事务互相等待对方持有的锁，永远等不完。

```
A: BEGIN; UPDATE t_lk SET d = d + 1 WHERE id = 5     ← A 锁 5
B: BEGIN; UPDATE t_lk SET d = d + 1 WHERE id = 10    ← B 锁 10
A: UPDATE ... WHERE id = 10                          ← A 等 B
B: UPDATE ... WHERE id = 5                           -> ERROR 1213: Deadlock found（0.00s）
A 的第二条 UPDATE 完成（等待 0.50s）
```

**等待图（wait-for graph）**：每条边“等待者 → 持有者”，出现环即死锁。

```
A ──等待 id=10──→ B
↑                 │
└──等待 id=5──────┘
```

## 二、怎样发现死锁

| 思路 | 做法 | 优点 | 缺点 |
| --- | --- | --- | --- |
| 超时 | 等待超过 `innodb_lock_wait_timeout`（实测默认 50 秒）即放弃 | 简单、无额外开销 | 要等满超时；分不清死锁与长等待 |
| 主动检测 | 每产生一条新等待边，就在等待图中搜索环 | 立即发现 | 大量线程等同一把锁时开销大 |

InnoDB 默认主动检测：`innodb_deadlock_detect`（实测默认 ON）。等待边就是专题 26 中处于 WAITING 的锁请求。

### 2.1 回滚谁：小事务

手册：尽量选择**较小的事务**回滚，大小由插入、更新、删除的行数决定。实验：制造死锁前让一方额外修改 200 行。

| 谁额外改了 200 行 | 谁的语句形成了环 | 被回滚 | 日志 `undo log entries` |
| --- | --- | --- | --- |
| A | B | **B** | A 201；B 1 |
| B | B | **A** | A 1；B 201 |

第二行：形成环的是 B，被回滚的却是改动更少的 A。

### 2.2 检测上限（手册）

等待链上事务超过 **200** 个，或需检查的锁超过 **1,000,000** 个时，直接按死锁处理，回滚正在检查的事务；日志出现 `TOO DEEP OR LONG SEARCH IN THE LOCK TABLE WAITS-FOR GRAPH`。

### 2.3 关闭检测

手册：高并发下大量线程等同一把锁时，检测会拖慢系统，可关闭并依靠 `innodb_lock_wait_timeout`。实测（超时 5 秒）：

```
SET GLOBAL innodb_deadlock_detect = OFF；A 锁 5、B 锁 10、A 等 10、B 等 5
B: UPDATE ... WHERE id = 5    -> ERROR 1205（5.00s）
A: UPDATE ... WHERE id = 10   -> ERROR 1205（5.50s）     ← A 也超时
```

B 超时只回滚该语句，之前锁住的 10 仍被持有，A 继续等直至超时。

::: danger 关闭死锁检测的前提
调小 `innodb_lock_wait_timeout`，且应用收到 1205 后**主动回滚整个事务**；否则死锁变成“双方各自超时、锁依旧不放”。
:::

## 三、死锁与超时各回滚什么

| 情况 | 回滚范围（手册） | 实测 |
| --- | --- | --- |
| 死锁 1213 | **整个事务** | B 被回滚后再查，其之前对 id=10 的修改也消失：`(5,5) (10,10)` |
| 锁等待超时 1205 | 默认**只回滚当前语句**；开启 `innodb_rollback_on_timeout`（实测默认 OFF）后回滚整个事务 | B 先把 id=20 改为 100，再改被锁的 id=5 超时；之后 id=20 仍为 100，B 仍为 RUNNING |

| 错误码 | 事务状态 | 应用处理 |
| --- | --- | --- |
| 1213 | 已整体回滚 | **重试整个事务**（手册：“Deadlocks are not dangerous. Just try again.”） |
| 1205 | 事务、已做修改与已持有锁仍在 | 决定重试语句还是回滚事务，**不能放任事务一直开着** |

## 四、读懂死锁日志

`SHOW ENGINE INNODB STATUS` 的 `LATEST DETECTED DEADLOCK`（**只保留最近一次**）。第一节实验的真实日志（节选加注释）：

```
*** (1) TRANSACTION:
TRANSACTION 224316, ACTIVE 1 sec starting index read        ← 事务号；活跃 1 秒；正在索引查找
LOCK WAIT 3 lock struct(s), 2 row lock(s), undo log entries 1   ← 锁等待；持 2 个行锁；1 条 undo
MySQL thread id 14 ... updating                             ← 连接 ID
UPDATE t_lk SET d = d + 1 WHERE id = 10                     ← 当前正在执行的语句

*** (1) HOLDS THE LOCK(S):
RECORD LOCKS ... index PRIMARY of table `lab`.`t_lk` trx id 224316 lock_mode X locks rec but not gap
 0: len 4; hex 80000005;            ← 主键 5（符号位翻转，专题 8）
 1: len 6; hex 000000036c3c;        ← DB_TRX_ID = 0x36c3c = 224316，即事务 (1) 写入（专题 24）
 2: len 7; hex 0200000a47109e;      ← DB_ROLL_PTR
 3: len 4; hex 80000005;            ← c = 5
 4: len 4; hex 80000006;            ← d = 6（已被 (1) 加 1）

*** (1) WAITING FOR THIS LOCK TO BE GRANTED:
... lock_mode X locks rec but not gap waiting   主键 10

*** (2) TRANSACTION 224317 ... UPDATE t_lk SET d = d + 1 WHERE id = 5
*** (2) HOLDS：主键 10        *** (2) WAITING FOR：主键 5
*** WE ROLL BACK TRANSACTION (2)
```

### 4.1 日志写法与 data_locks 对照

| 死锁日志 | `data_locks.LOCK_MODE` | 含义 |
| --- | --- | --- |
| `lock_mode X locks rec but not gap` | `X,REC_NOT_GAP` | 记录锁 |
| `lock_mode X locks gap before rec` | `X,GAP` | 间隙锁 |
| `lock_mode X`（无修饰） | `X` | 临键锁 |
| `... locks gap before rec insert intention waiting` | `X,GAP,INSERT_INTENTION` | 等待中的插入意向锁 |
| `lock mode S ...` | `S...` | 共享锁 |

### 4.2 “先查后插”死锁日志（节选）

```
*** (1) TRANSACTION 224348 ... inserting / INSERT INTO t_lk VALUES (7,7,7)
*** (1) HOLDS:   lock_mode X locks gap before rec                          hex 8000000a → (5,10)
*** (1) WAITING: lock_mode X locks gap before rec insert intention waiting hex 8000000a
*** (2) TRANSACTION 224349 ... inserting / INSERT INTO t_lk VALUES (7,7,7)
*** (2) HOLDS:   同一间隙         *** (2) WAITING: insert intention waiting
*** WE ROLL BACK TRANSACTION (2)
```

双方都持有同一间隙锁、都在等插入意向锁 → “间隙锁 + 插入意向锁”型死锁。

::: danger 错误理解 vs 正确理解
- ❌ 日志中的 SQL 就是加上 HOLDS 锁的那条语句。
- ✅ 日志只显示每个事务**当前正在执行**的语句。(1) 持有的 id=5 的锁由它上一条语句加上，日志不显示；需结合代码或 `events_statements_history` 还原。
- ❌ INNODB STATUS 能看到所有历史死锁。
- ✅ 只保留最近一次。`innodb_print_all_deadlocks`（实测默认 OFF）开启后每次死锁写入错误日志（实测出现同格式内容）；手册建议排查后关闭。
:::

## 五、锁等待的排查路径

```
information_schema.innodb_trx          事务状态（RUNNING / LOCK WAIT）、开始时间、持锁数
        │
performance_schema.data_locks          每一把锁（含 WAITING 请求）：模式、索引、LOCK_DATA
        │ ENGINE_LOCK_ID
performance_schema.data_lock_waits     等待边：请求方锁 → 阻塞方锁
        │
sys.innodb_lock_waits                  连接以上，给出双方 SQL、等待时长、KILL 语句
        │ blocking_query 为 NULL（阻塞方空闲事务）
performance_schema.events_statements_history   阻塞方之前执行过的语句（专题 22）
```

## 六、常见死锁模式与预防

| 模式 | 实验 | 日志特征 | 预防 |
| --- | --- | --- | --- |
| 加锁顺序相反 | 本专题第一节 | 双方 HOLDS / WAITING 互为对方记录锁 | 各代码路径按**相同顺序**访问（如主键升序） |
| S 锁升级为 X | 专题 25 | 双方持 `lock mode S`，等 `lock_mode X` | 读后要改直接 `FOR UPDATE` |
| 间隙锁 + 插入意向锁 | 专题 26 / 本专题 4.2 | `locks gap before rec` + `insert intention waiting` | 直接 INSERT 依靠唯一约束；`INSERT ... ON DUPLICATE KEY UPDATE`；RC |
| 扫描范围过大 | 专题 25、26 | 大量 `lock_mode X`、含 supremum | 为条件列建索引 |

手册其他建议：事务小而短、做完立即提交；能接受旧快照就不加 `FOR UPDATE / FOR SHARE`；加锁读可考虑 RC；实在无法避免时用表锁或单行“信号量表”串行化（牺牲并发）。

**应用重试**：捕获 1213 后重试**整个事务**，次数设上限并加随机退避；事务中有外部副作用（发消息、调接口）须保证幂等或移到提交之后。

## 七、在三条主线中的位置

```
B 一致性：锁冲突的终点——等待或死锁；死锁回滚整个事务
C 诊断：问题 → 现象（1205 / 1213、LOCK WAIT）→ 指标（data_locks / data_lock_waits）→ 定位（死锁日志、历史语句）→ 优化（顺序、索引、写法、隔离级别）→ 验证
```

## 八、诊断实践

### 8.1 速查

| 现象 | 查什么 | 下一步 |
| --- | --- | --- |
| 应用报 1205 | `sys.innodb_lock_waits` 找阻塞方；`blocking_query` 为 NULL 时查 `events_statements_history` | 定位长事务 / 闲置事务；应用超时后回滚 |
| 应用报 1213 | `SHOW ENGINE INNODB STATUS` 的 LATEST DETECTED DEADLOCK | 按 4.1 翻译锁模式，按第六节归类 |
| 死锁频繁、需统计 | 开启 `innodb_print_all_deadlocks` 一段时间，分析错误日志 | 归类后改代码；结束后关闭 |
| 高并发热点行、CPU 高、大量等待 | 等待数、检测开销 | 先从业务上打散热点；评估关闭检测并配合短超时与主动回滚 |

### 8.2 病例

| 病例 | 现象 | 定位 | 处置 |
| --- | --- | --- | --- |
| 批量转账偶发死锁 | 1213 | 日志显示双方以相反顺序锁两行 | 按账户 ID 排序后加锁 |
| “不存在则插入”高并发死锁 | 1213 | 日志为间隙锁 + 插入意向锁 | `ON DUPLICATE KEY UPDATE` / 唯一约束 / RC |
| 关闭死锁检测后系统卡住 | 大量 1205，持续不消失 | 超时只回滚语句，锁仍持有 | 应用收到 1205 后回滚事务；调小超时 |
| 1205 后数据“部分生效” | 事务前半部分修改仍在 | 超时默认只回滚语句，应用却提交了事务 | 超时后显式回滚，或开启 `innodb_rollback_on_timeout` |

## 九、本地复现（Docker mysql:8.4，3 个客户端窗口）

```sql
USE lab;
DROP TABLE IF EXISTS t_lk;
CREATE TABLE t_lk (id INT PRIMARY KEY, c INT NOT NULL, d INT NOT NULL, KEY idx_c (c));
INSERT INTO t_lk VALUES (0,0,0),(5,5,5),(10,10,10),(15,15,15),(20,20,20),(25,25,25);
SELECT @@innodb_deadlock_detect, @@innodb_lock_wait_timeout, @@innodb_print_all_deadlocks, @@innodb_rollback_on_timeout;

-- 一、相反顺序死锁
-- 窗口 1：BEGIN; UPDATE t_lk SET d = d + 1 WHERE id = 5;
-- 窗口 2：BEGIN; UPDATE t_lk SET d = d + 1 WHERE id = 10;
-- 窗口 1：UPDATE t_lk SET d = d + 1 WHERE id = 10;     -- 等待
-- 窗口 2：UPDATE t_lk SET d = d + 1 WHERE id = 5;      -- ERROR 1213
-- 窗口 3：SHOW ENGINE INNODB STATUS\G
-- 窗口 2：SELECT id, d FROM t_lk WHERE id IN (5,10);   -- 自己之前的修改已回滚

-- 二、回滚谁：在一方事务中先执行
CREATE TABLE t_big (id INT PRIMARY KEY, v INT);
INSERT INTO t_big WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM s WHERE n < 200) SELECT n, 0 FROM s;
--   该方事务内先 UPDATE t_big SET v = v + 1; 再按“一”制造死锁，看谁被回滚与 undo log entries

-- 三、记录每次死锁
SET GLOBAL innodb_print_all_deadlocks = ON;      -- 实验后改回 OFF；docker logs 容器名 查看

-- 四、关闭检测
SET GLOBAL innodb_deadlock_detect = OFF;         -- 两窗口 SET innodb_lock_wait_timeout = 5; 按“一”操作，双方先后 1205
SET GLOBAL innodb_deadlock_detect = ON;

-- 五、超时只回滚语句
-- 窗口 1：BEGIN; UPDATE t_lk SET d = d + 1 WHERE id = 5;
-- 窗口 2：SET innodb_lock_wait_timeout = 2; BEGIN; UPDATE t_lk SET d = 100 WHERE id = 20;
--         UPDATE t_lk SET d = d + 1 WHERE id = 5;      -- ERROR 1205
--         SELECT d FROM t_lk WHERE id = 20;            -- 仍为 100
```

**预期现象**：与上文真实输出一致；错误日志位置以本地配置为准。

::: tip PG 对照
PG 同样用等待图检测死锁，但等待超过 `deadlock_timeout`（默认 1 秒）后才检测，省去多数短等待的检测开销，代价是发现稍晚；InnoDB 每次等待立即检测，开销大时只能整体关闭。
:::

## 十、与其他专题的关联

- **专题 8 / 24**：死锁日志中物理记录字段（主键、`DB_TRX_ID`、`DB_ROLL_PTR`）的解读。
- **专题 22**：锁等待在完整诊断流程中的位置。
- **专题 25 / 26**：各种锁及其冲突规则、死锁的成因。
- **专题 23**：RC 作为减少锁冲突的选项。

## 十一、复习 checklist

- [ ] 能区分等待与死锁，画出等待图
- [ ] 知道超时与主动检测两种思路的取舍，以及 `innodb_deadlock_detect` 默认开启
- [ ] 知道死锁回滚“小”事务（按改动行数），以及检测上限 200 / 1,000,000
- [ ] 能说明关闭检测后为何双方都会超时、需要哪些配套措施
- [ ] 能区分 1213 回滚整个事务、1205 默认只回滚语句，并说出应用处理方式
- [ ] 能逐行读懂死锁日志，将锁描述对照到 data_locks 的 LOCK_MODE
- [ ] 知道日志只显示当前语句、只保留最近一次，以及 `innodb_print_all_deadlocks`
- [ ] 能说出锁等待排查路径上各诊断表的关系
- [ ] 能列出四种常见死锁模式、日志特征与预防方法，以及应用重试的要点
