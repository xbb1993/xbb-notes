# 专题 23 · 事务的实际运行机制与隔离级别

> 级别 ★ · 主线 B · 实测版本：沙箱 MySQL 8.0.46

本专题回答：事务要防止哪些问题？一个事务实际从哪一刻开始、快照在哪一刻拍下？四种隔离级别各防住什么？快照读和当前读有什么区别？

**交互图解**：<a href="/xbb-notes/mysql-t23-isolation.html" target="_blank">隔离级别时间线图解（4 个场景 × 3 种隔离级别逐步播放，实时显示已提交值、未提交修改、B 的快照）</a>

**贯穿模块五的例子**：账户表 `t_acct(id, name, balance)`，初始 A、B 两个账户各 1000，约束 `CHECK (balance >= 0)`。会话 A 为修改方，会话 B 为读取方。

## 一、事务要解决什么问题

### 1.1 一次转账

A 给 B 转 1500：① B 加 1500；② A 扣 1500。A 只有 1000，② 必然违反约束。

```
不用事务（自动提交）：
A: UPDATE ... balance + 1500 WHERE id = 2   -> 1 row(s) affected
A: UPDATE ... balance - 1500 WHERE id = 1   -> ERROR 3819: Check constraint 't_acct_chk_1' is violated.
B: SELECT id, balance FROM t_acct           -> (1, 1000), (2, 2500)
B: SELECT SUM(balance) FROM t_acct          -> 3500          ← 凭空多出 1500

放进事务：
A: BEGIN
A: UPDATE ... balance + 1500 WHERE id = 2   -> 1 row(s) affected
A: UPDATE ... balance - 1500 WHERE id = 1   -> ERROR 3819
B: SELECT id, balance FROM t_acct           -> (1, 1000), (2, 1000)   ← 看不到 A 做了一半的修改
A: ROLLBACK
B: SELECT id, balance FROM t_acct           -> (1, 1000), (2, 1000)
```

**类比：寄快递。** 事务是一个打包箱，要么整箱送到（提交，commit），要么整箱退回（回滚，rollback）；封箱之前别人看不到里面装了什么。

### 1.2 ACID：从“会出什么问题”推出来

| 要防止的问题 | 性质 | InnoDB 的实现 | 详见 |
| --- | --- | --- | --- |
| 做了一半失败留下半成品 | **A**tomicity 原子性：要么全做要么全不做 | **undo log**：记录修改前的值，回滚时恢复 | 专题 4、31 |
| 并发事务看到对方做了一半的修改 | **I**solation 隔离性 | **MVCC**（读）+ **锁**（写） | 专题 24–26 |
| 提交后宕机丢数据 | **D**urability 持久性 | **redo log**：提交时先写日志并刷盘 | 专题 4、29 |
| 总额从 2000 变成 3500 | **C**onsistency 一致性：数据满足业务规则 | **目标**：由 A、I、D 加约束和应用逻辑共同保证 | — |

::: danger 错误理解 vs 正确理解
- ❌ ACID 是四个并列的机制。
- ✅ A、I、D 是**手段**，C 是**目的**。数据库保证不出现半成品、不互相干扰、不丢失；“转账前后总额不变”要靠应用把两条 UPDATE 放进同一事务。
:::

## 二、事务的实际生命周期

### 2.1 自动提交

`autocommit` 默认开启（沙箱实测 1）。手册：不在显式事务中时，每条语句都像被 `START TRANSACTION ... COMMIT` 包住，执行完立即提交，无法 ROLLBACK。多条语句作为整体需 `BEGIN` / `START TRANSACTION`（等价，后者为标准语法且支持更多选项）或 `SET autocommit = 0`。开启新事务会隐式提交当前未结束的事务。

### 2.2 事务“真正”从哪一刻开始

用 `information_schema.innodb_trx`（InnoDB 活跃事务视图）观察：

```
A: BEGIN                           innodb_trx: （空）                        ← InnoDB 中还没有这个事务
A: SELECT balance ... WHERE id=1   innodb_trx: trx_id=422172140039432        ← 第一次读，事务出现
A: UPDATE ... WHERE id=1           innodb_trx: trx_id=19580, rows_locked=1   ← 第一次写，分配真实事务 ID
```

