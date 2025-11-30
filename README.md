# WebRTC 视频直播系统

一个基于 WebRTC 的点对点视频直播系统，支持 NAT 打洞、TURN 回退和服务器转发。

## 功能特点

- 🎬 **WebRTC P2P 传输** - 优先使用点对点连接，降低延迟
- 🔓 **NAT 穿透** - 使用 STUN/TURN 服务器进行 NAT 打洞
- 🔄 **智能回退** - P2P 失败时自动切换到 TURN 或服务器转发
- 👥 **多观看者** - 单个主播可同时被多个客户端观看
- 📊 **实时统计** - 显示网速、码率、观看人数等信息
- 🔢 **6 位房间号** - 使用简单的 6 位数字作为房间 ID
- 📹 **摄像头选择** - 支持选择任意摄像头作为视频源
- 🎚️ **画质调节** - 支持 480p/720p/1080p 多种画质

## 技术架构

```
┌─────────────────────────────────────────────────────────────┐
│                       信令服务器                              │
│                    (WebSocket + HTTP)                        │
└─────────────────────────────────────────────────────────────┘
           │                                    │
           │ 信令交换                            │ 信令交换
           │ (SDP/ICE)                          │ (SDP/ICE)
           ▼                                    ▼
┌─────────────────┐     P2P/TURN/Relay     ┌─────────────────┐
│    主播客户端    │◄─────────────────────►│    观看者客户端   │
│   (浏览器)      │     视频流传输          │   (浏览器)       │
└─────────────────┘                        └─────────────────┘
```

### 连接策略

1. **P2P 直连** (优先) - 通过 STUN 服务器获取公网地址，直接 P2P 连接
2. **TURN 中继** (备选) - 如果 P2P 失败，使用公共 TURN 服务器中继
3. **服务器转发** (最后) - 如果 TURN 也不可用，使用服务器转发视频帧

## 安装和运行

### 1. 安装依赖

```bash
cd webrtc_streaming
pip install -r requirements.txt
```

### 2. 启动服务器

```bash
python server.py
```

服务器将在 `http://0.0.0.0:8080` 启动。

### 3. 访问网页

在浏览器中打开 `http://localhost:8080` 或 `http://<服务器IP>:8080`

## 使用说明

### 开始直播

1. 点击 "📹 开始直播"
2. 选择摄像头
3. 选择画质 (480p/720p/1080p)
4. 点击 "🎬 开始直播"
5. 获得 6 位数字房间号，分享给观众

### 观看直播

1. 点击 "👁️ 观看直播"
2. 输入 6 位数字房间号
3. 点击 "▶️ 进入直播间"

## 视频编解码

系统自动选择最优编解码器，优先级：

- **AV1** - 最先进，最佳压缩效率
- **VP9** - 良好压缩，广泛支持
- **VP8** - 兼容性好
- **H.264** - 硬件加速支持

## 公共 STUN/TURN 服务器

系统使用以下公共服务器：

### STUN 服务器

- stun.l.google.com:19302
- stun1-4.l.google.com:19302
- stun.stunprotocol.org:3478

### TURN 服务器

- openrelay.metered.ca (TCP/UDP)

> 注意：公共 TURN 服务器可能不稳定，生产环境建议部署自己的 TURN 服务器

## API 接口

### WebSocket 消息

连接地址: `ws://host:8080/ws`

#### 客户端发送

```json
// 创建房间
{ "type": "create_room" }

// 加入房间
{ "type": "join_room", "room_id": "123456" }

// 离开房间
{ "type": "leave_room" }

// WebRTC信令
{ "type": "offer|answer|ice_candidate", "target_id": "xxx", "sdp|candidate": {...} }

// 请求服务器转发
{ "type": "request_relay", "room_id": "123456" }
```

#### 服务器发送

```json
// 欢迎消息
{ "type": "welcome", "client_id": "xxx", "ice_servers": [...] }

// 房间创建成功
{ "type": "room_created", "room_id": "123456" }

// 加入房间成功
{ "type": "room_joined", "room_id": "123456", "broadcaster_id": "xxx" }

// 统计信息
{ "type": "stats_summary", "viewer_count": 5, "current_bitrate": 1500, ... }
```

### REST API

```
GET /                 - 主页面
GET /api/rooms        - 获取活跃房间列表
GET /api/ice-servers  - 获取ICE服务器配置
```

## 浏览器兼容性

需要现代浏览器支持：

- Chrome 80+
- Firefox 75+
- Safari 14+
- Edge 80+

## 文件结构

```
webrtc_streaming/
├── server.py           # 信令服务器
├── requirements.txt    # Python依赖
├── README.md          # 说明文档
└── static/
    ├── index.html     # 前端页面
    └── app.js         # 前端逻辑
```

## 性能优化

- 使用最先进的视频编解码器 (AV1/VP9)
- 根据网络状况自动调整码率
- P2P 优先，减少服务器负载
- WebSocket 保持长连接，减少延迟
