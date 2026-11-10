# 专题 5 · SQL 语义基础：NULL 三值逻辑、隐式类型转换、字符集与排序规则

> 级别 ☆（高频重点）· 主线 A（性能）/ C（诊断）· 实测版本：沙箱 MySQL 8.0.46

三件事的共同点：**SQL 里的“相等”和直觉不一样**，而且出错时**不报错**，只会给出看似正常的错误结果，或悄悄让索引失效。

| 主题 | 直觉 | 实际 | 后果 |
| --- | --- | --- | --- |
| NULL | `remark <> 'x'` 返回所有不等于 x 的行 | NULL 行不会返回 | 结果少了 |
| 隐式类型转换 | `phone = 13800000123` 与 `phone = '13800000123'` 等价 | 前者不能用索引，还会多匹配 | 全表扫描，结果多了 |
| 排序规则 | `'abc'` 与 `'ABC'` 是两个值 | 默认规则下相等 | 唯一键冲突、多匹配 |

## 一、NULL 与三值逻辑

### 1.1 核心规则

NULL 表示**未知 / 不适用**，不是空字符串，也不是 0。类比问卷上“未填写”的一栏：不能说它等于“是”，也不能说它不等于“是”。

- 比较结果有三种：**TRUE、FALSE、UNKNOWN**。任何值与 NULL 做 `=`、`<>`、`<`、`>` 比较，结果都是 UNKNOWN（MySQL 显示为 NULL）。
- **WHERE 只保留结果为 TRUE 的行**，FALSE 与 UNKNOWN 都被丢弃。
- 判断 NULL 只能用 `IS NULL` / `IS NOT NULL`；`<=>` 是 MySQL 的 NULL 安全等于，两边都为 NULL 时返回 1。

沙箱实测：

```
NULL = NULL   NULL <> NULL   NULL IS NULL   NULL <=> NULL   1 = NULL
   NULL           NULL             1              1            NULL
```

### 1.2 五个陷阱（沙箱实测）

::: warning 陷阱 1：`<>` 漏掉 NULL 行
```
COUNT(*) = 1000000   COUNT(remark) = 900239   NULL 行 = 99761
WHERE remark <> 'remark-1'                     → 900238
WHERE remark <> 'remark-1' OR remark IS NULL   → 999999
```
:::

::: warning 陷阱 2：NOT IN 列表中有 NULL，结果为空
```
WHERE id NOT IN (1, 2, NULL)   → 0 行
WHERE id IN (1, 2, NULL)       → 2 行
```
推导（以 `id = 5` 为例）：

```
id NOT IN (1, 2, NULL)
= id <> 1 AND id <> 2 AND id <> NULL
= TRUE    AND TRUE    AND UNKNOWN
= UNKNOWN   → 被丢弃
```

`IN` 是 OR 连接，`id = 1` 时 `TRUE OR ...` 为 TRUE，所以正常。工作中常见的 `WHERE x NOT IN (SELECT x FROM ...)`，只要子查询结果含一个 NULL，整体就返回空。**改用 `NOT EXISTS`**。
:::

::: warning 陷阱 3：聚合函数跳过 NULL
```
数据 (10, NULL, 20)
AVG(x)             → 15.0000   （(10+20)/2）
SUM(x) / COUNT(*)  → 10.0000   （30/3，相当于 NULL 按 0 计）
```
`COUNT(列)`、`SUM`、`AVG`、`MAX`、`MIN` 都跳过 NULL，只有 `COUNT(*)` 统计全部行。NULL 应不参与还是按 0 计，是业务决定。
:::

::: warning 陷阱 4：唯一索引允许多个 NULL
`UNIQUE KEY uk_email(email)` 上插入两行 `email = NULL` 成功，因为 `NULL = NULL` 不是 TRUE。“最多一个为空”无法用唯一索引保证。
:::

::: warning 陷阱 5：升序时 NULL 排最前
MySQL 把 NULL 视为最小值：升序排最前，降序排最后。
:::

::: tip PG 对照
- PostgreSQL 把 NULL 视为最大值，升序时排**最后**，并支持 `NULLS FIRST / NULLS LAST`。MySQL 不支持该语法，要把 NULL 放到最后可写 `ORDER BY email IS NULL, email`。
- MySQL 的 `<=>` 对应 PG 的 `IS NOT DISTINCT FROM`。
:::