```
BEGIN            第一次 SELECT               第一次 UPDATE
  │                  │                           │
  │ InnoDB 中         │ 事务出现                   │ 从全局计数器取真实 ID 19580
  │ 还没有这个事务     │ （显示为很大的临时数字，    │ （用来标记“这个版本由谁写入”，
  │                  │   不加锁）                 │   是专题 24 可见性判断的基础）
```

只读阶段不分配真实 ID；`START TRANSACTION READ ONLY` 读取后同样显示大数字，且 `trx_is_read_only=1`。

::: tip 观察细节
`innodb_trx` 的数据有短暂的刷新间隔，脚本中查询前等待 0.3 秒才稳定看到结果。
:::

### 2.3 快照在哪一刻拍下

**快照**：某一时刻已提交数据的“照片”，之后的普通 SELECT 看照片而不是最新数据（原理见专题 24）。

```
实验 5a：BEGIN
  B: BEGIN
  A: UPDATE t_acct SET balance = 700 WHERE id = 1     （自动提交）
  B: SELECT balance ... WHERE id = 1   -> 700         ← RR 下快照在第一次 SELECT 时才拍

实验 5b：START TRANSACTION WITH CONSISTENT SNAPSHOT
  B: START TRANSACTION WITH CONSISTENT SNAPSHOT
  A: UPDATE t_acct SET balance = 700 WHERE id = 1
  B: SELECT balance ... WHERE id = 1   -> 1000        ← 开启事务那一刻就拍了
```

手册：RR 下事务内所有快照读使用**第一次读**建立的快照；`WITH CONSISTENT SNAPSHOT` 等同 `START TRANSACTION` 后立即执行一次 SELECT，**只在 RR 下有效**。实测在 RC / RU 下使用会产生 `Warning 138: WITH CONSISTENT SNAPSHOT was ignored because this phrase can only be used with REPEATABLE READ isolation level.`

工程意义：对账、导出要求多张表对应同一时间点时，用 `WITH CONSISTENT SNAPSHOT` 开启事务（`mysqldump --single-transaction` 即如此）。

### 2.4 长事务拖住整个库

B 开启事务读一次后不关闭，A 自动提交执行 5000 次 UPDATE。**history list length**：已提交但旧版本还不能清理的 undo 记录数量。

```
开始前                          history_len = 13
A 执行 5000 次 UPDATE，B 未关     history_len = 5000
再等 5 秒，B 仍未关               history_len = 5000      ← 一条都没清理
B COMMIT 后 5 秒                 history_len = 0
```

B 的快照可能还要读这些旧版本，后台清理线程（purge）不能删除。长事务导致 undo 膨胀、版本链变长、查询变慢（专题 24、31）；若还持有锁，就是专题 22 的“闲置阻塞者”。

```sql
SELECT trx_mysql_thread_id, trx_started, TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS secs,
       trx_rows_locked, trx_query
FROM information_schema.innodb_trx
WHERE trx_started < NOW() - INTERVAL 60 SECOND ORDER BY trx_started;
```

## 三、四种隔离级别

### 3.1 类比与三种读异常

> **拍照类比**
> - **READ UNCOMMITTED（RU）**：不拍照，直接看现场，连别人正在搬、没放稳的东西都看得到。
> - **READ COMMITTED（RC）**：每看一眼重新拍一张，照片里只有放稳（已提交）的东西。
> - **REPEATABLE READ（RR）**：事务里第一次看时拍一张，整个事务只看这张。
> - **SERIALIZABLE**：排队，一个一个来。

**① 脏读（dirty read）**：读到别人未提交、后来又撤销的数据。

```
            会话 A                               会话 B（READ UNCOMMITTED）
T1   BEGIN
T2   UPDATE ... balance + 500 WHERE id=1（未提交）
T3                                            SELECT balance WHERE id=1  -> 1500  ⚠
T4   ROLLBACK
T5                                            SELECT balance WHERE id=1  -> 1000
```

T3 的 1500 从未真正存在。RC 下 T3 读到 1000（实测）。

**② 不可重复读（non-repeatable read）**：同一事务里两次读同一行，结果不同。

```
            会话 A                               会话 B
T1                                            BEGIN
T2                                            SELECT balance WHERE id=1  -> 1000
T3   UPDATE ... = 800 WHERE id=1（自动提交）
T4                                            SELECT balance WHERE id=1  -> RC: 800 ⚠   RR: 1000 ✓
T5                                            COMMIT
T6                                            SELECT balance WHERE id=1  -> 800
```

