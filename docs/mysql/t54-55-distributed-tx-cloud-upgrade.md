# 专题 54–55 · 分布式事务、云端 MySQL 与分支版本、升级（合并）

> 级别：54 ☆ / 55 ○ · 主线 B（衔接 C）· 实测环境：沙箱两个 MySQL 8.0.46 实例 sh0（3320，账户 A）、sh1（3321，账户 B），初始余额各 1000

本篇回答：跨库转账为什么单机事务管不住？XA 两阶段提交与专题 32 的内部两阶段提交是什么关系？协调者失联时参与者会怎样，如何诊断与处理？本地消息表、TCC、Saga 各适合什么？云托管、Percona、MariaDB 与官方版有何差别？8.0 现状如何，升级到 8.4 要检查什么？

## 在三条主线中的位置

```
B 一致性：单机事务（23）→ 内部两阶段提交（32）→【跨库：XA 两阶段提交 / 柔性事务（54）】
C 诊断：悬挂 XA 事务（XA RECOVER）及其持有的行锁（data_locks）
```

## 一、问题：跨库转账（专题 54）

```
朴素做法：sh0 上 BEGIN; A-100; COMMIT;   再   sh1 上 BEGIN; B+100; COMMIT;
                                   ↑ 此处崩溃 → A 扣了，B 没加，钱凭空消失
反过来先加 B → 崩溃时钱凭空多出来
```

两个库各自满足 ACID，但"两个库要么都改、要么都不改"无人保证。

## 二、XA 两阶段提交

### 2.1 推导：专题 32 的跨机器版

```
专题 32：redo 先写 prepare → 写 binlog（"决定提交"的证据）→ redo 写 commit
         崩溃恢复：redo 为 prepare 时去 binlog 找 XID，找到提交，找不到回滚
```

推广到多个库：

```
角色：协调者（应用 / 中间件）+ 参与者（各 MySQL 实例）
第一阶段 prepare：每个参与者执行完修改并持久化，进入"准备好"状态
                 承诺"之后让我提交就一定能提交" → 不能释放行锁
第二阶段 commit / rollback：全部 prepare 成功 → 全部提交；任一失败 → 全部回滚
```

| 专题 32 内部两阶段提交 | XA 两阶段提交 |
| --- | --- |
| 参与者：InnoDB（redo）、binlog | 参与者：多个 MySQL 实例 |
| 协调者：MySQL Server 自身 | 协调者：应用 / 中间件 |
| 决策证据：binlog 中的 XID | 决策证据：协调者自己的事务日志 |
| 同一进程，崩溃恢复自动完成 | 跨机器，协调者失联后参与者无法自行决定 |

### 2.2 实验（真实输出）

```
① 正常 XA 转账
   sh0：XA START 'tx1'; UPDATE ... balance-100 ...; XA END 'tx1'; XA PREPARE 'tx1'; XA COMMIT 'tx1';
   sh1：XA START 'tx1'; UPDATE ... balance+100 ...; XA END 'tx1'; XA PREPARE 'tx1'; XA COMMIT 'tx1';
   前：sh0 A=1000  sh1 B=1000     后：sh0 A=900  sh1 B=1100
   （演示中每个实例 prepare 后紧接 commit；真实协调者先让全部参与者 prepare 成功再逐个 commit）

② 协调者在 sh1 已 COMMIT、sh0 仅 PREPARE 时崩溃（连接断开）
   sh0 A=900  sh1 B=1200                        ← 合计 2100，钱"凭空多出来"
   sh0 XA RECOVER：formatID=1 gtrid_length=3 bqual_length=0 data=tx2
   sh0 innodb_trx：trx_state=RUNNING thread=0 trx_rows_locked=1 trx_rows_modified=1   ← 无连接，事务仍在
   sh0 data_locks：acct PRIMARY RECORD X,REC_NOT_GAP GRANTED 1                       ← 仍持有 A 的排他锁
   其他业务改 A：ERROR 1205 (HY000): Lock wait timeout exceeded; try restarting transaction
   快照读 A：900

③ sh0 被 kill -9 后重启
   XA RECOVER：1  3  0  tx2                     ← 仍然存在
   错误日志：
     [System]  [MY-010229] Starting XA crash recovery...
     [Warning] [MY-010225] Found 1 prepared XA transactions
     [System]  [MY-010232] XA crash recovery finished.

④ 人工处理：查协调者日志 / 另一参与者结果 → sh1 已提交 → sh0 也提交
   XA COMMIT 'tx2' → XA RECOVER 为空
   sh0 A=800  sh1 B=1200                        ← 合计回到 2000
```

### 2.3 XA 的三个问题

