# 专题 1 · 实验环境与观测工具入门

> 级别 ☆（轻量）· 主线 C（诊断）· 实测版本：本地 MySQL 8.4.11（Docker），对照沙箱 MySQL 8.0.46

本专题是诊断主线的起点：先有一套能随时推倒重来的实验库，再认识 MySQL 提供的几只“眼睛”。后面所有专题的实验都建立在这里。

本专题要真正掌握的只有两件事：**几分钟内重建实验环境**；遇到问题时**先判断该用哪只眼睛，并分清慢在服务端还是客户端**。

## 搭建实验环境

用 Docker 跑 MySQL 8.4，配置目录和数据目录都挂到宿主机：删容器不丢数据，清空 data 目录就能彻底重来。

配置文件 `/root/mysql-lab/conf/lab.cnf`（权限 644）：

```ini
[mysqld]
character-set-server    = utf8mb4
slow_query_log          = ON
slow_query_log_file     = /var/lib/mysql/slow.log
long_query_time         = 0.5
innodb_buffer_pool_size = 512M
```

启动命令，挂载路径一律写绝对路径：

```bash
docker run -d --name mysql84 \
  -p 3306:3306 \
  -e MYSQL_ROOT_PASSWORD='实验密码' \
  -v /root/mysql-lab/conf:/etc/mysql/conf.d \
  -v /root/mysql-lab/data:/var/lib/mysql \
  mysql:8.4
```

镜像的主配置 `/etc/my.cnf` 末尾有一行 `!includedir /etc/mysql/conf.d/`，所以挂进去的 `lab.cnf` 会在启动时被读取。`!includedir` 不属于任何段，即使写在 `[client]` 后面也不影响，被包含的文件自己以 `[mysqld]` 开头即可。

启动后先确认配置生效：

```sql
SELECT VERSION();
SHOW VARIABLES LIKE 'slow_query_log%';
SHOW VARIABLES LIKE 'innodb_buffer_pool_size';   -- 512M = 536870912
```

::: warning 易错
`MYSQL_ROOT_PASSWORD` 只在数据目录**第一次初始化**时生效，之后重启或重建容器都不会再读它。要改密码只能进库执行 `ALTER USER`，而且官方镜像默认建了 `root@localhost` 和 `root@%` 两个账号，两个都要改。
:::

::: warning 易错
Docker 挂载一个不存在的宿主机目录时，会自动创建一个空目录挂进去；MySQL 在 `conf.d` 里找不到配置文件也不报错，直接用默认值启动。两边都静默，所以“配置写了但没生效”时，第一步就是用 `SHOW VARIABLES` 验证。另外，“所有人可写”的配置文件会被 MySQL 出于安全考虑直接忽略。
:::

配置文件只在启动时读取，修改后 `docker restart mysql84` 即可，不必重建容器。

两个版本相关的点：8.0 起 binlog 默认开启，所以什么都不配，数据目录里也会有 `binlog.000001` 这类文件（专题 32 会用到）；8.4 默认禁用了 `mysql_native_password` 认证插件，老版本客户端连不上时先查这里。

::: tip Navicat 使用注意
Navicat 不支持命令行客户端的 `\G`；默认会限制结果集行数（不影响 `COUNT(*)` 的值，因为结果只有一行）；每个查询窗口可能是独立连接，一个窗口里 `SET SESSION` 对另一个窗口无效；它显示的耗时是**客户端视角**，见下文。做需要精确对照的实验时，回到 `docker exec -it mysql84 mysql -uroot -p` 命令行。
:::

## 造百万行测试数据

`lab.t_order` 是后续专题反复使用的基准表：100 万行、10 万个用户、`amount` 均匀分布在 0–1000、`remark` 约 10% 为 NULL。

```sql
CREATE DATABASE lab;
USE lab;

CREATE TABLE t_order (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    INT UNSIGNED    NOT NULL,
  status     TINYINT         NOT NULL,
  amount     DECIMAL(10,2)   NOT NULL,
  order_no   VARCHAR(32)     NOT NULL,
  created_at DATETIME        NOT NULL,
  remark     VARCHAR(255)    NULL,
  PRIMARY KEY (id),
  KEY idx_user (user_id)
) ENGINE = InnoDB;

SET SESSION cte_max_recursion_depth = 1000000;   -- 默认只有 1000

INSERT INTO t_order (user_id, status, amount, order_no, created_at, remark)
WITH RECURSIVE seq(n) AS (
  SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 1000000
)
SELECT FLOOR(1 + RAND() * 100000),                        -- 10 万个用户
       FLOOR(RAND() * 5),                                 -- 5 种状态
       ROUND(RAND() * 1000, 2),
       CONCAT('NO', LPAD(n, 12, '0')),
       NOW() - INTERVAL FLOOR(RAND() * 365 * 86400) SECOND,
       IF(RAND() < 0.1, NULL, CONCAT('remark-', n))       -- 约 10% 为 NULL
FROM seq;
```

字段设计是有意的：`user_id` 有索引、`amount` 没有，下面用来对比优化器的估算；`remark` 可空，专题 5 讲 NULL 时会用到。

