# 专题 26 · 锁（下）：记录锁、间隙锁、临键锁、加锁规则与幻读

> 级别 ★ · 主线 B（衔接 binlog 与复制）· 实测版本：沙箱 MySQL 8.0.46

本专题回答：RR 下当前读怎样防住幻读？间隙锁、临键锁、记录锁各锁什么？为什么 RR 把访问过但不满足条件的行也锁到事务结束？具体语句会加哪些锁？间隙锁为什么不排他？插入意向锁是什么、为什么需要它？RC 为什么锁冲突更少？

**交互图解**：<a href="/xbb-notes/mysql-t26-gap-locks.html" target="_blank">间隙锁与临键锁图解（6 种语句 × RR / RC，在索引上画出被锁的记录与间隙，附 data_locks 原始输出与探测结果，可输入任意值判断插入是否被挡）</a>

**贯穿本专题的表**：

```sql
CREATE TABLE t_lk (id INT PRIMARY KEY, c INT NOT NULL, d INT NOT NULL, KEY idx_c (c));
INSERT INTO t_lk VALUES (0,0,0),(5,5,5),(10,10,10),(15,15,15),(20,20,20),(25,25,25);
-- id 主键，c 普通索引，d 无索引
```

## 一、问题：只锁已有的行，挡不住新插入的行

```
A（RC）: BEGIN; SELECT id FROM t_lk WHERE id > 15 FOR UPDATE   -> (20), (25)
B:       INSERT INTO t_lk VALUES (30,30,30)                    -> 立即成功
A:       SELECT id FROM t_lk WHERE id > 15 FOR UPDATE          -> (20), (25), (30)   ← 当前读的幻读
```

| 威胁 | 锁住已有的行能挡住吗 |
| --- | --- |
| 修改 / 删除 20、25 | 能 |
| 插入新的 30 | **不能**：30 还不存在 |

## 二、方案：锁住记录之间的空隙

索引记录有序（专题 9），新值会落在哪个空隙是确定的：

```
主键索引：   0     5     10     15     20     25
空隙：    (-∞,0) (0,5) (5,10) (10,15) (15,20) (20,25) (25,+∞)
                                                          ↑ 30 只能插进这里
```

**间隙锁（gap lock）**——手册：

- 锁索引记录之间的空隙，或第一条之前、最后一条之后的空隙。
- “纯抑制性”：**唯一目的是阻止别人往空隙里插入**。
- **可以共存**；共享与排他的间隙锁**没有区别**，互不冲突，作用相同。

两个实现细节：

1. 间隙锁**挂在空隙右边的记录上**：`LOCK_DATA=10` 的间隙锁锁的是 (5,10)。
2. 最后一个空隙挂在伪记录 **supremum** 上——每页都有、比所有真实记录都大；手册：它不是真实记录，锁它的效果就是锁住最大值之后的空隙。

## 三、三种行锁

| 名称 | 锁什么 | `data_locks.LOCK_MODE` | 区间 |
| --- | --- | --- | --- |
| 记录锁（record lock） | 只锁记录 | `X,REC_NOT_GAP` | 10 |
| 间隙锁（gap lock） | 只锁记录左边的空隙 | `X,GAP` | (5,10) |
| **临键锁（next-key lock）** | 记录 + 左边空隙 | **`X`**（无修饰） | (5,10] |

手册：临键锁 = 索引记录上的记录锁 + 该记录**前面**空隙上的间隙锁。

**适用场景**——从“这一处需要保护什么”出发：

| 需要保护 | 锁 | 场景 |
| --- | --- | --- |
| 记录不能被改，且其前面空隙不能被插入 | 临键锁 | 范围内记录、普通索引命中的记录、无索引扫描到的记录 |
| 前面空隙不能被插入，但记录本身不在条件范围内 | 间隙锁 | 等值未命中时空隙右边的记录；扫描遇到的第一条不满足条件的记录 |
| 只有记录本身，不可能有人插入同样的值 | 记录锁 | 唯一索引等值命中；二级索引命中后回表锁主键 |

RR 默认用临键锁，在确定“不需锁记录”或“不需锁间隙”处分别退化；RC 只剩记录锁（外键、唯一性检查除外）。

## 四、为什么 RR 把访问过但不满足条件的行锁到事务结束

### 4.1 原因一：当前读在事务内不变

