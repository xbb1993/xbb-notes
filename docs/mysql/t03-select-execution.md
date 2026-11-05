# 专题 3 · 一条 SELECT 怎么执行

> 级别 ★（核心）· 主线 A（性能）主干：执行器 → 索引 → 页 → Buffer Pool → 磁盘 · 实测版本：沙箱 MySQL 8.0.46，数据为专题 1 的 `lab.t_order`（100 万行）

专题 2 讲到执行器会逐行调用存储引擎“给我下一行”。本专题进入引擎内部，回答三个问题：

1. 引擎收到“找 `user_id = 123` 的行”后，具体读了哪些数据？
2. 同一条 SQL，为什么有时 0.2 秒、有时 3 秒？
3. 别人正在修改这一行时，SELECT 读到什么？会不会被卡住？

全篇使用同一条 SQL：

```sql
SELECT * FROM t_order WHERE user_id = 123;   -- 沙箱数据中命中 14 行
```

## 一、类比：图书馆

| 图书馆 | InnoDB | 说明 |
| --- | --- | --- |
| 一页纸 | 页（page） | 磁盘与内存之间读写的最小单位，默认 16KB（`innodb_page_size`） |
| 按编号排列的书架 | 聚簇索引（主键索引） | 表本身，按主键 `id` 排序，存放完整的行 |
| 按作者排序的卡片柜 | 二级索引 `idx_user` | 只记录 `(user_id, id)` |
| 先查卡片、再按编号去书架取书 | 回表 | 从二级索引拿到 `id`，再去聚簇索引取完整行 |
| 阅览桌 | Buffer Pool | 内存中的页缓存 |
| 地下书库 | 磁盘 | 桌上没有，就要下楼去取 |

## 二、数据怎么组织

### 2.1 规模

沙箱实测（`mysql.innodb_index_stats`）：

| 索引 | 总页数 | 叶子页数 | 约合 |
| --- | --- | --- | --- |
| PRIMARY（聚簇索引，即整张表） | 4647 | 4608 | 4647 × 16KB ≈ 73MB |
| idx_user（二级索引） | 2085 | 1770 | ≈ 33MB |

### 2.2 从朴素方案到 B+ 树

- **朴素方案**：逐页扫描 4647 页、逐行比较 `user_id`。为了 14 行读 73MB，不可接受。
- **InnoDB 的方案**：每个索引是一棵 **B+ 树**，即多层的有序树。只有最底层的叶子页存数据，上层页只存“往哪个子页走”的路标。每页能放几百个路标，所以 100 万行只需 3 层。

```
idx_user（按 user_id 排序）                    PRIMARY（按 id 排序）
          [根页]                                        [根页]
         /  |   \                                      /  |   \
   [中间页] ...  [中间页]                       [中间页] ...  [中间页]
     /  |  \                                      /  |  \
 [叶子页: (122,…) (123,39245) (123,48109) …]   [叶子页: id=39245 → 整行数据 …]
          只有 user_id 和 id                           完整的 7 个字段
```

| | 叶子页存什么 | 排序依据 |
| --- | --- | --- |
| 聚簇索引 | 完整的行。InnoDB 的表本身就是这棵树 | 主键 |
| 二级索引 | `(索引列, 主键)` | 索引列，相同时按主键 |

从根到叶，每层读 1 页。B+ 树的内部结构在专题 9，聚簇与二级索引的设计取舍在专题 10。

## 三、完整读取路径

```
执行器                                    InnoDB
  │ ① 按索引定位：idx_user, user_id = 123
  ├────────────────────────────────────▶ 在 idx_user 上从根走到叶子（3 页）
  │                                      找到第一条 (123, id=39245)
  │                                      ② 回表：在 PRIMARY 上从根走到叶子（3 页）
  │                                      取出 id=39245 的完整行
  │                                      ③ 可见性判断：这个版本当前事务能否看到（第六节）
  │ ◀──────────────────────────────────── 返回 1 行
  │ ④ Server 层判断其余 WHERE 条件
  │ ⑤ 写入网络缓冲区，准备发给客户端
  │ ⑥ “给我下一行”
  ├────────────────────────────────────▶ 在 idx_user 叶子页上右移一条 → (123, 48109)，再回表 …
  │   …… 循环，直到遇到 user_id = 124 为止
```