::: tip 关联
这条 INSERT 是一次百万行的**单事务写入**。专题 29–32 讲 redo、undo、binlog 与大事务时，会回头拿它举例。
:::

## 四只眼睛

每个工具回答一个不同的问题。排查时先想清楚自己要问的是哪一个，再选工具。

| 工具 | 回答的问题 | 入口 | 现阶段先看什么 | 深入专题 |
| --- | --- | --- | --- | --- |
| EXPLAIN | 优化器**打算**怎么执行 | `EXPLAIN SELECT …` | `type`、`key`、`rows`、`filtered`、`Extra` | 15 |
| PROCESSLIST | **现在**谁在跑、卡在什么状态 | `SHOW PROCESSLIST` 或 `performance_schema.processlist` | `Command`、`Time`、`State` | 2、45 |
| 慢查询日志 | **过去**哪些 SQL 单次执行慢 | `/var/lib/mysql/slow.log` | `Query_time`、`Lock_time`、`Rows_examined` 与 `Rows_sent` 的比值 | 18、22 |
| SHOW ENGINE INNODB STATUS | InnoDB **内部**发生了什么 | `SHOW ENGINE INNODB STATUS\G` | `TRANSACTIONS`、`BUFFER POOL AND MEMORY`、`LOG`、`LATEST DETECTED DEADLOCK` 四段 | 27、28、29 |
| sys schema | 哪类 SQL **总量**最大 | `sys.statement_analysis`、`sys.session` | 执行次数、总耗时、扫描行数 | 44 |

`performance_schema.processlist` 可以加 `WHERE command <> 'Sleep'` 过滤，比 `SHOW PROCESSLIST` 好用。Navicat 等客户端自己的连接会以 `Sleep` 状态出现在里面，这正是专题 2 “连接层”的现成例子。

::: warning 易混淆
慢日志只按**单次耗时**筛选。“单次不慢、但扫描量巨大且调用频繁”的 SQL 它抓不到，例如一条 0.1 秒的全表扫描每秒被调用 50 次，就足以吃满好几个 CPU 核。这类 SQL 要靠 sys schema 的总量统计（专题 44），或打开 `log_queries_not_using_indexes`。
:::

::: warning 易错：参数作用域
`SET GLOBAL long_query_time = 0.1` 只影响**之后新建的连接**，当前会话执行 `SHOW VARIABLES` 看到的仍是旧值，再跑查询也照旧不记录。要立即对当前会话生效，用 `SET SESSION`。这条规则对大部分参数都成立，专题 46 系统讲。`long_query_time = 0` 会记录所有语句，只适合实验环境。
:::

::: tip PG 对照
EXPLAIN ↔ `EXPLAIN`；PROCESSLIST ↔ `pg_stat_activity`；慢日志 ↔ `log_min_duration_statement`；sys.statement_analysis ↔ `pg_stat_statements`。思路相同，名字不同。
:::

## 读懂第一份 EXPLAIN：估算与实际

两条查询，一条走索引、一条全表扫描，实测结果如下：

```
EXPLAIN SELECT * FROM t_order WHERE user_id = 123;
type=ref  key=idx_user  key_len=4  ref=const  rows=9       filtered=100.00  Extra=NULL

EXPLAIN SELECT * FROM t_order WHERE amount > 999;
type=ALL  key=NULL                             rows=996019  filtered=33.33   Extra=Using where
```

再用 `COUNT(*)` 拿到真实值对照：

| 查询 | EXPLAIN 估算 | 实际 | 偏差来源 |
| --- | --- | --- | --- |
| `user_id = 123` 的行数 | rows = 9 | 9 行 | 等值条件走索引，优化器到索引树上实地估算（index dive），所以准 |
| `amount > 999` 的全表行数 | rows = 996019 | 1000000 行 | 抽样若干叶子页推算，误差 0.4% |
| `amount > 999` 满足条件的比例 | filtered = 33.33%（约 33 万行） | 1006 行（约 0.1%） | 无索引无直方图，只能用经验值，**高估 300 多倍** |

逐项拆开看：

**`rows = 9`**：100 万行随机分给 10 万个用户，平均每人 10 行，9 正好在这个量级。等值条件有索引时，优化器会真的到索引树上探一下这个值落在哪个区间，所以估得几乎分毫不差。

**`rows = 996019`**：`amount` 上没有索引只能全表扫，这里估的其实是全表行数。InnoDB 不会去数，而是随机抽样一部分叶子页（`innodb_stats_persistent_sample_pages`，默认 20），算出每页平均行数再乘以总页数。存下来的估算值可以在这里看到：

```sql
SELECT n_rows, clustered_index_size FROM mysql.innodb_table_stats
WHERE database_name = 'lab' AND table_name = 't_order';
```

**`filtered = 33.33`**：这才是重点。它表示优化器估计扫出来的行里有 33.33% 满足条件。可 `amount` 均匀分布在 0–1000，真实比例只有约 0.1%。优化器对 `amount` 的分布一无所知，范围条件只能按一个写死的经验值估。

