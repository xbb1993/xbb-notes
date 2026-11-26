# 写入路径：WAL 与 Cache

> 专题 8 · 模块三 · ★ 核心必会 · 主线：W S
> 地图位置：写入路径第 ⑤⑥⑦ 步"写 WAL → 放进 Cache → 返回 204"。
> 依据：云端 1.6.7 实测 + 1.13.2 源码 `tsdb/engine/tsm1/`（另对照了 1.6.6 源码）。

## 一、核心概念

### 1.1 从"又要快又不能丢"推出两个部件

| 朴素方案 | 问题 |
|---|---|
| 直接写进排好序、压缩好的文件 | 每条都要随机读写、反复压缩，磁盘跟不上 |
| 只放内存，攒够再写盘 | 进程崩溃时数据丢失 |

| 部件 | 负责 | 做法 | 类比 |
|---|---|---|---|
| **Cache** | 快，而且马上能查到 | 内存中按列（series + field）组织，不压缩 | 桌上分好袋的待整理文件 |
| **WAL**（Write-Ahead Log，预写日志） | 不丢 | 只在文件末尾追加，写完 fsync | 前台流水登记簿 |

与 MySQL redo log、Redis AOF 是同一个思路：先记日志，再确认成功。

### 1.2 一次写请求的完整顺序（1.13.2 源码 `Engine.WritePoints`）

```
① 解析、落箱、类型检查
② Cache.WriteMulti      ← 先写 Cache；超过上限就直接报错，WAL 不会被写
③ WAL.WriteMulti        ← Snappy 压缩后追加
④ 等待 fsync 完成       ← "schedule an fsync and wait for it to complete"
⑤ 返回 204
```

官方文档的描述是"先写 WAL 再写 Cache"，但源码实际是先 Cache 后 WAL。结论相同：**返回 204 时，数据已在 Cache 中，并已刷入 WAL 文件。**

| | WAL | Cache |
|---|---|---|
| 归属 | 每个 shard 一份：`wal/库/RP/shard号/_0000N.wal` | 每个 shard 一份（每个 shard 的存储引擎各自创建） |
| 创建 | shard 第一次写入时 | shard 打开时 |
| 内容来源 | 每次写请求压缩后追加 | 每次写请求直接放入；重启时由 WAL 重建 |
| 清理 | 快照成功后，删除已关闭的分段 | 快照成功后，释放被快照的部分 |
| 组织方式 | 按写入顺序追加 | key = `series key#!~#field`，与 TSM 的 key 相同 |
| 压缩 | 每条记录 Snappy 压缩 | 不压缩 |

### 1.3 WAL 的分段与删除

- 分段大小约 10 MB（`DefaultSegmentSize = 10 * 1024 * 1024`），写入前检查，所以会略微超出。
- 快照时：关闭当前分段并开新分段 → Cache 写成 TSM → 删除已关闭的分段。

实测（默认配置，分批写入 57.6 万行宽表数据）：

```
12 万行   4981136  _00001.wal
36 万行  10786131  _00001.wal ；4164046 _00002.wal    ← 超过 10 MB 后切换分段
写完     3156198  _00003.wal                         ← 快照后 01、02 被删除
快照 1 次，TSM 文件 1 个
```

**专题 1 遗留问题的答案**：重启时最后一个分段会被重新打开，作为"当前分段"。

- 1.6.6 重新打开时没有恢复这个分段的已有大小（内部记为 0）。快照时判断它"是空的"，于是不开新分段，它也就不算"已关闭的分段"，不会被删除。
- 1.13.2 加了 `currentSegmentWriter.size = int(stat.Size())`，这个问题已修复（源码推断，未在 1.13.2 上实测）。
- 影响：只多占一点磁盘，每次重启会把同样的点再重放一遍（幂等覆盖），不丢数据、不产生重复。

### 1.4 fsync 与 `wal-fsync-delay`

- **fsync**：要求操作系统把文件真正写到磁盘，而不是停留在操作系统的缓冲区。
- `wal-fsync-delay`（默认 0s）：**等多久再刷盘、一次刷多少个请求**。每个请求仍然要等自己的数据刷盘后才返回，**不是"先返回、后刷盘"，不会增加丢数据风险，代价是延迟**。（这一条更正了大纲里的说法。）

