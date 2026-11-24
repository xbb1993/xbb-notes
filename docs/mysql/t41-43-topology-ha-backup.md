# 专题 41–43 · 复制拓扑与陷阱、高可用、备份与恢复（合并）

> 级别：41 ☆ / 42 ★ / 43 ☆ · 主线 B / C · 实测环境：沙箱 MySQL 8.0.46，主库 SRC（3310）、从库 REP（3311）、从库 REP2（3312）、恢复用空实例 REC（3313）；输出中两台服务器的 UUID 已替换为 `SRC` / `REP`

本篇回答：常见复制拓扑各解决什么？从库为什么必须只读、errant GTID 是什么？复制中断该"跳过"还是"修复"？主库宕机后怎样切换、什么条件下不丢数据？脑裂怎么发生、怎么防？MGR 换了什么思路？复制为什么不能替代备份，误删数据怎样做时间点恢复？

动画：<a href="/xbb-notes/mysql-t42-failover.html" target="_blank">主库故障切换流程（异步 vs 半同步 + 只读启动）</a> · <a href="/xbb-notes/mysql-t39-replication.html" target="_blank">复制链路与半同步</a>

## 在三条主线中的位置

```
B 一致性：复制（39–40）→【拓扑与运维 41】→【故障切换 42：会不会丢、会不会两个主库】→【备份 43：最后一道防线】
C 诊断：复制中断（Last_SQL_Error）→ GTID 集合对比 → 修复或重建；切换后核对数据
```

## 一、复制拓扑（专题 41）

| 拓扑 | 结构 | 用途 | 代价 / 注意 |
| --- | --- | --- | --- |
| **一主多从** | 主 → 从 1、从 2… | 读扩展；故障候选；从库做备份 | 每个从库占主库一个 Dump 线程与一份带宽 |
| **级联** | 主 → 从 A → 从 B | 从库多时减轻主库；跨机房先传一份再分发 | 从 B 延迟为两段之和；中间节点故障影响下游；从 A 需 `log_replica_updates` |
| **双主** | A ⇄ B 互为主从 | 切换方便 | 两边同时写会冲突 → 常用"双主单点写"，另一台热备 |
| 多源复制（○） | 一个从库复制多个主库 | 汇总分库数据做分析 | 各源数据不能冲突 |
| 延迟复制（○） | `SOURCE_DELAY=N`，单位秒，默认 0（8.4 手册） | 误操作后从延迟从库取数据（第七节） | 不能做读扩展 |

## 二、陷阱与修复（专题 41）

### 2.1 从库默认可写 → errant GTID（真实输出）

```
rep:  @@read_only = 0   @@super_read_only = 0
rep:  INSERT INTO lab.t_acct VALUES (100, 1)        ← 成功
rep gtid_executed:          SRC:1-36021, REP:1      ← 多出以从库 UUID 开头的事务
GTID_SUBTRACT(rep, src) =   REP:1
```

**errant GTID**：只在某个从库上、主库没有的事务。`GTID_SUBTRACT(A, B)` 返回在 A 不在 B 的 GTID。

危害：① 眼前——主库之后写同一主键时回放冲突，复制中断；② 潜伏——该从库将来被提升为主库，其他从库按 GTID 补齐时会拉取并执行这个误写。

### 2.2 回放冲突，复制中断（真实输出）

主库 `INSERT INTO lab.t_acct VALUES (100, 500)`：

```
Replica_IO_Running: Yes
Replica_SQL_Running: No                              ← 回放停，接收仍在
Last_SQL_Errno: 1062
Last_SQL_Error: ... Worker 1 failed executing transaction 'SRC:36022' at source log binlog.000003, end_log_pos 443 ...
Retrieved_Gtid_Set: SRC:1-36022
Executed_Gtid_Set:  SRC:1-36021, REP:1
replication_applier_status_by_worker：1062  SRC:36022  ... Could not execute Write_rows ev...
未被误写的 rep2：Replica_SQL_Running: Yes，id=100 → 500
```

### 2.3 修复：跳过 vs 修复（真实输出）

**跳过**（常见但危险）——在从库注入同 GTID 的空事务：

```sql
STOP REPLICA;
SET GTID_NEXT='SRC:36022'; BEGIN; COMMIT; SET GTID_NEXT='AUTOMATIC';
START REPLICA;
```