### 1.3 NULL 与索引

```
EXPLAIN SELECT id FROM t_null WHERE email IS NULL;
type=ref  key=uk_email  key_len=203  rows=2
```

- `IS NULL` **可以使用索引**。“IS NULL 用不了索引”的说法在 MySQL 中不成立。
- `key_len = 203`：`VARCHAR(50)` 在 utf8mb4 下最多 50 × 4 = 200 字节，加 2 字节长度前缀，再加 1 字节 NULL 标记。

### 1.4 设计建议

| 情况 | 建议 |
| --- | --- |
| “没有值”与“空值”含义相同（如备注） | `NOT NULL DEFAULT ''` |
| “未知”与“空”含义不同（如未填写生日） | 保留 NULL，查询时显式处理 `IS NULL` |
| 数值列 | 不要用 0 冒充“未知”，否则 `AVG` 会被拉低 |

## 二、隐式类型转换

### 2.1 规则

字符串与数字比较时，MySQL 不报错，而是**把两边都转换为浮点数（double）再比较**（官方手册 “Type Conversion in Expression Evaluation”）。

字符串转数字：忽略前导空格，从头读取数字，遇到第一个无法构成数字的字符即停止并丢弃其后内容；一个数字都读不到则为 0。

### 2.2 实验表

```sql
CREATE TABLE t_conv (
  id      INT PRIMARY KEY,
  phone   VARCHAR(20) NOT NULL,          -- '138' + 8 位编号，id=123 → '13800000123'
  user_id INT UNSIGNED NOT NULL,
  KEY idx_phone (phone),
  KEY idx_uid (user_id)
);
-- 20 万行取自 t_order，另插入两条脏数据
INSERT INTO t_conv VALUES (900001, '13800000123abc', 1), (900002, ' 13800000123', 1);
```

### 2.3 后果一：字符串列 = 数字，索引失效

```
EXPLAIN ... WHERE phone = '13800000123';   type=ref  key=idx_phone  rows=1
EXPLAIN ... WHERE phone = 13800000123;     type=ALL  key=NULL       rows=199758
SHOW WARNINGS;
Warning 1739  Cannot use ref access on index 'idx_phone' due to type or collation conversion on field 'phone'
Warning 1739  Cannot use range access on index 'idx_phone' due to type or collation conversion on field 'phone'
```

原因：`idx_phone` 按字符串规则排序，转成数值后顺序不再一致（字符串 `'9'` 排在 `'10'` 之后，数值 9 却小于 10），无法在索引上查找，只能逐行转换比较。等价于 `WHERE CAST(phone AS DOUBLE) = 13800000123`，与“在索引列上套函数”是同一类问题（专题 11、21）。

### 2.4 后果二：多匹配出错误的行

```
WHERE phone = '13800000123'  → 1 行：123
WHERE phone = 13800000123    → 3 行：
  900002  ' 13800000123'      ← 前导空格被忽略
  123     '13800000123'
  900001  '13800000123abc'    ← 从 'a' 起被截断
Warning 1292  Truncated incorrect DOUBLE value: '13800000123abc'

'1abc' = 1                              → 1
'abc'  = 0                              → 1
'9007199254740993' = 9007199254740992   → 1   ← 两个不同的数被判为相等
```

最后一例是精度问题：double 只能精确表示 2⁵³（9007199254740992）以内的整数。超长订单号、雪花 ID 存为字符串又按数字比较，可能匹配到别人的数据。

::: warning 易错：严格模式管不住比较时的转换
`STRICT_TRANS_TABLES`（默认开启）只在**写入**非法值时报错；比较时的转换只产生 Warning 1292，查询照常返回。
:::

### 2.5 反方向：数字列 = 字符串，索引可用

```
EXPLAIN ... WHERE user_id = '123';   type=ref  key=idx_uid  rows=3
```

转换的是常量 `'123'`，只转一次，列本身不变，索引顺序不受影响。

| 列类型 | 传入的值 | 被转换的一方 | 索引 |
| --- | --- | --- | --- |
| VARCHAR | 数字 | 列（每行都转） | 失效 |
| INT | 字符串 | 常量（转一次） | 可用 |