上面每一次“读 1 页”都有两种结果：

```
需要第 N 页
   ├── 在 Buffer Pool 里 ──▶ 直接使用（内存访问）
   └── 不在 ──────────────▶ 从下层读进 Buffer Pool 再使用（I/O，慢几个数量级）
```

对应两个全局计数器（单位：次）：

| 计数器 | 官方含义 | 本笔记称为 |
| --- | --- | --- |
| `Innodb_buffer_pool_read_requests` | 逻辑读请求次数 | 逻辑读 |
| `Innodb_buffer_pool_reads` | 无法由 Buffer Pool 满足、需要向下层读取的次数 | 物理读 |
| `Innodb_buffer_pool_read_ahead` | 由预读线程读入的页数 | 预读页数 |

## 四、回表的代价

Buffer Pool 已热时，每条 SQL 执行前后取计数差值（沙箱实测）：

```
SQL                                          逻辑读   物理读
SELECT 1                                          0        0
SELECT * FROM t_order WHERE id = 500000           3        0     ← 主键等值
SELECT id FROM t_order WHERE user_id = 123       10        0     ← 只用二级索引，不回表
SELECT *  FROM t_order WHERE user_id = 123       66        0     ← 二级索引 + 14 次回表
```

- **主键查询 = 3**：在 PRIMARY 上从根到叶，正好 3 层。
- **`SELECT id` = 10**：所需的 `id` 就在 `idx_user` 的叶子里，不必回表。这种“索引里已有全部所需列”的情况叫**覆盖索引**（专题 10）。
- **`SELECT *` = 66**：比覆盖索引多 56 次，14 行平均每次回表约 4 次逻辑读，与 PRIMARY 树高 3 同一量级。

::: warning 易混淆：逻辑读次数不等于不同页的个数
`read_requests` 统计的是“向 Buffer Pool 要页”的请求次数，同一页被访问多次就计入多次。它适合比较同一查询不同写法的相对读取量，不能当作精确页数。
:::

## 五、冷与热、随机与顺序

### 5.1 实验设计

为看到真实的下层读取，启动时设置：

- `innodb_buffer_pool_load_at_startup = OFF`：启动时不预加载页（见 5.4）。
- `innodb_flush_method = O_DIRECT`：InnoDB 读写数据文件时绕过操作系统文件缓存（见 5.4）。

| | SQL | 读取方式 |
| --- | --- | --- |
| Q2 | `SELECT SUM(amount) FROM t_order WHERE user_id BETWEEN 1 AND 3000` | 走 `idx_user` 范围扫描，命中 29948 行，逐行回表；主键分散，属于**随机读** |
| Q1 | `SELECT COUNT(*) FROM t_order WHERE remark LIKE '%99999%'` | 全表扫描，按主键顺序读完全部叶子页，属于**顺序读** |

### 5.2 沙箱真实输出

```
                            逻辑读    物理读   预读页数   客户端耗时
Q2 随机读  冷（第1次）       124522    4663       0      3.436 s
           热（第2次）       118028       0       0      0.189 s
Q1 顺序读  冷（第1次）        18147      95    4544      0.316 s
           热（第2次）        13540       0       0      0.208 s
```

### 5.3 解读

**冷热差距：随机读约 18 倍，顺序读约 1.5 倍。**

- Q2 只需 3% 的行（29948 / 100 万），物理读却有 4663 次，接近整张表的页数（4647）。这 3 万行的主键随机分布在 4608 个叶子页上，几乎每页都要读一次，而且是一页一页地等。
- Q1 读整张表，同步物理读只有 95 次，其余 4544 页由**预读**提前读入。

**预读（read-ahead）**：InnoDB 发现顺序访问时，提前批量读入后续的页。触发条件由 `innodb_read_ahead_threshold` 控制，默认 56（沙箱实测）：一个**区**（extent，连续 64 页，即 1MB）中有至少 56 页被顺序访问，就异步读入下一个整区。另有随机预读 `innodb_random_read_ahead`，默认 OFF。

