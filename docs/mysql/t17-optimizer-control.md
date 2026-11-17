# 专题 17 · 优化器控制：索引提示、Optimizer Hint、optimizer_switch 与局限性

> 级别 ☆（按学习者要求简述）· 主线 A / C · 实测版本：沙箱 MySQL 8.0.46

本专题回答：优化器选错计划时（专题 13、16 讲了它为什么会错），有哪些手段可以干预？每种手段的作用范围和风险是什么？

类比：优化器是导航软件。**提示（hint）** 是你对司机说“这一趟走高架”，只影响这一趟；**optimizer_switch** 是改导航软件的设置，影响之后所有路线；**改统计信息 / 索引** 是修地图，从根上让导航算对。

## 一、手段总览

| 手段 | 作用范围 | 写错时的表现 | 典型用途 |
| --- | --- | --- | --- |
| 索引提示 `USE / FORCE / IGNORE INDEX` | 一条语句中的一张表 | 索引名写错 **报错** ERROR 1176 | 指定或排除某个索引 |
| Optimizer Hint `/*+ ... */` | 一条语句（可细到查询块、表、索引） | 写错 **只给警告** 3128，提示被忽略 | 索引、join 顺序、算法开关、语句超时、语句级变量 |
| `STRAIGHT_JOIN` | 一条语句 | — | 按 FROM 中书写顺序关联 |
| `optimizer_switch` 系统变量 | 会话或全局 | — | 打开 / 关闭某项优化策略 |
| Query Rewriter 插件 | 全局，按语句模式匹配 | — | 改不了应用代码时，在服务端改写 SQL |

优先级（推荐顺序）：**修统计信息 / 索引 / 改写 SQL > 单条语句加提示 > 会话级开关 > 全局开关**。越靠后，影响面越大、越难回收。

## 二、索引提示

```sql
SELECT ... FROM t USE INDEX (idx_a)    ...   -- 只在列出的索引中选（还可以选全表扫描）
SELECT ... FROM t FORCE INDEX (idx_a)  ...   -- 只要能用该索引，就不选全表扫描
SELECT ... FROM t IGNORE INDEX (idx_a) ...   -- 不考虑该索引
```

::: warning 易混淆：USE INDEX ≠ 必须用这个索引
`USE INDEX` 只是缩小候选范围，**全表扫描仍是候选**。要排除全表扫描，必须用 `FORCE INDEX`。
:::

实测（同一条范围查询，命中比例处于交叉点附近）：

| 写法 | EXPLAIN type | 耗时 |
| --- | --- | --- |
| `USE INDEX (idx_user)` | ALL（优化器仍判定全表扫描更便宜） | 140.4 ms |
| `FORCE INDEX (idx_user)` | range | 296.8 ms |

这个例子同时说明：**强制走索引不一定更快**。命中比例超过交叉点后，回表的随机读比全表扫描更慢（专题 10）。

另一个副作用（专题 13 实测）：`FORCE INDEX` 会让优化器跳过 index dive（对每个 IN 值逐个下潜估算行数），行数改用统计信息估计。

## 三、Optimizer Hint

写在 `SELECT / UPDATE / DELETE / INSERT` 关键字之后的特殊注释 `/*+ ... */` 中。

### 3.1 常用提示

| 类别 | 提示 | 作用 |
| --- | --- | --- |
| 索引 | `INDEX(t idx)` / `NO_INDEX(t idx)` | 与 FORCE / IGNORE INDEX 类似，但可写在子查询内部、指定查询块 |
| join 顺序 | `JOIN_ORDER(a, b)`、`JOIN_PREFIX`、`JOIN_SUFFIX`、`JOIN_FIXED_ORDER` | 固定全部或部分关联顺序 |
| 算法开关 | `BKA / NO_BKA`、`MRR / NO_MRR`、`NO_ICP`、`SKIP_SCAN / NO_SKIP_SCAN`、`HASH_JOIN / NO_HASH_JOIN` 等 | 对单条语句开关某项优化，等价于局部的 optimizer_switch |
| 超时 | `MAX_EXECUTION_TIME(N)` | 语句执行超过 N 毫秒即中止 |
| 变量 | `SET_VAR(var = value)` | 只在这条语句执行期间修改一个会话变量 |

### 3.2 实测

