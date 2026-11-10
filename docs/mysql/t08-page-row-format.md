# 专题 8 · 数据页与行格式、行溢出

> 级别 ☆（高频重点）· 主线 A（索引 → 页）· 实测版本：沙箱 MySQL 8.0.46，数据为专题 1 的 `lab.t_order`

本专题回答三个问题：

1. 拿到叶子页后，怎么在 16KB 里找到 `id = 500000` 那一行？（补全专题 3 的查找路径）
2. 一行 `t_order` 在磁盘上占多少字节？InnoDB 表为什么比 MyISAM 大约 30%（专题 6）？
3. 一行放不进页时怎么办？对查询有什么影响？

实验方法：`FLUSH TABLES ... FOR EXPORT` 保证数据已刷盘，复制出 `.ibd` 文件，用 Python 小脚本读取页头与记录（脚本见第六节）。

## 一、页内结构

### 1.1 从朴素方案开始

| 方案 | 做法 | 问题 |
| --- | --- | --- |
| 有序数组 | 行在页内按主键紧密排好 | 可二分查找，但插入要挪动后面所有行 |
| 链表 | 行随便放，用指针按主键串起来 | 插入只改指针，但查找只能顺序走 |

InnoDB 两者兼用：**行之间用单向链表串起来，另建一个小目录支持二分查找。**

### 1.2 类比：字典的书眉

字典每页上方的书眉印着“本页从 ab 到 ac”，查词先看书眉缩小范围，再逐个看。InnoDB 的**页目录**（Page Directory）就是页内书眉：页内记录按顺序每 4–8 条分为一组，每组在页尾记一个**槽**（slot），指向组内最后一条记录。查找时先对槽二分，再在组内沿链表走几步。

### 1.3 页的布局

```
16KB 页
┌──────────────────────────────┐ 偏移 0
│ File Header        38 字节   │ 页号、页类型、同层前后页指针（双向链表）
├──────────────────────────────┤ 38
│ Page Header        56 字节   │ 记录数、槽数、空闲区位置、页所在层级 …
├──────────────────────────────┤ 94
│ Infimum / Supremum 26 字节   │ 两条虚拟边界记录：比所有行都小 / 比所有行都大
├──────────────────────────────┤
│ User Records ↓               │ 真实的行，按插入顺序堆放；按主键顺序用 next 指针串成单向链表
│ Free Space                   │
│ Page Directory ↑             │ 槽，从页尾向上增长，每槽 2 字节
├──────────────────────────────┤ 16376
│ File Trailer        8 字节   │ 校验信息，用于发现“页只写了一半”（专题 30）
└──────────────────────────────┘ 16384
```

::: warning 易混淆：物理顺序 ≠ 逻辑顺序
行在页内按**插入顺序**堆放，按**主键顺序**由链表维护。插入一行只需放到空闲区并修改两个指针，不必挪动其他行。
:::

### 1.4 实测：t_order.ibd 的页头统计

```
索引       层级   页数    平均行数   平均槽数   平均已用空间(heap_top)   平均碎片(garbage)
PRIMARY    0     4608    217.0      55.0       15205 字节              2 字节
PRIMARY    1        6    768.0     192.7       15261                 1317
PRIMARY    2        1      6.0       2.0         228                    0
idx_user   0     1770    565.0     117.1       12791                 3066
idx_user   1        4    442.5      84.5       12662                 3250
idx_user   2        1      4.0       2.0         204                    0
```

1. **树高 3 层**：根页 6 个子节点，中间页平均 768 个子节点，6 × 768 = 4608 = 叶子页数。这就是专题 3 中主键查询逻辑读为 3 的结构来源。
2. **页内查找**：每叶 217 行、约 55 个槽，每组约 4 行；对槽二分最多约 log₂55 ≈ 6 次比较，再在组内走几步。
3. **主键页约 93% 满**：手册说明，插入聚簇索引时 InnoDB 尽量为每页留出 1/16 空闲；顺序插入时页约 15/16 满（15360 字节），与实测 15205 吻合。
4. **二级索引页约 59% 满**：`idx_user` 每条 17 字节（user_id 4 + id 8 + 记录头 5），565 × 17 ≈ 9605 字节。`user_id` 随机，插入位置随机，页频繁分裂；手册说明随机插入时页填充率在 1/2 到 15/16 之间。约 3000 字节的 `garbage` 是页分裂时搬走记录在原页留下的空间，可被后续插入复用（专题 9）。

一个叶子页（第 196 页）的目录：