实测（单次运行）：

| | 0s | 100ms |
|---|---|---|
| 串行 50 次小写入 | 0.30 秒 | 5.01 秒 |
| 并发 50 次小写入 | 0.15 秒 | 0.24 秒 |

串行写入时，每个请求都要等满一个窗口；并发写入时，一个窗口内的请求被合并成一次刷盘。适合磁盘 fsync 很慢、写入方多且并发的情况。

| | 返回时已刷盘？ | 可调的取舍 |
|---|---|---|
| Redis AOF `everysec` | 否，最多丢约 1 秒 | 丢失窗口 vs 性能 |
| MySQL `innodb_flush_log_at_trx_commit=2` | 否 | 丢失窗口 vs 性能 |
| InfluxDB 1.x | 是 | 只能调整刷盘的等待和合并（源码中这条路径没有"先返回后刷盘"的选项） |

**kill -9 实验**：拿到 204 后立刻 kill -9 → WAL 中有 52 字节 → 重启后数据还在。（kill -9 只模拟进程崩溃；断电的情况未实测，按源码推断也不会丢。）

### 1.5 Cache 的上限

规则（1.13.2 `Cache.WriteMulti`、`Cache.Size`）：

```
Cache 当前大小 + 正在快照中的部分 + 本批大小 > cache-max-memory-size（默认 1g）→ 拒绝
```

- 上限**按 shard 分别计算**，多个 shard 同时写入时，内存是几份 Cache 之和。
- 正在快照的那部分也计入，快照没写完之前一直占用。

实测（上限临时改为 2m）：

```
第 1 批 → 204
第 2 批 → {"error":"engine: cache-max-memory-size exceeded: (2560504/2097152)"}  [HTTP 500]
日志：msg="Write failed" service=write shard=36 ...
```

返回码是 **500**（服务端装不下），不是 400（数据有问题）。

**正常使用下离上限有多远**：Cache 只靠快照变小，快照阈值 25 MB（或冷写入 10 分钟）。实测 Cache 记账约每个值 16 字节（实际进程内存更大）。1 万块表 × 4 个 field × 每 15 秒，约每秒 43 KB，约 10 分钟触发一次快照。所以每个 shard 的 Cache 在 0～25 MB 之间涨落，与 1 GB 有约 40 倍的余量。

**会超限的情况**（某个 shard 的写入速度长时间超过快照写盘速度）：

| 场景 | 原因 |
|---|---|
| 批量导入、补传、重算覆盖历史数据（多路并发全速写入同一个 shard） | 快照还没写完，新数据持续进入 |
| 上限配置得接近或小于 25 MB | 还没到快照阈值就先碰到上限 |
| 磁盘 IO 被压实或其他进程占满 | 快照写得慢，正在快照的部分一直占用内存 |

**为什么设计成"拒绝且不写"**（根据源码顺序推断，官方没有说明原因）：

| 备选设计 | 问题 |
|---|---|
| 不设上限 | 内存耗尽，整个进程被杀，所有 shard 一起停止服务 |
| 只写 WAL、不进 Cache | 查询看不到这些数据；快照要从 Cache 生成 TSM，这部分无法落盘；重启时又会全部装回 Cache |
| 阻塞排队 | 请求体和连接继续占内存，客户端最终超时，问题只是被推迟 |
| **立即拒绝（实际采用）** | 背压：把"装不下"明确告诉上游，由上游退避重试 |

先检查 Cache、通过后才写 WAL，保证了**告诉客户端失败的数据，数据库里确实没有**，重启后也不会凭空出现。代价是写入方必须有缓冲，并对 500 退避重试。覆盖写是幂等的，所以重试是安全的。

### 1.6 每个 shard 一份，以及冷 shard 的成本

- shard 只按时间切分。1 个 RP、保留 1 年、7 天一个 shard → 约 52～53 个 shard，**每个 shard 都包含这一周里全部 1 万条 series 的数据**。不是 52 万个。
- 每个 shard 有 1 个 WAL 目录和 1 个 Cache。series 数决定的是 Cache 里有多少个 key（1 万 × 4 个 field = 4 万个 key）。
- 每多一个 RP 或一个库，就多一组 shard。

冷 shard 的实测状态（`SHOW STATS` 中 `tsm1_cache` 的 `memBytes`）：