::: warning 反直觉：只取少量行，走索引不一定比全表扫描快
冷状态下，Q2（3% 的行，走索引 + 回表）耗时 3.4 秒；Q1（扫全表）耗时 0.3 秒。原因是回表产生大量随机读，而全表扫描是顺序读、有预读。这也是优化器有时放弃索引、选择全表扫描的原因：它在比较两者的成本（专题 10、16）。
:::

::: warning 实验局限
之后重复两次同样的冷启动，Q2 冷耗时降到约 0.43 秒，物理读次数仍是 4663。云主机磁盘之下还有一层宿主机缓存，实验无法控制。**耗时受存储层影响，物理读次数才是稳定可比的指标**；诊断时优先看计数，秒数只作参考。
:::

### 5.4 易错：重启后不一定是冷的

**机制一：Buffer Pool 转储与加载**

`innodb_buffer_pool_dump_at_shutdown`、`innodb_buffer_pool_load_at_startup` 默认均为 ON。

- 关闭时：把 Buffer Pool 中最近使用的页的**编号**（不是页内容）写入数据目录下的 `ib_buffer_pool` 文件。写出比例由 `innodb_buffer_pool_dump_pct` 控制，默认 25（%）。
- 启动后：后台线程按清单把这些页重新读入。

沙箱实测：关闭后 `ib_buffer_pool` 中有 1405 个页编号；启动后 `Innodb_buffer_pool_load_status` 显示 `Buffer pool(s) load completed`；随后 Q2 的物理读从 4663 降为 3844。

**机制二：操作系统文件缓存**

InnoDB 不绕过操作系统读文件时，读过的数据会留在操作系统的页缓存（page cache）里。重启 mysqld 只清空 Buffer Pool，操作系统缓存仍在。

沙箱实测：`fsync` 模式下连续重启两次，第二次 Q2 的物理读仍记为 4663 次，耗时却只有 0.169 秒，与热状态相当。这些“物理读”是从操作系统缓存取得的，没有访问磁盘。

**结论**：`Innodb_buffer_pool_reads` 表示“InnoDB 向下层要页的次数”，不保证真的读了磁盘。

::: tip 版本差异：innodb_flush_method 默认值（Linux）
| 版本 | 默认值 | 影响 |
| --- | --- | --- |
| 8.0 | `fsync` | 读取经过操作系统缓存，重启 mysqld 后仍可能是热的 |
| 8.4 | `O_DIRECT`（系统支持时） | 绕过操作系统缓存，Buffer Pool 是唯一的数据缓存 |

本地环境为 8.4，只受机制一影响。专题 1 中“容器重启后首次执行”的 0.453 秒，可能已受启动预加载影响，并非完全冷。
:::

::: tip PG 对照
PostgreSQL 官方文档建议 `shared_buffers` 从内存的 25% 起步，其余内存交给操作系统缓存，即依赖双层缓存，思路接近 MySQL 8.0 的 fsync；MySQL 8.4 则倾向由 Buffer Pool 独占数据缓存。
:::

## 六、快照读与加锁读

### 6.1 问题与方案

- **场景**：会话 A 修改了 `id = 500000` 的 `amount`，尚未提交；会话 B 读这一行。
- **朴素方案**：B 等 A 提交或回滚后再读。读写互相阻塞，并发很差。
- **InnoDB 的方案**：修改时保留旧版本，普通 SELECT 读一个由已提交数据构成的快照，无需等待。这就是 **MVCC**（Multi-Version Concurrency Control，多版本并发控制），旧版本保存在 undo log 中（专题 24、31）。

### 6.2 沙箱真实输出

```
会话 A：BEGIN; UPDATE t_order SET amount = 1.00 WHERE id = 500000;   -- 不提交

会话 B：SELECT id, amount FROM t_order WHERE id = 500000;
+--------+--------+
| id     | amount |
+--------+--------+
| 500000 |  94.61 |        ← 立即返回修改前的值
+--------+--------+

会话 B：SET innodb_lock_wait_timeout = 3;
        SELECT id, amount FROM t_order WHERE id = 500000 FOR UPDATE;
ERROR 1205 (HY000): Lock wait timeout exceeded; try restarting transaction
```