```
槽指向的偏移（前 6 个）：99, 338, 618, 898, 1178, 1445 … 最后一个：112
每个槽拥有的记录数：1, 4, 4, 4, 4, 4, 4, 4, 4, 4 … 最后一个：8
```

第一个槽固定指向 Infimum（偏移 99），只拥有它自己；最后一个槽指向 Supremum（偏移 112）。据《MySQL 技术内幕：InnoDB 存储引擎》，普通组拥有 4–8 条记录，超过 8 条时拆分。

### 1.5 完整查找路径

```
找 id = 500000
① 根页（第 2 层）：对槽二分 → 组内顺序找 → 得到子页号
② 中间页（第 1 层）：同上 → 得到叶子页号
③ 叶子页（第 0 层）：对 55 个槽二分 → 定位到组 → 组内沿链表走几步 → 找到该行
```

## 二、行格式

### 2.1 DYNAMIC 格式

8.0 默认行格式为 **DYNAMIC**（`innodb_default_row_format`，沙箱实测 dynamic）。一条记录以“原点”（origin）为界：

```
            ← 额外信息（向前读）              原点   真实数据（向后读）→
┌─────────────────┬────────────┬──────────┐ ┌───────┬────────┬──────────┬────────┬───┐
│ 变长字段长度列表  │ NULL 标志位 │ 记录头 5B │ │ 主键  │ 事务ID │ 回滚指针  │ 其余列 │ … │
│ （逆序存放）      │            │          │ │       │  6B    │   7B     │        │   │
└─────────────────┴────────────┴──────────┘ └───────┴────────┴──────────┴────────┴───┘
```

| 部分 | 规则（MySQL 8.4 手册 “InnoDB Row Formats”） |
| --- | --- |
| 变长字段长度列表 | 每个**非 NULL** 变长字段占 1 或 2 字节。只有该字段部分存到溢出页，或“最大长度超过 255 字节且实际长度超过 127 字节”时才用 2 字节 |
| NULL 标志位 | 可为 NULL 的列数为 N 时占 `CEILING(N/8)` 字节；NULL 值本身不占数据空间 |
| 记录头 | 固定 5 字节：删除标记、本组拥有的记录数、堆序号（heap_no）、记录类型、下一条记录的相对偏移 |
| 隐藏列 | 聚簇索引记录额外有 6 字节事务 ID、7 字节回滚指针；表无主键时另有 6 字节行 ID |

- **事务 ID**（常称 DB_TRX_ID）：最后修改该行的事务编号。
- **回滚指针**（常称 DB_ROLL_PTR）：指向 undo log 中该行的上一个版本。

二者是 **MVCC 的物理基础**：用事务 ID 判断当前版本是否可见，不可见时沿回滚指针找旧版本（专题 24）。

### 2.2 手算一行 t_order（`id = 21986`）

| 部分 | 字节 | 依据 |
| --- | --- | --- |
| 变长字段长度列表 | 2 | `order_no`（14 字节）、`remark`（12 字节）各 1 字节 |
| NULL 标志位 | 1 | 仅 `remark` 可为 NULL |
| 记录头 | 5 | 固定 |
| `id` BIGINT | 8 | |
| 事务 ID | 6 | 隐藏列 |
| 回滚指针 | 7 | 隐藏列 |
| `user_id` INT | 4 | |
| `status` TINYINT | 1 | |
| `amount` DECIMAL(10,2) | 5 | 整数 8 位数字占 4 字节，小数 2 位数字占 1 字节 |
| `order_no` | 14 | `'NO000000021986'` |
| `created_at` DATETIME | 5 | |
| `remark` | 12 | `'remark-21986'` |
| **合计** | **70** | |

`remark` 为 NULL 的行：少 1 字节长度与 12 字节数据，共 57 字节。

### 2.3 用真实字节验证

在第 196 页上沿链表遍历，相邻记录原点之间的距离即一条记录的大小：`70, 70, 70, …`，最小 57、最大 70、平均 68.9，与手算吻合。第一条记录：

