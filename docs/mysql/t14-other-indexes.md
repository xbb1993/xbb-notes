# 专题 14 · 其他索引与 8.0 新增索引特性

> 级别 ○（了解即可）· 主线 A · 实测版本：沙箱 MySQL 8.0.46

本专题补上前几个专题留下的“专题 14 再讲”：

| 特性 | 解决什么问题 | 回扣 |
| --- | --- | --- |
| 降序索引 | 方向混合的排序必须 filesort | 专题 11 |
| 函数索引 | 对列套函数后用不上索引 | 专题 12 |
| 不可见索引 | 删除索引前想先试一试 | 专题 12 |
| 多值索引 | 查询 JSON 数组中的元素 | — |
| 自适应哈希索引 | InnoDB 自动为热点数据加速 | 专题 9 |
| 全文索引、空间索引 | 文本检索、地理位置查询 | — |

## 一、降序索引

### 1.1 问题与实验

索引 `(user_id, status, created_at)` 上，`ORDER BY status DESC, created_at ASC` 只能 filesort：两列都正序，反向读时一起变倒序，凑不出“一倒一正”（专题 11）。

```sql
SELECT id, status, created_at FROM t_case WHERE user_id = 777
ORDER BY status DESC, created_at ASC LIMIT 20;
```

```
索引                                   Extra                         检查行数   排序行数   耗时
(user_id, status, created_at)          Using index; Using filesort      50033        20    14.62 ms
(user_id, status DESC, created_at)     Using where; Using index            20         0     0.41 ms
```

`information_schema.STATISTICS` 的 `COLLATION` 列：普通列为 `A`（升序），降序列为 `D`。

### 1.2 要点

- **5.7 差异**：5.7 接受 `DESC` 语法但忽略它；8.0 手册称 `DESC` “不再被忽略”，按降序存储键值。从 5.7 升级来的表，原先写了 `DESC` 的索引其实一直是正序。
- **只有方向混合时才需要**：全部倒序时正序索引反向读即可（`Backward index scan`）。
- 限制（手册）：仅 InnoDB；含降序列的二级索引不能使用 change buffer；不能用于不带 GROUP BY 的 `MIN()`/`MAX()` 优化。

## 二、函数索引

### 2.1 问题与实验

`WHERE DATE(created_at) = '2026-10-01'` 用不上 `created_at` 的索引（专题 12）。最好的办法是改写成范围；改不了 SQL 时（第三方系统、报表工具生成），可用**函数索引**对表达式结果建索引。

```sql
ALTER TABLE t_case ADD INDEX idx_cdate ((DATE(created_at)));   -- 两层括号
```

```
条件                                                   type    key         rows
DATE(created_at) = '2026-10-01'                        ref     idx_cdate   2832
CAST(created_at AS DATE) = '2026-10-01'                ref     idx_cdate   2832   ← 等价写法也能用
DATE(created_at) BETWEEN '2026-10-01' AND '2026-10-03' range   idx_cdate   8672
DATE_FORMAT(created_at, '%Y-%m-%d') = '2026-10-01'     index   idx_u_s_c   …     ← 换了函数，用不上
DATE(created_at) = 20261001                            index   idx_u_s_c   …     ← 常量是整数，用不上
```

`SHOW CREATE TABLE` 显示表达式被改写为 ``KEY `idx_cdate` ((cast(`created_at` as date)))``，所以 `CAST(created_at AS DATE)` 也能匹配。

### 2.2 要点

- **实现**（手册）：在**隐藏的虚拟生成列**上建普通索引；该列不出现在 `SELECT *` 中、不占数据存储，但计入表的列数上限。
- **表达式必须匹配**：换成 `DATE_FORMAT`，或常量写成整数 `20261001`（引入类型转换，专题 5）都用不上。
- **能改写 SQL 时优先改写**：`created_at >= … AND created_at < …` 只需普通索引，还能服务其他按时间的查询；函数索引只服务这一个表达式。
- 限制（手册）：不能用于主键、外键；不能是单纯列名；不能用前缀长度。

