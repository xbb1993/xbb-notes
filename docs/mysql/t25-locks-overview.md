# 专题 25 · 锁（上）：全局锁、表锁、元数据锁、意向锁、行锁

> 级别 ★ · 主线 B（衔接 C）· 实测版本：沙箱 MySQL 8.0.46

本专题回答：MVCC 解决了读写冲突，写和写之间靠什么互斥？锁有哪几种粒度、各解决什么问题？为什么一条 ALTER 能让整张表卡死？意向锁有什么用？共享锁为什么还要“锁”？行锁在各隔离级别下怎么加、怎么释放？

## 一、问题与两条线

两个扣款不能都基于 1000 各扣 100 后写回 900：写和写必须**互斥**——这就是锁。随之两个问题：

```
① 锁多大范围？
范围大 ◀──────────────────────────────────────────────▶ 范围小
整个实例（全局锁）     一张表（表锁）               一行（行锁）
加锁简单、锁数量少，但大家都要等                   并发度高，但锁多、管理成本高

② 保护什么？数据，还是表结构？
```

| 保护对象 | 锁 | 管理者 |
| --- | --- | --- |
| 表结构 | 元数据锁（MDL） | Server 层 |
| 数据 | 全局锁、`LOCK TABLES` | Server 层 |
| 数据 | 意向锁、行锁 | InnoDB |

## 二、全局锁

**问题**：逻辑备份逐表导出，各表必须是同一时刻的样子。**方案**：`FLUSH TABLES WITH READ LOCK`（FTWRL）让整个实例只读。

```
G:  FLUSH TABLES WITH READ LOCK
S3: SELECT balance FROM t_acct WHERE id = 1         -> 立即返回 1000        ← 读不受影响
S2: UPDATE t_acct SET balance = balance + 1 WHERE id = 1
    PROCESSLIST state: Waiting for global read lock                       ← 写被挡
G:  UNLOCK TABLES（1.5 秒后）→ S2 完成，等待 1.50s
```

| 方案 | 写入是否被挡 | 适用 |
| --- | --- | --- |
| FTWRL | 整个实例写入暂停 | 所有引擎 |
| 一致性快照（`START TRANSACTION WITH CONSISTENT SNAPSHOT`，`mysqldump --single-transaction`） | 不挡，靠 MVCC | 仅事务型表（InnoDB） |
| `LOCK INSTANCE FOR BACKUP`（备份锁） | 手册：允许备份期间 DML，阻止创建 / 重命名 / 删除文件及 `TRUNCATE`、`OPTIMIZE` 等 | 物理备份工具 |

::: danger 错误理解 vs 正确理解
- ❌ 备份 MySQL 一定要锁库。
- ✅ 全是 InnoDB 表时用一致性快照即可，不必停写；全局锁是为了照顾非事务型表。
:::

## 三、表锁

```sql
LOCK TABLES t_acct READ;    -- 所有会话只能读
LOCK TABLES t_acct WRITE;   -- 仅本会话可读写，其他会话读写都等
UNLOCK TABLES;
```

Server 层显式表锁，主要为 MyISAM 等无行锁的引擎准备；InnoDB 日常基本不用。

## 四、元数据锁（MDL）

### 4.1 问题与方案

会话 1 正在执行耗时的 SELECT，会话 2 `ALTER TABLE ... DROP COLUMN`——若立即执行，会话 1 读到一半列就没了。**方案**：每条语句访问表时**自动**给“表结构”加锁：读写语句加共享的结构锁，彼此不冲突；DDL 加排他的结构锁，须等所有使用者离开。即 **MDL（Metadata Lock）**，“元数据”指表定义（列、类型、索引）。

### 4.2 四要素

| 要素 | 内容 |
| --- | --- |
| 归属 | 按“会话 × 表”存在 |
| 来源 | Server 层自动加，无需任何语句 |
| 生命周期 | **持有到事务结束**（手册）；自动提交模式下一条语句即一个事务，语句结束释放 |
| 类型 | 见下表 |

