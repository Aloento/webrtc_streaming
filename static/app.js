/**
 * WebRTC Video Streaming Client
 * ============================
 * 支持功能:
 * - WebRTC P2P视频传输
 * - NAT打洞 (STUN/TURN)
 * - 服务器转发回退
 * - 多客户端观看
 * - 实时统计信息
 */

class WebRTCStreamingClient {
    constructor() {
        this.ws = null;
        this.clientId = null;
        this.roomId = null;
        this.isBroadcaster = false;
        this.localStream = null;
        this.iceServers = [];

        // 存储与各个对等端的连接
        this.peerConnections = new Map();

        // 视频质量配置
        this.qualityPresets = {
            low: { width: 854, height: 480, frameRate: 24, bitrate: 800000 },
            medium: { width: 1280, height: 720, frameRate: 30, bitrate: 1500000 },
            high: { width: 1920, height: 1080, frameRate: 30, bitrate: 3000000 }
        };
        this.currentQuality = 'medium';

        // 统计信息
        this.stats = {
            bytesSent: 0,
            bytesReceived: 0,
            bitrate: 0,
            packetsLost: 0,
            latency: 0
        };
        this.statsInterval = null;
        this.streamStartTime = null;

        // 服务器转发相关
        this.isRelayMode = false;
        this.relayCanvas = null;
        this.relayCtx = null;

        // WebCodecs 编解码器
        this.videoEncoder = null;
        this.videoDecoder = null;
        this.encoderConfig = null;
        this.pendingFrames = [];
        this.isEncoderReady = false;
        this.isDecoderReady = false;
        this.frameCounter = 0;
        this.keyFrameInterval = 60; // 每60帧一个关键帧

        this.init();
    }

    init() {
        this.connectWebSocket();
        this.setupCameraSelect();
        this.setupQualityButtons();
        this.setupEventListeners();
    }

    // ==================== WebSocket连接 ====================