```
Replica_SQL_Running: Yes                         ← 复制恢复
src id=100 -> 500    rep id=100 -> 1             ← 数据分叉
CHECKSUM src: 723986100   rep: 2069994258   rep2: 723986100
```

**正确修复**：

```sql
-- ① 从库修数据，且本会话不写 binlog，避免产生新的 errant GTID
SET SESSION sql_log_bin=0; UPDATE lab.t_acct SET balance=500 WHERE id=100; SET SESSION sql_log_bin=1;
-- ② 主库为 errant GTID 注入空事务，让所有服务器都"拥有"它
SET GTID_NEXT='REP:1'; BEGIN; COMMIT; SET GTID_NEXT='AUTOMATIC';
```

```
CHECKSUM src: 723986100   rep: 723986100   rep2: 723986100
GTID_SUBTRACT(rep, src) = ''
```

| 做法 | 复制恢复 | 数据一致 | 适用 |
| --- | --- | --- | --- |
| 注入空事务跳过 | 是 | **否** | 确认被跳过事务对数据无影响时 |
| 修数据（`sql_log_bin=0`）+ 主库为 errant GTID 注入空事务 | 是 | 是 | 差异少、可定位 |
| 重建从库（Clone / 备份） | 是 | 是 | 差异多、无法定位或不确定时 |

`CHECKSUM TABLE` 适合写入暂停时核对；在线核对用 pt-table-checksum 类工具（分块计算，经复制比较）。

### 2.4 预防

```
从库 super_read_only=ON → 实测 ERROR 1290 ... running with the --super-read-only option；复制线程照常写入
从库 relay_log_recovery=ON（专题 39）
主库 binlog 保留 ≥ 从库可能断开的最长时间；binlog_expire_logs_seconds 默认 2592000 秒（30 天，8.4 手册）
  从库所需 binlog 已被清理 → 接收线程报错 → 只能重建
```

> **易混**：`read_only` 拦不住拥有 SUPER 等管理权限的账号，`super_read_only` 连它们也拦；复制线程不受两者影响。

## 三、高可用：故障切换要做的事（专题 42）

```
① 发现：真挂了还是网络抖动？
② 选新主：哪个从库数据最全？
③ 补齐：新主 relay log 回放完了吗？其他从库缺的怎么补？
④ 切换：其他从库改连新主；应用写流量指向新主
⑤ 处理旧主：它回来时会不会也在接受写入？
```

### 3.1 实验：一次完整的手动切换（真实输出）

```
① 制造三个事务：A(id=200) 两个从库都收到；B(201) 先停 rep2 接收线程 → 只有 rep 收到；
   C(202) 再停 rep 接收线程 → 两个从库都没收到（模拟异步还没发出）
   src gtid_executed: SRC:1-36026, REP:1

② kill -9 主库；恢复两个从库接收线程：
   Replica_IO_Running: Connecting
   Last_IO_Error: Error connecting to source ... This was attempt 1/86400, with a delay of 60 seconds between attempts.

③ 比较已收到的集合：
   rep : Retrieved_Gtid_Set: SRC:1-36025         Executed_Gtid_Set: SRC:1-36025, REP:1
   rep2: Retrieved_Gtid_Set: SRC:1-36024, REP:1  Executed_Gtid_Set: SRC:1-36024, REP:1
   → rep 多了 36025（B），选 rep

④ 提升 rep：
   WAIT_FOR_EXECUTED_GTID_SET(rep 已收到的集合) -> 0
   STOP REPLICA; RESET REPLICA ALL; SET GLOBAL super_read_only=OFF; SET GLOBAL read_only=OFF;

⑤ rep2 改连 rep（SOURCE_AUTO_POSITION=1），新主写入 D(203)：
   rep2 ids >= 200: 200,201,203      ← 原本没有的 B 被自动补上
   rep  ids >= 200: 200,201,203

⑥ 旧主库重启：
   @@read_only = 0   @@super_read_only = 0
   INSERT ... (204) → old src accepted a write
   src ids >= 200: 200,201,202,204
   GTID_SUBTRACT(旧主库, 新主库) = SRC:36026-36027

⑦ 直接把旧主库挂成新主的从库：
   Replica_IO_Running: Yes   Replica_SQL_Running: Yes
   src ids >= 200: 200,201,202,203,204
   CHECKSUM new primary rep: 471557010  rep2: 471557010  old src: 1403696649
```