| 语句 | MDL 类型（`metadata_locks.LOCK_TYPE`） | 冲突对象 |
| --- | --- | --- |
| SELECT | `SHARED_READ` | `EXCLUSIVE`、`SHARED_NO_READ_WRITE` |
| INSERT / UPDATE / DELETE | `SHARED_WRITE` | 同上 |
| ALTER TABLE（开始阶段） | `SHARED_UPGRADABLE` | 不挡普通读写 |
| ALTER TABLE（切换结构时） | `EXCLUSIVE` | **所有类型** |
| LOCK TABLES ... WRITE | `SHARED_NO_READ_WRITE` | 其他会话的读写 |

手册规则：**写锁请求优先于读锁请求**——排队中的 `EXCLUSIVE` 会挡住在它之后到来的 `SHARED_READ`。

### 4.3 经典事故（真实输出，S1..S4 连接 ID 为 10..13）

```
t=0.03s  S1: BEGIN; SELECT * FROM t_acct WHERE id = 1      ← 查完不提交
t≈0.03s  S2: ALTER TABLE t_acct ADD COLUMN note VARCHAR(20)
t≈1.0s   S3: SELECT * FROM t_acct WHERE id = 2
t≈1.5s   S4: UPDATE t_acct SET balance = balance + 1 WHERE id = 3

第 2.5 秒：
PROCESSLIST：11/12/13 均为 Waiting for table metadata lock
metadata_locks：
  10  SHARED_READ        TRANSACTION  GRANTED     ← S1 查完了，事务未结束，锁还在
  11  SHARED_UPGRADABLE  TRANSACTION  GRANTED
  11  EXCLUSIVE          TRANSACTION  PENDING     ← ALTER 等 S1
  12  SHARED_READ        TRANSACTION  PENDING     ← 普通 SELECT 也在等
  13  SHARED_WRITE       TRANSACTION  PENDING     ← 普通 UPDATE 也在等
sys.schema_table_lock_waits（节选）：waiting_pid=11 EXCLUSIVE ← blocking_pid=10，建议 KILL 10

t=3.55s S1 COMMIT → ALTER 等 3.53s、SELECT 等 2.52s、UPDATE 等 2.02s 后全部完成
```

```
t_acct 的 MDL：
  已持有：[S1: SHARED_READ（事务未结束）]
  排队：  [S2: EXCLUSIVE] → [S3: SHARED_READ] → [S4: SHARED_WRITE] → 之后所有语句……
             ↑ 与 S1 冲突      ↑ 本与 S1 不冲突，但排在更优先的 EXCLUSIVE 后面
```

后果：一个忘记提交的事务 + 一条 ALTER = 该表所有新请求堆积、连接被占满。

::: danger 错误理解 vs 正确理解
- ❌ SELECT 执行完就不再占用这张表。
- ✅ 显式事务中 SELECT 的 MDL 持有到**事务结束**。
- ❌ 等锁的 ALTER 只影响自己。
- ✅ 排队中的 ALTER 挡住其后所有访问该表的请求。
:::

### 4.4 防护

`lock_wait_timeout`：MDL 等待超时，沙箱实测默认 **31536000 秒（一年）**；与行锁超时 `innodb_lock_wait_timeout`（默认 50 秒）是两个参数。

```
S1: BEGIN; SELECT ...（不提交）
S2: SET SESSION lock_wait_timeout = 3; ALTER TABLE ... → 3.00s 后 ERROR 1205
S3: SELECT ... → S2 放弃后立即返回
```

1. DDL 前查 `information_schema.innodb_trx` 有无长事务。
2. DDL 会话设较短的 `lock_wait_timeout`，失败重试。
3. Online DDL 开始和结束时**仍需短暂排他 MDL**（专题 36）。

## 五、意向锁

### 5.1 问题与方案

表级锁请求（如 `LOCK TABLES ... WRITE`）要知道“表里有没有行被锁”。朴素方案逐行检查，100 万行查 100 万次。**方案**：加行锁前先在**表上**挂标记，整表请求只需看一眼。手册：意向锁的主要目的是表明“有人正在锁、或将要锁表中的某一行”。

### 5.2 规则与兼容矩阵（8.4 手册）

| 想加的行锁 | 先在表上加 |
| --- | --- |
| 行 S | `IS` 或更强 |
| 行 X | `IX` |

