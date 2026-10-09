# 第10章 RDB持久化

## 核心概念

**要解决的问题**：Redis 是内存数据库，数据库状态（所有非空数据库及其键值对）只存在内存里——进程一退出，数据全没了。RDB 持久化要解决的就是"把某个时间点的数据库状态存到磁盘上，进程重启后还能还原回来"这件事。

### 10.1 创建 RDB 文件：SAVE 与 BGSAVE

**`SAVE`**：服务器进程自己执行 `rdb.c/rdbSave`，直接把内存状态写盘。写的过程中服务器被完全阻塞，所有客户端请求都要排队等，写完才恢复处理。

**`BGSAVE`**：`fork` 一个子进程去执行 `rdbSave`，父进程（服务器本身）继续正常处理请求。之所以能这样做而不破坏数据一致性，靠的是操作系统的**写时复制（COW）**：`fork` 那一刻子进程复制的只是内存页表，不是物理内存本身；之后父进程或子进程谁写了某一页，才会真正触发那一页的复制。所以子进程手里的"快照"始终是 `fork` 那一刻的数据，父进程后续的写入不会污染它。这跟第4章"`BGSAVE`/`BGREWRITEAOF` 期间调高字典 rehash 阈值"背后是同一个 COW 考量的另一次应用——都是为了减少父进程在子进程"拍照"期间产生的额外页复制。

**`BGSAVE` 期间三个命令的不同待遇**（这是本章一个重点辨析点）：

| 命令 | 处理方式 | 原因 |
|---|---|---|
| `SAVE` | 直接拒绝 | 避免父进程和子进程同时对同一个 RDB 文件执行 `rdbSave`，产生竞态、文件内容错乱 |
| `BGSAVE` | 直接拒绝 | 再 fork 一个子进程重复做同样的事，没必要且浪费资源 |
| `BGREWRITEAOF` | **延迟**到 `BGSAVE` 完成后执行 | 两者操作**没有任何逻辑冲突**（一个写 RDB 文件一个写 AOF 文件，各自基于 fork 时的内存快照独立工作），纯粹是**性能考量**——两个子进程同时做大量磁盘 I/O 会互相抢资源 |

服务器用 `aof_rewrite_scheduled` 标记"是否有 `BGREWRITEAOF` 被延迟"，用 `rdb_child_pid`、`aof_child_pid` 两个**独立**属性分别追踪两个持久化子进程的 PID（没在跑则为 -1）。这两个字段各自独立存在，恰好印证了"两者本可以同时追踪、技术上不是做不到并存"，进一步说明排队纯粹是主动的性能选择，不是逻辑上必须互斥。

**载入**：RDB 文件的载入没有专门命令，由 `rdb.c/rdbLoad` 在服务器**启动时自动执行**，检测到文件存在就载入；载入期间服务器同样处于阻塞状态。如果服务器同时开启了 AOF 持久化，会优先用 AOF 文件还原数据（AOF 更新频率通常更高、更接近实时），只有 AOF 关闭时才用 RDB 还原。

### 10.2 自动间隔性保存

**要解决的问题**：`BGSAVE` 不阻塞服务器了，但还得靠人手动敲命令，生产环境需要"定期自动拍快照"。

**方案**：`save` 选项配置多组"秒数+修改次数"条件，例如：

```
save 900 1
save 300 10
save 60 10000
```

`serverCron`（默认每100毫秒跑一次）遍历 `saveparams` 数组，**任意一条条件满足**就执行一次 `BGSAVE`（不是要全部满足，也不是互相覆盖取最严的一条）：

```python
for saveparam in server.saveparams:
    save_interval = unixtime_now() - server.lastsave
    if server.dirty >= saveparam.changes and save_interval > saveparam.seconds:
        BGSAVE()
```

支撑判断的两个状态字段：`dirty`（距上次成功持久化以来的修改次数，读写键空间时会顺带 +1，这是第9章"键空间读写顺带维护动作"的具体一项）、`lastsave`（上次成功持久化的 Unix 时间戳）。`BGSAVE` 完成后 `dirty` 清零、`lastsave` 更新，作为下一轮判断的新起点。

**为什么要多档配置而不是单一固定周期**：单一定时策略两头不讨好——数据长期不变时白跑一次 `BGSAVE`（`fork` 的页表复制、COW 期间的潜在内存膨胀都不是零成本，尤其对大内存实例）；数据变动很频繁时又可能在两次快照之间丢太多数据。多档"次数+时间"组合，本质是给不同烈度的写入场景各设一道保险，两个维度互相兜底。

### 10.3 RDB 文件结构