逐步读出的结论：

- 第 ③ 步比较的是 **Retrieved**（已收到），因为已收到未执行的部分可在第 ④ 步执行完。
- 第 ⑤ 步：GTID 让 rep2 自动补齐从未直接收到的 B，无需位点换算。
- 第 ⑥ 步：C 只在旧主库上——客户端已确认成功，新主库上却没有（异步丢数据）；旧主库重启默认可写，又接受了 204 → **两个可写主库 = 脑裂**。
- 第 ⑦ 步：

> **错误 vs 正确**
> - ❌ 旧主库能挂成从库、两个 Yes，说明数据没问题。
> - ✅ 复制只补缺、不删多余。`GTID_SUBTRACT(旧主, 新主)` 非空即有分叉数据 → 用 Clone / 备份**重建**；多出事务若有业务价值，先从其 binlog 取出人工核对后补回新主。

### 3.2 数据不丢的条件

| 复制方式 | C 在宕机时 | 切换后 |
| --- | --- | --- |
| 异步 | 主库已提交、客户端已确认、无从库收到 | **已确认事务丢失**（本实验） |
| 半同步 AFTER_SYNC 未超时 | 收到 ACK 前主库不提交不返回 → 客户端确认时至少一个从库 relay log 中有 C | 选中收到 C 的从库（比较 Retrieved）即不丢 |
| 半同步已退化 | 同异步 | 可能丢（专题 39） |

"半同步不丢数据"需同时满足：① 半同步处于 ON；② 选新主比较 Retrieved 选最全；③ 新主先回放完 relay log 再接受写入。

动画中可切换两种配置，对比 C 的结局与旧主库的处理：<a href="/xbb-notes/mysql-t42-failover.html" target="_blank">主库故障切换流程</a>。

### 3.3 脑裂与隔离（fencing）

**脑裂**：两个节点同时认为自己是主库并接受写入。常见原因：主库没挂只是与检测程序网络中断，被误判后从库被提升；旧主库重启默认可写，连接池又连回了它。

原则：**新主库接受写入前，先确保旧主库不能再写**（fencing）。

| 手段 | 做法 |
| --- | --- |
| 所有节点只读启动 | 配置文件写 `super_read_only=ON`，只在确认的主库上由切换程序关闭 → 第 ⑥ 步的旧主库不会接受写入 |
| 写入口唯一 | 应用只经一个入口（VIP / 中间件）写入，切换时移动入口 |
| 强制隔离 | 能连上就设只读或 KILL 连接；连不上则经云平台 / 电源管理强制关机（STONITH，Shoot The Other Node In The Head） |
| 多数派判断 | 只有能与多数节点通信的一方可写，少数派自动停写（MGR） |

### 3.4 自动化方案

**外部切换工具**（Orchestrator、MHA 等）：自动完成 ①–④（探测、比较 GTID 选主、补齐、调整拓扑、钩子脚本切 VIP / 通知中间件）。数据安全仍取决于底层复制方式，防脑裂取决于 fencing。

**MGR（MySQL Group Replication，组复制）**：事务提交前先在组内达成多数派一致。

```
客户端提交 → 主节点广播事务的 write set
          → 基于 Paxos 的组通信确定全局顺序
          → 各成员按同一顺序做冲突检测（certification），与并发事务改同一行则回滚
          → 多数成员确认后才提交、返回客户端
```

类比："半同步的强化版"——半同步等 1 个从库收到，MGR 等**多数**确认，并内置选主与防脑裂。

| 项目 | 内容（8.4 手册） |
| --- | --- |
| 容错 | 容忍 f 个故障需 n = 2f + 1：3 台容忍 1，5 台容忍 2，7 台容忍 3 |
| 组规模上限 | 9 个成员 |
| 防脑裂 | 分区时只有多数派一侧能提交 |
| InnoDB Cluster | MySQL Server + Group Replication、MySQL Shell（AdminAPI 管理）、MySQL Router（应用与集群间透明路由），至少 3 个实例 |
| 一致性选项 | `group_replication_consistency` 在 8.4.0 默认改为 `BEFORE_ON_PRIMARY_FAILOVER`（8.4.0 release notes），与主节点切换后的读一致性有关，具体语义未核实原文，不展开 |

