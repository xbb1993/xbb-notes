# 专题 2 · 整体架构与 SQL 生命周期

> 级别 ★（核心）· 主线 A（性能）起点，兼作主线 C（诊断）的分层地图 · 实测版本：沙箱 MySQL 8.0.46，数据为专题 1 的 `lab.t_order`（100 万行）

本专题回答一个问题：**一条 SQL 从客户端发出到结果返回，在服务端内部经过哪些环节，每个环节可能出什么问题、从哪里观察。**

不知道有哪些环节，排查“SQL 慢”时就只能盯着 SQL 文本改。知道了分层，就能先判断“慢在哪一层”，再对症处理。

## 一、全景：两层结构

### 类比：一家餐厅

| 餐厅 | MySQL | 职责 |
| --- | --- | --- |
| 前台 | 连接器 | 核对身份，安排一名服务员专门接待 |
| 点单员 | 解析器 | 听懂顾客说的话（语法） |
| 核对菜单 | 预处理（名称解析） | 确认点的菜确实存在 |
| 厨师长 | 优化器 | 决定这道菜用哪种做法 |
| 跑菜员 | 执行器 | 按做法一盘一盘地去后厨取菜 |
| 后厨与冰箱、仓库 | 存储引擎（InnoDB）、Buffer Pool、磁盘 | 只负责存取食材，不关心顾客是谁 |

```
 应用(客户端)
    │  ① 建立连接、认证
    ▼
┌──────────────────────────── Server 层（所有引擎共用）────────────────┐
│ 连接器 ──▶ 解析器 ──▶ 预处理 ──▶ 优化器 ──▶ 执行器                    │
│ 认证/线程    语法树      表、列存在?   选执行计划   按计划逐行取数据      │
└──────────────────────────────────────────────┬──────────────────────┘
                                               │ Handler API：“给我下一行”
┌──────────────────────────── 引擎层（可插拔）──▼──────────────────────┐
│ InnoDB：Buffer Pool（内存中的页缓存） ⇄ 磁盘上的数据文件               │
└──────────────────────────────────────────────────────────────────────┘
```

两个要点贯穿全篇：

1. **Server 层与引擎层分工**：Server 层负责理解、决策、组织结果；引擎层只负责按要求存取数据。
2. **执行器逐行向引擎要数据**：不是引擎先把结果全部算好再交上来。

> 8.0 变化：5.7 及以前，连接器之后还有一个“查询缓存”环节，8.0 已删除，见第三节。

## 二、连接器

### 2.1 要解决的问题

每个客户端连上来，服务端要做两件事：确认它是谁（认证），并安排一个执行单元专门处理它发来的请求。

### 2.2 MySQL 的方案：一个连接一个线程

默认的线程模型是 `thread_handling = one-thread-per-connection`：每个客户端连接独占一个服务端线程，这个线程负责该连接的认证和之后的每一条请求。

```
连接1 ──▶ 线程1 ┐
连接2 ──▶ 线程2 ├── 共享 Buffer Pool 等全局资源
连接3 ──▶ 线程3 ┘

连接断开 ──▶ 线程不销毁，放回线程缓存（若缓存未满）
新连接   ──▶ 先从线程缓存取；缓存为空才新建线程
```

**为什么需要线程缓存**：创建和销毁线程有系统开销。短连接频繁的应用（每个请求连一次、用完就断）如果每次都新建线程，这部分开销会累积起来。线程缓存让断开连接的线程留下来给下一个连接复用。

三种并发模型对照：

| | 模型 | 优点 | 代价 |
| --- | --- | --- | --- |
| Redis | 单线程事件循环处理所有连接的命令 | 连接很便宜，没有线程切换 | 一条慢命令会阻塞所有连接 |
| MySQL | 一个连接一个线程 | 连接之间互不阻塞 | 每个线程占内存，线程多了切换开销上升 |
| PostgreSQL | 一个连接一个进程 | 进程隔离性更强 | 比线程更重，所以 PG 生产环境通常配 pgbouncer 做连接池 |

> 线程池：MySQL 企业版提供线程池插件（`thread_handling = loaded-dynamically`），用固定数量的线程服务大量连接；社区版默认没有。Percona Server、MariaDB 有各自的实现。