```
原点前 8 字节：0c 0e 00 | 00 00 10 00 46
               ↑  ↑  ↑    └ 记录头：heap_no=2，普通记录，下一条在 +0x46=70 字节处
               │  │  └ NULL 标志位：无 NULL 列
               │  └ order_no 长度 14（长度列表按列的逆序存放，离原点更近）
               └ remark 长度 12

原点后：
id        00 00 00 00 00 00 55 e2        → 21986
事务 ID   00 00 00 00 05 14              → 1300（灌数据的事务）
回滚指针   81 00 00 01 31 28 d1           → 专题 24 解码
user_id   00 01 0e 61                    → 69217
status    80                             → 0
amount    80 00 02 a8 5a                 → 680.90（0x2a8 = 680，0x5a = 90）
order_no  4e 4f 30 30 … 38 36            → 'NO000000021986'
created   99 b7 f9 59 f0                 → 2025-10-28 21:39:48
remark    72 65 6d 61 72 6b 2d …         → 'remark-21986'
```

与 `SELECT * FROM t_order WHERE id = 21986` 逐项一致。

::: tip 细节：符号位翻转
`status = 0` 存为 `80`，`amount` 首字节也是 `80`：有符号整数与 DECIMAL 存储时翻转符号位，使“按字节比较”与“按数值比较”结果一致（负数小于正数），B+ 树比较键值时无需解码。无符号的 `id`、`user_id` 不翻转。
:::

### 2.4 为什么比 MyISAM 大

```
InnoDB：16384 字节 ÷ 每页 217 行 ≈ 每行 75.5 字节（含页内开销）
MyISAM：57,395,320 字节 ÷ 1,000,000 行 ≈ 每行 57.4 字节
差值约 18 字节 = 13 字节隐藏列 + 约 5 字节页内开销（预留的 1/16、页目录、页头等）
```

多出的空间换来 MVCC 与崩溃恢复。

## 三、行溢出

### 3.1 规则

B+ 树一页至少要放 2 行才有意义：只放 1 行时，分裂后仍是每页 1 行，树退化为链表（此解释出自《MySQL 技术内幕：InnoDB 存储引擎》）。手册规定：存于页内的行数据最大略小于半页，16KB 页时略小于 8KB。超出时把长字段挪到**溢出页**（8.0 中页类型为 LOB 页）。

| 行格式 | 长字段的存放（手册原文） |
| --- | --- |
| COMPACT | 前 768 字节留在行内，其余存溢出页 |
| DYNAMIC（默认） | 整个字段存溢出页，行内只留 **20 字节指针**；行太长时从最长的列开始挪，直到能放进页；长度 ≤ 40 字节的 TEXT/BLOB 一定留在行内 |

### 3.2 实验

三张表结构相同：`(id INT PRIMARY KEY, title VARCHAR(100), body TEXT)`，各 5000 行。

| 表 | 行格式 | body 长度 |
| --- | --- | --- |
| `t_doc_dyn` | DYNAMIC | 10016 字节 |
| `t_doc_cmp` | COMPACT | 10016 字节 |
| `t_doc_mid` | DYNAMIC | 3008 字节 |

解析 `.ibd` 页类型：

```
            B+树页   其中叶子页   每叶子页行数   溢出页（LOB）
t_doc_dyn     21        20          250.0          5000
t_doc_cmp    280       279           17.9          5000
t_doc_mid   1002      1001            5.0             0
```

逻辑读（Buffer Pool 已热，`id <= 2000`）：

```
                     只查 id, title    查 id, title, body
t_doc_dyn（10KB）         31                4023
t_doc_cmp（10KB）        137                4130
t_doc_mid（3KB）         425                 —
```

### 3.3 解读

1. **DYNAMIC 把大字段整个挪出**：10KB 超过半页，每行一个溢出页；行内只剩 id、title 和 20 字节指针，每叶 250 行，只查 title 读 31 页。
2. **COMPACT 留 768 字节前缀**：每叶只能放约 18 行，叶子页多 14 倍，只查 title 读 137 页。这是 DYNAMIC 取代 COMPACT 成为默认格式的原因。
3. **反直觉：中等长度的 TEXT 最拖累查询。**

::: warning 易混淆
| 错误理解 | 正确理解 |
| --- | --- |
| TEXT 都存在溢出页，不影响主表 | 能放进页的 TEXT 留在行内；3KB 的 body 全部留在行内 |
| body 越大，只查 title 越慢 | 3KB 表只查 title 读 425 页，是 10KB 表（31 页）的 13 倍多 |
:::

`t_doc_mid` 每叶只放 5 行，即使不查 body，扫描与范围查询也要读大量页，Buffer Pool 中也挤满用不到的 body。

4. **查大字段的代价**：查 body 时逻辑读从 31 涨到 4023，每行都要额外读溢出页，这就是大字段表上 `SELECT *` 的代价。