**③ 幻读（phantom read）**：同一事务里按同一条件查两次，行数变了。

```
            会话 A                               会话 B
T1                                            BEGIN
T2                                            SELECT COUNT(*) WHERE balance>=500   -> 2
T3   INSERT (3,'C',600)（自动提交）
T4                                            SELECT COUNT(*) WHERE balance>=500   -> RC: 3 ⚠   RR: 2 ✓
```

不可重复读是“同一行的值变了”，幻读是“满足条件的行变多或变少”。

### 3.2 汇总

| 隔离级别 | 脏读 | 不可重复读 | 幻读（普通 SELECT） | 普通 SELECT 读什么 |
| --- | --- | --- | --- | --- |
| READ UNCOMMITTED | 会 | 会 | 会 | 最新数据，包括未提交的 |
| READ COMMITTED | 不会 | 会 | 会 | 每条语句开始时已提交的数据 |
| **REPEATABLE READ（默认）** | 不会 | 不会 | 不会 | 事务内第一次读时的快照 |
| SERIALIZABLE | 不会 | 不会 | 不会 | 关闭自动提交时，普通 SELECT 自动变为 `FOR SHARE` |

### 3.3 RC 的快照：在什么时候重拍、里面有什么

| | B 的快照什么时候重拍 | 快照里有什么 |
| --- | --- | --- |
| RC | B 的**每条**普通 SELECT 开始时，不管 B 是否提交 | 那一刻**已提交**的数据 |
| RR | B 的事务结束后，下一个事务第一次读时 | 同上 |

所以 RC 下：A 的修改要等 **A 提交之后**，才出现在 B **下一条** SELECT 的快照里；决定快照内容的是 A 是否提交，与 B 是否提交无关。

```
时间 ─────────────────────────────────────────────────────────────▶
A:  BEGIN        UPDATE id=1 → 1001（加锁，未提交）          COMMIT
B（RC，同一个未提交事务内）：
    SELECT①          SELECT②                                  SELECT③
    快照：1000        快照：1000（A 未提交）                    快照：1001（A 已提交）
    SELECT ... FOR UPDATE：从 A 执行 UPDATE 起开始等锁 ━━━━━━━━┥→ 读到 1001
```

注意：A 只执行 `BEGIN` 时不持有任何锁；只有 A 修改或加锁读之后，被锁住的那些行才会挡住 B 的当前读，A 没碰过的行不受影响。

## 四、快照读与当前读

### 4.1 按语句写法判断

| 语句 | 读的类型 | 读什么 |
| --- | --- | --- |
| 普通 `SELECT` | **快照读**（consistent read） | 快照中的版本，不加锁 |
| `SELECT ... FOR UPDATE / FOR SHARE`、`UPDATE`、`DELETE`、`INSERT` | **当前读**（current read） | 最新的已提交版本，并加锁 |

这套规则在 RC、RR 下相同；RC 与 RR 的区别只是快照的**有效期**（一条语句 / 整个事务）。设计原因：快照读让读写互不阻塞；当前读保证修改基于最新数据，不覆盖别人已提交的修改。

### 4.2 隔离级别会改变结果的三种情况

A 执行 `BEGIN; UPDATE t_acct SET balance = balance + 1 WHERE id = 1;` 不提交（持有 id=1 的排他锁），B 用不同级别和写法读，锁等待超时 2 秒。**被锁挡住 = 当前读**：

| # | B 的级别 | B 的语句 | 真实结果 | 结论 |
| --- | --- | --- | --- | --- |
| ① | RR | 普通 `SELECT ... WHERE id = 1` | 立即返回 1000 | 快照读 |
| ② | RR | `... FOR SHARE` | 2 秒后 ERROR 1205 | 当前读 |
| ③ | **RR** | `INSERT INTO t_copy SELECT * FROM t_acct WHERE id = 1` | **ERROR 1205** | SELECT 部分是当前读 |
| ④ | **RC** | 同上 | **立即成功** | SELECT 部分是快照读 |
| ⑤ | SERIALIZABLE，自动提交开 | 普通 SELECT | 立即返回 1000 | 快照读 |
| ⑥ | **SERIALIZABLE，自动提交关** | 普通 SELECT | **ERROR 1205** | 变为当前读 |
| ⑦ | RU | 普通 SELECT | 立即返回 **1001** | 不加锁但读未提交的最新值 |