### 2.3 关键参数与实测值

沙箱 8.0.46 的默认值：

```
@@max_connections    151      允许的最大并发连接数
@@thread_cache_size  9        线程缓存最多保留的空闲线程数
@@wait_timeout       28800    非交互连接空闲多少秒后被服务端断开（28800 秒 = 8 小时）
@@interactive_timeout 28800   交互式客户端（如 mysql 命令行）的空闲超时
@@thread_handling    one-thread-per-connection
```

**`thread_cache_size` 的默认值怎么来的**

- 默认值是 -1，含义是“启动时自动计算”。官方手册只说明“默认由服务器在启动时自动确定”，计算方式以实测为准。
- 实测规律：`thread_cache_size = 8 + max_connections / 100`（整数除法，结果上限 100）。
  - `8`：保底值。
  - `max_connections / 100`：每允许 100 个连接，多缓存 1 个线程。
  - 为什么取 8 和 100，官方没有说明，这里不做推测。

在沙箱里改变 `max_connections` 重启后的实测结果：

| max_connections | 公式计算 | 实测 thread_cache_size |
| --- | --- | --- |
| 151（默认） | 8 + 1 = 9 | 9 |
| 1000 | 8 + 10 = 18 | 18 |
| 5000 | 8 + 50 = 58 | 58 |
| 19190 | 8 + 191 = 199，超过上限 | 100 |

（最后一行请求设置为 20000，因进程可打开文件数限制被服务器自动下调为 19190。）

**如何判断线程缓存够不够**：看两个累计计数的关系。

```
Connections      16    ← 累计建立过的连接次数
Threads_created  1     ← 累计真正新建的线程数（缓存取不到时才新建）
Threads_cached   ...   ← 当前缓存里的空闲线程数
```

`Threads_created` 远小于 `Connections`，说明绝大部分连接复用了缓存线程。如果 `Threads_created` 随时间持续增长，说明缓存经常不够用，可以调大 `thread_cache_size`。

### 2.4 易错点

::: warning 易错：权限变更对已连接的客户端何时生效
用 `GRANT` / `REVOKE` 等账号管理语句修改权限后，服务器会立即重新加载权限表，但对**已经建立的连接**，生效时机按权限级别不同（官方手册 “When Privilege Changes Take Effect”）：

| 权限级别 | 对已连接客户端何时生效 |
| --- | --- |
| 表级、列级权限 | 该客户端的下一条请求 |
| 库级权限 | 该客户端下次执行 `USE 库名` 时 |
| 静态全局权限、密码 | 不影响已连接的会话，只对之后新建的连接生效 |
| 动态全局权限 | 立即生效 |

如果绕过账号管理语句、直接 `UPDATE mysql.user` 等权限表，则在执行 `FLUSH PRIVILEGES` 或重启之前完全不生效。官方不推荐直接改权限表。
:::

::: warning 易错：max_connections 调大不等于能扛更多并发
`max_connections` 只是连接数上限。真正在消耗 CPU 的是 `Threads_running`（此刻正在执行语句的线程数）。连接数很多但大多处于 Sleep（空闲）状态，压力并不大；`Threads_running` 长期远超 CPU 核数，才说明服务端忙不过来。报 `Too many connections` 时，先查是谁占着连接不放（连接泄漏、连接池配置过大），而不是先调大上限。
:::

::: warning 易错：空闲连接会被服务端断开
连接空闲超过 `wait_timeout` 秒，服务端会主动断开它。沙箱实测（会话超时设为 2 秒，空闲 4 秒后再发 SQL）：

```
ERROR 4031 (HY000): The client was disconnected by the server because of inactivity.
See wait_timeout and interactive_timeout for configuring this behavior.
```

这个明确的报错从 **8.0.24** 开始提供（服务器和客户端都需要是 8.0.24 及以上）。更早的版本里，客户端只会看到笼统的 `Lost connection to MySQL server during query` 或 `MySQL server has gone away`。

生产上的典型表现是：连接池里的连接闲置一夜，第二天早上第一条 SQL 报错。处理方法是让连接池中连接的最大存活时间（如 HikariCP 的 `maxLifetime`）**小于** `wait_timeout`，由连接池主动淘汰旧连接。
:::