::: tip PG 对照
PostgreSQL 早有表达式索引（`CREATE INDEX ON t ((date(created_at)))`），用法基本相同。
:::

## 三、不可见索引

### 3.1 实验

删大表索引很快，删错后重建可能要几个小时，所以专题 12 的删除流程要求“先设为不可见、观察一个业务周期”。

```sql
ALTER TABLE t_case ALTER INDEX idx_u_s_c INVISIBLE;
```

```
SELECT id FROM t_case WHERE user_id = 777 AND status = 1;
  → key=idx_user，rows=97774                     ← 优化器不再使用 idx_u_s_c

同一查询加 /*+ SET_VAR(optimizer_switch = 'use_invisible_indexes=on') */
  → key=idx_u_s_c，rows=18148，Using index        ← 本条语句临时允许使用

SELECT … FROM t_case FORCE INDEX (idx_u_s_c) …
  → ERROR 1176: Key 'idx_u_s_c' doesn't exist in table 't_case'

ALTER TABLE t_case ALTER INDEX `PRIMARY` INVISIBLE;
  → ERROR 3522: A primary key index cannot be invisible
```

### 3.2 要点（手册）

| 特点 | 说明 |
| --- | --- |
| 切换很快 | 原地修改元数据，不重建索引 |
| 仍被维护 | 写入时照常更新；**唯一索引设为不可见后仍阻止重复值** |
| 主键不能不可见 | 包括充当隐式主键的非空唯一索引（专题 10） |
| 可单条语句临时启用 | `optimizer_switch` 的 `use_invisible_indexes`，可通过 `SET_VAR` 只对一条语句生效 |
| 引用它的索引提示会报错 | 可借此发现仍依赖该索引的代码 |

::: warning 易混淆
| 错误理解 | 正确理解 |
| --- | --- |
| 设为不可见就不占资源了 | 仍在维护，写入代价与空间都在；只是“试删”的手段 |
| 不可见的唯一索引不再约束唯一性 | 仍然约束 |
:::

## 四、多值索引

为 JSON 数组中的**每个元素**各建一条索引记录。实测：20 万个商品，`attrs.tags` 为含 3 个数字的数组：

```sql
ALTER TABLE t_prod ADD INDEX idx_tags ((CAST(attrs->'$.tags' AS UNSIGNED ARRAY)));
```

```
查询                                                     无索引                       有多值索引
42 MEMBER OF (attrs->'$.tags')                           ALL，检查 200000 行，147 ms   ref，检查 609 行，2.9 ms
JSON_OVERLAPS(attrs->'$.tags', CAST('[42,43]' AS JSON))  —                            range，检查 1180 行，6.2 ms
JSON_CONTAINS(attrs->'$.tags', CAST('[42]' AS JSON))     —                            range，检查 609 行，4.2 ms
```

- 只有这三个函数能用上（手册）。
- 限制（手册）：不能范围扫描（如“标签大于 100”）、不能覆盖、不能做主键；一个索引只能有一个多值部分；**不支持在线创建，以复制表方式重建**。
- 适合标签、权限列表等“一行多值”场景；若为核心业务，规范化为关联表通常更易查询与维护。

## 五、自适应哈希索引

**是什么**（手册）：InnoDB 观察索引查找模式，发现某些页被反复按相同键前缀查找时，自动在内存中为它们建哈希索引，之后同样的等值查找可直接通过哈希定位记录，跳过从根到叶的逐层查找。只存在于内存，不能手动创建。

**实测**（8.0 默认开启）：对 2000 个主键反复点查 20 万次：

```
INNODB_METRICS：
adaptive_hash_searches         199727    ← 通过哈希索引直接找到
adaptive_hash_searches_btree      468    ← 仍走 B+ 树逐层查找

SHOW ENGINE INNODB STATUS：
199527.47 hash searches/s, 467.53 non-hash searches/s
```

