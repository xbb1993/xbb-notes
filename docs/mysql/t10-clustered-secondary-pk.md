# 专题 10 · 聚簇索引、二级索引、回表、覆盖索引与主键选择

> 级别 ★（核心）· 主线 A · 实测版本：沙箱 MySQL 8.0.46，数据为专题 1 的 `lab.t_order`

本专题回答四个问题：

1. 为什么说“InnoDB 的表就是一棵 B+ 树”？没有主键会怎样？
2. 二级索引叶子里为什么存主键，而不是行的物理位置？
3. 什么时候走索引反而比全表扫描慢？
4. 主键用自增、UUID 还是雪花 ID？

## 一、类比：卡片为什么写书号

图书馆书架按书号排列（聚簇索引），卡片柜按作者排序（二级索引）。卡片上为什么写“书号”而不写“3 楼第 5 排第 2 格”？因为书架会调整：某格放满后，后面的书要整体后移（页分裂）。卡片写位置，每挪一次书所有相关卡片都要改；写书号则书挪到哪都不用改卡片，代价是查到书号后还得去书架再找一次。本专题的结论都从这个取舍出发。

## 二、聚簇索引

### 2.1 含义

PRIMARY 的叶子页存**完整的行**，按主键排序（专题 8、9）。InnoDB 没有单独的数据文件，主键 B+ 树就是表。数据按某个索引的顺序存放，这种索引叫**聚簇索引**（clustered index），一张表只能有一个。

### 2.2 没有主键时的选择规则（手册）

1. 有 `PRIMARY KEY`：用主键；
2. 没有主键：用**第一个所有列都 `NOT NULL` 的 `UNIQUE` 索引**；
3. 都没有：生成隐藏的 `GEN_CLUST_INDEX`，建在 6 字节的隐藏**行 ID** 上，行 ID 随插入单调递增。

沙箱实测（`information_schema.INNODB_INDEXES`）：

```
表         索引              TYPE   N_FIELDS（索引记录包含的字段数）
t_order    PRIMARY            3      9   ← 7 个列 + 事务ID + 回滚指针
t_order    idx_user           0      2   ← user_id + 主键 id
t_nopk     GEN_CLUST_INDEX    1      5   ← 行ID + 事务ID + 回滚指针 + 列 a、b
t_uk       uk_code            3      4   ← code + 事务ID + 回滚指针 + name
```

- `t_nopk` 无任何索引，自动生成 `GEN_CLUST_INDEX`。
- `t_uk` 无主键但有 `NOT NULL` 唯一索引 `uk_code`，其字段含事务 ID 与回滚指针，说明它就是聚簇索引。
- TYPE：0 为普通二级索引，1 为自动生成的聚簇索引，3 为聚簇索引。
- `idx_user` 建索引时只写了 `user_id`，**主键 `id` 是 InnoDB 自动加入的**。

### 2.3 无主键的隐患

| 隐患 | 说明 |
| --- | --- |
| 隐藏行 ID 无法使用 | 查询、关联、按行删除都用不上，聚簇索引被浪费 |
| 全局共享计数器 | 据《MySQL 实战 45 讲》第 45 讲，所有无主键表共用一个全局行 ID 计数器，6 字节用尽后从 0 开始，新行覆盖行 ID 相同的旧行 |
| 复制与工具 | ROW 格式 binlog 在从库按行定位时，无主键更难找到目标行（专题 39、40）；部分在线 DDL 工具要求有主键 |

**结论：每张表显式定义主键。** 8.0 较新版本与 8.4 提供 `sql_generate_invisible_primary_key`（默认 OFF），开启后建表未写主键时自动加入不可见主键，沙箱实测：

```
`my_row_id` bigint unsigned NOT NULL AUTO_INCREMENT /*!80023 INVISIBLE */,
...
PRIMARY KEY (`my_row_id`)
```

可作兜底，规范做法仍是设计时定义主键。

## 三、二级索引为什么存主键

### 3.1 两种方案

```
方案 A：存物理位置（页号 + 页内位置）
  idx_user 叶子：(123 → 第 5812 页第 7 条)    找行：直接跳到该位置，读 1 页

方案 B：存主键值（InnoDB）
  idx_user 叶子：(123 → id=39245)              找行：用 id 再走一遍主键树，约 3 页 ← 回表
```

### 3.2 方案 A 的问题：行会移动