**整体布局**：

```
REDIS(5字节) + db_version(4字节) + databases(可为空) + EOF(1字节) + check_sum(8字节)
```

`REDIS` 是固定标识字符串，`db_version` 是字符串形式的版本号（如 `"0006"`），`EOF` 标志正文结束，`check_sum` 是对前三部分内容计算出的校验和——载入时重新计算一遍对比，检测文件是否损坏。

**`databases` 部分**：可包含零个或任意多个非空数据库，每个数据库由 `SELECTDB`（1字节常量）+ `db_number`（1/2/5字节，读到后据此切换目标数据库）+ `key_value_pairs` 组成。

**`key_value_pairs`**：不带过期时间的键值对是 `TYPE + key + value`；带过期时间的是在前面插入 `EXPIRETIME_MS`（1字节常量）+ `ms`（8字节毫秒级 UNIX 时间戳），即 `EXPIRETIME_MS + ms + TYPE + key + value`。`key` 总是按字符串对象规则保存；`TYPE`（1字节）决定 `value` 该怎么读——常见取值：`REDIS_RDB_TYPE_STRING`/`LIST`/`SET`/`ZSET`/`HASH`（对应各类型的非紧凑编码）、以及 `LIST_ZIPLIST`/`SET_INTSET`/`ZSET_ZIPLIST`/`HASH_ZIPLIST`（对应紧凑编码）。

**value 的编码——按类型逐个过**：

1. **字符串对象**：编码只有两条分支——
   - `REDIS_ENCODING_INT`（能用 long 表示的整数）：按整数实际大小定长存，`ENCODING` 取 `REDIS_RDB_ENC_INT8`/`INT16`/`INT32` 之一，不退化成"数字转文本"，延续第6章"按需选最小够用类型"的哲学。
   - `REDIS_ENCODING_RAW`（其余情况，运行时是 `embstr` 还是 `raw` 在这里**不区分**）：长度 ≤20字节或关闭了 `rdbcompression` 配置时原样存 `len+string`；长度 >20字节且开启压缩（默认开启）时用 LZF 压缩，存 `ENCODING(LZF) + compressed_len + origin_len + compressed_string`。

2. **List（`REDIS_ENCODING_LINKEDLIST`）**：`list_length + item1 + item2 + ...`，每个 item 按字符串对象规则存。

3. **Set（`REDIS_ENCODING_HT`）**：`set_size + elem1 + elem2 + ...`，结构和 List 几乎一样。

4. **Hash（`REDIS_ENCODING_HT`）**：`hash_size + key1 + value1 + key2 + value2 + ...`，同一键值对的键紧挨着值。

5. **Zset（`REDIS_ENCODING_SKIPLIST`）**：`sorted_set_size + member1 + score1 + ...`，`score` 是 double，但**会先转换成字符串再按字符串对象规则存**（如 `3.14` → `"3.14"`），不是直接存 8 字节二进制。

6. **intset 编码的 Set（`REDIS_RDB_TYPE_SET_INTSET`）**：不单独定义格式，而是把整个 intset **整体转换成一个字符串对象**存下去；载入时先按字符串对象读回来，再转换回 intset。

7. **ziplist 编码的 List/Hash/Zset（`*_ZIPLIST`）**：同样是"整体包装成字符串对象"存，读回时先还原成 ziplist，再根据 `TYPE`（`LIST_ZIPLIST`/`HASH_ZIPLIST`/`ZSET_ZIPLIST`）决定这个 ziplist 该套上哪种逻辑类型的壳——`TYPE` 在这里同时承担"按 ziplist 解码"和"解码后是什么逻辑类型"两层信息。

**紧凑编码在 RDB 里"偷懒复用字符串保存逻辑"的设计**：ziplist/intset 整体打包成字符串对象、zset 的 score 转字符串再存，这两处是**同一条设计思路的三次应用**——把"非天然字符串"的东西包装成字符串对象，复用现成的字符串保存/读入/（可能的）压缩逻辑，不用为每种数据形态单独定义一套持久化格式。好处是实现简单、能顺带享受字符串已有的 LZF 压缩、对未来新增的紧凑结构（如现代 Redis 的 listpack）有天然的可扩展性；代价是 zset 的 score 存成字符串比存 8 字节二进制更占空间——这是用空间和转换开销换实现简单/可移植性的取舍。

### 10.4 分析真实 RDB 文件（`od -c` 命令）

**空数据库**：`SAVE` 后 `od -c dump.rdb` 输出 `REDIS0006` + `377`（EOF，八进制377=十进制255）+ 8字节校验和——因为 `databases` 为空，版本号后面直接跟 EOF。

