# 专题 34–35 · 数据类型与 schema 设计陷阱、范式与反范式（合并）

> 级别：34 ☆ / 35 ☆ · 主线 A / B（衔接 C）· 实测版本：沙箱 MySQL 8.0.46

本篇回答：金额、时间、字符串、整数各该用什么类型？`DATETIME` 与 `TIMESTAMP` 差在哪？utf8mb4 与排序规则有什么坑？NULL 与严格模式为何重要？什么时候该冗余、建汇总表，怎样维护？

## 模块七大纲

```
表结构设计（34、35）：列用什么类型？要不要冗余？
          ▼
结构上线后要改（36）：怎样不停服务地改表？
          ▼
特定结构（37 分区表、38 视图 / 存储过程 / 触发器 / 外键 / 自增 ID / 临时表）
```

| 层级 | 知识点 | 专题 |
| --- | --- | --- |
| ★ | Online DDL 三种算法；DDL 与 MDL；大表变更工具原理 | 36 |
| ☆ | 金额 DECIMAL；`DATETIME` 与 `TIMESTAMP`；utf8mb4；严格模式 | 34 |
| ☆ | 范式与反范式；汇总表、冗余列的维护 | 35 |
| ☆ | 分区表适用场景与局限 | 37 |
| ○ | 视图、存储过程、触发器、事件、外键；自增 ID 锁模式与用尽；临时表 | 38 |

## 一、数据类型选择（专题 34）

**总原则**：能正确表达业务含义的前提下，选最小、最简单的类型——小则每页行多、索引小（专题 8、10）；简单则比较快、不涉及字符集与排序规则。

### 1.1 金额：DECIMAL，不用 FLOAT / DOUBLE

二进制浮点数无法精确表示 0.1 这类十进制小数（如同 1/3 无法用有限位十进制表示）。三列 `FLOAT`、`DOUBLE`、`DECIMAL(10,2)` 各存 0.1 与 0.2（真实输出）：

```
SUM(f) = 0.30000000447034836     SUM(f) = 0.3 → 0
SUM(d) = 0.30000000000000004
SUM(m) = 0.30                    SUM(m) = 0.3 → 1
存入 1234567.89：FLOAT → 1234570（有效位不够）；DOUBLE、DECIMAL → 1234567.89
```

| 类型 | 精确 | 存储（手册） | 用途 |
| --- | --- | --- | --- |
| `DECIMAL(M,D)` | 是 | 每 9 位十进制数字 4 字节，整数与小数部分分别计算 | 金额、精确数值 |
| `FLOAT` / `DOUBLE` | 否 | 4 / 8 字节 | 可接受误差的科学计算、读数 |

也可以“分”为单位存 `BIGINT`：计算最快，但应用须统一换算。

### 1.2 时间：DATETIME 与 TIMESTAMP

| | `DATETIME` | `TIMESTAMP` |
| --- | --- | --- |
| 范围（手册） | `1000-01-01 00:00:00` ～ `9999-12-31 23:59:59` | `1970-01-01 00:00:01` UTC ～ **`2038-01-19 03:14:07` UTC** |
| 存储（手册） | 5 字节 + 小数秒 | 4 字节 + 小数秒 |
| 时区 | 不转换 | 写入时由**会话时区**转 UTC 存储，读取时转回会话时区 |
| 小数秒 | 最多 6 位 | 同左 |

```
会话时区 +08:00 写入 '2026-11-19 10:00:00' 到两列
+08:00 读：dt = 2026-11-19 10:00:00   ts = 2026-11-19 10:00:00
+00:00 读：dt = 2026-11-19 10:00:00   ts = 2026-11-19 02:00:00   ← 随会话时区变化
会话时区 +00:00：'2038-01-19 03:14:07' 成功；'2038-01-19 03:14:08' → ERROR 1292
```

::: danger 错误理解 vs 正确理解
- ❌ TIMESTAMP 更小还能自动处理时区，总是更好。
- ✅ 其转换依赖**每个连接的会话时区**，应用、连接池、服务器时区不统一时同一值读出不同；且 2038 年后无法表示。常见做法：统一 `DATETIME` 并约定全部存 UTC（或固定时区），由应用转换。
:::