- **“写里面套读”**（手册 Locks Set by Different SQL Statements）：`INSERT INTO T SELECT ... FROM S` 在 RC 下对 S 做快照读，其他级别给 S 加共享临键锁；`CREATE TABLE ... SELECT` 同理；`REPLACE INTO t SELECT ... FROM s`、`UPDATE t ... WHERE col IN (SELECT ... FROM s)` 给 s 加共享临键锁。手册给出的加锁理由是：使用基于语句的 binlog 前滚恢复时，每条 SQL 必须按原样执行（专题 32）。
- **SERIALIZABLE**：关闭自动提交时普通 SELECT 变为 `FOR SHARE`。
- **RU**：既不是快照读也不是当前读，不加锁地读最新值。

判断步骤：先看写法；遇到写里套读的语句再看隔离级别；仍不确定就在事务中执行后查 `performance_schema.data_locks`，有锁即为当前读。EXPLAIN 看不出。

### 4.3 RC 的快照读不等于当前读

RC 下每条语句都拍新快照，但只在**无并发修改**时两者结果相同。实测（RC）：

```
区别一：遇到别人未提交的修改
  A: BEGIN; UPDATE id=1 -> 1001（未提交，1.5 秒后提交）
  B 快照读（0.3s）：SELECT ... WHERE id = 1             -> (1, 1000)  耗时 0.00s
  B 当前读（0.3s）：SELECT ... WHERE id = 1 FOR UPDATE  -> (1, 1001)  耗时 1.20s（等 A 提交）

区别二：单条语句执行期间（每行 SLEEP(1)，A 在 0.5s 提交 id=2 = 555）
  快照读：SELECT id, balance, SLEEP(1) FROM t_acct             -> (1,1000) (2,1000)
  当前读：SELECT id, balance, SLEEP(1) FROM t_acct FOR UPDATE  -> (1,1000) (2,555)
```

| | 快照读 | 当前读 |
| --- | --- | --- |
| 遇到他人未提交修改 | 立即返回上一个已提交版本 | 等对方结束后读最新值 |
| 单条语句内部 | 整条语句看语句开始时的快照（语句级一致） | 逐行取那一刻的最新值 |
| 加锁 | 不加，不阻塞别人 | 加锁，阻塞别人的写 |

### 4.4 RR 下的“幻读”到底指什么

在 RR 事务中继续（真实输出）：

```
T4  SELECT COUNT(*) WHERE balance >= 500               -> 2        快照读
T5  SELECT COUNT(*) WHERE balance >= 500 FOR UPDATE    -> 3   ⚠    当前读
T6  SELECT COUNT(*) WHERE balance >= 500               -> 2        回到快照

另一轮：
    SELECT id, name, balance                           -> (1,A,1000) (2,B,1000)
    UPDATE ... SET balance = balance + 1 WHERE balance >= 500   -> 3 row(s) affected   ⚠ 改到了 C
    SELECT id, name, balance                           -> (1,A,1001) (2,B,1001) (3,C,601)
```

手册：快照只作用于 SELECT，不一定作用于 DML；别人刚提交的行，本事务查不到却可能被本事务的 UPDATE / DELETE 影响，修改后这些行对本事务可见。

::: danger 错误理解 vs 正确理解
- ❌ “MySQL 的 RR 完全解决了幻读”或“MySQL 的 RR 有幻读”。
- ✅ RR 下**快照读**不会幻读（MVCC，专题 24）；**当前读**读最新数据，InnoDB 用**间隙锁**阻止“加锁读之后”的插入（专题 26）——上例中 A 的插入发生在 B 加锁读之前，所以被看到。同一事务混用快照读与当前读会看到“两个世界”，手册不建议在 RR 事务中这样混用。
:::

### 4.5 为什么 MySQL 默认 RR，PostgreSQL 默认 RC

| | MySQL | PostgreSQL |
| --- | --- | --- |
| 默认级别 | REPEATABLE READ | READ COMMITTED |
| 常见解释（业界流传，如《MySQL 实战 45 讲》） | 早期 binlog 只有 STATEMENT 格式，RC 下从库重放可能与主库不一致，RR 配合间隙锁可避免 | — |
| 手册可印证的事实 | RC 只支持 ROW 格式 binlog，`MIXED` 时自动改用行格式；沙箱 `binlog_format` 实测为 ROW | — |
| RR 下并发修改同一行 | 后执行的 UPDATE 用当前读，等前者提交后基于最新值继续修改，不报错 | 报错 `could not serialize access due to concurrent update`，应用需重试 |