**判断规则：转换落在被查找的列上，索引失效；落在常量上，索引可用。**

### 2.6 与工作的交叉

- **ORM 参数类型**：实体中手机号、订单号为 `Long`，表中为 `VARCHAR`，传参即变成数字比较。
- **JOIN 两边类型不一致**：`BIGINT` 与 `VARCHAR` 关联，VARCHAR 一侧的索引失效。
- **排查**：`EXPLAIN` 后紧跟 `SHOW WARNINGS`，查找 Warning 1739。

::: tip PG 对照
PostgreSQL 类型检查严格，`varchar_col = 13800000123` 直接报错 `operator does not exist: character varying = bigint`，不会静默转换。
:::

## 三、字符集与排序规则

### 3.1 概念

| 概念 | 回答的问题 | 类比 |
| --- | --- | --- |
| 字符集（character set） | 一个字符用哪些字节表示 | 用什么文字书写 |
| 排序规则（collation） | 字符串如何比较大小、哪些视为相等 | 字典按什么顺序排、哪些算同一个词 |

每个字符集有多个排序规则；服务器、库、表、列、连接各自都可以指定。

### 3.2 utf8 不是完整的 UTF-8

UTF-8 编码一个字符需要 1–4 字节：英文 1 字节，常用中文 3 字节，emoji 等 4 字节。MySQL 的 `utf8` 最多支持 3 字节，即 **`utf8mb3`**；完整实现是 **`utf8mb4`**。

沙箱实测：

```
CREATE TABLE t_mb3 (s VARCHAR(20)) CHARACTER SET utf8;
Warning 3719  'utf8' is currently an alias for the character set UTF8MB3, but will be an alias
              for UTF8MB4 in a future release. ...
SHOW CREATE TABLE → DEFAULT CHARSET=utf8mb3

INSERT INTO t_mb3 VALUES ('中文');     → 成功
INSERT INTO t_mb3 VALUES ('笑😀');     → ERROR 1366: Incorrect string value: '\xF0\x9F\x98\x80' for column 's'
SELECT CHAR_LENGTH('笑😀'), LENGTH('笑😀');   → 2 个字符，7 个字节
```

新建表一律使用 `utf8mb4`，不要写含义不明确的 `utf8`。

::: tip 版本差异（官方手册 “Changes in MySQL 8.0”）
| | 5.7 | 8.0 / 8.4 |
| --- | --- | --- |
| `character_set_server` 默认值 | `latin1` | `utf8mb4` |
| `collation_server` 默认值 | `latin1_swedish_ci` | `utf8mb4_0900_ai_ci` |

从 5.7 升级到 8.0 **不改变**已有库表的字符集，只影响新建对象。老系统升级后常出现新旧字符集混用，这是 3.6 节问题的来源。
:::

### 3.3 排序规则命名

以 `utf8mb4_0900_ai_ci` 为例：

| 片段 | 含义 |
| --- | --- |
| `utf8mb4` | 所属字符集 |
| `0900` | 基于 Unicode 排序算法（UCA）9.0.0 |
| `ai` | accent insensitive，不区分重音：`é` 等于 `e` |
| `ci` | case insensitive，不区分大小写：`A` 等于 `a` |

另有 `as`（区分重音）、`cs`（区分大小写）、`bin`（按编码逐字节比较）。

```
'abc' = 'ABC'                              → 1
'é' = 'e'                                  → 1
'abc' = 'ABC' COLLATE utf8mb4_0900_as_cs   → 0
'abc' = BINARY 'ABC'                       → 0
```

### 3.4 排序规则的后果

::: warning 唯一键冲突
```sql
CREATE TABLE t_name (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(20), UNIQUE KEY uk_name(name));
INSERT INTO t_name(name) VALUES ('abc');   -- 成功
INSERT INTO t_name(name) VALUES ('ABC');   -- ERROR 1062: Duplicate entry 'ABC' for key 't_name.uk_name'
INSERT INTO t_name(name) VALUES ('ábc');   -- ERROR 1062: Duplicate entry 'ábc' for key 't_name.uk_name'
```
用户名不区分大小写通常符合预期；但区分大小写的编码（如短链接码 `aB3x` 与 `Ab3X`）必须给该列指定 `_bin` 或 `_as_cs` 排序规则。
:::