| | X | IX | S | IS |
| --- | --- | --- | --- | --- |
| **X** | 冲突 | 冲突 | 冲突 | 冲突 |
| **IX** | 冲突 | 兼容 | 冲突 | 兼容 |
| **S** | 冲突 | 冲突 | 兼容 | 兼容 |
| **IS** | 冲突 | 兼容 | 兼容 | 兼容 |

- IX 与 IX 兼容：各锁不同行的事务互不影响，冲突交给行锁判断。
- 手册：意向锁**除整表请求外不阻挡任何东西**。

### 5.3 实验

```
A: BEGIN; UPDATE ... WHERE id = 1
B: BEGIN; UPDATE ... WHERE id = 2      -> 立即返回
data_locks：
  21  TABLE   IX              GRANTED
  21  RECORD  X,REC_NOT_GAP   GRANTED  id=1
  22  TABLE   IX              GRANTED            ← 与 A 的 IX 兼容
  22  RECORD  X,REC_NOT_GAP   GRANTED  id=2
B 再改 id=1：22 RECORD X,REC_NOT_GAP WAITING id=1 → 3 秒后 ERROR 1205
```

`X,REC_NOT_GAP`：只锁记录本身、不锁其前间隙的排他锁（间隙见专题 26）。

**易误解的实测**：A 持有 id=1 行锁时，C 执行 `LOCK TABLES t_acct WRITE`，C 的 state 为 `Waiting for table metadata lock`（A 持 `SHARED_WRITE`，C 请求 `SHARED_NO_READ_WRITE`），3 秒后 ERROR 1205。挡住 C 的是 **Server 层 MDL**，请求还没走到 InnoDB 的意向锁检查。MySQL 中“整表锁 vs 正在进行的行修改”通常先由 MDL 拦下；意向锁是 InnoDB 内部保证表锁与行锁一致的机制，`data_locks` 中的 `IX` / `IS` 是其证据。

## 六、行锁

### 6.1 共享锁（S）为什么还要“锁”

**场景**：下单时先检查商品“在售”再插入订单；快照读不加锁，检查之后运营可随时下架，导致卖出已下架商品。需要“我读过的行，在我事务结束前别人不能改”。

用 X 锁（`FOR UPDATE`）能挡住修改，但 100 个同时检查同一商品的事务也会互相排队。所以需要：**读者之间不互相阻挡，读者与写者互相阻挡**——这就是 S 锁。“共享”指与其他读者共享，“锁”挡的是写者。

> **类比**：会议室门口挂“使用中，欢迎旁听”。旁听多少人都行（S 与 S 兼容），但只要还有人在里面，就不能进来拆改（X 须等所有 S 离开）。

| | 行上已有 S | 行上已有 X |
| --- | --- | --- |
| 再加 S | 兼容 | 等待 |
| 再加 X | 等待 | 等待 |

| 语句 | 行锁 |
| --- | --- |
| `SELECT ... FOR SHARE` | S |
| `SELECT ... FOR UPDATE`、`UPDATE`、`DELETE` | X |
| 普通 SELECT | 不加（快照读） |

```
A: SELECT ... WHERE id = 1 FOR SHARE   → 表 IS + 行 S,REC_NOT_GAP  GRANTED
B: SELECT ... WHERE id = 1 FOR SHARE   → 表 IS + 行 S,REC_NOT_GAP  GRANTED   ← 兼容
C: SELECT ... WHERE id = 1 FOR UPDATE  → 表 IX GRANTED，行 X WAITING        ← 冲突
```

用途：业务“读后检查”；外键检查（手册：需检查外键约束的增删改会在被检查的父表记录上加共享锁）。

**陷阱：先 S 后升级为 X 易死锁**（真实输出）：

```
A: BEGIN; SELECT ... WHERE id = 1 FOR SHARE    -> 立即返回
B: BEGIN; SELECT ... WHERE id = 1 FOR SHARE    -> 立即返回
A: UPDATE ... WHERE id = 1                     -> 等待（需 X，B 持有 S）
   data_locks：A S GRANTED，A X WAITING，B S GRANTED
B: UPDATE ... WHERE id = 1                     -> ERROR 1213: Deadlock found
A 的 UPDATE 在 B 被回滚后完成（等待 0.81s）
```