最后一行对从 PG 转来很关键：MySQL 的 RR 不报错，但“先读后写”的业务可能覆盖他人修改（两个事务都读到 1000，各扣 100 后写回 900）。应写成 `UPDATE ... SET balance = balance - 100` 或使用 `SELECT ... FOR UPDATE`（专题 26）。

## 五、隔离级别怎么选

| 维度 | RC | RR |
| --- | --- | --- |
| 锁的范围 | 只锁记录，不加间隙锁（外键、唯一性检查除外） | 加间隙锁 / 临键锁 |
| binlog | 必须 ROW | 任意格式 |
| 一致性快照 | 每条语句一张新快照 | 整个事务一张，适合对账、报表、导出 |
| 常见用法 | 很多互联网公司在线业务改用 RC 以减少锁冲突（业界常见做法） | MySQL 默认 |

锁范围的差异与 RC 为何减少锁冲突见专题 26、27；RC 为何必须用 ROW binlog 见专题 32。

```sql
SELECT @@transaction_isolation;                               -- 8.0 起的变量名
SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED;       -- 当前会话
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;               -- 仅下一个事务
```

## 六、在三条主线中的位置

```
B 一致性：[事务：ACID、隔离级别、快照读 / 当前读] → MVCC → undo → 锁 → redo → binlog → 崩溃恢复 → 复制
A 性能：长事务导致 undo 堆积、版本链变长（专题 24、31）
C 诊断：隔离级别、长事务、history list length 是事务类问题的观察入口
```

## 七、诊断实践

### 7.1 观察入口

| 看什么 | 查询 | 说明 |
| --- | --- | --- |
| 当前隔离级别 | `SELECT @@transaction_isolation, @@global.transaction_isolation` | 会话级与全局级可能不同，连接池可能修改会话级 |
| 活跃事务与时长 | 上文 `innodb_trx` 长事务查询 | `trx_query` 为 NULL 且时间长 = 闲置事务 |
| 旧版本堆积 | `SELECT COUNT FROM information_schema.INNODB_METRICS WHERE NAME = 'trx_rseg_history_len'` | 持续增长不回落 → 有长事务挡住 purge |
| 某条语句是否加锁 | 事务中执行后查 `performance_schema.data_locks` | 区分快照读与当前读 |

### 7.2 病例

| 病例 | 现象 | 定位 | 处置 |
| --- | --- | --- | --- |
| 转账后总额不对 | 部分修改生效、部分失败 | 多条语句在自动提交模式下执行 | 放进同一事务，异常回滚 |
| 报表前后数据对不上 | 同一报表不同部分时间点不一致 | RC 下每条语句新快照，或 RR 下用 BEGIN 后第一次读太晚 | RR + `START TRANSACTION WITH CONSISTENT SNAPSHOT` |
| 数据库越来越慢、undo 表空间增长 | history_len 持续增长 | `innodb_trx` 中有开了很久的事务（包括只读事务） | 结束长事务；应用及时提交 |
| `INSERT ... SELECT` 汇总时在线写入卡住 | 源表写入等锁 | RR 下源表被加共享临键锁 | 改在 RC 会话中执行，或分批、错峰 |
| 两个并发扣款后余额只扣了一次 | 先 SELECT 余额再 UPDATE 写回固定值 | 快照读读到旧值，后写覆盖前写 | `SET balance = balance - x` 或 `SELECT ... FOR UPDATE` |

## 八、本地复现（Docker mysql:8.4，两个客户端窗口）