::: warning 易混淆
| 错误理解 | 正确理解 |
| --- | --- |
| SELECT 会被正在修改的事务卡住 | 普通 SELECT 是**快照读**（consistent read），不加行锁，不被写操作阻塞 |
| SELECT 一定读到最新数据 | 读到的是快照中的版本；快照在什么时刻建立，由隔离级别决定（专题 23） |
| 加了 `FOR UPDATE` 也不阻塞 | `FOR UPDATE` / `FOR SHARE` 是**加锁读**：读最新版本并加锁，遇到冲突要等待（专题 25、26） |
:::

**诊断推论**：纯 SELECT 慢，一般不是在等行锁，除非它带 `FOR UPDATE` / `FOR SHARE`，或者在等元数据锁（`Waiting for table metadata lock`，专题 25、36）。

## 七、在三条主线中的位置

```
A 性能：SQL → 优化器 → 执行计划 → [索引 → 页 → Buffer Pool → 磁盘]
                                    └──────── 本专题 ────────┘
B 一致性：本专题只区分快照读与加锁读，专题 23–26 展开
C 诊断：见第八节
```

## 八、诊断实践

### 8.1 一条 SELECT 慢，按顺序观察

| 步骤 | 看什么 | 回答的问题 |
| --- | --- | --- |
| 1 | `Handler_read_*`（会话级） | 引擎交给 Server 多少行（专题 2） |
| 2 | `Innodb_buffer_pool_read_requests` 差值 | 读了多少页（逻辑读），回表是否严重 |
| 3 | `Innodb_buffer_pool_reads` 差值 | 其中多少要向下层读取（物理读） |
| 4 | `Innodb_buffer_pool_read_ahead` 差值 | 物理读主要是顺序读还是随机读 |
| 5 | SQL 是否带 `FOR UPDATE` / `FOR SHARE`，PROCESSLIST 的 State | 是否在等锁 |

`Innodb_*` 计数器是全局的，单条 SQL 的差值只在无其他负载时准确；生产上更适合看一段时间内的增量。

### 8.2 病例一：同一条 SQL 时快时慢

1. **现象**：同一条查询，有时 0.2 秒，有时数秒，执行计划没有变化。
2. **指标**：慢的那次 `Innodb_buffer_pool_reads` 增量明显，快的那次接近 0。
3. **定位**：慢在页不在 Buffer Pool 中，需要 I/O。常见原因：实例刚重启；有大查询把常用页挤出了 Buffer Pool（专题 28）；Buffer Pool 相对热数据量太小。
4. **处置**：确认 Buffer Pool 大小与热数据量是否匹配；保持转储与加载默认开启，缩短重启后的预热时间。

### 8.3 病例二：走了索引反而比全表扫描慢

1. **现象**：范围条件走二级索引，命中行占比不大，却比全表扫描还慢。
2. **指标**：逻辑读约为“命中行数 × 每次回表的读取量”，物理读接近表的总页数，预读页数为 0。
3. **定位**：大量回表造成随机读。
4. **处置**：考虑覆盖索引避免回表（专题 10），或缩小范围；不要想当然地认为“走索引一定快”。

### 8.4 Buffer Pool 命中率

```sql
SELECT VARIABLE_NAME, VARIABLE_VALUE FROM performance_schema.global_status
WHERE VARIABLE_NAME IN ('Innodb_buffer_pool_read_requests', 'Innodb_buffer_pool_reads');
-- 间隔一段时间取两次，命中率 = 1 - Δreads / Δread_requests
```

用一段时间的**增量**计算，不要用启动以来的累计值，累计值会被长期平稳期稀释，看不出最近的变化。8.0 在 `fsync` 模式下，“未命中”可能由操作系统缓存满足，命中率偏低不一定意味着磁盘压力大，需结合操作系统的 I/O 指标判断（专题 45）。