::: warning 统计口径差异
`mysql.innodb_index_stats` 中 `t_doc_dyn` 的 `n_leaf_pages` 显示约 5020：溢出页分配在叶子段中，被计入了叶子段页数。真正的 B+ 树叶子页只有 20 个，需解析文件才能区分。
:::

### 3.4 工作建议

| 场景 | 建议 |
| --- | --- |
| 大字段（文章、详情、JSON 配置），列表只显示标题 | 只查需要的列，不用 `SELECT *` |
| 大字段在几百字节到几 KB，表又常被扫描或范围查询 | 大字段拆到单独的表，主表只留常用小字段（垂直拆分，专题 35） |
| 大字段常整段读取 | 考虑放对象存储，库中只存地址 |

## 四、两个上限与行格式一览

| 上限 | 范围 | 沙箱实测 |
| --- | --- | --- |
| 65535 字节 | Server 层，对所有引擎，按各列**最大可能长度**计算；TEXT/BLOB 只计 9–12 字节 | `(a VARCHAR(10000), b VARCHAR(10000)) CHARACTER SET utf8mb4` → `ERROR 1118: Row size too large. The maximum row size for the used table type, not counting BLOBs, is 65535`；把 b 改为 TEXT 即可建表 |
| 略小于 8KB | InnoDB 页内部分（16KB 页） | 33 个 `CHAR(255)`（latin1）→ `ERROR 1118: Row size too large (> 8126)`；CHAR 定长不能挪出；`innodb_strict_mode`（实测 1）开启时建表即报错 |

| 行格式 | 说明 |
| --- | --- |
| REDUNDANT | 最老的格式，仅为兼容保留 |
| COMPACT | 长字段行内保留 768 字节前缀 |
| DYNAMIC | 8.0 默认；长字段整个存溢出页，行内 20 字节指针 |
| COMPRESSED | DYNAMIC 基础上压缩页，`KEY_BLOCK_SIZE` 指定压缩后页大小；省空间、耗 CPU，Buffer Pool 中可能同时存压缩页与解压页 |

::: tip PG 对照
PostgreSQL 的对应机制是 **TOAST**：一行超过约 2KB 时先压缩大字段，仍太大则挪到单独的 TOAST 表，原行留指针。PG 默认压缩且阈值远小于半页，“中等长度字段撑大主表”的问题较轻。
:::

## 五、在三条主线中的位置与诊断要点

```
A 性能：… → 索引 → [页内：页目录二分 → 组内链表；行大小决定每页行数] → Buffer Pool → 磁盘
         每页行数越少，同样的查询读的页越多
B 一致性：行中的事务 ID、回滚指针是 MVCC 的物理基础（专题 24）
C 诊断：见下表
```

| 观察点 | 回答的问题 |
| --- | --- |
| `information_schema.TABLES` 的 `AVG_ROW_LENGTH` | 平均每行占多少字节（含页内开销） |
| `mysql.innodb_index_stats` 的 `n_leaf_pages` | 叶子页数是否与数据量相称（注意溢出页也被计入） |
| 只查小字段时逻辑读仍很高 | 怀疑中等长度大字段留在行内 |
| `INNODB_TABLES` 的 `ROW_FORMAT` | 是否仍是老的 COMPACT |

## 六、本地复现脚本

在专题 1 的 Docker 环境（`mysql:8.4`）中执行。

```sql
USE lab;
SELECT @@innodb_default_row_format, @@innodb_strict_mode;
SELECT NAME, ROW_FORMAT FROM information_schema.INNODB_TABLES WHERE NAME = 'lab/t_order';
SELECT TABLE_NAME, AVG_ROW_LENGTH FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'lab' AND TABLE_NAME = 't_order';

SET SESSION cte_max_recursion_depth = 100000;
CREATE TABLE t_doc_dyn (id INT PRIMARY KEY, title VARCHAR(100) NOT NULL, body TEXT) ROW_FORMAT = DYNAMIC;
CREATE TABLE t_doc_cmp (id INT PRIMARY KEY, title VARCHAR(100) NOT NULL, body TEXT) ROW_FORMAT = COMPACT;
CREATE TABLE t_doc_mid (id INT PRIMARY KEY, title VARCHAR(100) NOT NULL, body TEXT) ROW_FORMAT = DYNAMIC;
INSERT INTO t_doc_dyn WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 5000)
  SELECT n, CONCAT('title-', n), REPEAT(MD5(n), 313) FROM s;     -- 10016 字节
INSERT INTO t_doc_cmp SELECT * FROM t_doc_dyn;
INSERT INTO t_doc_mid WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 5000)
  SELECT n, CONCAT('title-', n), REPEAT(MD5(n), 94) FROM s;      -- 3008 字节

-- 逻辑读对比：前后各查一次 Innodb_buffer_pool_read_requests 算差值（Buffer Pool 热时）
SELECT id, title FROM t_doc_dyn WHERE id <= 2000;
SELECT id, title, body FROM t_doc_dyn WHERE id <= 2000;
SELECT id, title FROM t_doc_cmp WHERE id <= 2000;
SELECT id, title FROM t_doc_mid WHERE id <= 2000;

-- 两个上限
CREATE TABLE t_big1 (a VARCHAR(10000), b VARCHAR(10000)) CHARACTER SET utf8mb4;   -- 预期 ERROR 1118 (65535)
CREATE TABLE t_big2 (a VARCHAR(10000), b TEXT) CHARACTER SET utf8mb4;             -- 成功
```

