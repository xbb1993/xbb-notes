# InfluxDB 全景、快速入门与全链路地图

> 专题 1 · 模块一 · ☆ 高频重点 · 主线：W S Q O（全部主线的地图）
> 版本基线：生产 1.13.2；本篇实验在云端 1.6.7 上真实运行，与 1.13.2 可能存在的差异已标注。

## 一、核心概念

### 1.1 时序数据有多大：从一个场景算起

场景：1 万块电表，每 15 秒上报一次累计电度。

```
一块表一天：86400 ÷ 15 = 5,760 条
1 万块表一天：5,760 × 10,000 = 5,760 万条
一年：≈ 210 亿条（还只是 1 个测量值）
```

**时序数据**（Time Series Data）：按时间顺序产生、每条都带时间戳的测量值。
**时序数据库**（TSDB，Time Series Database）：专门为这类数据设计的数据库。

### 1.2 时序数据的五个特点（每个都对应后面的一个设计）

| 特点 | 电表里的样子 |
|---|---|
| 只往后追加 | 只会报"现在"的读数 |
| 写多，几乎不改 | 读数写进去一般不改（补传、修数例外） |
| 新数据热，旧数据冷 | 今天的曲线常看，三年前的很少查 |
| 整段过期 | "原始数据保留 90 天"，过期整段删 |
| 按时间窗口聚合 | "m1 上个月每天用了多少电" |

### 1.3 朴素方案：用 MySQL 直接存会卡在哪

表 `meter_reading(time, meter_id, kwh)`，主键 `(meter_id, time)`：

- **写入**：每行都要维护 B+ 树，210 亿行的索引本身就巨大。
- **过期**：`DELETE` 逐行删，还要写 undo 和 binlog。
- **空间**：每行有行头，`meter_id` 每行重复一遍；相邻读数相差很小的规律没被用来压缩。

> 边界：关系库按时间分区，过期时删分区，就能缓解删除问题。TimescaleDB 走的正是这条路（专题 47）。这里只是借朴素方案引出 InfluxDB 的设计动机。

### 1.4 InfluxDB 的四个设计（类比：档案室）

**设计 1：同一条时间线的数据放在一起，按时间排好 → series**

写入格式叫**行协议**（Line Protocol），一条数据就是一行文本：

```
meter,meter_id=m1 kwh=1000.5 1764028800000000000
└─┬─┘ └────┬────┘ └───┬────┘ └────────┬────────┘
measurement  tag      field         时间戳（纳秒）
```

- **measurement**（测量名）：相当于"表名"。
- **tag**（标签）：说明"是哪块表"，会被索引，用来筛选和分组。
- **field**（字段）：真正的测量值，不建索引。
- **series**（时间线）：measurement + 一组确定的 tag 值。`meter,meter_id=m1` 就是一条 series，m1 的所有读数都属于它。
  - 补充（专题 3）：这是**索引层**的用法。官方定义的 series 还包含 field key（存储层每一列 = series key + field），两种用法的区别见专题 3。
- 类比：一个人的档案袋。

**设计 2：按时间切箱子，过期整箱扔 → shard 与保留策略**

- **shard**（分片）：负责一段固定时间的数据，在磁盘上是一个目录。
- **保留策略**（RP，Retention Policy）：规定数据保留多久、每个 shard 装多长时间。
- 层次：数据库 → 保留策略 → shard。
- 类比：按周装的档案盒，过期整盒销毁。

**设计 3：先记流水账，再批量整理归档 → WAL、Cache、TSM、压实**

| 组件 | 是什么 | 档案室类比 |
|---|---|---|
| WAL（Write-Ahead Log，预写日志） | 只追加的日志文件；写得快，崩溃后能找回 | 前台流水登记簿 |
| Cache | 内存中按 series 组织的新数据，写完马上能查 | 桌上按档案袋分好的待整理件 |
| TSM 文件 | Cache 一次性写成的有序、压缩的磁盘文件 | 装订好的正式卷宗 |
| compaction（压实） | 后台把小 TSM 文件合并成大文件 | 把薄卷宗合订成厚卷宗 |

Cache 写成 TSM 文件这一步叫 snapshot（快照），触发条件之一是 shard 冷了：默认 10 分钟没有新写入（`cache-snapshot-write-cold-duration = 10m`，已对照官方配置文档）。

**设计 4：用目录卡从标签找到档案袋 → 索引**

- **索引**：从 tag 值查到有哪些 series。
- 1.x 有两种实现：**inmem**（整张表在内存里，默认）和 **tsi1**（表在磁盘上）。你们生产环境两种混用，见专题 18。
- 类比：目录卡片柜。