```
s6wide / s6na / s6nb（早已快照）  memBytes = 0，WAL 目录中没有文件
r4c / t2                           memBytes = 40～98，WAL 有一个几十字节的分段（1.6.x 的遗留缺陷）
```

- 快照后，冷 shard 的 Cache 和 WAL 几乎不占资源。
- 不销毁这些结构，是因为旧 shard 随时可能再被写入：补传、覆盖历史数据、删除。被写入时它会临时变热，10 分钟没有新写入后再次快照并清空。
- **推论**：重算覆盖历史数据时，如果同时并发写很多个旧周，每个旧 shard 都会有一份正在增长的 Cache，内存会叠加。按时间顺序一周一周地做更稳妥。
- shard 多了以后，真正的成本是 TSM 文件句柄与内存映射、每个 shard 的索引、启动时打开所有 shard 的时间，而不是 Cache 和 WAL。

### 1.7 重启：WAL 重放

实测：快照阈值临时改为 1g，230.4 万个点全部留在 WAL 中（23 MB，0 个 TSM 文件）。重启后该 shard 打开耗时约 301 ms，`COUNT` = 2304000。

默认配置下，每个 shard 的 WAL 会随快照被删除，积累不多，所以重放一般不是启动慢的主要原因。主要原因通常是 inmem 索引的重建（专题 15 验证）。这只是单机小规模的测量结果。

### 1.8 串联图

```
写请求 → 解析 / 落箱 / 类型检查
  ▼
Cache.WriteMulti（每个 shard 一份）
  │  当前 + 快照中 + 本批 > 上限 → 500 cache-max-memory-size exceeded（不写 WAL）
  ▼
WAL.WriteMulti（每个 shard 一份，顺序追加，约 10 MB 一个分段）
  │  等待 fsync（wal-fsync-delay 只影响等多久、一次刷多少个请求）
  ▼
返回 204：Cache ✔  WAL 已刷盘 ✔  TSM ✘
  ┊ Cache 达到 25 MB 或 10 分钟无写入 → 快照（专题 11）
  ▼
关闭当前分段、开新分段 → 写 TSM → 删除已关闭的分段、释放 Cache
崩溃 / 重启：重放 WAL → 重建 Cache
冷 shard：Cache 为 0、WAL 无文件；再次被写入时临时变热
```

## 二、易混淆 / 易错点

| 错误理解 | 正确理解 |
|---|---|
| 返回 204 时数据已经在 TSM 文件里 | 在 Cache 和已刷盘的 WAL 里，TSM 要等快照 |
| 源码顺序和文档一样，先 WAL 后 Cache | 1.13.2 源码是先 Cache 后 WAL；Cache 满了就不会写 WAL |
| `wal-fsync-delay` 是先返回、后刷盘，有丢数据风险 | 请求仍然等到刷盘才返回；代价是延迟，用途是合并刷盘 |
| Cache 满了返回 400 | 返回 500 |
| Cache 上限是整个进程的 | 每个 shard 一份，按 shard 计算 |
| 正常写入也容易撑满 1 GB | 正常时在 0～25 MB 之间涨落；超限主要发生在批量写入同一个 shard 时 |
| 超限后数据只是暂时没进 Cache，WAL 里已经有了 | 先检查 Cache，失败就不写 WAL |
| 每个 series 一个 shard | shard 只按时间切分，一个 shard 包含这段时间内的所有 series |
| 冷 shard 的 Cache 和 WAL 很占资源 | 快照后几乎为 0 |
| 快照后旧 WAL 一定会被删除 | 1.6.x 重启后的最后一个分段例外；1.13.2 已修复 |
| 启动慢一定是 WAL 太大 | 单个 shard 的 WAL 一般不大，主要原因多在索引重建 |

## 三、与其他章节的关联