::: warning 末尾空格
```
'a' = 'a '                                → 0   （utf8mb4_0900_ai_ci）
'a' = 'a ' COLLATE utf8mb4_general_ci     → 1
```

| 排序规则 | PAD_ATTRIBUTE | 末尾空格 |
| --- | --- | --- |
| `utf8mb4_0900_ai_ci`（8.0 默认） | NO PAD | 参与比较 |
| `utf8mb4_0900_bin` | NO PAD | 参与比较 |
| `utf8mb4_general_ci` | PAD SPACE | 忽略 |
| `utf8mb4_bin` | PAD SPACE | 忽略 |

从 `utf8mb4_general_ci` 迁移到 `utf8mb4_0900_ai_ci` 后原本能查到的数据查不到，常见原因就是这一差异。
:::

::: tip PG 对照
PostgreSQL 默认排序规则区分大小写，`WHERE name = 'abc'` 不匹配 `'ABC'`；MySQL 默认不区分。迁移时唯一约束和等值查询的行为都会变化。
:::

### 3.5 连接字符集与乱码

| 变量 | 含义 |
| --- | --- |
| `character_set_client` | 客户端发送的 SQL 使用什么编码 |
| `character_set_connection` | 服务端把收到的语句转换成什么编码处理 |
| `character_set_results` | 服务端把结果转换成什么编码返回 |

`SET NAMES utf8mb4` 同时设置这三个变量；连接驱动的字符编码参数本质上也是设置它们。

客户端未显式指定时，会先按操作系统设置（Unix 上的 `LANG` / `LC_ALL`）自动检测；检测不到才使用编译时默认值（通常为 utf8mb4）。沙箱容器的 `LANG` 为空，命令行客户端协商出的三个变量均为 `latin1`。

用 utf8mb4 与 latin1 两种连接，分别向同一张 utf8mb4 表写入 `'中文'`，沙箱实测：

```
utf8mb4 连接读取：
id  s            HEX(s)                         CHAR_LENGTH(s)
1   中文         E4B8ADE69687                   2     ← 正确
2   ä¸­æ–‡       C3A4C2B8C2ADC3A6E28093E280A1   6     ← 乱码

latin1 连接读取：
1   ??           E4B8ADE69687                   2
2   中文         C3A4C2B8C2ADC3A6E28093E280A1   6     ← 显示“正常”
```

第 2 行的形成过程（双重编码）：

```
客户端发送 '中文' 的 UTF-8 字节：E4 B8 AD E6 96 87
   ↓ 服务端按 latin1 理解，当成 6 个西文字符：ä ¸ ­ æ – ‡
   ↓ 再转换成 utf8mb4 存入
存储：6 个字符、14 个字节
```

MySQL 的 `latin1` 实际对应 Windows-1252 编码，所以字节 `96` 被解释为破折号 `–`。

::: warning 最危险之处
用同样的错误连接读回时，服务端反向转换一次，屏幕显示正确。写入方自测一切正常，问题要到其他系统用正确字符集读取时才暴露。排查不要相信屏幕显示，用 `HEX()` 与 `CHAR_LENGTH()` 看真实存储：一个常用中文字符应为 1 个字符、3 个字节。
:::

### 3.6 字符集不一致的 JOIN

两张结构相同的表，`t_u4` 为 utf8mb4、`t_u3` 为 utf8mb3，各 2 万行，`code` 列均有索引。沙箱实测：

```
EXPLAIN SELECT * FROM t_u4 a JOIN t_u3 b ON a.code = b.code WHERE a.id = 5;
a: type=const  key=PRIMARY  rows=1
b: type=index  key=code     rows=19084   Extra=Using where; Using index   ← 扫描 b 的整个索引

EXPLAIN SELECT * FROM t_u3 b JOIN t_u4 a ON a.code = b.code WHERE b.id = 5;
b: type=const  key=PRIMARY  rows=1
a: type=ref    key=code     rows=1                                       ← 正常查找
```

utf8mb3 是 utf8mb4 的子集，比较时 MySQL 把 utf8mb3 一侧转换为 utf8mb4：