### 1.5 全链路地图（方括号里是讲透它的专题）

```
【写入路径】
 电表/网关/Telegraf
        │  HTTP POST /write，行协议文本                          [5, 32]
        ▼
 ① 解析行协议 → measurement / tag / field / 时间戳               [2]
        ▼
 ② 拼出 series key：meter,meter_id=m1                            [3]
        ▼
 ③ 查索引：这条 series 见过吗？没见过就登记                       [14–18]
        ▼
 ④ 按时间戳决定进哪个 shard                                       [4]
        ▼
 ⑤ 追加写 WAL                                                    [8]
        ▼
 ⑥ 放进内存 Cache                                                [8]
        ▼
 ⑦ 返回 204
        ┊ 之后在后台进行
        ▼
 ⑧ Cache 写成 TSM 文件（snapshot）→ 小文件合并成大文件（压实）      [9, 11]

【查询路径】
 SELECT ... WHERE meter_id='m1' AND time > now()-1d
        ▼
 ① 解析语句                                                     [19]
        ▼
 ② 按时间范围挑出相关 shard                                      [24]
        ▼
 ③ 用索引按 tag 条件找到 series                                  [14]
        ▼
 ④ 每条 series：Cache 新数据 + TSM 旧数据合并                     [9, 24]
        ▼
 ⑤ 按时间窗口聚合，返回结果                                       [20, 21, 31]
```

### 1.6 四个观察入口

| 入口 | 用来看什么 |
|---|---|
| `influx` 命令行 | 建库、查询、查看 RP 和 shard |
| HTTP `/write`、`/query` | 程序读写都走这里；返回码是排查写入问题的第一手线索 |
| `influx_inspect` | 离线查看磁盘上的 TSM、WAL、索引文件 |
| `_internal` 库 | InfluxDB 自己记录的运行指标 |

### 1.7 生态与版本定位

- **TICK 四件套**：Telegraf 采集、InfluxDB 存储、Chronograf 界面、Kapacitor 告警与流处理。在"电表 → 网关 → MQTT broker → 入库"这条链路里，InfluxDB 位于末端。
- **三代版本**：
  - 1.x：TSM + InfluxQL，开源版只能单机。
  - 2.x：存储引擎沿用 TSM，组织方式（bucket）、鉴权（令牌）、主查询语言（Flux）都变了。
  - 3.x：Rust 重写，列式文件加对象存储，查询用 SQL 和 InfluxQL，不再支持 Flux。
  - 详见专题 46。
- **1.x 版本线**：1.8.10 之后开源版中断近四年，到 1.11.7 才恢复，之后一直更新到 1.13.2（生产在用，也是官方 v1 文档当前版本）。网上大量资料停在 1.8 时代，阅读时要先确认对应版本。
- 开源版没有集群；集群只在收费的 Enterprise 版里。
- Docker Hub 的 `latest` 标签已指向 InfluxDB 3 Core。部署 1.x 必须写明版本，例如 `influxdb:1.13.2`（官方 Docker 安装文档使用此标签）。

### 1.8 实验记录：写一条读数，看磁盘上发生了什么（云端 1.6.7 实测）

| 步骤 | 真实输出（摘要） | 说明了什么 |
|---|---|---|
| 刚启动 | 只有 `meta/meta.db` | 元数据：库、RP、shard、用户的登记表，不存读数 |
| 写入一条 | `HTTP/1.1 204 No Content` | 写入成功的标准返回 |
| 写入后的目录 | `data/energy/autogen/1/fields.idx`（22 B）、`wal/energy/autogen/1/_00001.wal`（52 B）、`data/energy/_series/00…07/0000`（每个 4 MB） | 库 → RP → shard 三层目录对应设计 2；WAL 记下了这次写入；`fields.idx` 记录 field 的类型；`_series` 是库级 series 登记簿，8 个分区，每个预分配 4 MB；**此时还没有 `.tsm` 文件** |
| 查看 RP 与 shard | `autogen 0s 168h0m0s`；shard 1 的范围是 `2025-11-24 → 2025-12-01` | `0s` 表示永久保留，每个 shard 装 7 天；数据时间是 11-25，箱子却从 11-24（周一）开始，说明 shard 边界按日历对齐（专题 4） |
| 重启后再查 | 数据还在；日志里有 `cacheloader ... Reading file ... _00001.wal`、`index_version=inmem` | 启动时重放 WAL，在内存里重建 Cache；默认使用内存索引 |
| 把冷写入时长临时改为 10s | 出现 `000000001-000000001.tsm`（104 B）；日志 `Snapshot for path written` | Cache 写成了 TSM 文件 |
| 约 10 秒后 | 出现 `_internal` 库，含 `tsm1_wal`、`tsm1_cache`、`tsm1_filestore`、`write`、`queryExecutor` 等 | 地图上每一段都有对应的运行指标 |

