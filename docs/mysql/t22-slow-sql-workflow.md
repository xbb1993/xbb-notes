# 专题 22 · 慢 SQL 定位完整流程

> 级别 ★ · 主线 C（衔接 A、B）· 实测版本：沙箱 MySQL 8.0.46

本专题回答：接到“接口变慢 / 数据库 CPU 高”的告警，怎样一步步找到问题 SQL、分清是计划问题还是等待问题、定位根因、修复并验证？

**场景**：用 Python 脚本在沙箱模拟 40 秒业务流量，7 个线程并发：

```
线程 1、2：按主键查订单          SELECT * FROM t_order WHERE id = ?
线程 3、4：按城市和等级统计用户  SELECT COUNT(*) FROM t_user WHERE city = ? AND level = ?
线程 5：  按编码查订单          SELECT * FROM t_s WHERE code = ?    （应用把参数按数字传入）
线程 6：  第 5 秒开启事务修改 id=100，然后 20 秒什么都不做，最后回滚
线程 7：  反复修改 id=100
```

埋了三个问题：缺索引、隐式类型转换、闲置事务持锁。下面按流程逐个找出。

**类比**：急诊分诊——先看体征（现象），再查化验单（指标），找到病灶（SQL 与根因），用药（优化），复查（验证）。不跳步，不凭经验直接开药。

## 一、流程总览

```
①现象    接口慢 / CPU 高 / 连接数涨
   ↓
②入口    正在执行？ → PROCESSLIST、锁等待视图
         已执行完？ → 慢日志（单条慢）、digest 汇总（总量大）
   ↓
③分类    计划问题：检查行数远大于返回行数
         等待问题：时间花在锁、I/O 上
   ↓
④定位    计划问题 → EXPLAIN（专题 15）→ 对照成因（专题 19–21）
         锁问题   → 找到阻塞者是谁、它做过什么
   ↓
⑤优化    索引 / 改写 / 统计信息 / 提示（专题 12、13、17）
   ↓
⑥验证    同样的负载再跑一遍，对比前后指标
```

## 二、入口一：正在执行的 SQL

### 2.1 PROCESSLIST

**PROCESSLIST**：每个连接一行，显示当前在做什么。第 12 秒的快照（真实输出，已过滤空闲连接）：

```
id  command  time  state              info
17  Query    6     updating           UPDATE t_s SET remark = 'x' WHERE id = 100
15  Query    1     executing          SELECT * FROM t_s WHERE code = 983562
16  Query    0     executing          SELECT COUNT(*) FROM t_user WHERE city = 'City22' AND level = 2
13  Query    0     Sending to client  SELECT * FROM t_order WHERE id = 525226
14  Query    0     executing          SELECT COUNT(*) FROM t_user WHERE city = 'City147' AND level = 1
```

| 列 | 含义 |
| --- | --- |
| `time` | 当前状态已持续的秒数 |
| `state` | 线程正在做的事 |
| `info` | 正在执行的 SQL |

只改一行的 UPDATE 已执行 6 秒，不正常。

::: danger 错误理解 vs 正确理解
- ❌ 在等行锁的语句，state 会显示“等锁”。
- ✅ 实测正在等 InnoDB 行锁的 UPDATE，state 为 `updating`。PROCESSLIST 分不清“在执行”还是“在等锁”，必须查锁等待视图。
:::

PROCESSLIST 是瞬时快照：执行快但调用极频繁的 SQL（线程 3、4）在快照里只一闪而过，看不出总代价。

### 2.2 锁等待：谁堵住了谁

**sys**：MySQL 自带的诊断视图库，把 **performance_schema**（简称 P_S，内置性能监控表）与 information_schema 的原始数据整理成易读形式。`sys.innodb_lock_waits` 每行是一对“等待者 → 阻塞者”：

```
wait_age: 00:00:06            locked_table_name: t_s     locked_index: PRIMARY
waiting_pid: 17               waiting_query: UPDATE t_s SET remark = 'x' WHERE id = 100
blocking_pid: 18              blocking_query: NULL       ← 阻塞者当前没在执行 SQL
blocking_trx_age: 00:00:07    sql_kill_blocking_query: KILL QUERY 18
```

`blocking_query` 为 NULL：阻塞者**开启事务、拿到锁后闲置**。这是生产上最常见的阻塞来源，如事务中调用外部接口、异常路径未提交也未回滚。

**追查闲置阻塞者做过什么**：`events_statements_history` 保存每个线程最近执行的语句（默认开启），经 `threads` 表把连接 ID 换成线程 ID：