::: tip 长连接与内存
《MySQL 实战 45 讲》第 1 讲指出：执行过程中临时使用的部分内存挂在连接对象上，连接断开时才释放，因此长连接长期执行大查询可能导致 mysqld 内存持续偏高。可选的处理方式是定期断开重连，或调用 `mysql_reset_connection` 重置连接状态。内存模型的完整分析在专题 45。
:::

## 三、查询缓存：8.0 已删除

5.7 及以前，SQL 进入解析器之前，会先用**整条 SQL 文本**作为键查一次缓存，命中就直接返回结果。

8.0 中该功能已被删除（官方工作日志 WL#10824）。沙箱实测：

```
SHOW VARIABLES LIKE 'query_cache%';   → 无结果
SHOW VARIABLES LIKE 'have_query_cache';
have_query_cache   NO
```

**为什么删除**：

- 失效粒度太粗：表上发生**任何一次写入**，与这张表相关的所有缓存结果都失效。写入频繁的表几乎无法命中。
- 并发瓶颈：缓存的维护需要一把全局锁，高并发下所有查询都要争用它。

::: warning 5.7 差异
网上老资料里的 `query_cache_size`、`query_cache_type`、`SQL_NO_CACHE` 在 8.0 都已不适用。
:::

::: tip 与 Redis 的关联
这正是缓存应当放在应用层的理由：应用知道业务数据的变化，可以按 key 精确失效；数据库只能按表整体失效。见 Redis 笔记模块五“缓存问题”。
:::

## 四、解析器与预处理

| 环节 | 做什么 | 只关心什么 |
| --- | --- | --- |
| 解析器（Parser） | 词法分析（切分出关键字、表名、列名、常量）+ 语法分析，生成语法树 | 语法是否正确 |
| 预处理 / 名称解析 | 确认表和列确实存在，把 `*` 展开成具体列，检查名称歧义 | 引用的对象是否存在、是否明确 |

不同环节报出不同的错误码，看错误码就能知道 SQL 停在了哪一步。沙箱实测：

```
SELEC * FROM t_order               ERROR 1064 (42000) You have an error in your SQL syntax   ← 解析器
SELECT no_such_col FROM t_order    ERROR 1054 (42S22) Unknown column 'no_such_col'           ← 名称解析
SELECT * FROM no_such_table        ERROR 1146 (42S02) Table 'lab.no_such_table' doesn't exist ← 打开表时
```

## 五、优化器

同一条 SQL 通常有多种执行方式：走哪个索引、是否全表扫描、多表 join 时先访问哪张表。优化器的工作是**估算每种方式的成本，选出它认为成本最低的一种**，结果就是执行计划。

专题 1 里 EXPLAIN 显示的 `rows`、`filtered` 就是优化器的估算值。估算错了，计划就可能选错。成本模型在专题 16，EXPLAIN 的完整用法在专题 15。

## 六、执行器与 Handler API

### 6.1 逐行拉取

执行器按执行计划调用存储引擎的接口。这套接口叫 **Handler API**：Server 层定义的一组统一的数据访问函数（如“按索引定位第一条”“读下一条”），每种存储引擎各自实现。可以类比为 Java 的 interface，InnoDB、MyISAM 是它的不同实现类。

执行器每次调用只拿**一行**，像迭代器的 `next()`。MySQL 为这些调用维护了计数器 `Handler_read_*`，可以直接观察。

| 计数器 | 对应的调用 |
| --- | --- |
| `Handler_read_key` | 按索引键定位一行（定位到第一条匹配记录） |
| `Handler_read_next` | 沿索引顺序读下一行 |
| `Handler_read_first` | 读索引的第一条记录 |
| `Handler_read_rnd_next` | 按存储顺序读下一行，全表扫描时大量出现 |

### 6.2 实测

用 `FLUSH STATUS` 清零会话计数器，执行查询，再看非零的计数（沙箱数据中 `user_id = 123` 有 14 行；数据由 `RAND()` 生成，各人环境里的行数不同）：