A 删除所有 `d = 10` 的行，未提交时 B 把 id=15 改成 d=10（真实输出）：

```
                         RC                                     RR
A: BEGIN; DELETE ... WHERE d = 10          （d 无索引，扫全表）
B: UPDATE ... SET d = 10 WHERE id = 15     立即成功                ERROR 1205（2 秒超时）
A: SELECT ... WHERE d = 10 FOR UPDATE      -> (15, 10)  ⚠           -> 空
A: COMMIT
最终 id=15                                  (15, 10)                 (15, 15)
```

访问过的行不仅“现在不满足”，还须在事务结束前“一直不满足”——只能一直锁着。

### 4.2 原因二：STATEMENT 格式 binlog 要求执行顺序 = 提交顺序

STATEMENT 格式 binlog 记录 SQL 原文、从库按**提交顺序**重新执行（专题 32）。把上面 RC 过程放进去：

```
主库实际执行：                 binlog（按提交）：                 从库重放：
① A: DELETE ... WHERE d = 10    ① B: UPDATE id=15 SET d=10        ① id=15 的 d 变为 10
   （只删 id=10）               ② A: DELETE ... WHERE d = 10       ② 删掉 id=10 和 id=15
② B: UPDATE id=15，提交
③ A: 提交
主库：id=15 还在                                                  从库：id=15 被删  ← 不一致
```

RR 把 id=15 锁到 A 提交，B 只能在之后执行，执行顺序与提交顺序一致。MySQL 直接禁止 RC + STATEMENT（真实输出）：

```
SET SESSION binlog_format = 'STATEMENT';            -- Warning 1287: '@@binlog_format' is deprecated
SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED;
BEGIN; UPDATE t_lk SET d = d + 1 WHERE c = 10;
ERROR 1665 (HY000): Cannot execute statement: impossible to write to binary log since BINLOG_FORMAT = STATEMENT
and at least one table uses a storage engine limited to row-based logging. InnoDB is limited to row-logging
when transaction isolation level is READ COMMITTED or READ UNCOMMITTED.
（同一语句在 RR 下执行成功）
```

| | 原因一 | 原因二 |
| --- | --- | --- |
| 用 ROW 格式 binlog 后是否仍成立 | 成立（RR 的语义选择） | 不再需要（ROW 记录行改前改后的值，不重新执行 WHERE） |
| 顺带解释 | — | RC 为何必须配 ROW 格式 |

### 4.3 这不等于锁表

只有 WHERE 无法走索引（下文情况 ⑥）时才锁满全表。即便如此也与表锁不同（真实输出）：

```
情况 ⑥：A: BEGIN; UPDATE t_lk SET c = c WHERE d = 10（全部记录与空隙被锁）
        B: SELECT id, d FROM t_lk WHERE id = 25 -> 立即返回；SELECT COUNT(*) -> 立即返回 6
表锁：  A: LOCK TABLES t_lk WRITE
        B: SELECT id, d FROM t_lk WHERE id = 25 -> 2 秒后 ERROR 1205
```

| 维度 | 行锁 + 间隙锁 | 表锁 |
| --- | --- | --- |
| 范围 | 由 WHERE 与索引决定，可以很小 | 固定整张表 |
| 普通读 | 不受影响（快照读） | WRITE 时也被挡 |
| 事务语义 | 随提交 / 回滚释放 | Server 层显式锁，需 `UNLOCK TABLES` |
| 代价 | 锁对象多、判断复杂 | 实现简单 |

情况 ⑥ 应视为需要修复的问题（给条件列建索引）。

## 五、加锁规则：6 种语句实测（RR）

方法：A 执行后不提交，查 `data_locks`；B 尝试插入 / 修改（锁等待超时 1 秒）。