```sql
SELECT h.EVENT_ID, h.SQL_TEXT FROM performance_schema.events_statements_history h
JOIN performance_schema.threads t ON t.THREAD_ID = h.THREAD_ID
WHERE t.PROCESSLIST_ID = 阻塞者的 blocking_pid ORDER BY h.EVENT_ID;
```

```
2  BEGIN
4  SELECT 1
5  UPDATE t_s SET amount = amount WHERE id = 100     ← 锁由这条语句加上
6  SELECT NOW()
```

配合 `information_schema.innodb_trx`：阻塞者 `trx_state` = RUNNING、`trx_query` = NULL、`trx_started` 给出事务开始时间。

**处置**：

- 紧急：`KILL 阻塞者连接ID` 断开连接，其事务回滚。视图给出的 `KILL QUERY` 只终止“正在执行的语句”，对闲置连接无效。
- 根治：应用缩短事务，异常路径必须回滚。
- 锁类型与加锁规则见模块五（专题 25–27）。

## 三、入口二：已执行完的 SQL

### 3.1 慢日志与 digest 各看到什么

**digest（语句指纹）**：P_S 把 SQL 中的常量替换为 `?`，形状相同的语句归为一类，在 `performance_schema.events_statements_summary_by_digest` 中按类累计。不受 `long_query_time` 限制，**每条执行过的语句都统计**。

负载结束后按总耗时排序（真实输出）：

| digest（节选） | 次数 | 总耗时 s | 平均 ms | 最大 ms | 锁时间 s | 平均检查行 | 平均返回行 | 未用索引次数 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `SELECT COUNT(*) FROM t_user WHERE city=? AND level=?` | 1606 | **78.51** | 48.88 | 112 | 0.01 | 100000 | 1.0 | 1606 |
| `SELECT * FROM t_s WHERE code=?` | 39 | 40.13 | 1029.01 | 2381 | 0 | 1000000 | 1.0 | 39 |
| `SELECT * FROM t_order WHERE id=?` | 193771 | 36.39 | 0.19 | 102 | 0.15 | 1 | 1.0 | 0 |
| `UPDATE t_s SET remark=? WHERE id=?` | 14 | 19.03 | 1359.45 | 19028 | **19.02** | 1 | 0.0 | 0 |

同时段新增慢日志（`long_query_time=0.5`）：

| 语句 | 慢日志条数 |
| --- | --- |
| t_s 按 code 查询 | 39 |
| UPDATE id=100 | 1（`Query_time: 19.03  Lock_time: 19.02`） |
| t_user 统计 | **0** |

::: danger 核心结论
- 总耗时第一的 t_user 统计在慢日志中**一条都没有**：单次 49 ms 从未超过阈值，但 40 秒执行 1606 次，持续全表扫描 10 万行，是 CPU 打满的主因。
- **优化优先级按总耗时排**，不按单次耗时。
:::

### 3.2 digest 字段

| 字段 | 含义 | 用法 |
| --- | --- | --- |
| `COUNT_STAR` | 执行次数 | 是否高频 |
| `SUM/AVG/MAX_TIMER_WAIT` | 总 / 平均 / 最大耗时，单位**皮秒**（10⁻¹² 秒） | ÷10¹² 得秒，÷10⁹ 得毫秒 |
| `SUM_LOCK_TIME` | 等锁总时间 | 与总耗时对比，判断等待问题 |
| `SUM_ROWS_EXAMINED` / `SUM_ROWS_SENT` | 检查行数 / 返回行数 | 比值判断计划问题 |
| `SUM_NO_INDEX_USED` | 未用索引的执行次数 | 标出全表扫描 |
| `QUERY_SAMPLE_TEXT` | 带真实参数的样本 SQL | 直接拿去 EXPLAIN |
| `FIRST_SEEN` / `LAST_SEEN` | 首次 / 最近出现时间 | 是否新上线语句 |
| `QUANTILE_95` / `QUANTILE_99` | 95 / 99 分位耗时（皮秒） | 看长尾 |

注意（8.0 手册）：

- 行数上限由 `performance_schema_digests_size` 决定（沙箱 10000）；超出后新语句计入 `DIGEST` 为 NULL 的行，该行占比高说明表不够用。
- `TRUNCATE` 清空统计，可用于优化前后各统计一轮。
- 统计从启动或上次 TRUNCATE **持续累计**。线上排查宜两次快照相减取增量。

### 3.3 sys 视图

