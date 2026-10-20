# MQTT 集群实现：路由表复制、会话迁移与共享订阅

> 专题 31 · 模块七 · ★ 核心必会 · 中等深度
> 版本基线：EMQX 5.x 官方文档（已核实处标注）；云端用两台 Mosquitto 2.0.18 桥接做对照实验；真集群未在云端实测
> 贯穿场景：meter3 连节点 A，svc 连节点 B；设备可能漂移到其他节点；节点可能宕机

**对应全景图的哪一块**：把专题 26–28 的"一台 broker 内部"扩展为"多台 broker 对外像一台"。

## 1. 核心概念

### 1.1 为什么要集群

| 单机天花板 | 来源 |
|---|---|
| Mosquitto 只用满一个核 | 专题 26 |
| 连接数、内存有上限 | 专题 26、28 |
| 单点故障，一挂全断 | 本篇 |

目标：meter3 连哪台都行，svc 连哪台都行，消息照样到；设备换节点重连，会话还在。

> 类比：快递公司多个网点。A 网点寄、B 网点取，公司内部要能转运；收件人今天去 A、明天去 B，都能取到自己的包裹。

### 1.2 朴素方案及其问题

**方案一：多台独立 broker + 负载均衡**——每台是孤岛，meter3 在 A、svc 在 B 就收不到。

**方案二：桥接**（一台 broker 以客户端身份连另一台，按主题转发，专题 33）：

| 问题 | 实验 | 原因 |
|---|---|---|
| 会话锁在原节点 | 实验 2 | 会话只存在于所在 broker |
| 没人订阅也全量转发 | 实验 3 | 桥接不知道对面有没有订阅者，N 节点每条复制 N−1 份 |
| 环路风险 | — | 双向桥接配置不当会来回弹 |
| Client ID 不全局唯一 | — | 同 ID 可同时连 A 和 B，"同 ID 踢旧"失效 |

> 对照 Redis：Redis Cluster 的经典 `PUBLISH` 全节点广播，与实验 3 一样；Redis 7 才加了分片发布订阅 `SPUBLISH`。

### 1.3 真集群的三件事

```
                    ┌──────── 集群共享状态 ────────┐
                    │ ① 路由表：过滤器 → 哪些节点     │
                    │ ② 会话注册表：Client ID → 节点  │
                    └────────────────────────────┘
   节点 A                                         节点 B
   meter3 ──PUBLISH──→ 查①：em/# 在 B 有订阅 ──转发──→ 本地订阅表 → svc
```

**① 路由表复制（两层路由）**

| 层 | 内容 | 存在哪 | 理由 |
|---|---|---|---|
| 全局路由表 | 过滤器 → 节点 | 复制到所有节点 | 以节点为粒度，规模小、变化少 |
| 本地订阅表 | 过滤器 → 客户端 | 只在本节点 | 客户端明细不必全集群同步 |

没有订阅者的节点收不到消息，消除桥接的浪费。

EMQX 5（官方文档已核实）：节点分 core（负责写入与全量复制）和 replicant（只读，承载客户端与会话）；路由表与主题树由 core 维护并经 Mria/RLOG 复制给 replicant；订阅表按节点分区；开源版建议集群不超过 3 节点。

局限（推论，未实测）：路由复制有短暂窗口，刚在 B 订阅时 A 可能还不知道，期间 A 上发布的消息可能漏掉——路由表选择最终一致，换不卡写入（专题 30 的 CAP 取舍）。

**② 会话注册与跨节点接管**

```
svc2 ──CONNECT（Clean Start=0）──→ 节点 A
A：查注册表 → svc2 会话在 B
A ──"把 svc2 的会话交给我"──→ B
B：踢旧连接，打包 订阅 + 离线队列 + inflight ──→ A
A：CONNACK Session Present=1，推送离线消息
```

即专题 6 会话接管的跨节点版，同时保证全集群 Client ID 唯一。EMQX 文档：`clean_start = false`（5.0 还需 `session_expiry_interval > 0`）时重连会恢复会话，含排队消息与订阅；内部流程文档未展开，上图为原理示意。