| # | A 的语句 | data_locks（行锁） | B 被阻塞 | B 成功 | 推导 |
| --- | --- | --- | --- | --- | --- |
| ① | `UPDATE ... WHERE id = 10` | `PRIMARY X,REC_NOT_GAP 10` | 改 id=10 | 插入 8、12 | 主键唯一，不可能再插入 id=10，只锁记录（手册：唯一索引查唯一行不需间隙锁；只用到多列唯一索引部分列时仍会加） |
| ② | `UPDATE ... WHERE id = 7` | `PRIMARY X,GAP 10` | 插入 6、9 | 插入 11；改 id=10、5 | 7 不存在，锁其所在空隙 (5,10)；单位是整段空隙 |
| ③ | `UPDATE ... WHERE c = 10` | `idx_c X 10,10`；`idx_c X,GAP 15,15`；`PRIMARY X,REC_NOT_GAP 10` | 插入 c=7、12、14 | 插入 c=16、3；改 id=15 | c 不唯一，新的 c=10 可能排在 (10,10) 左或右，两侧空隙都锁；扫到 (15,15) 不等于 10 即停，只锁其左间隙；回表只锁命中行 |
| ④ | `UPDATE ... WHERE id >= 10 AND id < 12` | `PRIMARY X,REC_NOT_GAP 10`；`PRIMARY X,GAP 15` | 插入 11、13 | 插入 16；改 id=15 | 锁范围内已有的 10，及 (10,15) 防插入；15 本身不在范围。部分资料描述为 15 上加临键锁，8.0.46 实测为间隙锁 |
| ⑤ | `SELECT ... WHERE id > 15 FOR UPDATE` | `PRIMARY X 20`；`X 25`；`X supremum` | 插入 16、30 | 插入 14；改 id=15 | 20、25 临键锁；25 之后靠 supremum |
| ⑥ | `UPDATE ... SET c = c WHERE d = 10` | `PRIMARY X` 0、5、10、15、20、25、supremum | 插入 3、30；改 id=25 | — | 扫全主键，访问过的全部锁到事务结束 |

第一节实验的 RR 版本：B 插入 30 等 2 秒后 ERROR 1205，A 前后两次 FOR UPDATE 都返回 (20),(25)。

**归纳**（框架来自《MySQL 实战 45 讲》，每条均在 8.0.46 重新验证）：

| 规则 | 依据 |
| --- | --- |
| 基本单位：RR 下对每条**访问到的**索引记录加临键锁 (前一条, 本条] | ⑤ ⑥ |
| 只锁访问到的 | ①–⑤ 范围外均可插入 |
| 优化 1：唯一索引等值命中 → 退化为记录锁 | ① |
| 优化 2：等值查询向右扫到第一条不满足的记录 → 退化为间隙锁 | ② ③ |
| 范围查询扫到的第一条超出范围的记录 → 8.0.46 实测只加间隙锁 | ④ |
| 二级索引命中后回表，主键上只锁命中行 | ③ |

**RC 下同样 6 种**：只剩命中记录上的 `X,REC_NOT_GAP`，无任何间隙锁；② ⑤ 中 B 的插入全部立即成功。

## 六、间隙锁为什么不排他

**先纠正前提**：多个事务同时持有同一空隙的间隙锁**不等于死锁**。只有多个持有者随后都要往该空隙插入才会死锁：

```
A: BEGIN; UPDATE t_lk SET d = 0 WHERE id = 6    -> 立即返回
B: BEGIN; UPDATE t_lk SET d = 0 WHERE id = 9    -> 立即返回
data_locks：A X,GAP GRANTED 10；B X,GAP GRANTED 10    之后都不插入，各自提交无事
```

空隙中没有行，能发生的操作只有 INSERT。两个 UPDATE 锁同一空隙（均 0 行受影响）时，B 仍能改 id=10（记录未被锁），但插入 (8,8,8) 被挡（ERROR 1205）。

| 操作对象 | 保护锁 | 事务之间 |
| --- | --- | --- |
| 已存在的记录（UPDATE / DELETE） | 记录锁、临键锁的记录部分 | 互斥 |
| 空隙（只可能 INSERT） | 间隙锁 | 加锁不冲突，但谁都插不进 |

**不排他的三个理由**：

1. **目标一致、无可争之物**：记录锁排他是因为持有者都要修改记录；间隙锁持有者都只想“别让别人插入”，多一个持有者不破坏这一目标。
2. **粒度粗，排他会造成假冲突**：上例 6 与 9 逻辑上无交集，却在同一空隙 (5,10)；若排他，B 将无谓等待 A。
3. **空隙会合并**（手册给出的原因）：记录被 purge 后，挂在其上的不同事务的间隙锁必须合并。

```
删除前：  5 ──(5,10)── 10 ──(10,15)── 15        A 持 (5,10)，B 持 (10,15)
10 被 purge：5 ─────────(5,15)───────── 15      A、B 都持有 (5,15)——若排他则出现不可能状态
```