1. **阻塞**：prepare 后必须持锁直到收到最终决定；协调者失联则锁一直挂着，重启也解不开（②③），其他业务只能等超时。
2. **协调者是关键单点**：参与者无法自行判断，协调者必须持久化决定、高可用、恢复后继续推进；否则只能人工判断（④）。
3. **无全局隔离**：② 中 A=900、B=1200 的中间状态可被其他会话分别读到。

此外：每参与者多一次往返与 prepare 刷盘，全程持锁 → XA 一般只用于并发不高、强一致要求高的场景。

> **错误 vs 正确**
> - ❌ 用了 XA 就和单机事务一样。
> - ✅ XA 只保证最终全部提交或全部回滚（原子性），代价是阻塞与协调者依赖；不提供跨库隔离，第二阶段过程中可读到中间状态。

### 2.4 诊断实践：悬挂 XA 事务

```
现象：某行更新持续 1205 锁等待超时，但 processlist 里找不到持锁会话
定位：
  XA RECOVER;                                                       -- 列出 prepared 状态的 XA 事务
  SELECT trx_id, trx_state, trx_mysql_thread_id, trx_started FROM information_schema.innodb_trx;   -- thread=0
  SELECT OBJECT_NAME, LOCK_MODE, LOCK_DATA FROM performance_schema.data_locks;                      -- 持有的锁
决策：查协调者日志或其他参与者该 XID 的结果 → 一致地 XA COMMIT 'xid' 或 XA ROLLBACK 'xid'
注意：KILL 无法结束它（没有连接）；重启也不会自动解决；不要在不知道其他参与者结果时随意回滚或提交
预防：协调者持久化决策日志并具备恢复能力；监控 XA RECOVER 非空
```

## 三、柔性事务（最终一致）

放弃强一致，接受短暂中间状态但保证最终一致（CAP / BASE 取舍）。

### 3.1 本地消息表（outbox）实验（真实输出）

下单（sh0 订单库）后给用户加积分（sh1 积分库）：

```
① sh0 本地事务：下单 + 写消息（同一事务）
   outbox: 101  user=7,add_points=30  NEW
② 投递进程读 NEW 消息投递给 sh1；消费端同一本地事务内先写去重表 consumed(msg_id) 再加积分
   sh1 points: 30
③ 投递进程标记 SENT 前崩溃 → 重启后重复投递
   ERROR 1062 (23000): Duplicate entry '101' for key 'consumed.PRIMARY'
   sh1 points: 30          ← 去重表主键挡住重复消息，消费事务回滚，积分未加两次
   outbox: 101 ... SENT
```

- 关键：业务数据与"要通知别人"写在**同一本地事务** → 跨库问题转化为单库事务 + 可靠投递。
- 投递可能重复 → 消费端**幂等**（去重表 + 主键最简单可靠）。
- 代价：积分晚到（最终一致）；需投递进程。

### 3.2 方案对比

| 方案 | 做法 | 一致性 | 隔离 | 业务侵入 | 典型场景 |
| --- | --- | --- | --- | --- | --- |
| **XA / 两阶段提交** | 数据库层 prepare + commit | 强一致（原子） | 无全局隔离 | 低 | 低并发、强一致，如内部结算 |
| **本地消息表 / 事务消息** | 业务与消息同一本地事务；异步投递；消费幂等 | 最终一致 | 无 | 中 | 下单后加积分、发通知等下游动作 |
| **TCC**（Try-Confirm-Cancel） | Try 预留（冻结 100 元）；Confirm 真正扣减；Cancel 释放 | 最终一致（业务层两阶段） | 靠"冻结"部分隔离 | **高**（每操作三个接口） | 资金、库存等需预留的场景 |
| **Saga** | 本地事务链，每步有补偿；失败则倒序补偿 | 最终一致 | 无（中间状态可见） | 中（写补偿） | 长流程，如订票 + 酒店 + 租车 |

TCC / Saga 必须处理：**幂等**（重试多次执行）、**空回滚**（Try 未执行先收到 Cancel）、**悬挂**（Cancel 后迟到的 Try）——用事务状态表记录判断。

**选型**：先问能否不跨库（分片键让同一用户数据同库，52）；必须跨库时——可接受最终一致用本地消息表 / 事务消息；需预留资源用 TCC；流程长用 Saga；低并发且必须强一致才用 XA。

## 四、云端 MySQL（专题 55）