**`SET MSG "HELLO"`**：`REDIS0006` + `376`（`SELECTDB`，八进制376=254）+ `\0`（数据库号0）+ `\0`（`TYPE`=`REDIS_RDB_TYPE_STRING`=0）+ `003`（key长度3）+ `MSG` + `005`（value长度5）+ `HELLO` + `377`（EOF）+ 校验和——和前面结构图逐字节对得上。

**`SETEX MSG 10086 "HELLO"`**：在 `SELECTDB`/`db_number` 和 `TYPE` 之间多出 `374`（`EXPIRETIME_MS`，八进制374=252）+ 8字节毫秒时间戳，之后仍是熟悉的 `TYPE+key+value`。

### 生产实践问题（讨论后约定推迟）

关于"持久化一致性和成本怎么取舍""不同场景怎么选方案"这两个实用问题，已在讨论中确认：**推迟到第11章 AOF 学完之后**专题展开，因为完整答案依赖 AOF 的 `appendfsync`（`always`/`everysec`/`no`）机制，而且现代 Redis（4.0+）生产主流是 RDB+AOF 混合持久化（`aof-use-rdb-preamble`），这本书没有覆盖，属于模块五「现代 Redis 补充篇」的内容。目前只确认了 RDB 一侧的结论：数据丢失窗口 = 上次成功快照到宕机的时间跨度，是 RDB 路径**结构性**的限制，调 `save` 频率只能缩小窗口、换来更频繁的 fork/COW 开销，消不掉这个窗口本身；`check_sum`/`EOF` 校验的是"文件有没有传输/写入损坏"，跟"业务数据有没有丢"是两个不同维度的保证。

## 易混淆/易错点

- **`BGSAVE` 和 `BGREWRITEAOF` 不能同时执行，是性能考量，不是逻辑冲突**：两者各自 fork、各自基于独立的内存快照工作，操作层面毫无交集；`rdb_child_pid`/`aof_child_pid` 两个独立属性的存在恰恰说明系统完全有能力同时追踪两者，只是主动选择不让它们抢占磁盘 I/O。
- **`SAVE`/`BGSAVE` 被拒绝是竞态问题，`BGREWRITEAOF` 被拒绝/延迟是性能问题**：三者虽然都发生在"`BGSAVE` 执行期间"，但拒绝 `SAVE`/`BGSAVE` 是为了避免真正的数据竞争（两边同时写同一个文件或重复 fork），延迟 `BGREWRITEAOF` 单纯是不想抢资源，不要把这两类原因混为一谈。
- **ziplist/intset 在 RDB 里没有专属文件格式分支**：不要以为 Redis 会为每种紧凑结构单独设计持久化格式，实际是"整体包装成字符串对象"复用现成逻辑，靠 `TYPE` 字段在读回时"补一刀"决定还原成什么类型。
- **RDB 结构里"紧凑编码怎么存"和第8章"运行时编码转换阈值"是两个完全不同的层次**：前者只关心持久化格式设计，跟 `hash-max-ziplist-entries` 之类运行时阈值毫无关系；后者才是决定对象"现在该用什么编码"的规则。载入完成时，一个对象即使按当前配置早就该转换成常规编码，也很可能仍以原编码存在（推断，非书本原文）——直到下一次写命令触发第8章的检查逻辑才会转换。
- **RDB 的 `REDIS_ENCODING_RAW` ≠ 运行时的 `raw` 编码**：RDB 层面根本不区分 `embstr`/`raw`，只要不是整数就统一按"长度+内容（可能压缩）"存，运行时编码是载入后根据长度重新判断的。
- **Zset 的 score 在 RDB 里存的是字符串，不是 8 字节二进制 double**：这是"包装成字符串对象复用逻辑"这条设计思路的第三个例子，跟 ziplist/intset 整体打包是同一哲学。
- **多档 `save` 条件是"任一满足即触发"**，不是必须同时满足，也不是只有最严格的一条数字生效——`serverCron` 每次都完整遍历所有条件。
- **RDB 的校验和保证的是文件完整性，不是业务一致性**：`check_sum` 能发现文件传输/存储损坏，但不能告诉你"这份快照距离宕机那一刻已经丢了多少数据"，这是两个不同维度的保证，讨论"数据恢复的一致性"时不要把两者混着说。

## 与其他章节的关联