InnoDB 中行的物理位置经常变化：页分裂（专题 9）、页合并（专题 7、9）、重建表（`OPTIMIZE TABLE`）。存物理位置时，每次搬移行，这些行在**每一个**二级索引中的条目都要更新：5 个二级索引、一次分裂搬 100 行，就要额外改 500 个条目。存主键则二级索引完全不受影响。

### 3.3 多维对比

| 维度 | 方案 A：存物理位置 | 方案 B：存主键（InnoDB） |
| --- | --- | --- |
| 经二级索引读一行 | 1 次定位，更快 | 再走一遍主键树（回表） |
| 行移动时 | 所有二级索引都要更新 | 不受影响 |
| 二级索引大小 | 位置固定，约 6–8 字节 | **取决于主键长度** |
| 修改主键值 | — | 行在主键树中移动，所有二级索引都要更新 |
| 采用者 | MyISAM（数据文件偏移）、PostgreSQL（ctid：页号 + 页内序号） | InnoDB |

**两个推论：**

1. **主键要短**：主键复制到每个二级索引的每条记录。手册原话：主键长则二级索引占更多空间，短主键更有利（第五节量化）。
2. **主键不修改**：改主键等于删除再插入，所有二级索引都要更新；主键应选与业务无关、永不改变的值。

::: tip PG 对照
PostgreSQL 索引存 ctid，读取少一次回表，但要承担方案 A 的代价：UPDATE 写新行版本、位置改变，所有索引原本都要指向新位置。PG 用 **HOT 更新**（Heap-Only Tuple）补救：新版本仍在同一页且未修改任何被索引的列时，不更新索引，在页内留跳转指针。两者在同一取舍上各选一边，并各有补救机制。
:::

## 四、回表与覆盖索引

### 4.1 覆盖索引

查询只需要索引列和主键时无需回表，称为**覆盖索引**（covering index），EXPLAIN 的 Extra 显示 `Using index`。沙箱实测（`idx_user` 只定义了 `user_id`）：

```
EXPLAIN SELECT id FROM t_order WHERE user_id = 123;
  type=ref  key=idx_user  Extra=Using index                     ← 覆盖
EXPLAIN SELECT id, user_id FROM t_order WHERE user_id BETWEEN 100 AND 200;
  type=range  key=idx_user  Extra=Using where; Using index      ← 覆盖
EXPLAIN SELECT id, amount FROM t_order WHERE user_id = 123;
  type=ref  key=idx_user  Extra=NULL                            ← 需要回表
```

专题 3 量化过代价：`SELECT id` 逻辑读 10，`SELECT *` 逻辑读 66（14 行，每次回表约 4 次逻辑读）。

::: warning 易混淆
| 错误理解 | 正确理解 |
| --- | --- |
| 二级索引只包含建索引时写的列 | InnoDB 二级索引自动包含主键列 |
| `Using index` 表示用到了索引 | 表示**只用索引就完成查询、没有回表**；需要回表时 Extra 不显示它 |
| `Using index` 与 `Using index condition` 相同 | 后者是索引下推，仍要回表（专题 11） |
:::

### 4.2 回表与全表扫描的交叉点

二级索引加回表的成本约与命中行数成正比（每行一次主键树随机查找）；全表扫描成本基本固定（顺序读完全部叶子页）。

实验：`SELECT SUM(amount) FROM t_order WHERE user_id <= X`，`amount` 不在 `idx_user` 中必须回表。分别 `FORCE INDEX(idx_user)` 与 `IGNORE INDEX(idx_user)`，记录服务端耗时（Buffer Pool 已热，3 次取最小），并看优化器的选择：

```
命中比例   走索引+回表   全表扫描   优化器的选择
  1.0%       11.3 ms    121.2 ms    range（索引）
  2.5%       35.1 ms    117.8 ms    range
  5.0%       74.0 ms    125.3 ms    range
  7.5%      106.8 ms    127.8 ms    range
 10.0%      150.5 ms    123.8 ms    range       ← 索引已更慢
 12.5%      164.3 ms    121.6 ms    range       ← 索引已更慢
 15.0%      213.6 ms    124.3 ms    ALL（全表）
 20.0%      280.9 ms    125.3 ms    ALL
```

1. **实际交叉点在 8%–10%**：命中 1% 时索引快 10 倍，命中 10% 时索引已更慢。
2. **优化器在 12.5%–15% 才切换**，在 10%、12.5% 两档选了更慢的索引。它依据估算行数与成本模型而非实际耗时，例如 `user_id <= 1000` 估计 19770 行、实际 10065 行（成本模型见专题 16）。
3. **这是数据全在内存时的结果**。需要读磁盘时回表随机读更贵，交叉点大幅前移：专题 3 冷启动时命中 3% 的行，索引 3.4 秒、全表扫描 0.3 秒。