```sql
USE lab;
CREATE TABLE t_acct (id INT PRIMARY KEY, name VARCHAR(10) NOT NULL, balance INT NOT NULL, CHECK (balance >= 0));
INSERT INTO t_acct VALUES (1,'A',1000),(2,'B',1000);

-- 1. 不用事务转账（窗口 A）
UPDATE t_acct SET balance = balance + 1500 WHERE id = 2;
UPDATE t_acct SET balance = balance - 1500 WHERE id = 1;     -- ERROR 3819
SELECT SUM(balance) FROM t_acct;                             -- 3500
UPDATE t_acct SET balance = 1000;                            -- 恢复

-- 2. 不可重复读（窗口 B；第二轮改为 REPEATABLE READ）
SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED;
BEGIN;
SELECT balance FROM t_acct WHERE id = 1;
--   窗口 A：UPDATE t_acct SET balance = 800 WHERE id = 1;
SELECT balance FROM t_acct WHERE id = 1;                     -- RC: 800，RR: 1000
COMMIT;

-- 3. 幻读 + 当前读（窗口 B，RR）
BEGIN;
SELECT COUNT(*) FROM t_acct WHERE balance >= 500;
--   窗口 A：INSERT INTO t_acct VALUES (3,'C',600);
SELECT COUNT(*) FROM t_acct WHERE balance >= 500;            -- 2
SELECT COUNT(*) FROM t_acct WHERE balance >= 500 FOR UPDATE; -- 3
ROLLBACK;

-- 4. 快照时机：分别用 BEGIN 与 START TRANSACTION WITH CONSISTENT SNAPSHOT 开启，
--    中间让窗口 A 修改 id=1，再查 id=1

-- 5. 写里套读：窗口 A 执行 BEGIN; UPDATE t_acct SET balance = balance + 1 WHERE id = 1;（不提交）
CREATE TABLE t_copy LIKE t_acct;
SET innodb_lock_wait_timeout = 2;
SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ;
INSERT INTO t_copy SELECT * FROM t_acct WHERE id = 1;        -- ERROR 1205
SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED;
INSERT INTO t_copy SELECT * FROM t_acct WHERE id = 1;        -- 成功

-- 6. 事务 ID：窗口 B 依次 BEGIN / SELECT / UPDATE，每步后在窗口 A 查
SELECT trx_id, trx_state, trx_rows_locked FROM information_schema.innodb_trx;

-- 7. 长事务：窗口 B 执行 BEGIN; SELECT COUNT(*) FROM t_acct; 后保持不动；
--    窗口 A 多次 UPDATE t_acct SET balance = balance + 1 WHERE id = 2; 并查 trx_rseg_history_len
```

**预期现象**：与上文真实输出一致；history_len 的绝对值与变化速度以本地为准。

::: tip PG 对照
PG 的 RR 是快照隔离：并发修改同一行时后者报序列化错误，需重试；MySQL 的 RR 在 UPDATE 时用当前读继续执行。PG 的 READ UNCOMMITTED 实际按 READ COMMITTED 执行，不存在脏读；PG 的 SERIALIZABLE 用 SSI（可串行化快照隔离）检测冲突并报错，而 MySQL 的 SERIALIZABLE 靠把读变为加锁读。
:::

## 九、与其他专题的关联

- **专题 3**：快照读与加锁读的初步区分。
- **专题 4**：undo、redo 在一条 UPDATE 中的位置。
- **专题 8**：每行隐藏的事务 ID 与回滚指针。
- **专题 22**：闲置事务持锁的诊断。
- **专题 24**：快照（Read View）与版本链的实现。
- **专题 26 / 27**：间隙锁、RC 与 RR 的锁差异、死锁。
- **专题 31**：undo、purge 与长事务。
- **专题 32**：binlog 格式与隔离级别的关系。

## 十、复习 checklist

- [ ] 能用转账例子说出 ACID 各防止什么问题、分别由什么机制实现，并解释“C 是目的”
- [ ] 知道自动提交的含义，以及 BEGIN 后事务实际在第一次读 / 写时才出现、第一次写才分配真实事务 ID
- [ ] 能说出 RR 下快照在第一次读时建立，以及 `WITH CONSISTENT SNAPSHOT` 的作用和仅在 RR 有效
- [ ] 能用时间线复现脏读、不可重复读、幻读，并说出四种隔离级别各防住哪些
- [ ] 知道 RC 每条 SELECT 都重拍快照，快照只含已提交数据
- [ ] 能区分快照读与当前读，说出三种隔离级别相关的例外（写里套读、SERIALIZABLE、RU）
- [ ] 能说出 RC 快照读与当前读的三点区别
- [ ] 能准确表述 RR 下的“幻读”：快照读不会，当前读靠间隙锁
- [ ] 知道 MySQL 与 PG 默认隔离级别不同的原因，以及两者 RR 并发修改表现不同
- [ ] 知道长事务如何挡住 purge，会用 `innodb_trx` 与 history_len 发现