**未解释的现象**：快照后 `_00001.wal` 仍然存在。推测是重启后这个文件被当成"当前正在写的段"，所以没删。这一点**未核实**，留到专题 8 验证。

本地复现（1.13.2）：

```bash
docker run -d --name influx113 -p 8086:8086 influxdb:1.13.2
sleep 5
docker exec influx113 influx -execute 'CREATE DATABASE energy'
curl -s -i -XPOST 'http://localhost:8086/write?db=energy' \
  --data-binary 'meter,meter_id=m1 kwh=1000.5 1764028800000000000' | head -1
docker exec influx113 influx -database energy -execute 'SELECT * FROM meter; SHOW SHARDS'
docker exec influx113 find /var/lib/influxdb -maxdepth 5 | sort
docker restart influx113 && sleep 5 && docker logs influx113 2>&1 | grep -iE 'Reading file|Opened shard'
```

## 二、易混淆 / 易错点

| 错误理解 | 正确理解 |
|---|---|
| series 就是一行数据 | series 是一条"线"，名字只由 measurement 和 tag 值决定，与时间无关；m1 的所有读数都属于同一条 series |
| 查询结果里 tag 和 field 并排显示，所以它们是同类的"列" | 显示上看着像，存储上完全不同：tag 建索引、决定 series；field 不建索引，是测量值 |
| 返回 204 就说明数据已经写进 TSM 文件了 | 204 时数据只在 WAL 和内存 Cache 里；落成 TSM 是后台的事 |
| 重启后内存里的数据就丢了 | 启动时会重放 WAL，重建 Cache |
| shard 从第一条数据的时间开始算 | shard 边界按固定日历对齐（本例从周一 00:00 UTC 开始） |
| 写了一条数据，磁盘只增加几十字节 | `_series` 会预分配空间，本例写一条就占了 8 × 4 MB |
| 网上资料都适用于我们的 1.13.2 | 大量资料停在 1.8 时代，默认值和功能可能已经变了 |
| 部署 1.x 用 `influxdb:latest` 就行 | `latest` 已指向 InfluxDB 3 Core，必须写明版本号 |
| 时序库能做的关系库都做不了 | 关系库按时间分区也能缓解问题；TimescaleDB 就是这条路线 |

## 三、与其他章节的关联

| 关联对象 | 关系 |
|---|---|
| 专题 2、3 | 本篇提前用到的 measurement / tag / field / series，在那里讲透 |
| 专题 4 | shard 边界对齐规则、RP 层次 |
| 专题 8、9、11 | WAL、Cache、TSM、压实的完整机制；验证"快照后 WAL 未删除"的现象 |
| 专题 14–18 | 索引；生产环境混合索引 |
| 专题 24、31 | 查询路径的执行细节与成本 |
| 专题 40 | `_internal` 指标 |
| 专题 46、47 | 2.x / 3.x 与其他时序数据库 |
| MySQL：redo log、B+ 树 | WAL 与 redo log 同为"先写日志再确认"；B+ 树就地更新 vs TSM 追加加合并 |
| Redis：AOF / RDB | WAL ≈ AOF（追加日志）；TSM 快照 ≈ 把内存状态整理成文件 |
| MQTT 主题 | InfluxDB 是"电表 → 网关 → broker → 入库"链路的末端 |

## 四、复习 checklist

- [ ] 能算出"1 万块表、每 15 秒一条"一年的数据量量级
- [ ] 能说出时序数据的五个特点，并各对应一个 InfluxDB 设计
- [ ] 能说出 MySQL 朴素方案的三个问题，以及"分区"这一缓解办法
- [ ] 能拆解一行行协议的四个部分，并说出 series 由什么决定
- [ ] 能解释库 → RP → shard 三层，以及为什么按时间分箱能让过期删除变便宜
- [ ] 能按顺序讲出 WAL → Cache → TSM → 压实，并用档案室类比各说一句
- [ ] 能不看图画出写入路径 8 步、查询路径 5 步
- [ ] 知道返回 204 时数据还不在 TSM 文件里，重启后靠重放 WAL 恢复
- [ ] 知道四个观察入口各用来看什么
- [ ] 能各用一句话说出 1.x、2.x、3.x 的定位，以及 1.x 版本线的"断档"
- [ ] 知道部署 1.x 时必须写明镜像版本号