代价：每次提交多一次组内网络往返，对网络延迟敏感；多主模式下并发改同一行会被回滚，实践多用单主；大事务 write set 大，拖慢整组。本专题未在沙箱实测 MGR，以上来自手册。

| | 异步 / 半同步 + 外部工具 | MGR / InnoDB Cluster |
| --- | --- | --- |
| 数据不丢 | 半同步 ON 且选对新主时不丢；异步可能丢 | 多数派确认后提交，少数故障不丢 |
| 防脑裂 | 依赖 fencing | 协议内置 |
| 写延迟 | 异步最低；半同步多一次往返 | 多一次共识往返 |
| 网络 | 可跨机房（异步） | 低延迟网络 |
| 运维 | 组件多，切换逻辑在外部脚本 | 组件统一，需理解协议与限制 |

::: tip 与 Redis、架构师笔记对照
- **Redis Sentinel** ≈ 外部切换工具：哨兵投票判定客观下线再选主；同为异步复制，切换可能丢已确认写入；`min-replicas-to-write` 限制少数派一侧旧主继续写，相当于一种 fencing。
- **Redis Cluster** 故障转移依赖多数主节点投票，与 MGR 多数派思路相同。
- **CAP**：分区时 MGR 少数派停写 → 选 C；异步 + 自动切换 → 选 A，代价是可能丢数据或脑裂。
:::

## 四、复制不能替代备份（专题 43）

```
主库：DELETE FROM lab.t_acct          ← 误操作，没写 WHERE
从库 rep2：t_acct rows = 1             ← 误删已被复制
```

复制防硬件故障，备份防误操作、逻辑错误、恶意破坏。

## 五、备份方式

| | 逻辑备份 | 物理备份 |
| --- | --- | --- |
| 内容 | SQL 语句 | 数据文件拷贝（表空间、redo、undo 等） |
| 工具 | mysqldump；MySQL Shell dump 工具 | Percona XtraBackup；Clone 插件；MySQL Enterprise Backup |
| 备份 / 恢复速度 | 慢（恢复要重新执行 SQL、建索引） | 快（直接用文件） |
| 体积 | 小 | 大 |
| 灵活性 | 可只恢复一张表；可跨版本、平台 | 一般整实例恢复，版本要求严格 |

> **易混：三个逻辑备份工具**
>
> | 工具 | 定位 | 状态 |
> | --- | --- | --- |
> | **mysqldump** | 最早的逻辑备份工具，单线程导出 SQL | 8.4 中保留 |
> | **mysqlpump**（多一个 p，parallel） | 5.7 推出的并行版，按库及库内对象并行处理 | 8.0.34 起弃用（8.0 手册："deprecated as of MySQL 8.0.34"），**8.4.0 删除** |
> | **MySQL Shell dump 工具** | 多线程并行、压缩、进度显示 | 官方推荐的并行逻辑备份方案 |
>
> 8.4.0 release notes 原意：删除 mysqlpump，改用 mysqldump 或 MySQL Shell dump 工具——被删的是 mysqlpump，不是 mysqldump。

**一致性**：mysqldump `--single-transaction` 开始时开启一致性快照事务（RR + `WITH CONSISTENT SNAPSHOT`，专题 23、24），整个导出期间读同一个 Read View，无需锁表；仅对 InnoDB 有效。

### 5.1 实验：逻辑与物理备份（真实输出）

```
mysqldump --single-transaction --source-data=2 --set-gtid-purged=ON --databases lab
  → 0.5s，8.9M
  -- CHANGE MASTER TO MASTER_LOG_FILE='binlog.000002', MASTER_LOG_POS=1817;   ← 8.0.46 的注释仍是旧语法
  SET @@GLOBAL.GTID_PURGED=/*!80000 '+'*/ 'SRC:1-36025, REP:1-2';             ← 备份包含哪些事务
  警告：partial dump 时仍会写入全部 GTID……

CLONE LOCAL DATA DIRECTORY = '/tmp/rpl/clone1'  → 0.7s，181M
  目录：#innodb_redo ibdata1 lab mysql mysql.ibd sys undo_001 undo_002 ...
  直接以该目录启动新实例：t_big rows=500000，gtid = SRC:1-36025, REP:1-9（与源一致，无需导入）
```