源码 `rec_lock_check_conflict()` 注释：不带插入意向标记的间隙类锁请求**不需要等待任何东西**，因为不同事务可以在空隙上持有冲突的锁类型。

**代价**：“先查后插”并发时会死锁（第七节）。若间隙锁排他，这类事务会串行执行而不死锁；InnoDB 选择保住并发与合并语义，死锁交给检测回滚 + 应用重试。间隙锁确实比记录锁更易与插入冲突（挡住整段区间），这正是设计成彼此不冲突、以及 RC 去掉间隙锁的原因。

## 七、插入意向锁

### 7.1 与表级意向锁区分

| | 意向锁（IS / IX） | **插入**意向锁 |
| --- | --- | --- |
| 级别 | 表级 | 行级，间隙锁的一种 |
| 作用 | 告诉整表锁请求“有人在锁行”（专题 25） | 告诉别人“我要往这个空隙某个位置插入” |
| data_locks | `TABLE`，`IX` | `RECORD`，`X,GAP,INSERT_INTENTION` |

### 7.2 为什么需要它

插入 v 前，要看 v 将落入的空隙（**比 v 大的下一条记录左边**）是否被别人用间隙锁 / 临键锁守着。值还不在索引上，无法锁“那一行”，冲突只能挂在空隙上。若需等待，要在锁队列中放一个锁请求排队——用哪种类型？

| 候选 | 问题 |
| --- | --- |
| 普通间隙锁 | 请求永远不等待，挡不住插入 |
| 下一条记录上的 X 记录锁 | 误伤锁住该记录的人，并让往同一空隙不同位置插入者互相阻塞 |
| **插入意向锁** | 专门类型，规则恰好满足需要 |

### 7.3 规则（源码 `rec_lock_check_conflict()`）

| 新请求 ＼ 他人持有 | 间隙锁 | 记录锁 | 临键锁 | 插入意向锁 |
| --- | --- | --- | --- | --- |
| **插入意向锁** | **等待** | 不等 | **等待** | 不等（注释：insert intention locks do not disturb each other） |
| 间隙锁 | 不等 | 不等 | 不等 | 不等 |
| 记录锁 / 临键锁 | 不等（记录类请求不等间隙锁） | 按 S / X 兼容 | 按 S / X 兼容 | 不等（注释：No lock request needs to wait for an insert intention lock） |

“排他”是**单向的**：插入意向锁服从间隙锁 / 临键锁；间隙锁请求不等插入意向锁；插入意向锁之间互不等待。源码注释说明后两条消除了早期“两个插入者互把对方的等待锁当冲突”造成的不必要死锁。另一条注释：插入意向锁不能越过已在等待的间隙 / 临键锁请求插队，否则插入分裂空隙会复制出等待锁，违反“一个事务同时最多等待一把锁”。

> **类比**：间隙锁 / 临键锁 = 施工队立的“禁止停车”牌，几队可以各立一块；插入意向锁 = 排队想停进这段路的车，停不同车位不互相挡；新施工队立牌不用等排队的车；牌子全撤，车一起停进去。

### 7.4 它就是“阻塞等待”本身

InnoDB 的阻塞等待 = 在锁队列登记一个等待中的锁请求并挂起线程。源码 `lock_rec_insert_check_and_lock()`：

```
插入 v → 找下一条记录（successor）
   ├─ 其上没有任何锁                → 直接插入，不创建锁对象
   ├─ 有锁但无与插入冲突的          → 直接插入，不创建锁对象
   └─ 有冲突（他人的间隙锁 / 临键锁）→ 创建 X|GAP|INSERT_INTENTION 请求，add_to_waitq，挂起
```

| 若等待不留锁对象 | 有等待中的锁对象 |
| --- | --- |
| 持锁者提交时不知谁在等，只能轮询 | 释放锁时扫描该记录等待队列，授予并唤醒 |
| 死锁检测看不到这条边，只能等超时 | 等待锁即等待图中的一条边，“先查后插”死锁 0.00s 即被检测 |
| 外部看不到在等什么 | `data_locks` / `data_lock_waits` 可见 |

实测诊断表（H 持 (5,10) 间隙锁，I 插入 6 等待）：