读后确定要改，直接用 `FOR UPDATE`；只需“读到的值在事务结束前不被改”且自己不改，才用 `FOR SHARE`。

### 6.2 行锁加在“访问到的索引记录”上

手册：**记录锁总是锁在索引记录上，即使表上没有定义索引。** 当前读执行过程：

```
InnoDB 沿选定索引逐条访问记录
   ├─ 访问一条 → 先加锁
   ├─ 交给 Server 层
   └─ Server 层判断 WHERE（索引无法过滤的条件在此判断）
         ├─ 满足 → 修改 / 返回
         └─ 不满足 → 跳过，访问下一条
```

**锁加在被访问到的记录上，早于 WHERE 判断。** WHERE 能用索引定位时，访问的基本就是满足条件的行；不能时要逐行访问，锁的范围远大于满足条件的范围。

### 6.3 各隔离级别怎么加、怎么释放

实验语句：`UPDATE t_acct SET balance = balance + 1 WHERE name = 'A'`（name 无索引，只有 id=1 满足；只能沿主键访问 1 → 2 → 3 → 结束标记）。

**RR：访问到的都锁，锁到事务结束**

```
A（RR）语句执行完、未提交：
   id=1  X  GRANTED                    ← 满足条件
   id=2  X  GRANTED                    ← 不满足，访问过，仍锁着
   id=3  X  GRANTED
   supremum pseudo-record  X  GRANTED  ← “最后一条之后”的标记（专题 26）
B: UPDATE ... WHERE id = 3 → 3 秒后 ERROR 1205；WHERE id = 1 → ERROR 1205
A COMMIT 后：无行锁
```

**RC：不满足条件的行判断完立即释放**

```
A（RC）语句执行完、未提交：
   id=1  X,REC_NOT_GAP  GRANTED        ← 只剩满足条件的行，且只锁记录本身
B: UPDATE ... WHERE id = 3 → 立即成功；WHERE id = 1 → ERROR 1205
```

手册（RC）：对不满足条件的行，在 MySQL 判断完 WHERE 后释放锁。

```
                id=1（满足）     id=2（不满足）     id=3（不满足）
RR：   加锁 ──── 保留到提交       保留到提交         保留到提交
RC：   加锁 ──── 保留到提交       判断完立即释放      判断完立即释放
```

**RC 的半一致读（semi-consistent read）**：A 先锁 id=3，B 执行同一条按 name 的 UPDATE（必然访问 id=3）：

```
B 为 RR：3 秒后 ERROR 1205（访问 id=3 须加锁，只能等）
B 为 RC：立即成功，改 1 行

RC 的 UPDATE 遇到被锁的行：先读其最近已提交版本（name='C'）判断 WHERE
   ├─ 不满足 → 直接跳过，不等
   └─ 满足 → 再等锁，拿到后重新读取并判断
```

**汇总**：

| 级别 | 满足条件的行 | 访问过但不满足的行 | 间隙 |
| --- | --- | --- | --- |
| READ UNCOMMITTED | 保留到事务结束 | 判断后释放 | 不锁 |
| READ COMMITTED | 保留到事务结束 | 判断后释放（UPDATE 有半一致读） | 不锁（外键、唯一性检查除外） |
| REPEATABLE READ | 保留到事务结束 | **保留到事务结束**（原因见专题 26） | 锁 |
| SERIALIZABLE | 同 RR | 同 RR | 同 RR |

RU 的锁行为与 RC 相同（手册：除普通读可能读到未提交数据外，其余同 RC）。

**为什么满足条件（被修改）的行必须锁到事务结束**：

```
若 A 改完 id=1 就释放 X：
  A: id=1 1000 → 900（未提交），释放锁
  B: id=1 900 → 800（基于 A 未提交的值），提交
  A: ROLLBACK → undo 把 id=1 恢复成 1000 → B 的修改被覆盖
```

RC 提前释放的只是**未被修改**的行。