- 第一条要在 b（utf8mb3）上查找，转换落在 **b 的列**上，索引失效；
- 第二条要在 a（utf8mb4）上查找，转换落在从 b 取到的**常量**上，索引可用。

与 2.5 节的规则一致。EXPLAIN 只显示“没走索引”而找不到原因时，用 `SHOW CREATE TABLE` 核对两边列的字符集与排序规则。

## 四、在三条主线中的位置

```
A 性能：SQL → [优化器能否使用索引] → 执行计划 → 索引 …
              隐式类型转换、字符集不一致都会让列一侧发生转换，导致索引不可用
C 诊断：结果不对或突然变慢时的检查点（见第五节）
B 一致性：不涉及
```

## 五、排查清单

| 症状 | 检查 | 工具 |
| --- | --- | --- |
| 查询结果少了 | WHERE 中的 `<>`、`NOT IN` 是否遗漏 NULL | 改写为 `OR col IS NULL`、`NOT EXISTS` 对比结果 |
| 结果多了 / 索引失效 | 是否存在类型或排序规则转换 | `EXPLAIN` + `SHOW WARNINGS`（Warning 1739、1292） |
| JOIN 不走索引 | 两边列的类型、字符集、排序规则是否一致 | `SHOW CREATE TABLE` |
| 乱码 | 连接字符集是否正确，数据是否已被双重编码 | `SHOW VARIABLES LIKE 'character_set%'`、`HEX()`、`CHAR_LENGTH()` |
| 唯一键意外冲突、等值查询多匹配 | 列的排序规则是否不区分大小写或重音 | `SHOW CREATE TABLE`、`information_schema.COLLATIONS` |

## 六、本地复现脚本

在专题 1 的 Docker 环境（`mysql:8.4`）中，用命令行客户端并加 `--default-character-set=utf8mb4` 执行。

```sql
USE lab;

-- 1. NULL
SELECT NULL = NULL, NULL <> NULL, NULL IS NULL, NULL <=> NULL, 1 = NULL;
SELECT COUNT(*), COUNT(remark), SUM(remark IS NULL) FROM t_order;
SELECT COUNT(*) FROM t_order WHERE remark <> 'remark-1';
SELECT COUNT(*) FROM t_order WHERE remark <> 'remark-1' OR remark IS NULL;
SELECT COUNT(*) FROM t_order WHERE id NOT IN (1, 2, NULL);
SELECT AVG(x), SUM(x) / COUNT(*) FROM (SELECT 10 x UNION ALL SELECT NULL UNION ALL SELECT 20) t;
CREATE TABLE t_null (id INT PRIMARY KEY, email VARCHAR(50), UNIQUE KEY uk_email(email));
INSERT INTO t_null VALUES (1,'a@x'), (2,NULL), (3,NULL), (4,'b@x');
SELECT * FROM t_null ORDER BY email;
EXPLAIN SELECT id FROM t_null WHERE email IS NULL;

-- 2. 隐式类型转换
CREATE TABLE t_conv (id INT PRIMARY KEY, phone VARCHAR(20) NOT NULL, user_id INT UNSIGNED NOT NULL,
                     KEY idx_phone(phone), KEY idx_uid(user_id));
INSERT INTO t_conv SELECT id, CONCAT('138', LPAD(id, 8, '0')), user_id FROM t_order WHERE id <= 200000;
INSERT INTO t_conv VALUES (900001, '13800000123abc', 1), (900002, ' 13800000123', 1);
ANALYZE TABLE t_conv;
EXPLAIN SELECT * FROM t_conv WHERE phone = '13800000123';
EXPLAIN SELECT * FROM t_conv WHERE phone = 13800000123;  SHOW WARNINGS;
EXPLAIN SELECT * FROM t_conv WHERE user_id = '123';
SELECT id, phone FROM t_conv WHERE phone = 13800000123;   SHOW WARNINGS;
SELECT '1abc' = 1, 'abc' = 0, '9007199254740993' = 9007199254740992;

-- 3. 排序规则
SELECT 'abc' = 'ABC', 'é' = 'e', 'a' = 'a ', 'a' = 'a ' COLLATE utf8mb4_general_ci;
CREATE TABLE t_name (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(20), UNIQUE KEY uk_name(name));
INSERT INTO t_name(name) VALUES ('abc');
INSERT INTO t_name(name) VALUES ('ABC');     -- 预期 ERROR 1062

-- 4. utf8mb3 与 emoji
CREATE TABLE t_mb3 (s VARCHAR(20)) CHARACTER SET utf8mb3;
INSERT INTO t_mb3 VALUES ('笑😀');           -- 预期 ERROR 1366

-- 5. 字符集不一致的 JOIN
CREATE TABLE t_u4 (id INT PRIMARY KEY, code VARCHAR(20), KEY(code)) CHARACTER SET utf8mb4;
CREATE TABLE t_u3 (id INT PRIMARY KEY, code VARCHAR(20), KEY(code)) CHARACTER SET utf8mb3;
INSERT INTO t_u4 SELECT id, order_no FROM t_order WHERE id <= 20000;
INSERT INTO t_u3 SELECT id, order_no FROM t_order WHERE id <= 20000;
ANALYZE TABLE t_u4, t_u3;
EXPLAIN SELECT * FROM t_u4 a JOIN t_u3 b ON a.code = b.code WHERE a.id = 5;
EXPLAIN SELECT * FROM t_u3 b JOIN t_u4 a ON a.code = b.code WHERE b.id = 5;
```