数据量小所以速度差异不明显；逻辑 8.9M 但恢复要 2.2 秒执行 SQL，物理 181M（含系统表空间、redo、undo）拷完即可启动。数据到几百 GB 时逻辑恢复常需数小时，物理恢复主要取决于拷贝速度 → 生产全量多用物理备份。`CLONE LOCAL` 需要 `BACKUP_ADMIN` 权限，目标目录必须不存在（8.4 手册）。

`GTID_PURGED` 是时间点恢复的关键：恢复后新实例认为已执行过这些事务，后续重放 binlog 时自动跳过。

## 六、时间点恢复 PITR（Point-In-Time Recovery）

```
全量备份 ──▶ 正常写入（id=300、改 id=1、建 t_log 写 1 行）──▶ 误删 t_acct ──▶ 继续写（t_log 第 2 行、t_acct id=400）
目标：误删没发生，但误删前后的正常写入都保留
```

实验（真实输出）：

```
① 找误操作的 GTID：
   SET @@SESSION.GTID_NEXT= 'REP:7'
   #261123 14:24:08 server id 2 ... Delete_rows: table id 115 flags: STMT_END_F
② 空实例恢复全量：
   rec gtid_executed before: ''
   restore took 2.2s
   rec gtid_executed after restore: SRC:1-36025, REP:1-2
   rec t_acct rows=7（备份时刻）
③ 重放全部 binlog，只排除误操作：
   mysqlbinlog --exclude-gtids='REP:7' /tmp/rpl/rep/data/binlog.0* | mysql ...
   rec t_acct ids: 1,2,100,101,200,201,203,300,400     ← 误删前的行都在，误删后的 400 也在
   rec t_log: 1:before accident,2:after accident
   rec gtid_executed: SRC:1-36025, REP:1-6:8-9         ← 唯独缺 REP:7
   主库 gtid_executed: SRC:1-36025, REP:1-9
```

把备份前的 binlog 也喂进去却没有主键冲突，因为 `GTID_PURGED` 中的事务被服务器自动跳过 → 有了 GTID，无需手算从哪个位置开始重放。

> **局限**：后续事务若依赖被删数据（如误删后又对同一行 UPDATE），排除误操作后的结果需人工判断；另一思路是只恢复到误操作之前（`--stop-datetime` / `--stop-position`），再单独补回之后的写入。恢复实例一般不直接替换生产库，而是导出被删数据写回生产。

### 其他补救（○）

| 手段 | 原理 | 前提 |
| --- | --- | --- |
| 延迟从库 | 误操作还没在延迟从库上执行，立即停其回放取数据 | 事先建好，在延迟窗口内发现 |
| binlog 闪回 | ROW binlog 有修改前完整行（专题 32），DELETE 反转为 INSERT、UPDATE 前后对调 | `binlog_format=ROW`、`binlog_row_image=FULL`；DROP / TRUNCATE 无法反转 |

## 七、备份策略要点

```
□ 定期全量（物理为主）+ 持续保留 binlog（最好实时拷到另一台）
□ binlog 保留时长 ≥ 两次全量间隔，否则中间无法时间点恢复
□ 备份放到另一台机器 / 对象存储，不与数据库同盘
□ 定期恢复演练：未验证能恢复的备份不算备份
□ 记录每份备份的 GTID 集合或位点
```

## 八、串联图

```
拓扑（41）：一主多从 / 级联 / 双主单写 / 延迟从库
  陷阱：从库可写 → errant GTID → 回放冲突中断
  修复：跳过（分叉）vs 修数据 + 主库注入空事务 vs 重建
  预防：super_read_only、relay_log_recovery、binlog 保留足够
          ▼
高可用（42）：发现 → 选新主（比较 Retrieved）→ 回放完 relay log → 其他从库改连（GTID 自动补齐）→ 切写入口
  丢不丢：异步可能丢；半同步 AFTER_SYNC ON 且选对新主不丢
  脑裂：旧主默认可写 → 全员只读启动 + fencing
  旧主：GTID_SUBTRACT 非空就重建
  MGR：多数派确认后提交，内置选主与防脑裂；n = 2f + 1，最多 9 个成员
          ▼
备份（43）：复制会复制误操作 → 全量（逻辑 / 物理）+ binlog
  PITR：恢复全量（GTID_PURGED）→ 重放 binlog，--exclude-gtids 排除误操作 → 导出数据写回生产
```