::: warning 实测细节：语句超时不释放已加的锁
RR 下 B 的语句因锁等待超时报错后，`data_locks` 显示 B 仍持有超时前已加上的 id=1、id=2 的 X 锁。语句超时只回滚该语句，已加的锁保留到事务结束——超时后应用应主动回滚事务。
:::

### 6.4 串联图

```
一条语句进来
   ├─ ① 全局锁：实例处于 FTWRL？          → Waiting for global read lock
   ├─ ② MDL（Server 层，自动，持有到事务结束）
   │     读写 SHARED_READ / SHARED_WRITE；DDL 需 EXCLUSIVE → Waiting for table metadata lock
   └─ ③ InnoDB
         ├─ 表级：先加意向锁 IS / IX
         └─ 行级：在访问到的索引记录上加 S / X
               RR：记录 + 间隙，全部保留到事务结束
               RC/RU：只锁记录，不满足条件的判断后释放；UPDATE 有半一致读
               冲突 → 行锁等待（state 如 updating，查 data_locks / sys.innodb_lock_waits）
```

## 七、在三条主线中的位置

```
B 一致性：事务 → MVCC（读写不冲突）→ [锁：写写互斥、表结构保护] → redo → …
C 诊断：PROCESSLIST 的各种 Waiting 状态对应哪种锁；metadata_locks / data_locks
A 性能：WHERE 不走索引 → 锁范围扩大 → 并发下降
```

## 八、诊断实践

### 8.1 现象 → 锁类型

| PROCESSLIST 现象 | 锁 | 查什么 |
| --- | --- | --- |
| `Waiting for global read lock` | 全局锁 | 谁执行了 FTWRL（通常是备份任务） |
| `Waiting for table metadata lock` | MDL | `performance_schema.metadata_locks`、`sys.schema_table_lock_waits`；再到 `innodb_trx` 找未提交长事务 |
| state 为 `updating` 等且 time 增长 | 行锁 | `sys.innodb_lock_waits`、`performance_schema.data_locks`（专题 22、27） |

### 8.2 病例

| 病例 | 现象 | 定位 | 处置 |
| --- | --- | --- | --- |
| 加字段后整张表不可用 | 大量 `Waiting for table metadata lock`，连接数暴涨 | `sys.schema_table_lock_waits` 的阻塞源是一个未提交事务 | KILL 阻塞连接或放弃 DDL；以后 DDL 前查长事务并设 `lock_wait_timeout` |
| 备份期间写入全部卡住 | `Waiting for global read lock` | 备份工具使用了 FTWRL | InnoDB 用一致性快照 / 备份锁 |
| 改一行却挡住了改别的行 | 行锁等待 | UPDATE 的 WHERE 无法走索引，RR 下锁住全表访问过的记录 | 为条件列建索引；评估 RC |
| 并发“先查后改”频繁死锁 | ERROR 1213 | `FOR SHARE` 后再 UPDATE，S 升级 X 互等 | 直接 `FOR UPDATE` |
| 锁等待超时后阻塞仍未消失 | 超时报错后其他会话继续等待 | 超时语句已加的锁保留在事务中 | 应用捕获超时后回滚事务 |

## 九、本地复现（Docker mysql:8.4，4 个客户端窗口）