乱码实验（宿主机执行，两次连接指定不同字符集）：

```bash
docker exec -i mysql84 mysql -uroot -p --default-character-set=utf8mb4 lab \
  -e "CREATE TABLE t_enc (id INT PRIMARY KEY, s VARCHAR(20)) CHARACTER SET utf8mb4; INSERT INTO t_enc VALUES (1,'中文');"
docker exec -i mysql84 mysql -uroot -p --default-character-set=latin1 lab -e "INSERT INTO t_enc VALUES (2,'中文');"
docker exec -i mysql84 mysql -uroot -p --default-character-set=utf8mb4 lab -e "SELECT id, s, HEX(s), CHAR_LENGTH(s) FROM t_enc;"
docker exec -i mysql84 mysql -uroot -p --default-character-set=latin1  lab -e "SELECT id, s, HEX(s), CHAR_LENGTH(s) FROM t_enc;"
```

**预期现象**：NULL 相关结果规律与上文一致（具体行数随随机数据变化）；字符串列与数字比较时 `type=ALL` 并出现 Warning 1739；`'ABC'` 插入报 1062；emoji 写入 utf8mb3 列报 1366；第一条 JOIN 中 b 为 `type=index`，第二条中 a 为 `type=ref`；乱码行 `CHAR_LENGTH` 为 6。

## 七、与其他专题的关联

- **专题 1**：`key_len` 中可空列多 1 字节，在 1.3 节得到实例。
- **专题 11、21**：在索引列上做函数运算导致索引失效，与隐式转换同属一类。
- **专题 13**：NULL 在统计信息与基数估算中的处理。
- **专题 20**：`NOT IN` 与 `NOT EXISTS`、子查询改写。
- **专题 34**：数据类型选择——手机号、订单号该用什么类型，列是否允许 NULL。

## 八、复习 checklist

- [ ] 能用三值逻辑推导 `NOT IN (1, 2, NULL)` 为什么返回空
- [ ] 知道 `<>` 会漏掉 NULL 行，以及 `COUNT(列)`、`AVG` 跳过 NULL
- [ ] 知道唯一索引允许多个 NULL，`IS NULL` 可以使用索引
- [ ] 知道 MySQL 与 PG 在 NULL 排序位置上的差异
- [ ] 能说出字符串与数字比较时的转换规则，以及由此导致的多匹配和精度问题
- [ ] 能用“转换落在列上还是常量上”判断索引是否可用
- [ ] 能区分字符集与排序规则，解释 utf8mb3 与 utf8mb4 的差异
- [ ] 能读懂 `utf8mb4_0900_ai_ci` 的各部分含义，知道 NO PAD 与 PAD SPACE 的区别
- [ ] 能解释双重编码乱码的形成过程，并用 `HEX()`、`CHAR_LENGTH()` 排查
- [ ] 能解释字符集不一致的 JOIN 为什么只有一个方向不走索引