### 1.3 字符集：utf8mb4

- 8.0 默认 `utf8mb4` / `utf8mb4_0900_ai_ci`（实测）。
- `utf8mb3` 最多 3 字节，存不了 emoji：写入 `ok👍` 报 `ERROR 1366: Incorrect string value: '\xF0\x9F\x91\x8D'`；`utf8mb4` 列成功，`CHAR_LENGTH = 3`、`LENGTH = 6`。
- 混用字符集 / 排序规则会导致关联时索引失效甚至报错（专题 21 的 Warning 1739、ERROR 1267），建库时统一。

**末尾空格**：

```
SELECT 'abc' = 'abc   '                            -- 0（utf8mb4_0900_ai_ci，PAD_ATTRIBUTE = NO PAD）
SELECT 'abc' COLLATE utf8mb4_general_ci = 'abc   '  -- 1（utf8mb4_general_ci，PAD SPACE）
SELECT 'ABC' = 'abc'                                -- 1（ci：不区分大小写）
```

从 5.7 升级、仍用 `general_ci` 的老表与 8.0 新表在此表现不同（`PAD_ATTRIBUTE` 实测于 `information_schema.COLLATIONS`）。

### 1.4 整数、字符串与其他

| 类型 | 要点 |
| --- | --- |
| 整数 | `TINYINT`/`SMALLINT`/`MEDIUMINT`/`INT`/`BIGINT` = 1/2/3/4/8 字节（手册）。`INT(11)` 的 11 只是显示宽度，8.0 已弃用（实测 `Warning 1681`）。主键 / 自增优先 `BIGINT UNSIGNED`（专题 38） |
| `VARCHAR(n)` | n 为字符数；存储 = 内容长度 + 1 或 2 字节长度前缀（最大可能长度 ≤ 255 字节用 1 字节，手册）。不要随手 `VARCHAR(255)`：排序、临时表按声明长度分配内存（专题 19 的 `key_size`） |
| `CHAR(n)` | 定长，适合固定长度编码 |
| 手机号、订单号 | 用字符串存，**按字符串传参**（专题 21） |
| `TEXT` / `BLOB` | 可能存溢出页（专题 8），避免 `SELECT *` |
| `ENUM` | 1～2 字节（手册）；增加枚举值需改表，很多团队改用 `TINYINT` + 代码常量 |
| `JSON` | 结构不固定的属性；按字段查询用函数索引或多值索引（专题 14） |
| 行大小 | 手册：行最大 65,535 字节（BLOB / TEXT 只计 9～12 字节），utf8mb4 的 `VARCHAR` 最多声明 16,383 个字符 |

### 1.5 NULL 与严格模式

```
两行：x = NULL、x = 1
SELECT COUNT(*) FROM t_null WHERE x <> 1   → 0      ← NULL 行也被排除（专题 5 三值逻辑）
COUNT(*) = 2，COUNT(x) = 1                           ← COUNT(列) 不统计 NULL（专题 21）
```

无“未知”业务含义的列一律 `NOT NULL` 加默认值，也有利于 `NOT IN` 改写为反连接（专题 20）。

8.0 默认 `sql_mode` 含 `STRICT_TRANS_TABLES`（实测）：

```
严格模式：'abcdefg' 写入 VARCHAR(5) → ERROR 1406: Data too long for column 'name'
sql_mode = ''：'abcdefg' 写入 VARCHAR(5)、300 写入 TINYINT
  → 成功，仅 Warning 1265 / 1264，实际存为 'abcde' 与 127   ← 数据被悄悄改掉
```

保持严格模式；为“兼容”关闭严格模式的老系统，数据可能早已被截断。

## 二、范式与反范式（专题 35）

### 2.1 同一份信息存一处还是多处

| | 范式化（只存一处） | 反范式化（冗余） |
| --- | --- | --- |
| 写 | 改一处，不会不一致 | 改多处，否则不一致 |
| 读 | 需要 join | 免 join，可直接建索引 |
| 空间 | 小 | 大 |

### 2.2 冗余一列的收益（真实输出）

“统计 City12 用户的订单”：