```
sys.statement_analysis（按总耗时排序，单位已换算）：
query                                         full_scan exec_count total_latency avg_latency lock_latency rows_examined_avg
SELECT COUNT(*) FROM t_user WHERE city=? ...  *         1606       1.31 min      48.88 ms    5.50 ms      100000
SELECT * FROM t_s WHERE CODE = ?              *         39         40.13 s       1.03 s      71.00 us     1000000
SELECT * FROM t_order WHERE id = ?                      193771     36.39 s       187.82 us   150.76 ms    1
UPDATE t_s SET remark = ? WHERE id = ?                  15         27.03 s       1.80 s      27.02 s      1

sys.statements_with_full_table_scans：只列发生过全表扫描的语句，带 no_index_used_pct
```

`full_scan` 为 `*` 表示发生过全表扫描。与原始表的差异（UPDATE 15 次、27 秒）来自查看前多了一次锁等待复现被累计进去。

## 四、分类：计划问题还是等待问题

| 语句 | 检查行 / 返回行 | 锁时间 / 总耗时 | 结论 |
| --- | --- | --- | --- |
| t_user 统计 | 100000 / 1 | ≈ 0 | **计划问题**：全表扫描 |
| t_s 按 code 查询 | 1000000 / 1 | ≈ 0 | **计划问题**：全表扫描 |
| UPDATE id=100 | 1 / 0 | 19.02 / 19.03 | **等待问题**：几乎全在等锁 |
| t_order 主键查询 | 1 / 1 | 很小 | 单条无问题；总耗时高源于调用量，应从应用层减少调用（如缓存） |

::: warning 版本差异：LOCK_TIME
8.0.28 发布说明：P_S 的 `LOCK_TIME` 此前低估，**未计入行锁等待**；8.0.28 起包含表锁与行锁（data lock）等待，慢日志与 P_S 口径一致。实测 8.0.46：`Query_time: 19.03  Lock_time: 19.02`。

- 更老版本上等行锁的语句 Lock_time 可能接近 0，易被误判为“执行慢”。
- 专题 18 引用的“获取初始锁的时间不计入执行时间”：这条几乎全在等行锁的语句在 8.0.46 仍被记录，Query_time 包含等待。手册未明确“初始锁”所指范围，以实测为准：**行锁等待会计入**。
:::

**I/O、CPU、内存入口**（模块六、九深入）：

- `Innodb_buffer_pool_reads` / `Innodb_buffer_pool_read_requests` 比值高：大量读请求落到磁盘（专题 3）。
- 操作系统：`top` 看 mysqld CPU，`iostat` 看磁盘使用率与等待。
- 本例 CPU 高源于对已在 Buffer Pool 中的行反复全表比较——计划问题造成的 CPU 消耗，不是 I/O 问题。

## 五、定位 → 优化 → 验证

### 5.1 定位

```
QUERY_SAMPLE_TEXT：SELECT COUNT(*) FROM t_user WHERE city = 'City16' AND level = 2
EXPLAIN → type=ALL  rows=100136  filtered=0.02      → 缺索引（专题 12）

QUERY_SAMPLE_TEXT：SELECT * FROM t_s WHERE code = 958787
EXPLAIN → type=ALL  possible_keys=idx_code  key=NULL → 字符串列与数字比较（专题 21）
```

第二条特征：`possible_keys` 有索引、`key` 为 NULL，且样本参数无引号 → 应用传参类型错误。

### 5.2 优化

| 问题 | 措施 | 优化后 EXPLAIN |
| --- | --- | --- |
| t_user 缺索引 | `ADD INDEX idx_city_level (city, level)`（10 万行，0.28 s） | ref，rows=71，Using index |
| code 传参类型错误 | 应用改为按字符串传参 | ref，rows=1 |
| 闲置事务持锁 | 应用缩短事务、异常回滚（负载中去掉线程 6、7） | — |

### 5.3 验证

`TRUNCATE` digest 表后再跑 40 秒（真实输出）：

| digest | 平均耗时 前 → 后 | 40 秒执行次数 前 → 后 | 平均检查行 | 未用索引次数 |
| --- | --- | --- | --- | --- |
| t_user 统计 | 48.88 ms → **0.213 ms** | 1606 → **123978** | 100000 → 50 | 1606 → 0 |
| t_s 按 code 查询 | 1029 ms → **0.226 ms** | 39 → **58033** | 1000000 → 1 | 39 → 0 |
| t_order 主键查询 | 0.19 ms → 0.135 ms | 193771 → 134183 | 1 → 1 | 0 |

主键查询次数下降，推断原因：沙箱仅 2 核，其他线程不再等待后分走更多 CPU。验证要看整体，不只盯一条语句。