解析页结构（可选）：

```bash
# 1) mysql 客户端中执行并保持连接：FLUSH TABLES t_order FOR EXPORT;
# 2) 另开终端：
docker cp mysql84:/var/lib/mysql/lab/t_order.ibd ./t_order.ibd
# 3) 回到 mysql 客户端：UNLOCK TABLES;
python3 pages.py t_order.ibd
```

```python
# pages.py：统计每个索引、每一层的页数与平均行数
import struct, sys, collections
P = 16384
f = open(sys.argv[1], 'rb').read()
u16 = lambda b, o: struct.unpack('>H', b[o:o+2])[0]
st = collections.defaultdict(list)
for i in range(len(f) // P):
    pg = f[i*P:(i+1)*P]
    if u16(pg, 24) != 17855:          # 页类型 17855 = B+ 树索引页
        continue
    H = 38                             # Page Header 起始偏移
    level = u16(pg, H + 26)
    index_id = struct.unpack('>Q', pg[H+28:H+36])[0]
    st[(index_id, level)].append((u16(pg, H), u16(pg, H + 2), u16(pg, H + 16)))
for (idx, lvl), v in sorted(st.items()):
    k = len(v)
    print(f"index_id={idx} level={lvl} pages={k} "
          f"avg_recs={sum(x[2] for x in v)/k:.1f} avg_slots={sum(x[0] for x in v)/k:.1f} "
          f"avg_heap_top={sum(x[1] for x in v)/k:.0f}")
```

index_id 与索引名的对应：

```sql
SELECT i.NAME, i.INDEX_ID FROM information_schema.INNODB_INDEXES i
JOIN information_schema.INNODB_TABLES t USING (TABLE_ID) WHERE t.NAME = 'lab/t_order';
```

**预期现象**：PRIMARY 共 3 层，叶子每页约 217 行、已用约 15200 字节；`idx_user` 叶子填充率明显更低；DYNAMIC 10KB 表的 B+ 树叶子页约 20 个，COMPACT 约 280 个，3KB 表约 1000 个；只查 title 的逻辑读按同样顺序递增。

## 七、与其他专题的关联

- **专题 3**：补全“叶子页内如何找到一行”。
- **专题 6**：InnoDB 与 MyISAM 的空间差异在 2.4 节得到逐字节解释。
- **专题 9**：页分裂、页合并与页填充率。
- **专题 11**：`key_len` 的计算与本节的字段字节数一致。
- **专题 24**：事务 ID、回滚指针与 MVCC 可见性。
- **专题 30**：File Trailer 校验与“半写页”。
- **专题 34、35**：数据类型选择、垂直拆分大字段。

## 八、复习 checklist

- [ ] 能画出 16KB 页的布局，说出 Infimum、Supremum 与页目录的作用
- [ ] 能描述在叶子页内查找一行的过程（槽二分 + 组内链表）
- [ ] 能解释顺序插入与随机插入下页填充率的差异（约 15/16 与 1/2～15/16）
- [ ] 能说出 DYNAMIC 行格式的组成，并手算一行 `t_order` 的字节数
- [ ] 知道两个隐藏列的含义，以及它们与 MVCC 的关系
- [ ] 能解释 InnoDB 比 MyISAM 大的来源
- [ ] 能说明行溢出的触发条件，以及 COMPACT 与 DYNAMIC 的差异
- [ ] 能解释为什么中等长度的 TEXT 最拖累不查它的查询
- [ ] 能区分 65535 字节与约 8KB 两个上限
