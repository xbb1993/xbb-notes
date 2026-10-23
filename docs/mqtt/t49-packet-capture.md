# 协议级抓包与排查

> 专题 49 · 模块十一 · ☆ 高频重点 · 第二遍（与 9、13、16、42 合讲，本篇展开）
> 云端实测：tshark 4.2.2 抓取本机回环 1883 端口；字段名在该版本查得，其他版本可能略有不同
> TLS 密钥导出解密未实验

**这一章解决什么**：日志说不清时，用抓包拿到"报文到底发没发、broker 回了什么"的证据。

## 1. 核心概念

### 1.1 什么时候抓包

大多数问题看日志和监控（46）就够。抓包适合：两边各执一词（"电表说发了，平台说没收到"）；日志不给原因（重复 CONNECT 直接关闭）；怀疑某个库实现有问题（32 中按固定 5 字节读 CONNACK 的坑）。

### 1.2 在哪抓、怎么抓

- 哪端可疑就在哪端抓；怀疑电表就在 broker 前或 LB 上抓电表那条连接。
- **TLS 下只能看到密文**：在 TLS 终结之后那段抓（LB→broker，32）；测试环境临时用明文复现；或让客户端导出密钥给 Wireshark 解密（取决于客户端，未实验）。
- 按端口、IP 过滤，只抓需要的。

**tshark**：Wireshark 的命令行版，适合服务器上抓包分析。

```bash
tshark -i lo -f "tcp port 1883" -w cap.pcapng      # 抓包
./decode.sh cap.pcapng                              # 翻译成时间线
```

### 1.3 读时间线

每行一个报文，`端口→端口` 是方向（1883 是 broker）；能直接看到专题 10 的"两段路"；用报文标识 `id` 配对 PUBLISH 与 PUBACK，算出每段耗时。

### 1.4 实用过滤

| 想看什么 | tshark 显示过滤 |
|---|---|
| 只看 MQTT | `-Y mqtt` |
| 某块电表的连接 | 先按 `mqtt.clientid == "meter3"` 找端口，再按端口过滤 |
| 所有被拒或断开的原因 | `-Y "mqtt.connack.reason_code > 0 or mqtt.disconnect.reason_code > 0"` |
| 心跳 | `-Y "mqtt.msgtype == 12 or mqtt.msgtype == 13"` |
| TCP 重传、重置 | `-Y "tcp.analysis.retransmission or tcp.flags.reset == 1"` |

最后一条：MQTT 层看似正常但消息慢或丢，往往是 TCP 大量重传——网络质量问题，不是 MQTT 问题。查字段名：`tshark -G fields | grep mqtt`。

报文类型编号：1 CONNECT、2 CONNACK、3 PUBLISH、4 PUBACK、8 SUBSCRIBE、9 SUBACK、12 PINGREQ、13 PINGRESP、14 DISCONNECT。

## 2. 易混淆 / 易错点

| 错误理解 | 正确理解 |
|---|---|
| 有问题先抓包 | 先看日志和指标，抓包是最后的证据 |
| 开了 TLS 也能直接看内容 | 只能看密文，要在终结后抓或解密 |
| MQTT 正常就是网络正常 | 看 TCP 重传与重置 |
| 抓全量包更保险 | 包太多看不过来，按端口和 IP 过滤 |

## 3. 与其他章节的关联

报文结构（5）、两段路与 PUBACK（10）、原因码（16、17）、TLS 终结位置（22、32）、监控先行（46）、故障破案（47）。

## 4. 诊断实践

### 4.1 实验（云端真实输出）

正常通信（订阅方 sink，发布方 meter3）：

```
  0.000s  56978→1883  CONNECT    sink
  0.000s   1883→56978 CONNACK                                 原因码=0
  0.000s  56978→1883  SUBSCRIBE          em/#                 id=1
  0.000s   1883→56978 SUBACK                                  id=1
  0.501s  56982→1883  CONNECT    meter3
  0.502s   1883→56982 CONNACK                                 原因码=0
  0.502s  56982→1883  PUBLISH            em/AE1/up/telemetry  qos=1 id=1
  0.502s   1883→56978 PUBLISH            em/AE1/up/telemetry  qos=1 id=1
  0.502s   1883→56982 PUBACK                                  id=1
  0.502s  56978→1883  PUBACK                                  id=1
  0.502s  56982→1883  DISCONNECT
  0.502s  56978→1883  DISCONNECT
```

出错场景（电表发 2000 字节，broker 上限 1024）：

```
  0.000s  53484→1883  CONNECT    meter9
  0.000s   1883→53484 CONNACK                                 原因码=0
  0.000s  53484→1883  PUBLISH            em/AE9/up/telemetry  qos=1 id=7
  0.000s   1883→53484 DISCONNECT                              原因码=149
```

149 = 0x95"报文太大"：电表说"我发了"，抓包显示"发了，但 broker 因为太大把你断开了"。

### 4.2 脚本

`decode.sh`（参数：抓包文件）：

```sh
#!/bin/sh
# 用 tshark 把抓包文件按"时间线"打印出来：谁发给谁、什么报文、主题、QoS、报文标识、各种原因码
tshark -r "$1" -Y mqtt -T fields -E separator='|' \
  -e frame.time_relative -e tcp.srcport -e tcp.dstport -e mqtt.msgtype -e mqtt.clientid -e mqtt.topic \
  -e mqtt.qos -e mqtt.msgid -e mqtt.connack.reason_code -e mqtt.puback.reason_code -e mqtt.disconnect.reason_code 2>/dev/null |
awk -F'|' 'BEGIN{split("CONNECT CONNACK PUBLISH PUBACK PUBREC PUBREL PUBCOMP SUBSCRIBE SUBACK UNSUB UNSUBACK PINGREQ PINGRESP DISCONNECT AUTH",N," ")}
$4!=""{rc=$9$10$11; printf "%7.3fs  %5s→%-5s %-10s %-7s %-20s %s%s%s\n",$1,$2,$3,N[$4],$5,$6,($7!=""?"qos="$7" ":""),($8!=""?"id="$8" ":""),(rc!=""?"原因码="rc:"")}'
```

### 4.3 现象 → 怀疑 → 观察点

| 现象 | 抓包看什么 |
|---|---|
| 设备说发了、平台没收到 | 设备那条连接上有没有 PUBLISH；broker 回的 PUBACK/DISCONNECT 原因码 |
| 设备被莫名断开 | 断开前最后几个报文；DISCONNECT 原因码；TCP RST |
| 消息慢 | PUBLISH 到 PUBACK 的耗时；TCP 重传 |
| 心跳异常、假离线 | PINGREQ/PINGRESP 间隔与是否有回应（7、47） |

## 5. 复习 checklist

- [ ] 能说出抓包适用的三种情况
- [ ] 能说出 TLS 下的三种应对
- [ ] 能用 tshark 抓包并读懂时间线，配对 PUBLISH 与 PUBACK
- [ ] 能写出查原因码、心跳、TCP 重传的过滤表达式