| 写法 | 计划 | 检查行数 | 耗时 |
| --- | --- | --- | --- |
| 范式：`t_order JOIN t_user`，`u.city = 'City12'` | 全表扫 t_user（10 万），再按 user_id 查 t_order | 102540 | 29.2 ms |
| 反范式：t_order 冗余 `city`，索引 `(city, amount)` | ref，Using index | 2540 | 0.95 ms |

快约 30 倍；代价是用户改城市须同步改其订单，且需先确定订单上的城市应是“下单时”还是“现在”的值（业务问题）。实验后已删除冗余列与索引。

### 2.3 汇总表

```
按天汇总 10 月订单：
直接在 t_order 上 GROUP BY：检查 1000000 行，218.44 ms
查汇总表 t_daily（366 行）：检查 31 行，      0.23 ms
```

| 维护方式 | 做法 | 一致性 | 代价 |
| --- | --- | --- | --- |
| 同步更新 | 同一事务中 `INSERT INTO t_daily ... ON DUPLICATE KEY UPDATE cnt = cnt + 1, ...` | 完全一致 | 汇总行成为**热点行**，高并发锁冲突（专题 21 计数表） |
| 定时重算 | 定时按时间段重算 | 有延迟 | 简单、可重跑 |
| 异步增量 | 订阅 binlog / 消息队列增量更新 | 短暂延迟 | 需额外组件 |

`VALUES(col)` 写法在 8.0 已弃用，推荐 `INSERT INTO t_daily VALUES (...) AS new ON DUPLICATE KEY UPDATE amt = amt + new.amt`。

::: danger 错误理解 vs 正确理解
- ❌ 范式越高越好，或为性能尽量冗余。
- ✅ 以范式为基础，在**读多写少、关联代价明显、可接受维护成本**处有针对性地冗余或建汇总表，并明确由谁维护一致性、允许多大延迟。汇总表与缓存（Redis 笔记）是同类取舍，区别是汇总表可与明细在同一事务更新。
:::

## 三、串联图

```
建表时：
  类型 → 金额 DECIMAL；时间 DATETIME + 约定时区（TIMESTAMP 注意会话时区与 2038）；
         utf8mb4 统一（注意排序规则末尾空格）；尽量 NOT NULL；保持严格模式；手机号 / 订单号存字符串并按字符串传参
  结构 → 范式为基础；读多写少、关联代价高处冗余或汇总；明确维护方式与一致性
上线后：
  类型选错 → 精度丢失、时区错乱、emoji 写入失败、隐式转换全表扫描（专题 21）
  冗余失控 → 数据不一致；汇总行成热点
  改表结构 → 专题 36
```

## 四、在三条主线中的位置

```
A 性能：类型小 → 每页行多 → 读的页少；冗余与汇总 → 少 join、少扫描
B 一致性：类型错导致精度、时区、写入问题；冗余数据需维护一致性
C 诊断：隐式转换、字符集不一致的根源在建表时（专题 21）
```

## 五、排查要点

| 现象 | 先查什么 | 方向 |
| --- | --- | --- |
| 金额对账出现几分钱误差 | 金额列类型 | 改 `DECIMAL` 或以分存整数 |
| 同一时间不同服务读出相差几小时 | 列是否 `TIMESTAMP`；各连接 `@@time_zone` | 统一时区约定或改 `DATETIME` |
| 写入 emoji 报 1366 | 列 / 表 / 连接字符集 | 统一 utf8mb4（含连接字符集） |
| `'abc'` 与 `'abc '` 比较结果升级前后不同 | 排序规则 `PAD_ATTRIBUTE` | 了解 NO PAD 行为，必要时统一排序规则 |
| 数据被截断却无报错 | `@@sql_mode` | 开启严格模式 |
| 条件查询漏数据 | 列是否可为 NULL、是否用了 `<>` / `NOT IN` | NOT NULL + 默认值；改写条件 |
| 报表聚合慢 | 是否每次扫明细大表 | 汇总表，评估维护方式 |

## 六、本地复现（Docker mysql:8.4）

