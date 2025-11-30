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
- 🎥 **WebCodecs 编码** - 服务器转发模式使用高效视频编码 (VP9/VP8/H264)

## 技术架构

```text
┌─────────────────────────────────────────────────────────────┐
│                       信令服务器                             │
│                    (WebSocket + HTTP)                       │
└─────────────────────────────────────────────────────────────┘
           │                                    │
           │ 信令交换                            │ 信令交换
           │ (SDP/ICE)                          │ (SDP/ICE)
           ▼                                    ▼
┌─────────────────┐     P2P/TURN/Relay     ┌─────────────────┐
│    主播客户端    │◄─────────────────────► │   观看者客户端   │
│   (浏览器)      │     视频流传输          │   (浏览器)       │
└─────────────────┘                        └─────────────────┘
```

### 连接策略

1. **P2P 直连** (优先) - 通过 STUN 服务器获取公网地址，直接 P2P 连接
2. **TURN 中继** (备选) - 如果 P2P 失败，使用 TURN 服务器中继
3. **服务器转发** (最后) - 如果 TURN 也不可用，使用服务器转发视频流

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

### P2P 模式

系统自动选择浏览器支持的最优编解码器。

### 服务器转发模式

使用 WebCodecs API 进行高效视频编码，优先级：

- **VP9** (vp09.00.10.08) - 最佳压缩效率，现代浏览器支持
- **VP8** - 广泛支持，良好兼容性
- **H.264** (avc1.42E01E) - 硬件加速支持
- **JPEG** (回退) - 用于不支持 WebCodecs 的浏览器

| 模式                   | 编码方式     | 带宽占用 | 适用场景             |
| ---------------------- | ------------ | -------- | -------------------- |
| P2P                    | 浏览器原生   | 最低     | NAT 穿透成功         |
| TURN                   | 浏览器原生   | 低       | P2P 失败但 TURN 可用 |
| 服务器转发 (WebCodecs) | VP9/VP8/H264 | 中       | 现代浏览器           |
| 服务器转发 (JPEG 回退) | JPEG 图片    | 高       | 旧版浏览器           |

## 公共 STUN/TURN 服务器

系统使用以下服务器：

### STUN 服务器

- stun.relay.metered.ca:80
- stun.l.google.com:19302
- stun1.l.google.com:19302

### TURN 服务器 (Metered.ca)

- global.relay.metered.ca:80 (UDP)
- global.relay.metered.ca:80 (TCP)
- global.relay.metered.ca:443 (TLS)
- global.relay.metered.ca:443 (TURNS/TCP)

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

// 编解码器配置 (主播发送)
{ "type": "codec_config", "codec": "vp09.00.10.08", "width": 1280, "height": 720 }
```

#### 服务器发送

```json
// 欢迎消息
{ "type": "welcome", "client_id": "xxx", "ice_servers": [...] }

// 房间创建成功
{ "type": "room_created", "room_id": "123456" }

// 加入房间成功
{ "type": "room_joined", "room_id": "123456", "broadcaster_id": "xxx" }

// 编解码器配置 (转发给观看者)
{ "type": "codec_config", "codec": "vp09.00.10.08", "width": 1280, "height": 720 }

// 统计信息
{ "type": "stats_summary", "viewer_count": 5, "current_bitrate": 1500, ... }
```

### 二进制消息格式 (服务器转发)

WebCodecs 编码帧格式：

```text
[类型 1字节][时间戳 8字节][时长 4字节][视频数据...]
- 类型: 0=普通帧, 1=关键帧
- 时间戳: Float64 (微秒)
- 时长: Uint32 (微秒)
```

JPEG 回退格式：

```text
[0xFF 1字节][JPEG数据...]
```

### REST API

```text
GET /                 - 主页面
GET /api/rooms        - 获取活跃房间列表
GET /api/ice-servers  - 获取ICE服务器配置
```

## 浏览器兼容性

需要现代浏览器支持：

- Chrome 94+ (完整 WebCodecs 支持)
- Firefox 130+ (WebCodecs 支持)
- Safari 16.4+ (部分 WebCodecs 支持)
- Edge 94+ (完整 WebCodecs 支持)

> 注：不支持 WebCodecs 的浏览器将自动回退到 JPEG 模式

## 文件结构

```text
webrtc_streaming/
├── server.py           # 信令服务器 (Python + aiohttp)
├── requirements.txt    # Python依赖
├── start.bat          # Windows启动脚本
├── README.md          # 说明文档
└── static/
    ├── index.html     # 前端页面
    └── app.js         # 前端逻辑 (WebRTC + WebCodecs)
```

## 画质预设

| 预设          | 分辨率    | 帧率  | 码率    |
| ------------- | --------- | ----- | ------- |
| 流畅 (low)    | 854×480   | 24fps | 800kbps |
| 高清 (medium) | 1280×720  | 30fps | 1.5Mbps |
| 超清 (high)   | 1920×1080 | 30fps | 3Mbps   |

## 性能优化

- 使用 WebCodecs API 进行高效视频编码 (VP9/VP8)
- P2P 优先，减少服务器负载
- 关键帧间隔 60 帧，平衡压缩效率和随机访问
- WebSocket 保持长连接，减少信令延迟
- 自动降级兼容旧版浏览器