## 九、诊断实践

| 现象 | 看什么 | 处置 |
| --- | --- | --- |
| `Replica_SQL_Running: No` | `Last_SQL_Errno`、`replication_applier_status_by_worker` 出错的 GTID | 找冲突原因；修数据而非盲目跳过；不确定就重建 |
| 从库有主库没有的事务 | `GTID_SUBTRACT(从库, 主库)` | 修数据 + 主库为其注入空事务；开 `super_read_only` |
| 从库报所需 binlog 已清理 | 主库 `binlog_expire_logs_seconds` 与断开时长 | 重建从库；加长保留 |
| 切换后旧主要重新加入 | `GTID_SUBTRACT(旧主, 新主)` | 非空则重建；多出事务人工核对 |
| 疑似两个主库可写 | 各节点 `read_only` / `super_read_only`、应用连接指向 | 立即把其中一个设只读，再核对分叉 |
| 误删数据 | binlog 中误操作的 GTID 与时间 | 延迟从库 / 闪回 / 全量 + binlog 时间点恢复 |

故障切换检查单：

```
□ 确认主库真的不可用（多点探测），并隔离它（只读 / 关机 / 摘 VIP）
□ 比较所有从库 RECEIVED_TRANSACTION_SET，选最全
□ 新主 WAIT_FOR_EXECUTED_GTID_SET(已收到集合) 返回 0
□ 新主 RESET REPLICA ALL，关闭 super_read_only / read_only
□ 其他从库 CHANGE REPLICATION SOURCE TO 新主（SOURCE_AUTO_POSITION=1）
□ 切换写入口；验证写入
□ 旧主回来后先比较 GTID_SUBTRACT，再决定挂从库还是重建
```

## 十、本地复现（Docker mysql:8.4）

```bash
# 沿用专题 39–40 的 src / rep 容器，再加 rep2；密码只放环境变量
docker run -d --name rep2 --network rpl -e MYSQL_ROOT_PASSWORD="$MYSQL_PWD" mysql:8.4 \
  --server-id=3 --gtid-mode=ON --enforce-gtid-consistency=ON
sleep 30
docker exec -e MYSQL_PWD rep2 mysql -uroot -e "CHANGE REPLICATION SOURCE TO SOURCE_HOST='src', SOURCE_USER='repl', SOURCE_PASSWORD='$MYSQL_PWD', SOURCE_AUTO_POSITION=1, GET_SOURCE_PUBLIC_KEY=1; START REPLICA;"
q(){ docker exec -e MYSQL_PWD "$1" mysql -uroot -N -e "$2"; }

# 41：误写从库 → errant GTID → 冲突中断
q rep "INSERT INTO lab.t_acct VALUES (100, 1)"
q rep "SELECT @@gtid_executed"
q src "INSERT INTO lab.t_acct VALUES (100, 500)"
docker exec -e MYSQL_PWD rep mysql -uroot -e "SHOW REPLICA STATUS\G" | grep -E "SQL_Running:|Last_SQL_Errno"
# 修复：rep 上 SET SESSION sql_log_bin=0 后改数据；src 上 SET GTID_NEXT='<rep 的 uuid>:1'; BEGIN; COMMIT; SET GTID_NEXT='AUTOMATIC'; 然后 rep 上 START REPLICA

# 42：故障切换
q rep2 "STOP REPLICA IO_THREAD"; q src "INSERT INTO lab.t_acct VALUES (201, 1)"
q rep  "STOP REPLICA IO_THREAD"; q src "INSERT INTO lab.t_acct VALUES (202, 1)"
docker kill src
q rep "START REPLICA IO_THREAD"; q rep2 "START REPLICA IO_THREAD"
q rep  "SELECT RECEIVED_TRANSACTION_SET FROM performance_schema.replication_connection_status"
q rep2 "SELECT RECEIVED_TRANSACTION_SET FROM performance_schema.replication_connection_status"
q rep "STOP REPLICA; RESET REPLICA ALL; SET GLOBAL super_read_only=OFF; SET GLOBAL read_only=OFF;"
q rep2 "STOP REPLICA; CHANGE REPLICATION SOURCE TO SOURCE_HOST='rep', SOURCE_USER='repl', SOURCE_PASSWORD='$MYSQL_PWD', SOURCE_AUTO_POSITION=1, GET_SOURCE_PUBLIC_KEY=1; START REPLICA;"
q rep2 "SELECT GROUP_CONCAT(id) FROM lab.t_acct WHERE id >= 200"   # 201 自动补上
docker start src; sleep 20; q src "SELECT GROUP_CONCAT(id) FROM lab.t_acct WHERE id >= 200"   # 202 只在旧主

# 43：备份 → 误删 → 时间点恢复
docker exec -e MYSQL_PWD rep mysqldump -uroot --single-transaction --source-data=2 --set-gtid-purged=ON --databases lab > full.sql
q rep "INSERT INTO lab.t_acct VALUES (300, 300)"; q rep "DELETE FROM lab.t_acct"; q rep "INSERT INTO lab.t_acct VALUES (400, 400)"
docker exec rep sh -c 'mysqlbinlog -v --base64-output=DECODE-ROWS /var/lib/mysql/binlog.0* | grep -B8 Delete_rows | grep GTID_NEXT'
docker run -d --name rec --network rpl -e MYSQL_ROOT_PASSWORD="$MYSQL_PWD" mysql:8.4 --server-id=4 --gtid-mode=ON --enforce-gtid-consistency=ON
sleep 30; docker exec -i -e MYSQL_PWD rec mysql -uroot < full.sql
docker exec rep sh -c 'mysqlbinlog --exclude-gtids="<误删的 GTID>" /var/lib/mysql/binlog.0*' | docker exec -i -e MYSQL_PWD rec mysql -uroot
q rec "SELECT GROUP_CONCAT(id ORDER BY id) FROM lab.t_acct"
```