| 场景 | 改动 | 耗时 |
| --- | --- | --- |
| 两表 join，优化器选了大表驱动 | 加 `/*+ JOIN_ORDER(o, u) */` | 945 ms → 205 ms |
| 同上 | 改用 `STRAIGHT_JOIN` 按书写顺序关联 | 220.8 ms |
| 延迟关联中的子查询未用上覆盖索引（专题 12） | 子查询内加 `INDEX` 提示 / 对干扰索引加 `NO_INDEX` | 84.3 ms → 12.1 ms / 11.9 ms |

`JOIN_ORDER` 与 `STRAIGHT_JOIN` 效果相近；区别在于 `JOIN_ORDER` 写在提示里，不改变 SQL 的 FROM 写法，且可以只固定部分表。

### 3.3 写错的后果（最重要的坑）

```sql
SELECT /*+ INDX(t_order idx_user) */ ...      -- 拼错提示名
-- 语句照常执行，提示被忽略，只产生 Warning 3128（需 SHOW WARNINGS 才看得到）

SELECT ... FROM t_order FORCE INDEX (idx_usr) ...   -- 拼错索引名
-- ERROR 1176：Key 'idx_usr' doesn't exist in table 't_order'
```

::: danger 错误理解 vs 正确理解
- ❌ 加了 Optimizer Hint 并且语句没报错，说明提示生效了。
- ✅ Optimizer Hint 写错只给警告。上线前必须用 `EXPLAIN` + `SHOW WARNINGS` 确认计划确实变了。

反过来，索引提示的风险在于**以后删掉或改名索引，带提示的语句会直接报错**。所以索引名一旦被提示引用，就成了应用代码的依赖。
:::

### 3.4 MAX_EXECUTION_TIME

```sql
SELECT /*+ MAX_EXECUTION_TIME(100) */ SUM(amount) FROM t_order WHERE amount > 1;
-- ERROR 3024 (HY000): Query execution was interrupted, maximum statement execution time exceeded
```

- 只对只读 `SELECT` 生效。
- 对应的系统变量 `max_execution_time`（毫秒）默认 0，表示不限制；可设为全局或会话级兜底，单条语句用提示覆盖。
- 用途：报表 / 搜索类接口防止一条慢查询长时间占用连接。

### 3.5 SET_VAR

```sql
SELECT /*+ SET_VAR(sort_buffer_size = 16777216) */ ... ORDER BY ...;
SELECT /*+ SET_VAR(optimizer_switch = 'index_merge=off') */ ...;
```

只在这条语句执行期间修改会话变量，执行完自动恢复，避免“设了忘记改回”污染连接池中被复用的连接。仅对允许用 SET_VAR 修改的变量有效（手册中标注 “SET_VAR Hint Applies: Yes” 的变量）。

## 四、optimizer_switch

```sql
SELECT @@optimizer_switch\G      -- 一串 名称=on/off，如 index_merge=on, mrr=on, skip_scan=on, hash_join=on ...
SET SESSION optimizer_switch = 'index_merge_intersection=off';
```

- 粒度是“整个会话 / 整个实例的所有语句”，比提示粗得多。
- 常见用法：排查时会话级关闭某项策略，比较前后计划，确认是否是该策略导致问题；确认后再决定用单条语句的提示修复。
- 全局修改仅用于已确认某项策略在该业务上普遍有害（例如升级后某策略引发大面积回退）的情况，并要写入配置、记录原因。

## 五、Query Rewriter 插件（了解）

场景：问题 SQL 来自第三方程序或无法快速发版的应用，改不了代码。

- 在 `query_rewrite.rewrite_rules` 表中登记“匹配模式 → 替换语句”，例如给某条 SQL 自动加上提示。
- 局限：按语句模式精确匹配；规则多了难以管理；属于应急手段，应用侧修复后应删除规则。

## 六、提示的长期风险

| 风险 | 说明 |
| --- | --- |
| 数据分布变化 | 提示固定的是“今天最优”的计划，数据量或分布变化后可能变成最差 |
| 版本升级 | 新版本的优化器可能已能选对，提示反而阻止它选更好的计划 |
| 索引变更 | 索引提示引用的索引被删除或改名时语句报错；Optimizer Hint 则静默失效 |
| 可维护性 | 提示散落在应用代码中，难以统一盘点 |

建议：每个提示在代码旁注明原因、日期与验证方式；数据量级变化或升级大版本后重新评估。

## 七、在三条主线中的位置