```sql
USE lab;
DROP TABLE IF EXISTS t_acct;
CREATE TABLE t_acct (id INT PRIMARY KEY, name VARCHAR(10) NOT NULL, balance INT NOT NULL);
INSERT INTO t_acct VALUES (1,'A',1000),(2,'B',1000),(3,'C',1000);

-- 一、MDL 事故
-- 窗口 1：BEGIN; SELECT * FROM t_acct WHERE id = 1;          -- 不提交
-- 窗口 2：ALTER TABLE t_acct ADD COLUMN note VARCHAR(20);     -- 卡住
-- 窗口 3：SELECT * FROM t_acct WHERE id = 2;                  -- 也卡住
-- 窗口 4：
SHOW PROCESSLIST;
SELECT t.PROCESSLIST_ID, ml.LOCK_TYPE, ml.LOCK_DURATION, ml.LOCK_STATUS
FROM performance_schema.metadata_locks ml JOIN performance_schema.threads t ON t.THREAD_ID = ml.OWNER_THREAD_ID
WHERE ml.OBJECT_SCHEMA = 'lab' AND ml.OBJECT_NAME = 't_acct';
SELECT * FROM sys.schema_table_lock_waits\G
-- 窗口 1：COMMIT;  → 窗口 2、3 立即完成；再用 SET SESSION lock_wait_timeout = 3 重做（之后 DROP COLUMN note）

-- 二、全局锁：窗口 1 FLUSH TABLES WITH READ LOCK；窗口 2 UPDATE（卡）、SELECT（不卡）；窗口 1 UNLOCK TABLES

-- 通用：查看行锁
SELECT t.PROCESSLIST_ID, dl.LOCK_TYPE, dl.INDEX_NAME, dl.LOCK_MODE, dl.LOCK_STATUS, dl.LOCK_DATA
FROM performance_schema.data_locks dl JOIN performance_schema.threads t ON t.THREAD_ID = dl.THREAD_ID
WHERE dl.OBJECT_NAME = 't_acct';

-- 三、意向锁：窗口 1、2 分别 BEGIN; UPDATE ... WHERE id = 1 / id = 2，查 data_locks
-- 四、S / X 与死锁：窗口 1、2 都 BEGIN; SELECT ... WHERE id = 1 FOR SHARE；
--     窗口 1 UPDATE ... WHERE id = 1（等待）；窗口 2 UPDATE ... WHERE id = 1（ERROR 1213）
-- 五、各级别的行锁：两个窗口先 SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ（或 READ COMMITTED）
--     窗口 1：BEGIN; UPDATE t_acct SET balance = balance + 1 WHERE name = 'A';  查 data_locks
--     窗口 2：UPDATE ... WHERE id = 3（RR 等待，RC 成功）
-- 六、半一致读：窗口 1 BEGIN; UPDATE ... WHERE id = 3；窗口 2 BEGIN; UPDATE ... WHERE name = 'A'（RR 等待，RC 成功）
```

**预期现象**：与上文真实输出一致；连接 ID 与等待时长以本地为准。

::: tip PG 对照
PG 无单独的 MDL，但 `ALTER TABLE` 需要的 `ACCESS EXCLUSIVE` 表锁同样会排队并挡住后续普通查询，事故形态一致；常规防护是 `SET lock_timeout = '3s'` 后再 DDL（对应 `lock_wait_timeout`）。PG 行锁记录在元组头上，不使用意向锁，表锁冲突靠 8 种表锁模式的兼容矩阵判断。
:::

## 十、与其他专题的关联

- **专题 2**：Server 层与存储引擎的分工（MDL 在 Server 层，行锁在 InnoDB）。
- **专题 4**：UPDATE 的 `IX` + `X,REC_NOT_GAP`。
- **专题 22**：锁等待的定位流程。
- **专题 23 / 24**：快照读不加锁、当前读加锁。
- **专题 26**：间隙锁、临键锁、加锁规则；RR 为何保留未命中行的锁。
- **专题 27**：死锁检测与处理。
- **专题 36**：Online DDL 与 MDL。

## 十一、复习 checklist

- [ ] 能说出锁粒度从全局到行的取舍，以及“保护数据”与“保护表结构”两条线
- [ ] 知道 FTWRL 的作用与代价，以及一致性快照、备份锁两种替代
- [ ] 能说出 MDL 的归属、来源、生命周期（持有到事务结束）与主要类型
- [ ] 能复现并解释“长事务 + ALTER 卡死整张表”，知道写锁请求优先的排队规则
- [ ] 知道 `lock_wait_timeout` 默认一年、与 `innodb_lock_wait_timeout` 的区别，以及 DDL 前的防护步骤
- [ ] 能说出意向锁要解决的问题、IS / IX 的加锁规则与兼容矩阵；知道整表锁冲突常先被 MDL 拦下
- [ ] 能解释共享锁“共享给读者、挡住写者”的用途，以及 S 升级 X 的死锁
- [ ] 知道行锁加在访问到的索引记录上、且早于 WHERE 判断
- [ ] 能说出 RR 与 RC 下行锁的加锁与释放规则，以及 RC 的半一致读
- [ ] 知道被修改的行为何必须锁到事务结束，以及语句超时不释放已加的锁