```
data_lock_waits：请求方 224291 X,GAP,INSERT_INTENTION  ←等待→  持有方 224290 X,GAP（记录 10）
innodb_trx：224290 RUNNING；224291 LOCK WAIT（trx_requested_lock_id、trx_wait_started 非空）
```

所有锁等待都如此实现（UPDATE 等记录锁时同样出现 `X,REC_NOT_GAP WAITING`）；插入意向锁特殊在**类型**。

> **类比**：银行取号。窗口有人时取号排队，叫号系统才能叫你、才能看出谁等谁；窗口空着就直接办理。插入意向锁就是这张号。

### 7.5 完整过程（真实输出）

```
H:  BEGIN; UPDATE t_lk SET d = 0 WHERE id = 7        → 持有 (5,10) 间隙锁
I1: INSERT (6,6,6) │ 都等待
I2: INSERT (8,8,8) │
  H   X,GAP                   GRANTED  10
  I1  X,GAP,INSERT_INTENTION  WAITING  10    ← 被 H 挡住
  I2  X,GAP,INSERT_INTENTION  WAITING  10    ← I1、I2 互不挡
S:  BEGIN; UPDATE t_lk SET d = 0 WHERE id = 9        → 立即返回（不等插入意向锁）
  S   X,GAP                   GRANTED  10
H:  COMMIT → I1、I2 仍 WAITING（S 的牌子未撤）
S:  COMMIT → I2、I1 同时插入成功，各等待 2.31s
```

```
H   [间隙锁 (5,10)]─────────────┤COMMIT
S                 [间隙锁 (5,10)]──────────────────┤COMMIT
I1  [插入意向锁 6：等待 ══════════════════════════]→ 插入
I2  [插入意向锁 8：等待 ══════════════════════════]→ 插入
```

### 7.6 插入之后：隐式锁与同值冲突

```
A: BEGIN; INSERT (6,6,6)        -> 成功；此时 data_locks 中无任何行锁
B: BEGIN; INSERT (8,8,8)        -> 立即成功（同一空隙不同位置）
B: INSERT (6,6,6)               -> 2 秒后 ERROR 1205
   data_locks（按 ENGINE_TRANSACTION_ID）：
     A 的事务 X,REC_NOT_GAP  GRANTED  6     ← A 的隐式锁被转换为显式
     B 的事务 S,REC_NOT_GAP  WAITING  6     ← B 做唯一性检查
```

- 新行靠 `DB_TRX_ID`（插入者事务号，专题 24）表明属于未提交事务——**隐式锁**，不占锁表。
- 别人要检查该行（如插入同值做唯一性检查）时，转换为显式 `X,REC_NOT_GAP`。
- 插入同一值的互斥发生在**唯一性检查的记录锁**上，插入意向锁故意不挡其他插入者。

### 7.7 “先查后插”死锁（真实输出）

```
A: BEGIN; SELECT * FROM t_lk WHERE id = 7 FOR UPDATE   -> 空
B: BEGIN; SELECT * FROM t_lk WHERE id = 7 FOR UPDATE   -> 空，立即返回
  A X,GAP GRANTED 10；B X,GAP GRANTED 10              ← 间隙锁共存
A: INSERT (7,7,7) → A X,GAP,INSERT_INTENTION WAITING 10（被 B 挡）
B: INSERT (7,7,7) → ERROR 1213: Deadlock found
A 的 INSERT 在 B 被回滚后完成（等待 0.80s）
```

改法：直接 INSERT 依靠唯一约束判断；`INSERT ... ON DUPLICATE KEY UPDATE`；或使用 RC。

## 八、UPDATE / DELETE 与 INSERT 的完整表述

- **UPDATE / DELETE**：在访问到的记录上加临键锁或记录锁。记录部分保护要改的行，与他人记录锁冲突时等待；间隙部分只挡别人插入，请求时从不等待。持有间隙锁本身不允许修改任何行。
- **INSERT**：值不在索引上，检查其将落入的空隙（挂在下一条记录上）。被他人间隙锁 / 临键锁守着时以插入意向锁身份排队；插入意向锁只服从间隙锁 / 临键锁，不挡其他插入者，也不挡任何人。
- **插入同一值**：由插入后的唯一性检查在记录锁上排除。
- **死锁**不是间隙锁特有：任何互相等待都可能形成死锁（如专题 25 的 S 升级 X）。

## 九、RC 为什么锁冲突更少