## 九、本地复现脚本

在专题 1 的 Docker 环境（`mysql:8.4`）中用命令行客户端执行，实验期间不要有其他连接在跑查询。

```sql
-- 0. 参数与索引规模
SELECT @@innodb_flush_method, @@innodb_buffer_pool_load_at_startup,
       @@innodb_buffer_pool_dump_pct, @@innodb_read_ahead_threshold;
SELECT index_name, stat_name, stat_value FROM mysql.innodb_index_stats
WHERE database_name = 'lab' AND table_name = 't_order' AND stat_name IN ('size', 'n_leaf_pages');

-- 1. 每条 SQL 前后各执行一次，计算差值
SELECT VARIABLE_NAME, VARIABLE_VALUE FROM performance_schema.global_status
WHERE VARIABLE_NAME IN ('Innodb_buffer_pool_read_requests',
                        'Innodb_buffer_pool_reads',
                        'Innodb_buffer_pool_read_ahead');

SELECT * FROM t_order WHERE id = 500000;
SELECT id FROM t_order WHERE user_id = 123;
SELECT * FROM t_order WHERE user_id = 123;
SELECT SUM(amount) FROM t_order WHERE user_id BETWEEN 1 AND 3000;
SELECT COUNT(*) FROM t_order WHERE remark LIKE '%99999%';
```

**冷启动**：在 `lab.cnf` 的 `[mysqld]` 段临时加入 `innodb_buffer_pool_load_at_startup = OFF`，执行 `docker restart mysql84`；8.4 默认 O_DIRECT，无需修改刷盘方式。实验结束后删除该行。

**快照读**：开两个命令行窗口。

```sql
-- 窗口 A
BEGIN;
UPDATE t_order SET amount = 1.00 WHERE id = 500000;

-- 窗口 B
SELECT id, amount FROM t_order WHERE id = 500000;              -- 预期：立即返回旧值
SET innodb_lock_wait_timeout = 3;
SELECT id, amount FROM t_order WHERE id = 500000 FOR UPDATE;   -- 预期：约 3 秒后 ERROR 1205

-- 窗口 A
ROLLBACK;
```

**预期现象**：主键查询逻辑读约 3；`SELECT *` 的逻辑读明显多于 `SELECT id`；Q2 冷时物理读接近表的总页数、热时为 0；Q1 冷时大部分页来自预读。具体数值与耗时因机器和数据而异。

## 十、与其他专题的关联

- **专题 1**：重启后的“冷”测量可能受 Buffer Pool 预加载影响（5.4）。
- **专题 2**：本专题展开了执行器调用之下、引擎内部的读取路径。
- **专题 9、10**：B+ 树结构；聚簇索引、回表、覆盖索引与主键选择。
- **专题 16**：优化器如何把回表和随机读计入成本。
- **专题 23–26**：隔离级别、MVCC 可见性、锁。
- **专题 28**：Buffer Pool 的淘汰策略，以及大查询如何挤掉热数据。
- **Redis**：Buffer Pool 与 Redis 都是内存缓存，区别在于 Buffer Pool 以页为单位、由数据库自动管理，未命中时自动从磁盘回源。

## 十一、复习 checklist

- [ ] 能画出聚簇索引与二级索引两棵 B+ 树，说明各自叶子页存什么
- [ ] 能按步骤描述 `SELECT * ... WHERE user_id = 123` 的完整读取路径，包括回表
- [ ] 知道逻辑读、物理读、预读三个计数器的含义，以及逻辑读不等于不同页的个数
- [ ] 能解释“只取 3% 的行走索引，冷状态下比全表扫描还慢”的原因
- [ ] 能说出预读的触发条件（区、64 页、阈值 56）
- [ ] 能说明重启后不一定冷的两个机制，以及 8.0 与 8.4 `innodb_flush_method` 默认值的差异
- [ ] 能区分快照读与加锁读，并推论“纯 SELECT 慢一般不是在等行锁”
- [ ] 会用增量计算 Buffer Pool 命中率，并知道其局限