```
SELECT * FROM t_order WHERE user_id = 123;            -- 返回 14 行
  Handler_read_key   1
  Handler_read_next  14

SELECT COUNT(*) FROM t_order WHERE amount > 999;      -- 结果 992
  Handler_read_first     1
  Handler_read_key       1
  Handler_read_rnd_next  1000001

SELECT id FROM t_order WHERE amount > 999 LIMIT 1;    -- 返回 1 行
  Handler_read_first     1
  Handler_read_key       1
  Handler_read_rnd_next  447
```

逐组解读：

1. **走索引的等值查询**：引擎在 `idx_user` 上定位 1 次（`read_key = 1`），再顺着索引读了 14 次（`read_next = 14`），正好对应 14 行结果。
2. **全表扫描**：`rnd_next = 1000001`，即 100 万行各读一次，再加上最后一次调用返回“没有更多行”。引擎交上来 100 万行，Server 层逐行判断 `amount > 999`，只留下 992 行，**99.9% 的读取被丢弃**。这就是专题 1 中 EXPLAIN 的 `Extra: Using where` 的含义：条件由 Server 层判断。
3. **加了 LIMIT 1**：读到第 447 行时找到第一条满足条件的记录，执行器拿够了就不再调用，扫描到此为止。这证明**是执行器决定何时停止**，引擎只是被动供货。

::: warning 易混淆：WHERE 条件由谁判断
| 错误理解 | 正确理解 |
| --- | --- |
| WHERE 条件都由存储引擎过滤 | 默认情况下，引擎只负责按索引定位和读取行，**索引用不上的条件由 Server 层逐行判断**。例外是“索引下推”（专题 11），它把一部分条件交给引擎提前判断 |
| 引擎先算出完整结果，再一次性交给 Server | 执行器逐行调用引擎，拿够了随时可以停 |
:::

## 七、结果返回：半双工协议

MySQL 客户端与服务端之间的通信协议是**半双工**的：同一时刻只有一方在发送。客户端发出一条 SQL 后，就要等服务端把结果发完。

由此带来两个后果：

- **协议里没有“够了，别再发了”的指令**。服务端开始返回结果后，客户端只能读完，或者断开连接。
- 应用 `SELECT` 了 100 万行，即使代码里只用前 10 行，服务端也要把 100 万行发出去。客户端读得慢时，服务端线程会停在 `Sending to client`（正在向客户端写数据包）状态。

所以，**需要几行就在 SQL 里 `LIMIT` 几行**，不要在应用里截断。这也是专题 1 中“客户端耗时大于服务端耗时”的来源之一。

## 八、串起来：一条 SELECT 的阶段轨迹

`performance_schema` 可以记录一条语句经过的每个阶段（stage）。以下是沙箱里 `SELECT * FROM t_order WHERE user_id = 123` 一次执行的真实轨迹，单位为微秒（数值随每次执行波动，看相对大小即可）：

```
阶段                              耗时(μs)   所在环节
starting                           26.1   ┐
checking permissions                0.9   │ 权限检查
Opening tables                     76.8   │ 打开表
init                                1.7   │
System lock                         3.1   ┘
optimizing                          7.7   ┐
statistics                         57.2   │ 优化器：估算各访问方式的行数与成本
preparing                          14.7   ┘
executing                         120.4   ← 执行器 + InnoDB 读取数据
end                                 0.6   ┐
query end                           0.6   │
waiting for handler commit          5.8   │ 收尾：提交（autocommit 下每条语句是一个事务）
closing tables                      1.9   │
freeing items                      18.6   │
cleaning up                         0.2   ┘
```

（轨迹开头另有一行 `Executing hook on transaction begin.` 和一次重复的 `starting`，属于事务开始的内部步骤，耗时可忽略。）

这些阶段名就是 `SHOW PROCESSLIST` 中 `State` 列的取值。线上大量线程停在同一个 State，就能定位它卡在哪个环节：

| 停留的 State | 所在环节 | 官方说明与常见原因 |
| --- | --- | --- |
| `Waiting for table metadata lock` | 打开表 | 等元数据锁，常见于 DDL 与长事务冲突（专题 25、36） |
| `Opening tables` 很久 | 打开表 | 被 `ALTER TABLE`、`LOCK TABLES` 阻塞，或 `table_open_cache` 过小 |
| `statistics` 很久 | 优化器 | 手册说明：通常是服务器忙于磁盘 I/O |
| `executing` | 执行 | 扫描量大，或在等行锁（专题 26、27） |
| `Sending to client` | 返回结果 | 结果集大或客户端读得慢 |
| `waiting for handler commit` | 提交 | 事务提交等待，常与日志刷盘有关（专题 29、32） |