**8.0 默认 ON、8.4 默认 OFF**（专题 3 已核对）。手册给出的关闭理由：

- 高并发负载（如多个并发 join）下访问哈希索引会产生**锁争用**；
- 有些负载下监控与维护开销超过收益；
- 以 `%` 开头的 `LIKE` 本来就得不到好处；
- 难以事先判断是否有益，建议开、关各做一次基准测试。

**判断是否成为瓶颈**：`SHOW ENGINE INNODB STATUS` 的 SEMAPHORES 部分若有大量线程等待 `btr0sea` 相关的锁，可增加 `innodb_adaptive_hash_index_parts`（默认 8 个分区，每区一把锁）或关闭。

## 六、全文索引与空间索引

**全文索引**（FULLTEXT）：解决 `LIKE '%关键词%'` 不能用索引的问题，原理是**倒排索引**（记录每个词出现在哪些行）。

- 用 `MATCH (col) AGAINST ('词')` 查询，有自然语言模式与布尔模式（`+必须 -排除`）；
- 中文无空格分词，建索引时指定 `WITH PARSER ngram`，按固定长度切词（`ngram_token_size`，实测默认 2）；
- 局限：相关性排序简单；不支持同义词、拼音、纠错；过短的词与停用词被忽略；大量写入时维护有开销；
- **工作中**：站内搜索、商品搜索等真正的检索需求一般交给 Elasticsearch 等专门系统，MySQL 通过同步推送数据；MySQL 全文索引适合数据量小、要求简单的场景。

**空间索引**（SPATIAL）：用于几何类型列（点、线、多边形），底层是 **R 树**（按矩形区域分层组织），支持 `ST_Contains`、`ST_Distance_Sphere` 等函数，用于“附近的门店”类查询。

**InnoDB 不支持哈希索引**：实测 `KEY ka (a) USING HASH` 产生 Note 3502（该存储引擎不支持 HASH 索引算法，已使用默认算法），实际建出 B 树索引。哈希索引只在 MEMORY 引擎中可用。

## 七、在三条主线中的位置

```
A 性能：… → [索引：B+ 树的变体与补充结构] → 页
         降序、函数、多值索引扩展了“哪些查询能用上索引”；自适应哈希在内存中省掉逐层查找
B 一致性：不涉及
C 诊断：见第八节
```

## 八、排查要点

| 现象 | 考虑 |
| --- | --- |
| 方向混合的排序出现 filesort | 降序索引 |
| 对列套函数且无法改写 SQL | 函数索引（表达式与常量类型须匹配） |
| 准备删除索引 | 先设为不可见，观察一个业务周期 |
| SEMAPHORES 中大量等待 `btr0sea` | 自适应哈希索引锁争用：增加分区或关闭 |
| JSON 数组元素查询全表扫描 | 多值索引，或规范化为关联表 |

## 九、本地复现脚本

需专题 12 的 `t_case`，在专题 1 的 Docker 环境（`mysql:8.4`）中执行。