| 关联对象 | 关系 |
|---|---|
| 专题 1 | 快照后 WAL 未删除的现象，在这里找到原因 |
| 专题 4 | WAL 和 Cache 都按 shard 划分；补传、覆盖写会让旧 shard 临时变热 |
| 专题 5 | 重放与重试依赖幂等覆盖；400 与 500 的区别 |
| 专题 9 | Cache 的 key 与 TSM 文件的 key 相同 |
| 专题 11 | 快照的触发条件与压实；压实积压会导致 Cache 超限 |
| 专题 12 | 删除也要先写 WAL |
| 专题 15 | 启动慢的主要原因：inmem 索引重建 |
| 专题 33、35 | 批量写入、历史数据修订时控制并发与批量大小 |
| 专题 40 | `_internal` 中的 `tsm1_cache`、`tsm1_wal` 指标 |
| Redis AOF / MySQL redo log | 都是"先写日志"；刷盘时机的取舍不同 |
| MQTT 主题 | 背压：下游装不下时，上游要缓冲并重试 |

## 四、诊断实践

| 现象 | 看哪里 | 判断与处置 |
|---|---|---|
| 写入 500 `cache-max-memory-size exceeded` | 日志中的 `shard=`；磁盘 IO；压实是否积压；是否在批量导入或重写 | 快照跟不上。降低批量写入的并发、按 shard 顺序写入、查磁盘；不要急着调大上限 |
| 写入延迟高、吞吐低，但不报错 | `wal-fsync-delay`；写入方是否串行 | 串行写入时每个请求都要等满一个窗口 |
| 进程内存比预期高 | 同时有几个 shard 在写入（`SHOW STATS` 中各 shard 的 `tsm1_cache memBytes`） | Cache 按 shard 叠加 |
| `wal/` 目录持续增大 | 有没有 `Snapshot for path written` 日志 | 快照没有触发或一直失败 |
| 担心崩溃丢数据 | 启动日志中的 `Reading file ... cacheloader` | 已返回 204 的数据会被重放 |
| 启动慢 | 各 shard 的 `Opened shard ... duration=` | 区分是 WAL 重放慢还是索引重建慢 |

本地复现（1.13.2）：

```bash
docker exec influx113 influx -execute "CREATE DATABASE w8"
curl -s -XPOST 'http://localhost:8086/write?db=w8' --data-binary 'meter,meter_id=m1 kwh=1 1795593600000000000'
docker restart influx113
# 10 分钟后，预期 _00001.wal 已被删除（1.13.2 已修复）
docker exec influx113 sh -c 'ls -l /var/lib/influxdb/wal/w8/autogen/*/; find /var/lib/influxdb/data/w8 -name "*.tsm"'
# wal-fsync-delay 串行对比
docker run -d --name influx_fs -p 8087:8086 -e INFLUXDB_DATA_WAL_FSYNC_DELAY=100ms influxdb:1.13.2
sleep 5; docker exec influx_fs influx -execute "CREATE DATABASE w8f"
time (for i in $(seq 1 50); do curl -s -o /dev/null -XPOST "http://localhost:8087/write?db=w8f" --data-binary "m v=$i $((1795593600+i))000000000"; done)
# Cache 上限
docker run -d --name influx_cl -p 8088:8086 -e INFLUXDB_DATA_CACHE_MAX_MEMORY_SIZE=2m influxdb:1.13.2
# 把 wide.lp 拆成 2 万行一批写入 8088 端口，预期第二批开始返回 500
# 各 shard 的 Cache 占用
docker exec influx113 influx -execute "SHOW STATS FOR 'tsm1_cache'"
```

## 五、复习 checklist

- [ ] 能从"又快又不丢"推出 Cache 与 WAL 的分工
- [ ] 能按源码顺序说出一次写请求的五步，以及返回 204 时数据在哪里
- [ ] 能说出 WAL 与 Cache 的归属、创建、来源、清理
- [ ] 知道 WAL 分段大小，以及快照后删除已关闭分段的过程
- [ ] 能解释专题 1 里 WAL 未删除的原因（1.6.x 缺陷，1.13.2 已修复）
- [ ] 能正确解释 `wal-fsync-delay`：影响的是延迟和刷盘合并，不是丢数据风险
- [ ] 知道 Cache 上限的计算方式（包含快照中的部分、按 shard 计算）和 500 返回码
- [ ] 能估算正常写入时 Cache 离上限有多远，说出三种会超限的场景
- [ ] 能解释"拒绝且不写"相对其他三种设计的好处
- [ ] 知道 shard 按时间切分、每个 shard 一份 WAL/Cache，冷 shard 几乎不占资源
- [ ] 知道并发重写多个旧 shard 时内存会叠加