```sql
USE lab;
-- 一、浮点与定点
CREATE TABLE t_types (id INT PRIMARY KEY, f FLOAT, d DOUBLE, m DECIMAL(10,2));
INSERT INTO t_types VALUES (1,0.1,0.1,0.1),(2,0.2,0.2,0.2),(3,1234567.89,1234567.89,1234567.89);
SELECT SUM(f), SUM(d), SUM(m) FROM t_types WHERE id <= 2;
SELECT f, d, m FROM t_types WHERE id = 3;
-- 二、时区与范围
CREATE TABLE t_time (id INT PRIMARY KEY, dt DATETIME, ts TIMESTAMP NULL);
SET time_zone = '+08:00'; INSERT INTO t_time VALUES (1,'2026-11-19 10:00:00','2026-11-19 10:00:00');
SET time_zone = '+00:00'; SELECT dt, ts FROM t_time;
INSERT INTO t_time VALUES (3,'2038-01-19 03:14:08','2038-01-19 03:14:08');   -- ERROR 1292
-- 三、字符集与排序规则（客户端 --default-character-set=utf8mb4）
CREATE TABLE t_cs (id INT PRIMARY KEY, a VARCHAR(20) CHARACTER SET utf8mb3, b VARCHAR(20) CHARACTER SET utf8mb4);
INSERT INTO t_cs VALUES (2,'ok👍','ok');                                       -- ERROR 1366
SELECT 'abc' = 'abc   ', 'abc' COLLATE utf8mb4_general_ci = 'abc   ';
-- 四、严格模式
CREATE TABLE t_strict (id INT PRIMARY KEY, name VARCHAR(5), n TINYINT);
INSERT INTO t_strict VALUES (1,'abcdefg',1);                                   -- ERROR 1406
SET SESSION sql_mode = ''; INSERT INTO t_strict VALUES (2,'abcdefg',300); SHOW WARNINGS; SELECT * FROM t_strict;
-- 五、汇总表
CREATE TABLE t_daily (d DATE PRIMARY KEY, cnt INT NOT NULL, amt DECIMAL(16,2) NOT NULL);
INSERT INTO t_daily SELECT DATE(created_at), COUNT(*), SUM(amount) FROM t_order GROUP BY DATE(created_at);
```

**预期现象**：与上文真实输出一致；本地日期分布不同时调整查询区间；8.4 默认 `sql_mode` 以 `SELECT @@sql_mode` 为准。

::: tip PG 对照
- `timestamptz` 同样按会话时区转换（存 UTC），无 2038 上限；`timestamp` ≈ `DATETIME`；社区推荐 `timestamptz`。
- `numeric` ≈ `DECIMAL`；PG 的 UTF8 天然支持 4 字节字符。
- PG 对超长字符串、越界整数一律报错，没有“悄悄截断”。
- PG 物化视图（`MATERIALIZED VIEW` + `REFRESH`）可直接充当汇总表，MySQL 需自建表维护。
:::

## 七、与其他专题的关联

- **专题 5**：三值逻辑与 NULL。
- **专题 8 / 10**：行格式、类型大小对页与索引的影响。
- **专题 14**：JSON 的函数索引与多值索引。
- **专题 19**：声明长度影响排序与临时表内存。
- **专题 20 / 21**：NOT IN 与 NULL、隐式转换、字符集不一致、COUNT 与计数表。
- **专题 36**：上线后如何修改表结构。

## 八、复习 checklist

- [ ] 能用实验说明 FLOAT / DOUBLE 的精度问题，知道金额用 DECIMAL 或以分存整数
- [ ] 能对比 DATETIME 与 TIMESTAMP 的范围、存储、时区行为，说出工程上的时区约定
- [ ] 知道 utf8mb3 存不了 emoji、8.0 默认字符集与排序规则，以及 NO PAD 的末尾空格行为
- [ ] 知道 INT 显示宽度已弃用、VARCHAR 长度前缀规则与声明长度的影响、手机号等应存字符串
- [ ] 知道 NULL 带来的条件陷阱与 NOT NULL 的好处，以及关闭严格模式会悄悄截断数据
- [ ] 能对比范式与反范式的读写代价，并用冗余列与汇总表实验说明收益
- [ ] 能说出汇总表三种维护方式的一致性与代价