| 差异 | RR | RC |
| --- | --- | --- |
| 间隙锁 / 临键锁 | 有 | 无（外键、唯一性检查除外；手册：RC 下搜索与索引扫描禁用间隙锁） |
| 访问过但不满足条件的行 | 锁到事务结束 | 判断后立即释放（专题 25） |
| UPDATE 遇被锁的行 | 等待 | 半一致读，不满足即跳过（专题 25） |
| “先查后插”并发死锁 | 会出现 | 第一步不加间隙锁 |
| 代价 | — | 当前读有幻读；binlog 必须 ROW |

## 十、在三条主线中的位置

```
B 一致性：事务 → MVCC → [锁：记录锁 / 间隙锁 / 临键锁防当前读幻读] → redo → binlog（RR 与 STATEMENT 复制）→ 复制
A 性能：WHERE 不走索引 → 锁范围扩大
C 诊断：data_locks 的 LOCK_MODE 解读；data_lock_waits 的等待边
```

## 十一、诊断实践

### 11.1 读懂 LOCK_MODE

| LOCK_MODE | 含义 |
| --- | --- |
| `X,REC_NOT_GAP` / `S,REC_NOT_GAP` | 记录锁 |
| `X,GAP` / `S,GAP` | 间隙锁（锁 LOCK_DATA 左边的空隙） |
| `X` / `S` | 临键锁（记录 + 左边空隙） |
| `X,GAP,INSERT_INTENTION` | 插入意向锁（通常为 WAITING） |
| `LOCK_DATA = supremum pseudo-record` | 锁住最大值之后的空隙 |

### 11.2 病例

| 病例 | 现象 | 定位 | 处置 |
| --- | --- | --- | --- |
| 插入频繁超时，被挡的值“看起来没人用” | INSERT 等待，`data_locks` 有 `INSERT_INTENTION WAITING` | 他人持有该空隙的间隙锁 / 临键锁（常见于范围更新、等值未命中的当前读） | 缩小范围、让条件走更精确的索引、评估 RC |
| “不存在则插入”高并发死锁 | ERROR 1213 | 两个事务 FOR UPDATE 未命中后都插入 | 直接 INSERT 依靠唯一约束 / `ON DUPLICATE KEY UPDATE` / RC |
| 一条更新挡住了整张表的写入 | 大量等待，持锁方 `data_locks` 全是 `X` 且含 supremum | WHERE 列无索引 | 建索引 |
| 改为 RC 后报 ERROR 1665 | 写入失败 | binlog 为 STATEMENT | 使用 ROW |

## 十二、本地复现（Docker mysql:8.4，3 个客户端窗口）

```sql
USE lab;
DROP TABLE IF EXISTS t_lk;
CREATE TABLE t_lk (id INT PRIMARY KEY, c INT NOT NULL, d INT NOT NULL, KEY idx_c (c));
INSERT INTO t_lk VALUES (0,0,0),(5,5,5),(10,10,10),(15,15,15),(20,20,20),(25,25,25);

-- 窗口 3 看锁与等待：
SELECT ENGINE_TRANSACTION_ID, INDEX_NAME, LOCK_MODE, LOCK_STATUS, LOCK_DATA
FROM performance_schema.data_locks WHERE OBJECT_NAME = 't_lk' AND LOCK_TYPE = 'RECORD';
SELECT REQUESTING_ENGINE_TRANSACTION_ID, BLOCKING_ENGINE_TRANSACTION_ID FROM performance_schema.data_lock_waits;

-- 第五节 6 种情况：窗口 1 设定隔离级别后 BEGIN; 执行下列之一（不提交）；窗口 2 SET innodb_lock_wait_timeout = 1; 探测
--   ① UPDATE t_lk SET d = d + 1 WHERE id = 10;
--   ② UPDATE t_lk SET d = d + 1 WHERE id = 7;
--   ③ UPDATE t_lk SET d = d + 1 WHERE c = 10;
--   ④ UPDATE t_lk SET d = d + 1 WHERE id >= 10 AND id < 12;
--   ⑤ SELECT * FROM t_lk WHERE id > 15 FOR UPDATE;
--   ⑥ UPDATE t_lk SET c = c WHERE d = 10;
-- 探测示例：INSERT INTO t_lk VALUES (9,9,0); INSERT INTO t_lk VALUES (30,30,0);

-- 第四节原因一：窗口 1 BEGIN; DELETE FROM t_lk WHERE d = 10;  窗口 2 UPDATE t_lk SET d = 10 WHERE id = 15;
--   窗口 1 SELECT id, d FROM t_lk WHERE d = 10 FOR UPDATE;
-- 第四节原因二：
SET SESSION binlog_format = 'STATEMENT';
SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED;
BEGIN; UPDATE t_lk SET d = d + 1 WHERE c = 10;      -- 预期 ERROR 1665
ROLLBACK;

-- 第六节：窗口 1、2 分别 BEGIN; UPDATE t_lk SET d = 0 WHERE id = 6 / id = 9;（都成功）；窗口 2 INSERT (8,8,8)（等待）
-- 第七节 7.5：窗口 1 BEGIN; UPDATE t_lk SET d = 0 WHERE id = 7;  窗口 2 INSERT (6,6,6)、另开窗口 INSERT (8,8,8)（都等待）
-- 第七节 7.6：窗口 1 BEGIN; INSERT (6,6,6);  窗口 2 BEGIN; INSERT (8,8,8)（成功）；INSERT (6,6,6)（等待）
-- 第七节 7.7：窗口 1、2 都 BEGIN; SELECT * FROM t_lk WHERE id = 7 FOR UPDATE; 然后先后 INSERT (7,7,7)
```