- **第4章「字典」**：`BGSAVE` 依赖的 COW 机制，和 `BGSAVE`/`BGREWRITEAOF` 期间提高字典 rehash 阈值，是同一个 COW 考量在两处不同地方的应用——都是为了减少父进程在子进程持有快照期间产生的额外页复制。
- **第6章「整数集合」**：RDB 里整数字符串对象按大小选 `INT8`/`INT16`/`INT32` 定长存，和 intset "按需升级到最小够用类型"是同一条设计哲学；intset 本身在 RDB 里整体包装成字符串对象存、读回后再还原，是本章"紧凑结构靠包装字符串复用"这条思路的一个具体案例。
- **第7章「压缩列表」**：ziplist 编码的 List/Hash/Zset 在 RDB 里同样靠整体包装成字符串对象存，`TYPE` 字段区分它读回后该套上哪种逻辑类型的壳；这是本章"紧凑结构靠包装字符串复用"思路的另一个案例。
- **第8章「对象」**：RDB 的 `TYPE` 常量和 value 编码，与本章描述的字符串/List/Hash/Set/Zset 各类型的运行时编码直接对应；但"RDB 怎么存紧凑编码"和"运行时何时触发编码转换（`list-max-ziplist-entries` 等阈值）"是两个独立层次，不能混淆；`OBJECT ENCODING` 查到的编码，是载入完成后重新判断出来的，不完全由 RDB 文件里记录的 TYPE 决定。
- **第9章「数据库」**：`dirty` 计数器在数据库键空间的日常读写路径上就会顺带 +1（第9章"读写键空间顺带的维护动作"之一），本章只是讲了它在自动保存场景下的具体用法；过期键不会被写入新生成的 RDB 文件、主服务器载入 RDB 时过期键会被过滤（这是第9章 9.7 节已经讲过的结论，本章的 RDB 生成/载入流程正是这条规则的落地位置）。
- **第11章「AOF持久化」（待学）**：`aof_rewrite_scheduled`、`aof_child_pid` 这两个字段在本章已经出现，是 `BGSAVE`/`BGREWRITEAOF` 互斥调度的一部分，具体的 AOF 写入/重写机制留到下一章；"持久化一致性与成本的取舍""不同场景选型"这两个实用问题，约定在 AOF 学完后专题讨论。
- **模块五「现代 Redis 补充篇」（待学）**：RDB+AOF 混合持久化格式（`aof-use-rdb-preamble`）是本书未覆盖、但生产主流的做法，属于这个后续补充模块。

## 复习 Checklist

- [ ] 能说清 `SAVE` 和 `BGSAVE` 的实现差异（是否 fork 子进程、是否阻塞服务器），并说出 `BGSAVE` 依赖的 COW 原理
- [ ] 能完整复述 `BGSAVE` 期间对 `SAVE`/`BGSAVE`/`BGREWRITEAOF` 三个命令的不同处理方式，并准确解释"前两者是竞态问题、后者是性能问题"这个区分
- [ ] 能说出 `rdb_child_pid`/`aof_child_pid` 两个独立字段如何佐证"`BGSAVE`/`BGREWRITEAOF` 不冲突只是不并发"这个结论
- [ ] 能说清服务器载入数据时优先用 AOF 还是 RDB 的判断规则
- [ ] 能默写 `save` 多档条件"任一满足即触发"的判断逻辑，并说出 `dirty`/`lastsave` 各自的作用
- [ ] 能从"丢失窗口 vs fork/COW 开销"的角度，论证为什么用多档 save 条件而不是单一固定周期
- [ ] 能默写 RDB 整体结构（`REDIS`+`db_version`+`databases`+`EOF`+`check_sum`）和数据库结构（`SELECTDB`+`db_number`+`key_value_pairs`），以及带/不带过期时间键值对的结构差异
- [ ] 能说出字符串对象在 RDB 里的两条编码分支（`INT8`/`16`/`32` vs 原样/LZF压缩的 RAW），以及压缩触发的长度阈值（20字节）
- [ ] 能默写 List/Set/Hash/Zset 各自的保存结构模板，并说清 Zset 的 score 为什么转成字符串存而不是存二进制 double
- [ ] 能准确说出 ziplist/intset 在 RDB 里"整体包装成字符串对象"的存法，并说清 `TYPE` 字段如何承担"按什么解码"和"解码后是什么逻辑类型"两层信息
- [ ] 能区分"RDB 结构里紧凑编码怎么存"和"第8章运行时编码转换阈值"这两个层次，不混为一谈
- [ ] 能看懂一段真实 `od -c` 输出（空库/字符串键/带过期字符串键），逐字节对应到结构定义
- [ ] 知道"持久化一致性/成本取舍""不同场景选型"这两个实用问题被推迟到 AOF 学完后专题讨论的原因