| | 自建 | 云托管（RDS 一类） | 存储计算分离（Aurora 一类） |
| --- | --- | --- | --- |
| 谁负责 | 全部自己 | 厂商负责安装、备份、高可用切换、监控、小版本升级 | 同左 |
| 能做什么 | 完全控制 | 一般无操作系统权限与 SUPER，只能改允许的参数 | 同左 |
| 架构 | 39–43 的复制、高可用、备份需自建 | 底层通常仍是主从复制 + 自动切换 | 计算节点共享分布式存储层，由存储层负责多副本 |
| 对你的影响 | — | 诊断方法不变（P_S / sys 可用），部分手段受限（看不到 OS 指标、不能 kill -9） | 只读节点共享存储、不重放 binlog，"从库延迟"来源与专题 40 不同，以厂商文档为准 |

## 五、分支版本

| 版本 | 与 Oracle MySQL 的关系 | 要点 |
| --- | --- | --- |
| Oracle MySQL（社区 / 企业） | 官方 | 本课程基线 |
| Percona Server for MySQL | 基于官方版增强监控与运维，力求直接替换 | 配套 XtraBackup（43）、pt-online-schema-change（36）、pt-table-checksum（41） |
| MariaDB | 从 MySQL 分叉、长期独立演进 | GTID、JSON、优化器、部分系统表等与 MySQL 8.x 不同；**不能当作 8.x 直接替代**，迁移需逐项验证 |

## 六、版本模型与升级

**发布模型**（8.4 手册 1.3 节）：

| | LTS | Innovation |
| --- | --- | --- |
| 内容 | 仅必要修复，LTS 内不删除功能 | 含新功能 |
| 支持期 | Oracle Lifetime Support：5 年 Premier + 3 年 Extended | 支持到下一个 Innovation 发布 |
| 质量 | 都含 bug / 安全修复，均为生产级 | 同左 |
| 升级 | 支持升级到下一个 LTS（如 8.4.x → 9.7.x）；不支持跳过一个 LTS | — |

**8.0 现状**（MySQL 官方 EOL 公告）：自 **2026-04-21** 起 MySQL 8.0 进入 Oracle Sustaining Support，官方建议升级到 **8.4 LTS 或 9.7 LTS** → 新项目直接从 8.4 LTS（或更新 LTS）起步。

**8.0 → 8.4 升级检查单**（已核实）：

| 类别 | 变化 | 影响 | 专题 |
| --- | --- | --- | --- |
| 认证 | `mysql_native_password` 默认**禁用**，需 `--mysql-native-password=ON` 启用；`default_authentication_plugin` 已删除，改用 `authentication_policy`（语法有变化） | 旧客户端 / 驱动可能连不上；先查账号认证插件 | — |
| 复制语句 | `CHANGE MASTER TO`、`START SLAVE`、`SHOW SLAVE STATUS`、`RESET MASTER`、`SHOW MASTER STATUS` 等删除，改 SOURCE / REPLICA / BINARY LOG 系列 | 运维脚本、监控采集要改 | 39 |
| 复制参数 | `binlog_transaction_dependency_tracking` 删除，主库总用 writeset | 去掉配置项 | 40 |
| 工具 | `mysqlpump` 删除 | 改用 mysqldump 或 Shell dump 工具 | 43 |
| InnoDB 默认值 | AHI OFF、change buffer none、Linux 默认 O_DIRECT、`innodb_io_capacity` 10000、log buffer 64 MiB 等 | 性能特征可能变化，需压测对比 | 46 |

**升级方法**：测试环境先升级并用流量回放 / 基准测试对比（47）；用 MySQL Shell 升级检查工具扫描不兼容项；生产先升从库 → 观察 → 切主（42）；升级前全量备份（43）。

```sql
-- 升级前自查：哪些账号仍用旧认证插件
SELECT user, host, plugin FROM mysql.user;
```

## 七、串联图

```
跨库写入 → 单机事务管不到
  ├─ XA 两阶段提交（= 专题 32 内部两阶段提交的跨机器版）
  │     prepare：持久化并承诺可提交，锁不释放 → commit / rollback
  │     问题：协调者失联即阻塞（锁一直挂，重启不释放）；协调者单点；无全局隔离
  │     诊断：XA RECOVER、innodb_trx（thread=0）、data_locks
  └─ 柔性事务（最终一致）
        本地消息表 / 事务消息：业务与消息同一本地事务 + 异步投递 + 消费幂等
        TCC：业务层预留 / 确认 / 取消（幂等、空回滚、悬挂）
        Saga：本地事务链 + 倒序补偿
  首选：用分片键避免跨库
云与版本（55）：托管省运维、限权限；Percona 可直接替换，MariaDB 已分叉
  8.0 自 2026-04-21 进入 Sustaining Support → 8.4 LTS / 9.7 LTS
  升级检查：认证插件、复制语句、复制参数、mysqlpump、InnoDB 默认值
```

## 八、本地复现（Docker mysql:8.4）