**③ 节点故障**

| 会话类型 | 节点宕机时 | 代价 |
|---|---|---|
| 普通会话（默认） | 丢失（EMQX 文档：状态在内存中，节点重启或停止即丢） | 快 |
| durable sessions（EMQX 5.7.0 引入，默认关闭） | RocksDB 存盘 + Raft 多副本复制，可恢复 | 吞吐降、延迟升；须本地盘（不支持 NFS），建议 SSD |

**Raft**：一份数据写到多数副本才算成功的复制协议，少数节点宕机不丢。

默认配置下，集群提高的是**服务可用性**（设备可重连到别的节点），不提高单个会话的持久性。

### 1.4 共享订阅、保留消息、遗嘱

| 机制 | 集群中要考虑 |
|---|---|
| 共享订阅（专题 19） | 组成员分布在不同节点：全局挑选（跨节点协调）或本地优先（省转发但可能不均），各家策略不同 |
| 保留消息（专题 14） | 新订阅者可能在任一节点，须复制到所有节点或放共享存储 |
| 遗嘱（专题 15） | 节点宕机时其上设备的遗嘱由谁发，取决于实现（未核实），故障演练要专门检查 |

### 1.5 对照 Redis Cluster

| | Redis Cluster | MQTT 集群（EMQX 类） |
|---|---|---|
| 数据分布 | 哈希槽切分，每个 key 一个节点 | 连接可落任意节点；路由全复制，会话跟连接走 |
| 连错节点 | MOVED，客户端自己去找 | broker 内部转发或接管会话，客户端无感 |
| 发布订阅 | PUBLISH 全广播；7.0 起 SPUBLISH | 按路由表定向转发 |
| 节点故障 | 主从切换，副本接管槽 | 普通会话丢、设备重连他处；durable sessions 可恢复 |

一句话：**Redis 让客户端去找数据，MQTT 集群让数据去找客户端**——设备太弱，不该承担找节点的逻辑。

## 2. 易混淆 / 易错点

| 错误理解 | 正确理解 |
|---|---|
| 多台 broker + 负载均衡 = 集群 | 无路由共享就是孤岛 |
| 桥接 = 集群 | 桥接全量转发，无会话迁移、无全局 ID 唯一 |
| 每个节点存全部订阅明细 | 全局只复制"过滤器 → 节点" |
| 集群了就不丢会话 | 默认内存会话随节点宕机丢失，要显式开 durable sessions |
| 节点越多越好 | 路由要复制到每个节点；开源版文档建议 3 节点 |
| 订阅成功即能收到他节点消息 | 路由复制有短暂窗口（推论） |
| 集群里 Redis 的 MOVED 思路同样适用 | MQTT 由 broker 内部转发，客户端不需要知道拓扑 |

## 3. 与其他章节的关联

| 本篇内容 | 相关专题 |
|---|---|
| 会话接管、Client ID 唯一 | 6（回顾） |
| Session Present、会话队列 | 12（回顾） |
| 保留消息、遗嘱 | 14、15（回顾） |
| 共享订阅 | 19（回顾） |
| 单机天花板 | 26（回顾） |
| 主题树 → 两层路由 | 27（回顾） |
| 单机持久化 vs 集群持久化 | 28（回顾） |
| CAP、脑裂、Raft | 30 |
| 负载均衡、会话粘性 | 32 |
| 桥接、多地域 | 33 |
| 集群指标监控 | 46 |
| 故障演练 | 47、51 |

## 4. 诊断实践

### 4.1 实验（云端真实输出：两台 Mosquitto 2.0.18 桥接，作为"非集群"对照）

配置：

```
# B.conf
listener 1884
allow_anonymous true
sys_interval 1

# A.conf
listener 1883
allow_anonymous true
sys_interval 1
connection bridge-to-B
address 127.0.0.1:1884
topic em/# both 1
```

**实验 1：meter3 连 A，svc 在线连 B**

```
收到 em/meter3/up/telemetry/power = 12.3
```