    connectWebSocket() {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${location.host}/ws`;

        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
            console.log('WebSocket连接成功');
            this.updateStatus('connected', '已连接到服务器');
        };

        this.ws.onclose = () => {
            console.log('WebSocket连接断开');
            this.updateStatus('disconnected', '连接已断开');
            // 尝试重连
            setTimeout(() => this.connectWebSocket(), 3000);
        };

        this.ws.onerror = (error) => {
            console.error('WebSocket错误:', error);
            this.showMessage('连接错误', 'error');
        };

        this.ws.onmessage = (event) => {
            if (typeof event.data === 'string') {
                this.handleMessage(JSON.parse(event.data));
            } else {
                // 二进制数据 - 服务器转发的视频帧
                this.handleRelayFrame(event.data);
            }
        };
    }

    handleMessage(data) {
        console.log('收到消息:', data.type);

        switch (data.type) {
            case 'welcome':
                this.clientId = data.client_id;
                this.iceServers = data.ice_servers;
                console.log('客户端ID:', this.clientId);
                break;

            case 'room_created':
                this.handleRoomCreated(data);
                break;

            case 'room_joined':
                this.handleRoomJoined(data);
                break;

            case 'room_closed':
                this.handleRoomClosed(data);
                break;

            case 'viewer_joined':
                this.handleViewerJoined(data);
                break;

            case 'viewer_left':
                this.handleViewerLeft(data);
                break;

            case 'offer':
                this.handleOffer(data);
                break;

            case 'answer':
                this.handleAnswer(data);
                break;

            case 'ice_candidate':
                this.handleIceCandidate(data);
                break;

            case 'stats_summary':
                this.handleStatsSummary(data);
                break;

            case 'relay_enabled':
                this.showMessage('已切换到服务器转发模式', 'info');
                break;

            case 'codec_config':
                // 收到编解码器配置，初始化解码器
                this.configureDecoder(data.codec, data.width, data.height);
                break;

            case 'error':
                this.showMessage(data.message, 'error');
                break;
        }
    }

    // ==================== 摄像头和质量设置 ====================

    async setupCameraSelect() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const videoDevices = devices.filter(d => d.kind === 'videoinput');

            const select = document.getElementById('cameraSelect');
            select.innerHTML = '<option value="">选择摄像头...</option>';

            videoDevices.forEach((device, index) => {
                const option = document.createElement('option');
                option.value = device.deviceId;
                option.text = device.label || `摄像头 ${index + 1}`;
                select.appendChild(option);
            });

            // 选择变更时预览
            select.addEventListener('change', async () => {
                if (select.value && !this.isBroadcasting()) {
                    await this.previewCamera(select.value);
                }
            });
        } catch (err) {
            console.error('获取摄像头列表失败:', err);
        }
    }

    setupQualityButtons() {
        const buttons = document.querySelectorAll('.quality-btn');
        buttons.forEach(btn => {
            btn.addEventListener('click', () => {
                buttons.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.currentQuality = btn.dataset.quality;

                // 如果正在直播，更新编码参数
                if (this.isBroadcasting()) {
                    this.updateEncodingParams();
                }
            });
        });
    }

    setupEventListeners() {
        // 房间号输入框只允许数字
        const roomInput = document.getElementById('roomIdInput');
        roomInput.addEventListener('input', (e) => {
            e.target.value = e.target.value.replace(/[^0-9]/g, '');
        });

        // 回车加入房间
        roomInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                joinRoom();
            }
        });
    }

    async previewCamera(deviceId) {
        try {
            const quality = this.qualityPresets[this.currentQuality];

            const constraints = {
                video: {
                    deviceId: deviceId ? { exact: deviceId } : undefined,
                    width: { ideal: quality.width },
                    height: { ideal: quality.height },
                    frameRate: { ideal: quality.frameRate }
                },
                audio: true
            };

            if (this.localStream) {
                this.localStream.getTracks().forEach(track => track.stop());
            }

            this.localStream = await navigator.mediaDevices.getUserMedia(constraints);

            const video = document.getElementById('localVideo');
            video.srcObject = this.localStream;

        } catch (err) {
            console.error('获取摄像头失败:', err);
            this.showMessage('无法访问摄像头: ' + err.message, 'error');
        }
    }

    // ==================== 直播功能 ====================

    isBroadcasting() {
        return this.isBroadcaster && this.roomId !== null;
    }

    async startBroadcast() {
        const cameraSelect = document.getElementById('cameraSelect');
        if (!cameraSelect.value) {
            this.showMessage('请先选择摄像头', 'error');
            return;
        }

        // 获取摄像头流
        await this.previewCamera(cameraSelect.value);

        if (!this.localStream) {
            this.showMessage('无法获取视频流', 'error');
            return;
        }

        this.isBroadcaster = true;

        // 创建房间
        this.send({ type: 'create_room' });

        // 更新UI
        document.getElementById('startBroadcastBtn').disabled = true;
        document.getElementById('stopBroadcastBtn').disabled = false;
        document.getElementById('cameraSelect').disabled = true;
    }

    handleRoomCreated(data) {
        this.roomId = data.room_id;

        // 显示房间信息
        document.getElementById('roomInfo').style.display = 'block';
        document.getElementById('roomIdDisplay').textContent = this.roomId;
        document.getElementById('liveBadge').style.display = 'block';
        document.getElementById('broadcasterStats').style.display = 'block';

        this.streamStartTime = Date.now();
        this.startStatsUpdate();

        this.showMessage(`直播已开始! 房间号: ${this.roomId}`, 'success');

        // 开始发送服务器转发的帧（用于备用）
        this.startRelayFrameSender();
    }

    stopBroadcast() {
        // 关闭所有连接
        this.peerConnections.forEach((pc, peerId) => {
            pc.close();
        });
        this.peerConnections.clear();

        // 停止本地流
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
        }

        // 通知服务器
        this.send({ type: 'leave_room' });

        this.isBroadcaster = false;
        this.roomId = null;
        this.stopStatsUpdate();

        // 更新UI
        document.getElementById('startBroadcastBtn').disabled = false;
        document.getElementById('stopBroadcastBtn').disabled = true;
        document.getElementById('cameraSelect').disabled = false;
        document.getElementById('roomInfo').style.display = 'none';
        document.getElementById('liveBadge').style.display = 'none';
        document.getElementById('broadcasterStats').style.display = 'none';
        document.getElementById('localVideo').srcObject = null;

        this.showMessage('直播已结束', 'info');
    }

    handleViewerJoined(data) {
        const viewerId = data.viewer_id;
        console.log('新观看者:', viewerId);

        // 创建与新观看者的P2P连接
        this.createPeerConnection(viewerId, true);

        this.showMessage(`新观看者加入 (${data.viewer_count}人在看)`, 'info');
    }

    handleViewerLeft(data) {
        const viewerId = data.viewer_id;

        if (this.peerConnections.has(viewerId)) {
            this.peerConnections.get(viewerId).close();
            this.peerConnections.delete(viewerId);
        }

        document.getElementById('viewerCount').textContent = data.viewer_count;
    }

    // ==================== 观看功能 ====================

    joinRoom() {
        const roomId = document.getElementById('roomIdInput').value.trim();

        if (roomId.length !== 6 || !/^\d+$/.test(roomId)) {
            this.showMessage('请输入6位数字房间号', 'error');
            return;
        }

        this.send({
            type: 'join_room',
            room_id: roomId
        });
    }

    handleRoomJoined(data) {
        this.roomId = data.room_id;
        this.isBroadcaster = false;

        // 更新UI
        document.getElementById('roomIdInput').disabled = true;
        document.getElementById('joinRoomBtn').style.display = 'none';
        document.getElementById('leaveRoomBtn').style.display = 'inline-flex';
        document.getElementById('watchContainer').style.display = 'flex';
        document.getElementById('viewerStats').style.display = 'block';

        this.showMessage(`已加入房间 ${this.roomId}`, 'success');
        this.startStatsUpdate();

        // 等待主播的offer
    }

    handleRoomClosed(data) {
        this.showMessage(data.message || '直播已结束', 'info');
        this.leaveRoom();
    }

    leaveRoom() {
        // 关闭连接
        this.peerConnections.forEach((pc, peerId) => {
            pc.close();
        });
        this.peerConnections.clear();

        this.send({ type: 'leave_room' });

        this.roomId = null;
        this.isRelayMode = false;
        this.stopStatsUpdate();

        // 更新UI
        document.getElementById('roomIdInput').disabled = false;
        document.getElementById('roomIdInput').value = '';
        document.getElementById('joinRoomBtn').style.display = 'inline-flex';
        document.getElementById('leaveRoomBtn').style.display = 'none';
        document.getElementById('watchContainer').style.display = 'none';
        document.getElementById('viewerStats').style.display = 'none';
        document.getElementById('remoteVideo').srcObject = null;
    }

    // ==================== WebRTC P2P连接 ====================

    createPeerConnection(peerId, isInitiator) {
        console.log(`创建PeerConnection: ${peerId}, isInitiator: ${isInitiator}`);

        const config = {
            iceServers: this.iceServers,
            iceCandidatePoolSize: 10
        };

        const pc = new RTCPeerConnection(config);
        this.peerConnections.set(peerId, pc);

        // ICE候选
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.send({
                    type: 'ice_candidate',
                    target_id: peerId,
                    candidate: event.candidate.toJSON()
                });
            }
        };

        // ICE连接状态
        pc.oniceconnectionstatechange = () => {
            console.log(`ICE状态 [${peerId}]:`, pc.iceConnectionState);

            if (pc.iceConnectionState === 'failed') {
                // P2P连接失败，请求服务器转发
                console.log('P2P连接失败，切换到服务器转发模式');
                this.requestRelayMode();
            } else if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
                this.updateConnectionType('P2P');
            }
        };

        // 连接状态
        pc.onconnectionstatechange = () => {
            console.log(`连接状态 [${peerId}]:`, pc.connectionState);
        };

        // 接收远程流
        pc.ontrack = (event) => {
            console.log('收到远程轨道:', event.track.kind);
            const video = document.getElementById('remoteVideo');
            if (video.srcObject !== event.streams[0]) {
                video.srcObject = event.streams[0];
            }
        };

        // 如果是主播，添加本地流
        if (this.isBroadcaster && this.localStream) {
            this.localStream.getTracks().forEach(track => {
                pc.addTrack(track, this.localStream);
            });

            // 设置编码参数
            this.setEncodingParams(pc);
        }

        // 如果是发起者，创建offer
        if (isInitiator) {
            this.createAndSendOffer(pc, peerId);
        }

        return pc;
    }

    async createAndSendOffer(pc, peerId) {
        try {
            const offer = await pc.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true
            });

            await pc.setLocalDescription(offer);

            this.send({
                type: 'offer',
                target_id: peerId,
                sdp: pc.localDescription.toJSON()
            });
        } catch (err) {
            console.error('创建Offer失败:', err);
        }
    }

    async handleOffer(data) {
        const peerId = data.from_id;
        console.log('收到Offer from:', peerId);

        let pc = this.peerConnections.get(peerId);
        if (!pc) {
            pc = this.createPeerConnection(peerId, false);
        }

        try {
            await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));

            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            this.send({
                type: 'answer',
                target_id: peerId,
                sdp: pc.localDescription.toJSON()
            });
        } catch (err) {
            console.error('处理Offer失败:', err);
        }
    }

    async handleAnswer(data) {
        const peerId = data.from_id;
        const pc = this.peerConnections.get(peerId);

        if (pc) {
            try {
                await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
            } catch (err) {
                console.error('处理Answer失败:', err);
            }
        }
    }

    async handleIceCandidate(data) {
        const peerId = data.from_id;
        const pc = this.peerConnections.get(peerId);

        if (pc && data.candidate) {
            try {
                await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
            } catch (err) {
                console.error('添加ICE候选失败:', err);
            }
        }
    }

    // ==================== 编码参数设置 ====================

    setEncodingParams(pc) {
        const quality = this.qualityPresets[this.currentQuality];

        const sender = pc.getSenders().find(s => s.track?.kind === 'video');
        if (sender) {
            const params = sender.getParameters();
            if (!params.encodings || params.encodings.length === 0) {
                params.encodings = [{}];
            }

            params.encodings[0].maxBitrate = quality.bitrate;
            params.encodings[0].maxFramerate = quality.frameRate;

            // 使用最先进的编解码器
            // 优先级: AV1 > VP9 > VP8 > H264
            sender.setParameters(params).catch(err => {
                console.warn('设置编码参数失败:', err);
            });
        }
    }

    updateEncodingParams() {
        this.peerConnections.forEach((pc, peerId) => {
            this.setEncodingParams(pc);
        });
    }

    // ==================== 服务器转发模式 ====================

    requestRelayMode() {
        if (this.isRelayMode) return;

        this.isRelayMode = true;
        this.updateConnectionType('服务器转发');

        // 初始化解码器
        this.initVideoDecoder();

        this.send({
            type: 'request_relay',
            room_id: this.roomId
        });
    }

    // 初始化 WebCodecs 视频编码器 (主播端)
    async initVideoEncoder() {
        if (!('VideoEncoder' in window)) {
            console.warn('WebCodecs不支持，回退到JPEG模式');
            this.startJpegRelayFrameSender();
            return;
        }

        const quality = this.qualityPresets[this.currentQuality];

        // 编解码器优先级: VP9 > VP8 > H264
        const codecs = [
            { codec: 'vp09.00.10.08', name: 'VP9' },
            { codec: 'vp8', name: 'VP8' },
            { codec: 'avc1.42E01E', name: 'H264' }
        ];

        let selectedCodec = null;
        for (const c of codecs) {
            try {
                const support = await VideoEncoder.isConfigSupported({
                    codec: c.codec,
                    width: quality.width,
                    height: quality.height,
                    bitrate: quality.bitrate,
                    framerate: quality.frameRate
                });
                if (support.supported) {
                    selectedCodec = c;
                    break;
                }
            } catch (e) {
                continue;
            }
        }

        if (!selectedCodec) {
            console.warn('没有支持的视频编解码器，回退到JPEG');
            this.startJpegRelayFrameSender();
            return;
        }

        console.log(`使用编解码器: ${selectedCodec.name}`);

        this.encoderConfig = {
            codec: selectedCodec.codec,
            width: quality.width,
            height: quality.height,
            bitrate: quality.bitrate,
            framerate: quality.frameRate,
            latencyMode: 'realtime',
            bitrateMode: 'variable'
        };

        try {
            this.videoEncoder = new VideoEncoder({
                output: (chunk, metadata) => {
                    this.handleEncodedChunk(chunk, metadata);
                },
                error: (e) => {
                    console.error('编码器错误:', e);
                }
            });

            await this.videoEncoder.configure(this.encoderConfig);
            this.isEncoderReady = true;

            // 发送编解码器配置给服务器
            this.send({
                type: 'codec_config',
                codec: selectedCodec.codec,
                width: quality.width,
                height: quality.height
            });

            console.log('视频编码器初始化成功');
            this.startWebCodecsFrameSender();
        } catch (e) {
            console.error('编码器初始化失败:', e);
            this.startJpegRelayFrameSender();
        }
    }

    // 初始化 WebCodecs 视频解码器 (观看端)
    async initVideoDecoder() {
        if (!('VideoDecoder' in window)) {
            console.warn('WebCodecs不支持，使用图片显示模式');
            return;
        }

        // 创建用于显示的canvas
        if (!this.relayCanvas) {
            this.relayCanvas = document.createElement('canvas');
            this.relayCtx = this.relayCanvas.getContext('2d');
        }

        this.videoDecoder = new VideoDecoder({
            output: (frame) => {
                this.renderDecodedFrame(frame);
            },
            error: (e) => {
                console.error('解码器错误:', e);
            }
        });

        this.isDecoderReady = false;
        console.log('视频解码器已创建，等待配置...');
    }

    // 配置解码器
    async configureDecoder(codec, width, height) {
        if (!this.videoDecoder) return;

        try {
            await this.videoDecoder.configure({
                codec: codec,
                codedWidth: width,
                codedHeight: height,
                optimizeForLatency: true
            });

            this.relayCanvas.width = width;
            this.relayCanvas.height = height;

            // 将canvas流设置为视频源
            const video = document.getElementById('remoteVideo');
            if (!video.srcObject) {
                video.srcObject = this.relayCanvas.captureStream(30);
            }

            this.isDecoderReady = true;
            console.log(`解码器配置完成: ${codec} ${width}x${height}`);
        } catch (e) {
            console.error('解码器配置失败:', e);
        }
    }

    // 处理编码后的数据块
    handleEncodedChunk(chunk, metadata) {
        if (this.ws.readyState !== WebSocket.OPEN) return;

        // 创建包含元数据的消息
        const chunkData = new Uint8Array(chunk.byteLength);
        chunk.copyTo(chunkData);

        // 构建二进制消息: [类型1字节][时间戳8字节][时长4字节][数据]
        const header = new ArrayBuffer(13);
        const headerView = new DataView(header);
        headerView.setUint8(0, chunk.type === 'key' ? 1 : 0); // 是否关键帧
        headerView.setFloat64(1, chunk.timestamp, true);
        headerView.setUint32(9, chunk.duration || 0, true);

        // 合并header和数据
        const message = new Uint8Array(13 + chunkData.length);
        message.set(new Uint8Array(header), 0);
        message.set(chunkData, 13);

        this.ws.send(message.buffer);
    }

    // 渲染解码后的帧
    renderDecodedFrame(frame) {
        if (!this.relayCtx) return;

        this.relayCtx.drawImage(frame, 0, 0);
        frame.close();
    }

    // WebCodecs帧发送器
    startWebCodecsFrameSender() {
        if (!this.isBroadcaster || !this.isEncoderReady) return;

        const video = document.getElementById('localVideo');
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        const encodeFrame = () => {
            if (!this.isBroadcasting() || !this.isEncoderReady) return;
            if (this.videoEncoder.state !== 'configured') return;

            const width = video.videoWidth || this.encoderConfig.width;
            const height = video.videoHeight || this.encoderConfig.height;

            canvas.width = width;
            canvas.height = height;
            ctx.drawImage(video, 0, 0, width, height);

            try {
                const imageData = ctx.getImageData(0, 0, width, height);
                const frame = new VideoFrame(imageData.data, {
                    format: 'RGBA',
                    codedWidth: width,
                    codedHeight: height,
                    timestamp: performance.now() * 1000
                });

                // 每隔一定帧数发送关键帧
                const isKeyFrame = this.frameCounter % this.keyFrameInterval === 0;
                this.videoEncoder.encode(frame, { keyFrame: isKeyFrame });
                frame.close();

                this.frameCounter++;
            } catch (e) {
                console.warn('帧编码失败:', e);
            }

            // 根据帧率发送
            const frameInterval = 1000 / this.encoderConfig.framerate;
            setTimeout(encodeFrame, frameInterval);
        };

        if (video.readyState >= 2) {
            encodeFrame();
        } else {
            video.addEventListener('loadeddata', encodeFrame, { once: true });
        }
    }

    // JPEG回退模式 (用于不支持WebCodecs的浏览器)
    startJpegRelayFrameSender() {
        if (!this.isBroadcaster) return;

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const video = document.getElementById('localVideo');
        const quality = this.qualityPresets[this.currentQuality];

        const sendFrame = () => {
            if (!this.isBroadcasting()) return;

            canvas.width = video.videoWidth || quality.width;
            canvas.height = video.videoHeight || quality.height;
            ctx.drawImage(video, 0, 0);

            canvas.toBlob((blob) => {
                if (blob && this.ws.readyState === WebSocket.OPEN) {
                    // 添加JPEG标识头
                    blob.arrayBuffer().then(buffer => {
                        const header = new Uint8Array([0xFF]); // JPEG标识
                        const message = new Uint8Array(1 + buffer.byteLength);
                        message.set(header, 0);
                        message.set(new Uint8Array(buffer), 1);
                        this.ws.send(message.buffer);
                    });
                }
            }, 'image/jpeg', 0.75);

            setTimeout(sendFrame, 1000 / quality.frameRate);
        };

        if (video.readyState >= 2) {
            sendFrame();
        } else {
            video.addEventListener('loadeddata', sendFrame, { once: true });
        }
    }

    handleRelayFrame(data) {
        if (!this.isRelayMode) return;

        const uint8 = new Uint8Array(data);

        // 检查是否是JPEG (0xFF开头)
        if (uint8[0] === 0xFF) {
            this.handleJpegFrame(uint8.slice(1));
            return;
        }

        // WebCodecs编码的数据
        if (!this.isDecoderReady) {
            console.warn('解码器未就绪，丢弃帧');
            return;
        }

        try {
            const view = new DataView(data);
            const isKeyFrame = view.getUint8(0) === 1;
            const timestamp = view.getFloat64(1, true);
            const duration = view.getUint32(9, true);
            const chunkData = new Uint8Array(data, 13);

            const chunk = new EncodedVideoChunk({
                type: isKeyFrame ? 'key' : 'delta',
                timestamp: timestamp,
                duration: duration,
                data: chunkData
            });

            this.videoDecoder.decode(chunk);
        } catch (e) {
            console.warn('解码帧失败:', e);
        }
    }

    // JPEG帧显示
    handleJpegFrame(data) {
        const blob = new Blob([data], { type: 'image/jpeg' });
        const url = URL.createObjectURL(blob);

        const img = new Image();
        img.onload = () => {
            if (!this.relayCanvas) {
                this.relayCanvas = document.createElement('canvas');
                this.relayCtx = this.relayCanvas.getContext('2d');
            }

            this.relayCanvas.width = img.width;
            this.relayCanvas.height = img.height;
            this.relayCtx.drawImage(img, 0, 0);
            URL.revokeObjectURL(url);

            const video = document.getElementById('remoteVideo');
            if (!video.srcObject) {
                video.srcObject = this.relayCanvas.captureStream(30);
            }
        };
        img.src = url;
    }

    startRelayFrameSender() {
        if (!this.isBroadcaster) return;

        // 优先使用WebCodecs
        this.initVideoEncoder();
    }

    // ==================== 统计信息 ====================

    startStatsUpdate() {
        this.statsInterval = setInterval(() => {
            this.updateStats();
        }, 1000);
    }

    stopStatsUpdate() {
        if (this.statsInterval) {
            clearInterval(this.statsInterval);
            this.statsInterval = null;
        }
    }

    async updateStats() {
        // 更新直播时长
        if (this.streamStartTime) {
            const duration = Math.floor((Date.now() - this.streamStartTime) / 1000);
            const minutes = Math.floor(duration / 60).toString().padStart(2, '0');
            const seconds = (duration % 60).toString().padStart(2, '0');

            const durationEl = document.getElementById('streamDuration');
            if (durationEl) {
                durationEl.textContent = `${minutes}:${seconds}`;
            }
        }

        // 获取WebRTC统计
        let totalBytesSent = 0;
        let totalBytesReceived = 0;
        let bitrate = 0;

        for (const [peerId, pc] of this.peerConnections) {
            try {
                const stats = await pc.getStats();

                stats.forEach(report => {
                    if (report.type === 'outbound-rtp' && report.kind === 'video') {
                        totalBytesSent += report.bytesSent || 0;

                        if (report.timestamp && this.lastStatsTimestamp) {
                            const timeDiff = report.timestamp - this.lastStatsTimestamp;
                            const bytesDiff = report.bytesSent - (this.lastBytesSent || 0);
                            bitrate = Math.round((bytesDiff * 8) / timeDiff); // kbps
                        }

                        this.lastStatsTimestamp = report.timestamp;
                        this.lastBytesSent = report.bytesSent;
                    }

                    if (report.type === 'inbound-rtp' && report.kind === 'video') {
                        totalBytesReceived += report.bytesReceived || 0;

                        const packetsLostEl = document.getElementById('packetsLost');
                        if (packetsLostEl) {
                            packetsLostEl.textContent = report.packetsLost || 0;
                        }
                    }

                    if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                        const latencyEl = document.getElementById('latency');
                        if (latencyEl && report.currentRoundTripTime) {
                            latencyEl.textContent = Math.round(report.currentRoundTripTime * 1000);
                        }
                    }
                });
            } catch (err) {
                console.warn('获取统计失败:', err);
            }
        }

        // 更新UI
        const bitrateEl = document.getElementById('currentBitrate') || document.getElementById('receivedBitrate');
        if (bitrateEl) {
            bitrateEl.textContent = bitrate;
        }

        const totalSentEl = document.getElementById('totalSent');
        if (totalSentEl) {
            totalSentEl.textContent = (totalBytesSent / 1024 / 1024).toFixed(2);
        }

        // 发送统计到服务器
        if (this.isBroadcaster) {
            this.send({
                type: 'stats_update',
                bitrate: bitrate,
                bytes_sent: totalBytesSent
            });
        } else {
            this.send({
                type: 'stats_update',
                is_p2p: !this.isRelayMode,
                bytes_received: totalBytesReceived
            });
        }
    }

    handleStatsSummary(data) {
        document.getElementById('viewerCount').textContent = data.viewer_count;
        document.getElementById('currentBitrate').textContent = data.current_bitrate || 0;
        document.getElementById('totalSent').textContent = ((data.total_bytes_sent || 0) / 1024 / 1024).toFixed(2);

        // 更新观看者列表
        const viewersList = document.getElementById('viewersList');
        viewersList.innerHTML = '';

        if (data.viewers && data.viewers.length > 0) {
            data.viewers.forEach(viewer => {
                const div = document.createElement('div');
                div.className = 'viewer-item';

                const duration = Math.floor(viewer.connected_duration);
                const minutes = Math.floor(duration / 60);
                const seconds = duration % 60;

                div.innerHTML = `
                    <span class="viewer-id">${viewer.id}</span>
                    <span>${minutes}分${seconds}秒</span>
                    <span class="connection-type ${viewer.is_p2p ? 'p2p' : 'relay'}">
                        ${viewer.is_p2p ? 'P2P' : '转发'}
                    </span>
                `;
                viewersList.appendChild(div);
            });
        } else {
            viewersList.innerHTML = '<div class="viewer-item" style="justify-content: center; color: #888;">暂无观看者</div>';
        }
    }

    // ==================== 工具方法 ====================

    send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }

    updateStatus(state, text) {
        const indicators = document.querySelectorAll('.status-indicator');
        const statusTexts = document.querySelectorAll('.status-text');

        indicators.forEach(el => {
            el.className = 'status-indicator ' + state;
        });

        statusTexts.forEach(el => {
            el.textContent = text;
        });
    }

    updateConnectionType(type) {
        const badge = document.getElementById('connectionTypeBadge');
        const typeEl = document.getElementById('connectionType');

        if (badge) {
            badge.textContent = type;
            badge.style.background = type === 'P2P' ? '#00ff88' : '#ffa500';
        }

        if (typeEl) {
            typeEl.textContent = type;
        }
    }

    showMessage(message, type = 'info') {
        const toast = document.getElementById('messageToast');
        toast.textContent = message;
        toast.className = 'message-toast show ' + type;

        setTimeout(() => {
            toast.classList.remove('show');
        }, 3000);
    }
}

// ==================== 全局实例和UI控制 ====================

let client = null;

document.addEventListener('DOMContentLoaded', () => {
    client = new WebRTCStreamingClient();
});

function selectMode(mode) {
    document.getElementById('modeSelector').style.display = 'none';

    if (mode === 'broadcast') {
        document.getElementById('broadcastPanel').classList.add('active');
    } else {
        document.getElementById('watchPanel').classList.add('active');
    }
}

function goBack() {
    // 停止任何正在进行的直播或观看
    if (client.isBroadcaster && client.roomId) {
        client.stopBroadcast();
    } else if (client.roomId) {
        client.leaveRoom();
    }

    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.getElementById('modeSelector').style.display = 'flex';
}

function startBroadcast() {
    client.startBroadcast();
}

function stopBroadcast() {
    client.stopBroadcast();
}

function joinRoom() {
    client.joinRoom();
}

function leaveRoom() {
    client.leaveRoom();
}

function copyRoomId() {
    const roomId = document.getElementById('roomIdDisplay').textContent;
    navigator.clipboard.writeText(roomId).then(() => {
        client.showMessage('房间号已复制', 'success');
    }).catch(() => {
        client.showMessage('复制失败', 'error');
    });
}