```sql
USE lab;
ALTER TABLE t_case ADD INDEX idx_u_s_c (user_id, status, created_at);   -- 若已存在可跳过

-- 1. 降序索引
EXPLAIN SELECT id, status, created_at FROM t_case WHERE user_id = 777 ORDER BY status DESC, created_at ASC LIMIT 20;
ALTER TABLE t_case ADD INDEX idx_u_sd_c (user_id, status DESC, created_at);
EXPLAIN SELECT id, status, created_at FROM t_case WHERE user_id = 777 ORDER BY status DESC, created_at ASC LIMIT 20;
SELECT INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME, COLLATION FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = 'lab' AND TABLE_NAME = 't_case' AND INDEX_NAME LIKE 'idx_u_%' ORDER BY 1, 2;

-- 2. 函数索引
ALTER TABLE t_case ADD INDEX idx_cdate ((DATE(created_at)));
EXPLAIN SELECT id FROM t_case WHERE DATE(created_at) = '2026-10-01';
EXPLAIN SELECT id FROM t_case WHERE DATE_FORMAT(created_at, '%Y-%m-%d') = '2026-10-01';
EXPLAIN SELECT id FROM t_case WHERE DATE(created_at) = 20261001;

-- 3. 不可见索引
ALTER TABLE t_case ALTER INDEX idx_u_s_c INVISIBLE;
EXPLAIN SELECT id FROM t_case WHERE user_id = 777 AND status = 1;
EXPLAIN SELECT /*+ SET_VAR(optimizer_switch = 'use_invisible_indexes=on') */ id FROM t_case WHERE user_id = 777 AND status = 1;
ALTER TABLE t_case ALTER INDEX `PRIMARY` INVISIBLE;     -- 预期 ERROR 3522
ALTER TABLE t_case ALTER INDEX idx_u_s_c VISIBLE;

-- 4. 多值索引
CREATE TABLE t_prod (id INT PRIMARY KEY, name VARCHAR(30), attrs JSON);
SET SESSION cte_max_recursion_depth = 200000;
INSERT INTO t_prod WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 200000)
SELECT n, CONCAT('p', n), JSON_OBJECT('tags', JSON_ARRAY(FLOOR(RAND()*1000), FLOOR(RAND()*1000), FLOOR(RAND()*1000))) FROM s;
EXPLAIN SELECT COUNT(*) FROM t_prod WHERE 42 MEMBER OF (attrs->'$.tags');
ALTER TABLE t_prod ADD INDEX idx_tags ((CAST(attrs->'$.tags' AS UNSIGNED ARRAY)));
EXPLAIN SELECT COUNT(*) FROM t_prod WHERE 42 MEMBER OF (attrs->'$.tags');

-- 5. 自适应哈希索引（8.4 默认关闭，先打开）
SET GLOBAL innodb_adaptive_hash_index = ON;
SET GLOBAL innodb_monitor_enable = 'adaptive_hash_searches%';
-- 对少量主键反复点查若干万次后：
SELECT NAME, COUNT FROM information_schema.INNODB_METRICS
WHERE NAME IN ('adaptive_hash_searches', 'adaptive_hash_searches_btree');
```

**预期现象**：降序索引后 filesort 消失、`COLLATION` 出现 `D`；函数索引对 `DATE(…)` 生效、对 `DATE_FORMAT` 与整数常量不生效；不可见索引不再被选，加 `SET_VAR` 后又可用；多值索引让 `MEMBER OF` 从全表扫描变为 ref；开启自适应哈希后，热点点查的哈希查找远多于 B 树查找。

## 十、与其他专题的关联

- **专题 3**：8.0 / 8.4 默认值差异（自适应哈希）。
- **专题 5**：类型转换导致函数索引不匹配。
- **专题 9**：自适应哈希省去逐层查找；实验中曾关闭以单独测 B+ 树。
- **专题 11、12**：方向混合排序、函数导致索引失效、安全删除索引流程。
- **专题 17**：`SET_VAR` 与其他优化器提示。

## 十一、复习 checklist

- [ ] 知道降序索引解决的问题，以及 5.7 忽略 `DESC` 的历史差异
- [ ] 知道函数索引基于隐藏虚拟列实现，表达式与常量类型须匹配，能改写时优先改写
- [ ] 能说明不可见索引的用途与特点（仍维护、唯一约束仍生效、主键不能不可见）
- [ ] 知道多值索引可用的三个函数与主要限制
- [ ] 能解释自适应哈希索引的作用、8.4 改为默认关闭的理由与观察方法
- [ ] 知道全文、空间索引的适用场景，以及 InnoDB 不支持 HASH 索引