::: warning 5.7 差异
5.7 中执行期间最常见的 State 是 `Sending data`，名字有误导性：它实际表示“正在读取和处理数据”，不一定在发送。8.0 手册注明该状态已并入 `executing`。
:::

## 九、在三条主线中的位置

```
A 性能：  [连接器 → 解析 → 优化器 → 执行器] → 索引 → 页 → Buffer Pool → 磁盘
           └──────── 本专题 ────────────┘     专题 9-11、7-8、28
B 一致性：本专题只触及收尾的提交阶段（waiting for handler commit），专题 4 讲 UPDATE 时展开
C 诊断：  本专题提供“分层地图”，每层对应的观察入口见第十节
```

## 十、诊断实践

### 10.1 分层观察入口

| 层 | 先看什么 | 说明 |
| --- | --- | --- |
| 连接层 | `Threads_connected`、`Threads_running`、`Max_used_connections`、`Threads_created`、`Aborted_connects` | 连接数是否逼近上限、真正忙的线程有多少、线程缓存是否够用、是否有大量失败连接 |
| 解析层 | 错误码 1064 / 1054 / 1146 | SQL 停在了哪一步 |
| 优化器 | `EXPLAIN` | 计划是否合理（专题 15） |
| 执行器与引擎 | `Handler_read_*` | 引擎实际读了多少行 |
| 全流程 | PROCESSLIST 的 `State`、`performance_schema` 的阶段轨迹 | 卡在哪一个环节 |

### 10.2 病例一：连接池早上报错

1. **现象**：每天早上第一批请求报数据库错误，重试后恢复。
2. **指标**：8.0.24 及以上版本报 `ERROR 4031 ... because of inactivity`；更早版本报 `MySQL server has gone away`。
3. **定位**：连接池里的连接闲置超过 `wait_timeout`，已被服务端断开，连接池不知道。
4. **处置**：连接池最大存活时间设为小于 `wait_timeout`；不要通过把 `wait_timeout` 调得很大来掩盖问题，否则泄漏的连接会长期占着位置。

### 10.3 病例二：Too many connections

1. **现象**：新连接报 `Too many connections`。
2. **指标**：对比 `Threads_connected` 与 `Threads_running`。
   - `Threads_connected` 接近 `max_connections`，但 `Threads_running` 很小：大量连接空闲占位，查连接泄漏或连接池配置过大。
   - 两者都很高：大量语句同时在执行，可能被某个慢查询或锁堵住，转到 PROCESSLIST 看 State。
3. **定位**：

```sql
SELECT user, host, command, state, COUNT(*) AS cnt
FROM performance_schema.processlist
GROUP BY user, host, command, state
ORDER BY cnt DESC;
```

按来源和状态分组，看哪个应用、哪种状态占了大多数连接。

### 10.4 病例三：找出全表扫描的“隐形消耗”

慢日志只记录单次超过阈值的 SQL（专题 1）。如果怀疑有大量“单次不慢但都在全表扫描”的 SQL，可以看全局 `Handler_read_rnd_next` 的增长速度：

```sql
SHOW GLOBAL STATUS LIKE 'Handler_read_rnd_next';
-- 间隔 10 秒再执行一次，两次差值 / 10 = 每秒全表扫描读取的行数
```

增长很快说明有全表扫描在持续发生，再用 sys schema 找出具体语句（专题 44）。

## 十一、本地复现脚本

在专题 1 的 Docker 环境中（`mysql:8.4` 或 `mysql:8.0`），用命令行客户端执行。Navicat 的多个窗口可能是不同连接，会话级计数器会对不上。