::: warning 易混淆
| 错误理解 | 正确理解 |
| --- | --- |
| 有索引就该用 | 命中比例超过某点后，回表随机读比顺序扫全表更贵 |
| 优化器不用索引一定是选错了 | 往往是对的；它也会错，本实验中反而是“用多了” |
| 交叉点是固定百分比 | 取决于行宽、数据是否在内存、磁盘类型 |
:::

## 五、主键选择

### 5.1 评价标准

| 标准 | 原因 |
| --- | --- |
| 短 | 复制到每个二级索引；扇出更大、树更矮 |
| 趋势递增 | 末尾分裂、页填满、叶子物理连续（专题 9） |
| 不变 | 修改主键要移动行并更新所有二级索引 |
| 全局唯一（视业务） | 分库分表、多系统合并数据不冲突 |
| 不泄露业务信息（视业务） | 对外暴露时不能被猜测或推算 |

前三条是存储层硬要求，后两条取决于业务。

### 5.2 MySQL 的 UUID() 是什么

手册：`UUID()` 返回**版本 1 UUID**，格式 `aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`；前三组来自时间戳的低、中、高位，第四组用于时钟回拨时保持唯一，第五组为网卡地址（拿不到时用随机数）。

**第一组是时间戳的低 32 位**（单位 100 纳秒），变化最快，每 2³² × 100 纳秒 ≈ 7.2 分钟循环一次。沙箱连续调用：

```
c76a2b20-dbef-11f1-bb4d-02fc00000001
c76a2b46-dbef-11f1-bb4d-02fc00000001
c76a2b49-dbef-11f1-bb4d-02fc00000001
（SLEEP 1 秒后）
c802d650-dbef-11f1-bb4d-02fc00000001
```

短时间内递增，所以**一次性批量插入时 UUID() 看似有序，实验会得出错误结论**。真实写入分散在全天，第一组每 7 分钟循环，新值会排到之前的值前面。实验按 v1 格式**模拟“100 万行均匀写入一整天”**（每行间隔 86.4 毫秒），循环点附近：

```
第几行    UUID v1                                  距开始的秒数
1         1dcd6f00-5dd3-11e6-bb4d-02fc00000001     0.1
2         1dda9e00-5dd3-11e6-bb4d-02fc00000001     0.2
4393      fffbc700-5dd3-11e6-bb4d-02fc00000001     379.6
4394      0008f600-5dd4-11e6-bb4d-02fc00000001     379.6   ← 第一组从 ffff… 回到 0000…
4395      00162500-5dd4-11e6-bb4d-02fc00000001     379.7
```

第 4394 行按字符串排序比第 1 行还小，插入位置跳回 B+ 树最左边再逐渐右扫；一天循环约 200 次，每轮都插在上一轮的值之间，造成大量中间分裂。

`UUID_TO_BIN(uuid, 1)`：第二个参数为 1 时对调第一组（时间低位）与第三组（时间高位），把变化最快的部分移到右边。手册称“可以提高索引效率”，且只对版本 1 UUID 有效。

### 5.3 实验

五张表结构相同、只有主键不同，各插入 100 万行：

```sql
CREATE TABLE t_k_xxx (
  id         <主键类型>,
  user_id    INT UNSIGNED NOT NULL,
  amount     DECIMAL(10,2) NOT NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY idx_user (user_id)       -- 用于观察主键长度对二级索引的影响
);
```

| 表 | 主键类型 | 取值 | 代表的做法 |
| --- | --- | --- | --- |
| auto | `BIGINT UNSIGNED AUTO_INCREMENT` | 1, 2, 3 … | 自增（8 字节） |
| v1_str | `CHAR(36)` | 模拟一天内的 `UUID()` | 直接用 `UUID()` 字符串 |
| v1_bin_swap | `BINARY(16)` | `UUID_TO_BIN(上述值, 1)` | MySQL 官方推荐的 UUID 存法 |
| v4_str | `CHAR(36)` | `BIN_TO_UUID(RANDOM_BYTES(16))` | 应用生成的随机 UUID 存成字符串 |
| v4_bin | `BINARY(16)` | `RANDOM_BYTES(16)` | 随机 UUID 存成二进制 |

**Buffer Pool 512MB（数据能放进内存）：**