**预期现象**：与上文真实输出一致。8.4 mysqldump 的位置注释可能已是新语法；官方镜像初始化会写入带 GTID 的事务，导入带 `GTID_PURGED` 的备份报错时，先在 rec 上执行 `RESET BINARY LOGS AND GTIDS`（8.4 中替代 `RESET MASTER`）。

::: tip PG 对照
- 故障切换常用 Patroni，借 etcd 等外部一致性存储选主、防脑裂，介于外部工具与多数派之间。
- `pg_dump` ≈ mysqldump；`pg_basebackup` + WAL 归档 ≈ 物理全量 + binlog，PITR 用 `recovery_target_time` 等参数。PG 一般只能"恢复到某个点为止"，不能像 GTID 那样跳过中间一个事务、保留之后的事务。
:::

## 十一、与其他专题的关联

- **专题 23–24**：`--single-transaction` 一致性快照 = RR Read View。
- **专题 32**：ROW binlog 是闪回与 gh-ost 的基础；`binlog_row_image`。
- **专题 36**：Clone / 影子表与重建。
- **专题 39–40**：GTID 集合、半同步 AFTER_SYNC、从库默认可写、`relay_log_recovery`。
- **模块十**：分库分表后的高可用与备份。

## 十二、复习 checklist

- [ ] 能对比一主多从、级联、双主、延迟复制的用途与代价
- [ ] 能解释 errant GTID 的产生、两层危害，以及用 `GTID_SUBTRACT` 发现
- [ ] 能说出"注入空事务跳过"为何会导致数据分叉，以及正确修复的两步
- [ ] 知道 `read_only` 与 `super_read_only` 的区别和 binlog 保留时间的意义
- [ ] 能按五步说出手动故障切换流程，并解释为何比较 Retrieved 而非 Executed
- [ ] 能说出半同步不丢数据的三个条件
- [ ] 能解释脑裂的成因与 fencing 手段，知道旧主库何时必须重建
- [ ] 能说出 MGR 的多数派思路、2f+1、上限 9、InnoDB Cluster 组成及代价
- [ ] 能区分 mysqldump、mysqlpump、Shell dump 工具，对比逻辑与物理备份
- [ ] 能独立完成"全量 + binlog --exclude-gtids"的时间点恢复，并说出其局限