::: warning 重点
这次估错没有后果，因为反正只能全表扫。但在多表 join 时，这个数会被拿去决定谁做驱动表，**估错就可能选错执行计划**。“优化器为什么选错索引”的根子，很多时候就在这里。
:::

::: tip 关联
专题 13 会用同一张表、同一个条件建直方图，看 `filtered` 变成多少；专题 16 讲这些估算如何进入成本模型。
:::

其余几列：`key_len = 4` 是因为 `INT UNSIGNED NOT NULL` 占 4 字节，可空列会多 1 字节做 NULL 标记，专题 11 用它判断联合索引用到了几列；`filtered = 100.00` 表示从索引取出的行全部满足条件；`Extra = Using where` 表示存储引擎把行交给 Server 层后，由 Server 层逐行判断条件，这是专题 3 “Server 层过滤”的伏笔。

## 服务端耗时与客户端耗时

同一条 `SELECT COUNT(*) FROM t_order WHERE remark LIKE '%99999%'`，两个视角的数字差了三倍多：

| 场景 | Navicat 显示 | 服务端实际 |
| --- | --- | --- |
| Buffer Pool 冷（容器重启后首次执行） | 0.453 s | 未测 |
| Buffer Pool 热 | 0.322 s | 0.096–0.099 s |

服务端时间取自 `performance_schema`，单位是皮秒：

```sql
SELECT sql_text, timer_wait / 1e12 AS seconds
FROM performance_schema.events_statements_history
WHERE sql_text LIKE '%99999%';
```

客户端时间额外包含网络往返、结果的接收与渲染，有时还夹带客户端自己发的语句。**慢日志的判定用的是服务端时间。**

::: warning 重点
排查“SQL 慢”时，第一件事是**分清慢在服务端还是客户端**。应用说一条 SQL 要 300 毫秒，服务端却只记了 100 毫秒，剩下的时间就该去查网络、连接池、结果集过大、应用自身处理，而不是去优化 SQL。专题 2 讲半双工协议时还会回到这一点。
:::

冷热差距小，说明这条 `LIKE '%…%'` 全表扫描的主要耗时在 CPU（逐行做字符串匹配），而不在 I/O。100 万行在内存里扫一遍只要 0.1 秒左右。I/O 型查询（比如大量随机读分散的行）冷热差距会大得多。

::: tip 关联
冷热对比的完整实验在专题 3，Buffer Pool 机制在专题 28。
:::

慢日志里一条记录长什么样（沙箱 8.0.46 实测，`long_query_time = 0`）：

```
# Query_time: 0.172475  Lock_time: 0.000002 Rows_sent: 1  Rows_examined: 1000000
SET timestamp=1791531663;
SELECT COUNT(*) FROM t_order WHERE remark LIKE '%99999%';
```

`Lock_time` 几乎为 0，说明没有锁争用；`Rows_examined` 与 `Rows_sent` 相差 100 万倍，是“为了返回 1 行扫了全表”的直接证据。**看慢日志先看这两个数的比值**，它比耗时本身更能说明问题。

## 诊断实践

两次环境排障都遵循同一个方法：**把现象拆成环节，用指标逐个证明，而不是反复改配置碰运气。**

### 病例一：慢日志文件不存在

1. **现象**：`docker exec mysql84 tail /var/lib/mysql/slow.log` 报文件不存在。
2. **指标**：容器内 `/etc/mysql/conf.d/` 下看不到 `lab.cnf`，配置文件根本没进容器，自然不会被加载。
3. **定位**：主配置里确有 `!includedir`；`docker inspect` 显示挂载也正常；但挂载源 `/root/mysql-lab/conf` 是空目录。原因很可能是以 root 执行 `docker run` 时 `~` 指向 `/root`，而配置文件建在了别的用户目录下。
4. **处置**：把 `lab.cnf` 放进实际挂载的目录，`docker restart`，重新验证变量。

查挂载的命令：

```bash
docker inspect mysql84 --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{println}}{{end}}'
```

### 病例二：慢日志一直为空

1. **现象**：`long_query_time` 调到 0.1 后，执行一条“0.3 秒”的查询，慢日志里仍只有启动时的文件头。
2. **拆分**：慢日志记录一条 SQL 要经过两步，先**判定**它超过阈值，再**写入**到 `log_output` 指定的位置。任何一步失败，结果都是空文件。
3. **指标**：`log_output = FILE`、文件路径正确，写入环节没问题；执行前后 `SHOW SESSION STATUS LIKE 'Slow_queries'` 都是 0，说明判定环节没触发；`performance_schema` 显示服务端耗时 0.096–0.099 秒，低于 0.1 秒阈值。
4. **结论**：这条 SQL 在服务端并不“慢”，之前看到的 0.3–0.45 秒是 Navicat 的客户端耗时。

::: tip 方法
`Slow_queries` 状态值只反映“判定”，不管日志有没有写成功，超过阈值就加 1。它是区分“没判定”和“没写进去”的分水岭。同类问题都可以这样找一个只属于某个环节的指标。
:::