```
A 性能：SQL → [优化器 ← 人为干预：提示 / 开关 / 改写] → 执行计划 → …
B 一致性：不涉及
C 诊断：EXPLAIN 发现计划不对 → 归因（专题 13 / 16）→ 选择干预手段（本专题）→ EXPLAIN + 实测验证
```

## 八、排查要点

| 现象 | 先查什么 | 可能原因 / 对策 |
| --- | --- | --- |
| 加了提示，计划没变 | `EXPLAIN` 后 `SHOW WARNINGS` | 提示拼错或位置不对（Warning 3128），提示被忽略 |
| 加了 `USE INDEX` 仍是全表扫描 | EXPLAIN type | `USE INDEX` 不排除全表扫描，需要 `FORCE INDEX` |
| 强制走索引后反而更慢 | rows、命中比例 | 命中比例已超过交叉点，回表随机读更贵；应考虑覆盖索引 |
| 删除索引后某接口报错 1176 | 应用中引用该索引名的提示 | 索引提示成为代码依赖，删索引前先搜代码 |
| 升级后某条带提示的 SQL 变慢 | 去掉提示对比计划与耗时 | 新优化器已能选对，提示阻止了更好的计划 |
| 想确认是否某项优化策略引起问题 | 会话级 `optimizer_switch` 关闭该项再 EXPLAIN | 确认后用单条语句的提示修复，避免改全局 |

::: tip PG 对照
PostgreSQL 核心不提供提示语法（社区的立场是应修正统计信息与成本参数），需要时使用扩展 pg_hint_plan；会话级的开关是 `enable_seqscan`、`enable_nestloop` 等参数，作用类似 optimizer_switch。语句超时用 `statement_timeout`（对所有语句类型生效），而 MySQL 的 `max_execution_time` 只管 SELECT。
:::

## 九、本地复现

```sql
USE lab;
-- 1. USE vs FORCE（X 取交叉点附近的值，参考专题 16）
EXPLAIN SELECT SUM(amount) FROM t_order USE INDEX (idx_user)   WHERE user_id <= 10000;
EXPLAIN SELECT SUM(amount) FROM t_order FORCE INDEX (idx_user) WHERE user_id <= 10000;

-- 2. 提示拼错只有警告；索引名拼错报错
EXPLAIN SELECT /*+ INDX(t_order idx_user) */ COUNT(*) FROM t_order WHERE user_id = 5;
SHOW WARNINGS;
SELECT COUNT(*) FROM t_order FORCE INDEX (idx_usr) WHERE user_id = 5;

-- 3. 语句超时
SELECT /*+ MAX_EXECUTION_TIME(100) */ SUM(amount) FROM t_order WHERE amount > 1;

-- 4. join 顺序
EXPLAIN SELECT /*+ JOIN_ORDER(o, u) */ COUNT(*)
FROM t_user u JOIN t_order o ON o.user_id = u.id
WHERE o.amount > 900 AND u.city = 'Beijing';
```

**预期现象**：1 中 USE INDEX 可能仍为 ALL、FORCE INDEX 为 range；2 中前者正常执行并有 Warning 3128，后者 ERROR 1176；3 中 ERROR 3024（若机器很快没超时，把阈值调小）；4 中 EXPLAIN 第一行变为 o 表。

## 十、与其他专题的关联

- **专题 10 / 16**：交叉点与回表低估——强制走索引为何可能更慢。
- **专题 12**：延迟关联中的覆盖索引，本专题用提示保证它被选中。
- **专题 13**：`FORCE INDEX` 跳过 index dive；修统计信息是首选对策。
- **专题 15**：用 EXPLAIN / trace 验证提示是否生效。
- **专题 18**：`MAX_EXECUTION_TIME` 与慢查询治理配合使用。

## 十一、复习 checklist

- [ ] 能说出索引提示、Optimizer Hint、optimizer_switch 三者的作用范围
- [ ] 知道 `USE INDEX` 与 `FORCE INDEX` 的区别，以及强制走索引可能更慢的原因
- [ ] 知道 Optimizer Hint 写错只给警告、索引提示写错直接报错，并会用 SHOW WARNINGS 验证
- [ ] 会用 `JOIN_ORDER`、`INDEX / NO_INDEX`、`MAX_EXECUTION_TIME`、`SET_VAR`
- [ ] 知道 `max_execution_time` 默认 0、只对 SELECT 生效
- [ ] 能列出提示的长期风险，并说出干预手段的推荐优先级