```
              插入耗时   主键叶子页   主键MB   idx_user叶子页   idx_user MB   文件MB
auto            6.54 s      2661        42         1770            32         84
v1_bin_swap     8.91 s      3196        50         2149            38        100
v4_bin         11.75 s      4484        80         2134            38        128
v1_str         14.28 s      5826       105         4163            74        188
v4_str         14.24 s      6434       117         4167            74        204
```

**Buffer Pool 64MB（数据大于内存）：**

```
              插入耗时   从磁盘读页数
auto            7.97 s           103
v1_bin_swap     9.65 s           216
v4_bin         50.14 s       129,002
v1_str        114.89 s       386,595
v4_str        115.63 s       347,286
```

### 5.4 解读

1. **有序性决定写入代价**：`auto` 与 `v1_bin_swap` 趋势递增，数据超过内存后耗时几乎不变；三种无序主键慢 6–14 倍，原因同专题 9（目标页随机，要先从磁盘读入）。
2. **`UUID()` 字符串与随机 UUID 一样糟**：`v1_str` 与 `v4_str` 几乎相同（115 秒对 116 秒）。v1 的时间低位在最前，按字符串排序近似随机；批量插入测试时又恰好有序，极易误判。
3. **长度决定所有索引的大小**：四张表的 `idx_user` 内容相同，只差附带的主键——8 字节主键 32MB，`BINARY(16)` 38MB，`CHAR(36)`（utf8mb4）74MB，即 2.3 倍。实际业务表常有 3–5 个二级索引，每个都按此比例膨胀。
4. **有序但更长也有代价**：`v1_bin_swap` 已有序，但 16 字节主键使主键叶子页比 `auto` 多 20%，`idx_user` 多 19%。

::: warning 易混淆
| 错误理解 | 正确理解 |
| --- | --- |
| `UUID()` 带时间戳，所以有序 | 时间低位在最前，约每 7 分钟循环，按字符串排序近似随机 |
| UUID 主键只影响主键索引 | 主键复制到每个二级索引，`CHAR(36)` 使本例二级索引变为 2.3 倍 |
| 批量导入测试没问题就可以用 | 批量导入时 `UUID()` 恰好有序，且测试数据往往能装进内存 |
| 存成 `BINARY(16)` 就解决了 | 只解决长度；随机 v4 存成二进制依然无序（数据超过内存后 50 秒对 8 秒） |
:::

### 5.5 方案对比

| 方案 | 长度 | 有序 | 全局唯一 | 可被猜测 | 评价 |
| --- | --- | --- | --- | --- | --- |
| `BIGINT` 自增 | 8 | ✓ | ✗（单库内） | 可以 | 单库首选 |
| 雪花 ID（`BIGINT`） | 8 | 趋势递增 | ✓ | 能推算生成时间 | 分布式常用 |
| `UUID_TO_BIN(UUID(), 1)` | 16 | ✓ | ✓ | 能推算时间与机器 | 需要 UUID 时的较好存法 |
| UUIDv7（应用生成，`BINARY(16)`） | 16 | ✓ | ✓ | 能推算时间 | 同上 |
| `UUID()` 字符串 / 随机 UUID | 16–36 | ✗ | ✓ | 不能 | 不适合做 InnoDB 主键 |

- **雪花 ID**：64 位整数，由毫秒时间戳、机器编号、序列号拼成，按时间趋势递增；多节点同一毫秒内交错只影响最右侧少数页，整体接近顺序插入（本次未单独实验，按原理与自增接近）。主要风险是**时钟回拨**可能产生重复 ID，需生成器自行处理。
- **UUIDv7**：2024 年 RFC 9562 定义，毫秒时间戳在最前，天然按时间排序；MySQL 的 `UUID()` 不生成它，需应用端生成。

### 5.6 自增主键的问题

| 问题 | 说明 | 应对 |
| --- | --- | --- |
| 可被猜测 | 连续编号可被遍历，可推算业务量 | 主键只在内部使用，对外另设随机业务编号（唯一索引） |
| 分库分表不唯一 | 各库各自从 1 开始 | 改用分布式 ID（专题 52） |
| 不连续 | 手册：回滚后已分配的值不再使用，批量插入也可能多分配 | 不用自增值统计行数，不依赖其连续 |
| INT 会用完 | `INT UNSIGNED` 最大约 42.9 亿 | 用 `BIGINT` |

