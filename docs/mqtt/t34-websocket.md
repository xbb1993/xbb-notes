# MQTT over WebSocket

> 专题 34 · 模块八 · ☆ 高频重点
> 第二遍 · 低优先级 8 个合讲 · 简述；云端实测：Mosquitto 2.0.18 WebSocket 监听 + paho-mqtt 2.1.0（transport=websockets）

## 1. 核心概念

- **是什么**：浏览器网页不能直接建 TCP 连接，只能用 WebSocket（网页与服务器之间保持长连接的协议）。把 MQTT 报文装在 WebSocket 里传，网页就能直连 broker。
- **互通**：WebSocket 客户端与 TCP 客户端在 broker 里平等，可以互相收发（实验）。
- **Mosquitto 配置**：

```
listener 9001
protocol websockets
```

- **用途**：网页实时大屏直接订阅；现场防火墙只放行 443 时可走 WebSocket（Azure IoT Hub 提供 443 上的 MQTT over WebSocket，45）。
- **对方案**：让大屏直连 broker 等于浏览器拿到 broker 账号，权限必须极紧（只读、只订阅汇总主题）；更常见是大屏连后端服务，由后端订阅 broker 再推给网页。

## 2. 易混淆 / 易错点

| 错误理解 | 正确理解 |
|---|---|
| WebSocket 客户端是另一套系统 | 与 TCP 客户端在同一 broker 中互通 |
| 大屏直连 broker 最简单无风险 | 浏览器持有 broker 账号，权限须极紧，常改由后端转推 |

## 3. 与其他章节的关联

接入层与 TLS（22、32）、授权（24）、云平台 443 端口（45）。

## 4. 诊断实践

实验（云端真实输出）：WebSocket 客户端（9001）订阅 `em/#`，TCP 电表（1883）发布：

```
WebSocket 客户端（端口 9001）收到： [('em/AE1/up/telemetry', '来自 TCP 电表的读数')]
```

客户端写法：`mqtt.Client(..., transport="websockets")`，`ws_set_options(path="/mqtt")`，连接 9001。

| 现象 | 优先怀疑 |
|---|---|
| 网页连不上 | 未开 WebSocket 监听；路径不匹配；反向代理未转发 Upgrade |
| 网页能订阅到不该看的数据 | 浏览器账号权限过大 |

## 5. 复习 checklist

- [ ] 能说出浏览器为何需要 WebSocket
- [ ] 能写出 Mosquitto WebSocket 监听配置
- [ ] 能说出大屏直连的风险与替代做法