::: danger 错误理解 vs 正确理解
- ❌ EXPLAIN 显示走上索引，优化就完成了。
- ✅ EXPLAIN 只证明计划变了。须在相同负载下对比 digest 的平均耗时、检查行数、未用索引次数，确认改善存在且未拖累其他语句（如新索引拖慢写入）。
:::

## 六、在三条主线中的位置

```
C 诊断：问题 → 现象 → [指标：PROCESSLIST / 锁视图 / 慢日志 / digest] → SQL → EXPLAIN → 锁 → I/O/CPU → 定位 → 优化 → 验证
A 性能：计划问题的根因落在优化器、索引（专题 12–21）
B 一致性：等待问题的根因落在事务与锁（模块五）
```

## 七、诊断实践

### 7.1 速查卡

```
1. 现在卡着吗？
   SHOW PROCESSLIST / information_schema.processlist   → time 大、state 可疑的语句
   SELECT * FROM sys.innodb_lock_waits\G                → 有无锁等待；blocking_query 是否 NULL
   NULL → events_statements_history 查阻塞者历史；innodb_trx 查事务开始时间

2. 一段时间内谁最耗资源？
   记录 digest 快照 → 等待一段时间 → 再记录 → 相减
   按 SUM_TIMER_WAIT 排序；看 COUNT_STAR、检查行 / 返回行、SUM_LOCK_TIME、SUM_NO_INDEX_USED
   sys.statement_analysis / sys.statements_with_full_table_scans

3. 单条特别慢的？
   慢日志 + mysqldumpslow（专题 18）

4. 分类
   检查行 ≫ 返回行 → 计划问题 → QUERY_SAMPLE_TEXT 做 EXPLAIN → 专题 19–21 成因
   锁时间 ≈ 总耗时 → 等待问题 → 第 1 步的锁视图
   都不是 → 看调用量（应用层）与 I/O、CPU 指标

5. 修复后同负载验证，对比 digest
```

### 7.2 病例小结

| 病例 | 现象 | 关键指标 | 根因 | 处置 |
| --- | --- | --- | --- | --- |
| 高频小查询打满 CPU | CPU 高，慢日志里没有可疑语句 | digest 总耗时第一，检查 100000 行 / 返回 1 行 | 缺索引 | 补联合索引 |
| 有索引不用 | 单条 1 秒左右，进慢日志 | `possible_keys` 有、`key` 为 NULL，样本参数无引号 | 字符串列与数字比较 | 修正传参类型 |
| 单行 UPDATE 卡十几秒 | PROCESSLIST state 为 updating，time 持续增长 | Lock_time ≈ Query_time；`blocking_query` 为 NULL | 闲置事务持锁 | KILL 阻塞连接；应用缩短事务 |

## 八、本地复现（Docker mysql:8.4）

负载脚本（需 Python 3 与 `pip install pymysql`；密码从环境变量 `MYSQL_PWD` 读取，不写进脚本）：

```python
# wl.py   用法：python wl.py 40          （含三个问题）
#         python wl.py 40 fixed           （修复后版本，需先建 t_user 联合索引）
import os, sys, time, random, threading, pymysql

def conn():
    return pymysql.connect(host='127.0.0.1', port=3306, user='root',
                           password=os.environ.get('MYSQL_PWD', ''),
                           database='lab', autocommit=True)

DUR = float(sys.argv[1]) if len(sys.argv) > 1 else 40
FIXED = len(sys.argv) > 2 and sys.argv[2] == 'fixed'
stop = time.time() + DUR

def fast():
    c = conn().cursor()
    while time.time() < stop:
        c.execute("SELECT * FROM t_order WHERE id = %s", (random.randint(1, 1000000),)); c.fetchall()

def city():
    c = conn().cursor()
    while time.time() < stop:
        c.execute("SELECT COUNT(*) FROM t_user WHERE city = %s AND level = %s",
                  ('City%d' % random.randint(1, 199), random.randint(0, 4))); c.fetchall()

def code():
    c = conn().cursor()
    while time.time() < stop:
        v = random.randint(1, 1000000)
        if FIXED:
            c.execute("SELECT * FROM t_s WHERE code = %s", (str(v),))      # 字符串参数
        else:
            c.execute("SELECT * FROM t_s WHERE code = %d" % v)             # 数字参数（问题）
        c.fetchall()

def blocker():
    c = conn().cursor(); time.sleep(5)
    c.execute("BEGIN"); c.execute("UPDATE t_s SET amount = amount WHERE id = 100")
    time.sleep(20); c.execute("ROLLBACK")

def waiter():
    c = conn().cursor(); time.sleep(6)
    while time.time() < stop - 8:
        c.execute("UPDATE t_s SET remark = 'x' WHERE id = 100"); time.sleep(0.5)

workers = [fast, fast, city, city, code] + ([] if FIXED else [blocker, waiter])
ts = [threading.Thread(target=f) for f in workers]
[t.start() for t in ts]; [t.join() for t in ts]
```