::: warning 版本差异（8.0 手册）
| 项目 | 5.7 及以前 | 8.0 / 8.4 |
| --- | --- | --- |
| 自增计数器 | 只在内存中；重启后首次插入时执行相当于 `SELECT MAX(自增列) ... FOR UPDATE` 重新确定，删除最大的几行后重启会**复用**这些值 | 每次变化写入 redo log，checkpoint 时存入数据字典，**重启后不回退** |
| `innodb_autoinc_lock_mode` 默认 | 1（连续模式） | 2（交错模式，沙箱实测 2）；手册解释：默认复制格式由基于语句改为基于行，不再要求按语句顺序分配 |
:::

### 5.7 结论

1. 单库默认 `BIGINT UNSIGNED AUTO_INCREMENT`，主键只在内部使用；
2. 需要全局唯一时用雪花 ID 或 UUIDv7（`BINARY(16)`）；
3. 必须用 MySQL `UUID()` 时存成 `UUID_TO_BIN(UUID(), 1)`，不要存字符串；
4. 对外标识符（订单号、分享链接）与主键分开设计。

::: tip PG 对照
PG 是堆表，随机 UUID 主键只让主键索引变乱，表数据仍按写入顺序追加；PG 的其他索引存 ctid、不含主键，主键再长也不会让其他索引变大。所以 PG 中 UUID 主键常见且代价较小。**从 PG 转到 MySQL 时，这是最需要改变的设计习惯之一。**
:::

## 六、在三条主线中的位置

```
A 性能：SQL → 优化器（选索引还是全表扫描） → 执行计划 → [二级索引树 → 回表 → 主键树] → 页 → Buffer Pool
         回表 = 每行一次主键树查找；主键的长度与有序性影响所有索引的大小与写入代价
B 一致性：二级索引页无事务 ID 与回滚指针，判断可见性时常需回到聚簇索引（专题 24）
C 诊断：见第七节
```

## 七、诊断实践

### 7.1 观察点

| 观察点 | 回答的问题 |
| --- | --- |
| EXPLAIN 的 Extra | `Using index` = 覆盖、无回表；为 NULL 或仅 `Using where` 时需回表 |
| EXPLAIN 的 rows 与实际行数 | 估算偏差会让优化器在交叉点附近选错 |
| `FORCE INDEX` / `IGNORE INDEX` 对比实际耗时 | 验证优化器的选择 |
| 表结构 | 主键类型与长度；是否无主键 |

查找无主键的表：

```sql
SELECT t.NAME FROM information_schema.INNODB_INDEXES i
JOIN information_schema.INNODB_TABLES t USING (TABLE_ID)
WHERE i.NAME = 'GEN_CLUST_INDEX';
```

### 7.2 病例一：只查两三列，仍然很慢

1. **现象**：`SELECT id, status FROM t_order WHERE user_id = ?` 在大量调用下耗时偏高。
2. **指标**：EXPLAIN 走 `idx_user`，Extra 为 NULL；逻辑读远大于返回行数。
3. **定位**：`status` 不在索引中，每行都要回表。
4. **处置**：把索引改为 `(user_id, status)` 使之覆盖；注意索引变宽带来的写入与空间代价（专题 12）。

### 7.3 病例二：范围查询忽快忽慢，优化器时而走索引时而全表扫描

1. **现象**：同一 SQL 不同参数下耗时差异很大。
2. **指标**：不同参数下 EXPLAIN 的 type 在 range 与 ALL 之间切换，rows 与实际行数偏差明显。
3. **定位**：命中比例在交叉点附近，估算偏差导致选择不稳定。
4. **处置**：用 `FORCE INDEX` / `IGNORE INDEX` 实测两种方案；考虑覆盖索引消除回表，使走索引在更大范围内都更快；统计信息问题见专题 13。

### 7.4 病例三：表不大，索引却很大，写入越来越慢

1. **现象**：二级索引总大小远超数据本身，数据增长后写入变慢。
2. **指标**：`mysql.innodb_index_stats` 中各二级索引的 `size` 偏大；写入期间 `Innodb_buffer_pool_reads` 上升。
3. **定位**：主键为 `CHAR(36)` UUID，既无序又长。
4. **处置**：新表按 5.7 节选择主键；存量表更换主键需重建表（专题 36）。

## 八、本地复现脚本

在专题 1 的 Docker 环境（`mysql:8.4`）中执行。