```bash
# 沿用专题 51–53 的 sh0（3306）、sh1（3307）容器；密码只放环境变量
q(){ mysql -h127.0.0.1 -P$1 -uroot -N -e "$2"; }
for p in 3306 3307; do q $p "CREATE DATABASE bank; CREATE TABLE bank.acct(id INT PRIMARY KEY, balance INT NOT NULL); INSERT INTO bank.acct VALUES (1,1000);"; done

# 54-1 正常 XA
q 3306 "XA START 'tx1'; UPDATE bank.acct SET balance=balance-100 WHERE id=1; XA END 'tx1'; XA PREPARE 'tx1'; XA COMMIT 'tx1';"
q 3307 "XA START 'tx1'; UPDATE bank.acct SET balance=balance+100 WHERE id=1; XA END 'tx1'; XA PREPARE 'tx1'; XA COMMIT 'tx1';"

# 54-2 悬挂事务：sh0 只 PREPARE（连接随即断开），sh1 提交
q 3306 "XA START 'tx2'; UPDATE bank.acct SET balance=balance-100 WHERE id=1; XA END 'tx2'; XA PREPARE 'tx2';"
q 3307 "XA START 'tx2'; UPDATE bank.acct SET balance=balance+100 WHERE id=1; XA END 'tx2'; XA PREPARE 'tx2'; XA COMMIT 'tx2';"
q 3306 "XA RECOVER; SELECT LOCK_MODE, LOCK_DATA FROM performance_schema.data_locks;"
q 3306 "SET SESSION innodb_lock_wait_timeout=3; UPDATE bank.acct SET balance=balance+1 WHERE id=1;"   # ERROR 1205
docker restart sh0; sleep 20; q 3306 "XA RECOVER"                                                     # 仍在
q 3306 "XA COMMIT 'tx2'"; q 3306 "SELECT balance FROM bank.acct"; q 3307 "SELECT balance FROM bank.acct"

# 54-3 本地消息表：sh0 同一事务写订单与 outbox；sh1 消费时先插 consumed(msg_id) 再加积分；重复投递一次，观察 1062 与积分不变

# 55 升级前自查
q 3306 "SELECT user, host, plugin FROM mysql.user"
```

**预期现象**：XA 结果与沙箱一致——悬挂事务在断开连接、重启后依然存在并持有行锁，直到人工 XA COMMIT / XA ROLLBACK。`docker restart` 为正常关机（沙箱为 kill -9），prepared 事务同样保留。

::: tip 与 Redis、PG、架构师笔记对照
- **Redis**：`MULTI/EXEC` 只是单实例命令打包（第 19 章），不支持回滚、不跨实例；集群跨槽多键操作直接拒绝——与"选好分片键、尽量不跨库"同一思路。
- **PG**：`PREPARE TRANSACTION` / `COMMIT PREPARED` ≈ XA PREPARE / XA COMMIT；`pg_prepared_xacts` ≈ `XA RECOVER`；PG 默认 `max_prepared_transactions=0`（默认禁止），正因悬挂事务会一直持锁、阻止清理。
- **架构师笔记第 15 章**："每个服务自己的数据库，放弃强一致追求最终一致" ↔ 柔性事务；CAP / BASE 是依据。
:::

## 九、与其他专题的关联

- **专题 23**：单机事务 ACID。
- **专题 25–27**：悬挂 XA 持有行锁导致的锁等待诊断。
- **专题 32–33**：内部两阶段提交与崩溃恢复中的 XA 恢复。
- **专题 39–46**：8.4 删除 / 变化项的来源专题。
- **专题 52**：分片键避免跨库事务。
- **专题 53**：消息幂等、binlog 驱动的异步链路。

## 十、复习 checklist

- [ ] 能说明跨库写入为何单机事务保证不了原子性
- [ ] 能把 XA 两阶段提交与专题 32 内部两阶段提交对照，说出角色与决策证据的差别
- [ ] 能用实验说明协调者失联时参与者的状态：XA RECOVER、thread=0、持锁、重启不消失
- [ ] 能说出 XA 的阻塞、单点、无全局隔离三个问题，以及悬挂事务的诊断与处理步骤
- [ ] 能解释本地消息表为何要"业务与消息同一本地事务"以及消费端幂等的实现
- [ ] 能对比 XA、本地消息表、TCC、Saga 的一致性、隔离、侵入与场景，说出 TCC 的幂等 / 空回滚 / 悬挂
- [ ] 能说出自建、云托管、存储计算分离的差别，以及 Percona 与 MariaDB 的定位
- [ ] 能说出 LTS / Innovation 模型、8.0 现状与 8.0 → 8.4 升级检查项