**预期现象**：与上文真实输出一致。④ 中 15 上的锁模式、8.4 上 `SET binlog_format` 的提示以本地实测为准。

::: tip PG 对照
PG 无间隙锁：RR 为快照隔离，写冲突时报序列化错误；SERIALIZABLE 用 SSI 检测读写依赖并在提交时报错。PG 上“先查后插”更常见的是唯一约束冲突报错，而非间隙锁死锁；对应写法是 `INSERT ... ON CONFLICT`。
:::

## 十三、串联图

```
问题：RR 当前读要保证“读过的范围在事务内不变”
   ├─ 已有行被改 / 删 → 记录锁
   └─ 新行被插入     → 间隙锁（挂在空隙右边的记录上；最后一段挂 supremum）
   ▼
基本单位：临键锁（X）= 记录 + 左间隙；只锁访问到的；唯一等值命中→记录锁；扫到第一条不满足→间隙锁
   ▼
访问过、不满足的也锁到事务结束：① 当前读不变 ② STATEMENT 复制要求执行顺序 = 提交顺序
   ▼
间隙锁彼此不冲突（目标一致、粒度粗、空隙会合并）
   ▼
INSERT：检查下一条记录上的锁 → 有冲突则以插入意向锁排队（服从间隙 / 临键锁，不挡任何人）
   → 插入后隐式锁 → 同值冲突由唯一性检查在记录锁上排除
   ▼
副作用：“先查后插”死锁；RC 去掉间隙锁 → 冲突少，代价是当前读幻读、binlog 必须 ROW
```

## 十四、与其他专题的关联

- **专题 9**：索引有序是间隙锁的前提。
- **专题 23**：RR 下当前读的“幻读”；RC 与 RR 选型。
- **专题 24**：`DB_TRX_ID` 作为隐式锁。
- **专题 25**：行锁基础、RC 的提前释放与半一致读。
- **专题 27**：死锁检测、死锁日志。
- **专题 32**：binlog 格式与复制。

## 十五、复习 checklist

- [ ] 能说明只锁已有行为何挡不住插入，以及间隙锁的唯一目的
- [ ] 知道间隙锁挂在空隙右边的记录上、最后一段挂在 supremum
- [ ] 能区分记录锁、间隙锁、临键锁及其 LOCK_MODE，并说出各自适用场景
- [ ] 能用两个原因解释 RR 为何保留未命中行的锁，并说明为何这不等于锁表
- [ ] 能按 6 种语句推导加锁结果，并归纳规则
- [ ] 能解释间隙锁为何不排他（三个理由）及其代价
- [ ] 能区分插入意向锁与表级意向锁，说出插入意向锁的单向规则
- [ ] 能说明插入意向锁就是插入时“阻塞等待”的载体，以及没有冲突时不创建锁对象
- [ ] 知道隐式锁、同值插入在唯一性检查上冲突，能解释“先查后插”死锁及改法
- [ ] 能列出 RC 减少锁冲突的原因与代价