```sql
-- 1. 连接层参数与计数
SELECT @@max_connections, @@thread_cache_size, @@wait_timeout, @@thread_handling;
SHOW GLOBAL STATUS WHERE Variable_name IN
 ('Connections','Threads_created','Threads_cached','Threads_connected','Threads_running');

-- 2. 查询缓存已删除
SHOW VARIABLES LIKE '%query_cache%';

-- 3. 不同环节的报错
SELEC * FROM t_order;
SELECT no_such_col FROM t_order;
SELECT * FROM no_such_table;

-- 4. Handler 计数
FLUSH STATUS; SELECT * FROM t_order WHERE user_id = 123;
SHOW SESSION STATUS WHERE Variable_name LIKE 'Handler_read%' AND Value <> '0';
FLUSH STATUS; SELECT COUNT(*) FROM t_order WHERE amount > 999;
SHOW SESSION STATUS WHERE Variable_name LIKE 'Handler_read%' AND Value <> '0';
FLUSH STATUS; SELECT id FROM t_order WHERE amount > 999 LIMIT 1;
SHOW SESSION STATUS WHERE Variable_name LIKE 'Handler_read%' AND Value <> '0';

-- 5. 阶段轨迹
UPDATE performance_schema.setup_instruments SET ENABLED = 'YES', TIMED = 'YES' WHERE NAME LIKE 'stage/%';
UPDATE performance_schema.setup_consumers   SET ENABLED = 'YES' WHERE NAME LIKE 'events_stages%';
SELECT * FROM t_order WHERE user_id = 123;
SET @tid = PS_CURRENT_THREAD_ID();
SELECT event_id INTO @eid FROM performance_schema.events_statements_history
 WHERE thread_id = @tid AND sql_text LIKE 'SELECT * FROM t_order%' ORDER BY event_id DESC LIMIT 1;
SELECT REPLACE(event_name, 'stage/sql/', '') AS stage, ROUND(timer_wait / 1e6, 1) AS us
FROM performance_schema.events_stages_history_long
WHERE thread_id = @tid AND nesting_event_id = @eid ORDER BY event_id;
```

`wait_timeout` 断连实验：用 `mysql --skip-reconnect` 登录（否则命令行客户端会自动重连，看不到报错），执行 `SET SESSION wait_timeout = 5;`，等 6 秒以上再执行 `SELECT 1;`。

预期现象：Handler 计数的规律与第六节一致（等值查询 `read_key = 1`、`read_next` 等于该用户的行数；全表扫描 `rnd_next` 约 100 万；加 LIMIT 后 `rnd_next` 很小），具体数值随数据不同。`thread_cache_size` 在默认 `max_connections = 151` 下应为 9。

## 十二、与其他专题的关联

- **专题 1**：`Using where` 与“服务端耗时 vs 客户端耗时”在第六、七节得到解释。
- **专题 3、4**：本专题是一条 SQL 的总览；专题 3 深入 SELECT 在引擎内部的读取路径，专题 4 深入 UPDATE 的写入与日志。
- **专题 11**：索引下推，把部分 WHERE 判断从 Server 层移到引擎层。
- **专题 15、16**：EXPLAIN 与优化器成本模型，即第五节的展开。
- **专题 25、36**：`Waiting for table metadata lock`。
- **专题 45**：连接、线程、内存的资源模型。
- **Redis**：单线程事件循环与一连接一线程的取舍；查询缓存被删除与应用层缓存。

## 十三、复习 checklist

- [ ] 能画出 Server 层五个环节与引擎层的分工图
- [ ] 能说明一连接一线程模型下线程缓存的作用，以及用 `Connections` 与 `Threads_created` 判断缓存是否够用
- [ ] 知道 `thread_cache_size` 默认值的实测规律（8 + max_connections / 100，上限 100）
- [ ] 能说清不同级别权限变更对已连接客户端何时生效
- [ ] 知道 `wait_timeout` 断连的现象（8.0.24 起 ERROR 4031）与连接池的配置原则
- [ ] 能解释 8.0 删除查询缓存的两个原因
- [ ] 看到 1064 / 1054 / 1146 能判断 SQL 停在哪个环节
- [ ] 能用 `Handler_read_*` 证明“执行器逐行拉取、Server 层过滤条件”
- [ ] 能解释半双工协议对大结果集的影响
- [ ] 能把 PROCESSLIST 中常见的 State 对应到所在环节