```sql
-- 运行前
TRUNCATE performance_schema.events_statements_summary_by_digest;
-- 运行期间（另开会话，约第 12 秒）
SELECT id, command, time, state, LEFT(info, 70) FROM information_schema.processlist WHERE command <> 'Sleep';
SELECT * FROM sys.innodb_lock_waits\G
-- 运行后
SELECT LEFT(DIGEST_TEXT, 60), COUNT_STAR, ROUND(SUM_TIMER_WAIT/1e12, 2) total_s,
       ROUND(AVG_TIMER_WAIT/1e9, 2) avg_ms, ROUND(SUM_LOCK_TIME/1e12, 2) lock_s,
       ROUND(SUM_ROWS_EXAMINED/COUNT_STAR) exam, SUM_NO_INDEX_USED
FROM performance_schema.events_statements_summary_by_digest
WHERE SCHEMA_NAME = 'lab' ORDER BY SUM_TIMER_WAIT DESC LIMIT 5;
SELECT * FROM sys.statement_analysis WHERE db = 'lab' LIMIT 5;
-- 修复并验证
ALTER TABLE t_user ADD INDEX idx_city_level (city, level);
TRUNCATE performance_schema.events_statements_summary_by_digest;
-- python wl.py 40 fixed，再执行上面的 digest 查询；实验后可 DROP INDEX idx_city_level
```

`t_s` 建表语句见专题 21。手动复现锁等待：会话 A `BEGIN; UPDATE t_s SET amount = amount WHERE id = 100;` 后闲置；会话 B `UPDATE t_s SET remark = 'x' WHERE id = 100;`；会话 C 查 PROCESSLIST、`sys.innodb_lock_waits` 与 history。

**预期现象**：B 的 state 为 `updating`，`blocking_query` 为 NULL，history 能看到 A 的 UPDATE；digest 中 t_user 统计总耗时靠前但慢日志里没有；修复后平均耗时、检查行数、未用索引次数明显下降。具体数字以本地为准。

::: tip PG 对照
PostgreSQL 对应工具：`pg_stat_activity`（≈ PROCESSLIST，且 `wait_event_type` 能直接区分是否在等锁，比 MySQL 的 state 更直观）、`pg_blocking_pids()`（找阻塞者）、`pg_stat_statements`（≈ digest 汇总）、`idle in transaction` 状态（≈ blocking_query 为 NULL 的闲置事务），以及 `idle_in_transaction_session_timeout` 参数自动断开闲置事务。
:::

## 九、与其他专题的关联

- **专题 3**：Buffer Pool 命中率指标。
- **专题 12 / 13 / 17**：索引、统计信息、提示等修复手段。
- **专题 15**：EXPLAIN / EXPLAIN ANALYZE。
- **专题 18**：慢日志与 mysqldumpslow，及其盲区。
- **专题 19–21**：计划问题的常见成因。
- **专题 23–27**：事务、锁与死锁，等待问题的根因。
- **模块六 / 九**：I/O、内存、CPU 层面的诊断。

## 十、复习 checklist

- [ ] 能画出“现象 → 入口 → 分类 → 定位 → 优化 → 验证”流程
- [ ] 知道三个入口：PROCESSLIST / 锁视图、慢日志、digest 汇总，及各自盲区
- [ ] 知道行锁等待在 PROCESSLIST 中显示为 `updating`，要用 `sys.innodb_lock_waits` 确认
- [ ] 能在 `blocking_query` 为 NULL 时，用 `events_statements_history` + `threads` 找到阻塞者执行过的 SQL
- [ ] 知道 `KILL QUERY` 与 `KILL` 的区别
- [ ] 会读 digest 主要字段，知道时间单位为皮秒、统计持续累计、NULL 行的含义
- [ ] 能用“检查行 / 返回行”与“锁时间 / 总耗时”区分计划问题与等待问题
- [ ] 知道 8.0.28 起 LOCK_TIME 计入行锁等待
- [ ] 知道验证必须同负载对比 digest，而不只看 EXPLAIN