```sql
USE lab;

-- 1. 聚簇索引的选择
CREATE TABLE t_nopk (a INT, b VARCHAR(10));
CREATE TABLE t_uk   (code VARCHAR(20) NOT NULL, name VARCHAR(20), UNIQUE KEY uk_code (code));
SELECT t.NAME, i.NAME, i.TYPE, i.N_FIELDS FROM information_schema.INNODB_INDEXES i
JOIN information_schema.INNODB_TABLES t USING (TABLE_ID)
WHERE t.NAME IN ('lab/t_nopk', 'lab/t_uk', 'lab/t_order');

-- 2. 覆盖索引
EXPLAIN SELECT id FROM t_order WHERE user_id = 123;
EXPLAIN SELECT id, amount FROM t_order WHERE user_id = 123;

-- 3. 交叉点：对多个 X 分别执行并记录耗时
SELECT SUM(amount) FROM t_order FORCE INDEX (idx_user)  WHERE user_id <= 10000;
SELECT SUM(amount) FROM t_order IGNORE INDEX (idx_user) WHERE user_id <= 10000;
EXPLAIN SELECT SUM(amount) FROM t_order WHERE user_id <= 10000;
SELECT sql_text, ROUND(timer_wait / 1e9, 1) AS ms FROM performance_schema.events_statements_history
WHERE thread_id = PS_CURRENT_THREAD_ID() ORDER BY event_id DESC LIMIT 3;

-- 4. 主键选择：以 v1_str 为例，其余四种按 5.3 节表格替换 id 的类型与取值
CREATE TABLE t_k_v1_str (id CHAR(36) NOT NULL, user_id INT UNSIGNED NOT NULL, amount DECIMAL(10,2) NOT NULL,
                         created_at DATETIME NOT NULL, PRIMARY KEY (id), KEY idx_user (user_id));
INSERT INTO t_k_v1_str (id, user_id, amount, created_at)
SELECT LOWER(CONCAT(
         LPAD(HEX(((136900000000000000 + o.id*864000) & 0xFFFFFFFF)), 8, '0'), '-',
         LPAD(HEX(((136900000000000000 + o.id*864000) >> 32) & 0xFFFF), 4, '0'), '-',
         LPAD(HEX((((136900000000000000 + o.id*864000) >> 48) & 0x0FFF) | 0x1000), 4, '0'),
         '-bb4d-02fc00000001')),
       o.user_id, o.amount, o.created_at
FROM t_order o ORDER BY o.id;
-- 表达式按 UUID v1 格式模拟“每 86.4 毫秒生成一个”的取值（100 万行约一整天）
ANALYZE TABLE t_k_v1_str;
SELECT index_name, stat_name, stat_value FROM mysql.innodb_index_stats
WHERE database_name = 'lab' AND table_name = 't_k_v1_str' AND stat_name IN ('n_leaf_pages', 'size');
```

**预期现象**：`t_nopk` 出现 `GEN_CLUST_INDEX`，`t_uk` 的 `uk_code` N_FIELDS 为 4；`SELECT id` 显示 `Using index`；数据在内存中时交叉点约 10%；五种主键的大小与耗时排序同 5.3 节。小 Buffer Pool 对比方法同专题 9。

## 九、与其他专题的关联

- **专题 3**：回表的逻辑读代价；冷启动时回表随机读更贵。
- **专题 8**：行中的隐藏列；二级索引记录的字节组成。
- **专题 9**：页分裂、页填充率、随机插入的代价。
- **专题 11**：联合索引与覆盖、索引下推。
- **专题 12**：索引设计时兼顾覆盖与写入代价。
- **专题 16**：优化器成本模型，解释交叉点附近的选择。
- **专题 24**：二级索引与 MVCC 可见性判断。
- **专题 36、52**：更换主键的 DDL；分布式 ID。

## 十、复习 checklist

- [ ] 能说出 InnoDB 选择聚簇索引的三级规则，并知道无主键的隐患
- [ ] 能从读取、行移动、索引大小、修改主键四方面对比“存物理位置”与“存主键”
- [ ] 能说出两个推论：主键要短、主键不修改
- [ ] 能用 `Using index` 判断覆盖索引，并区分 `Using index condition`
- [ ] 能解释回表与全表扫描存在交叉点的原因，以及交叉点受哪些因素影响
- [ ] 能解释 MySQL `UUID()` 为什么按字符串排序近似随机，`UUID_TO_BIN(..., 1)` 做了什么
- [ ] 能用实验数据说明主键的有序性与长度各自的影响
- [ ] 能给出不同场景下的主键选择，并说出自增主键的四个问题
- [ ] 知道 8.0 在自增计数器持久化与 `innodb_autoinc_lock_mode` 默认值上的变化