**实验 2：svc2 在 B 建持久会话后下线；A 上发 3 条 QoS 1；svc2 重连**

```
svc2 重连到 A 收到: []
svc2 再连回 B 收到: [c1 c2 c3 ]
```

**实验 3：B 无 em 订阅者，A 上发 1000 条**

```
B 收到的 PUBLISH 计数: 5 → 1005
```

命令：

```bash
mosquitto -c B.conf -d; mosquitto -c A.conf -d; sleep 2
# 实验1
mosquitto_sub -V 5 -p 1884 -t 'em/#' -v &
mosquitto_pub -V 5 -p 1883 -t em/meter3/up/telemetry/power -m 12.3
# 实验2
mosquitto_sub -V 5 -p 1884 -c -i svc2 -q 1 -x 3600 -t 'em/#' -E
for i in 1 2 3; do mosquitto_pub -V 5 -q 1 -p 1883 -t em/meter3/up -m "c$i"; done
timeout 2 mosquitto_sub -V 5 -p 1883 -c -i svc2 -q 1 -x 3600 -t 'em/#'   # 连 A：收不到
timeout 2 mosquitto_sub -V 5 -p 1884 -c -i svc2 -q 1 -x 3600 -t 'em/#'   # 连回 B：收到
# 实验3
mosquitto_sub -p 1884 -t '$SYS/broker/publish/messages/received' -C 1
for i in $(seq 1000); do echo x; done | mosquitto_pub -p 1883 -t em/meter3/up -l
sleep 3; mosquitto_sub -p 1884 -t '$SYS/broker/publish/messages/received' -C 1
```

### 4.2 真集群验证（EMQX 3 节点 docker compose；只给步骤与预期，未实测）

1. 起 3 节点组成集群。
2. svc 连节点 1，持久会话订阅 `em/#`；meter3 连节点 2 发布 → 预期 svc 收到。
3. svc 下线，发 3 条，svc 重连节点 3 → 预期 Session Present=1 并收到 3 条（跨节点接管）。
4. 再下线、发 3 条，`docker stop` 会话所在节点，svc 重连他处 → 预期默认配置会话丢失（Session Present=0）；开启 `durable_sessions.enable = true` 后可恢复。

### 4.3 现象 → 怀疑 → 观察点

| 现象 | 优先怀疑 | 观察点 |
|---|---|---|
| 同一后端时收时不收 | 不是集群，是独立 broker | 发布者、订阅者各连哪个节点；集群状态 |
| 重连后离线消息没了 | 接管失败或会话所在节点宕机 | Session Present；节点宕机记录 |
| 同 ID 两台设备同时在线 | 桥接/伪集群 | 各节点连接列表 |
| 节点间流量远大于业务量 | 桥接全量转发或大扇出 | 节点间转发计数 |
| 新订阅后头几条丢失 | 路由复制窗口 | 订阅与消息时间对齐 |
| 节点宕机后部分遗嘱没发 | 遗嘱负责方取决于实现 | 故障演练专项检查 |

## 5. 复习 checklist

- [ ] 能说出集群要解决的三个单机问题
- [ ] 能用实验 1–3 说明桥接为什么不等于集群
- [ ] 能画出两层路由（全局路由表 + 本地订阅表）并解释为什么这样分
- [ ] 能说出 EMQX 5 core / replicant 的分工
- [ ] 能画出跨节点会话接管流程
- [ ] 能比较普通会话与 durable sessions 在节点宕机时的差异及代价
- [ ] 能说出共享订阅、保留消息、遗嘱在集群中的额外问题
- [ ] 能用"数据找客户端 vs 客户端找数据"对比 Redis Cluster

---

参考：[EMQX Clustering](https://docs.emqx.com/en/emqx/latest/deploy/cluster/introduction.md)、[EMQX · MQTT Durable Sessions](https://docs.emqx.com/en/emqx/latest/durability/durability_introduction.md)、[EMQX · Durable storage design](https://docs.emqx.com/en/emqx/latest/design/durable-storage.html)
