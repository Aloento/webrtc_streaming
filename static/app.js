/**
 * WebRTC Video Streaming Client
 * ============================
 * Features:
 * - WebRTC P2P video transmission
 * - NAT traversal (STUN/TURN)
 * - Server relay fallback
 * - Multi-viewer
 * - Realtime statistics
 */

class WebRTCStreamingClient {
    constructor() {
        this.ws = null;
        this.clientId = null;
        this.roomId = null;
        this.isBroadcaster = false;
        this.localStream = null;
        this.iceServers = [];

        // Peer connections
        this.peerConnections = new Map();

        // Video quality presets
        this.qualityPresets = {
            low: { width: 854, height: 480, frameRate: 24, bitrate: 800000 },
            medium: { width: 1280, height: 720, frameRate: 30, bitrate: 1500000 },
            high: { width: 1920, height: 1080, frameRate: 30, bitrate: 3000000 }
        };
        this.currentQuality = 'medium';

        // Stats
        this.stats = {
            bytesSent: 0,
            bytesReceived: 0,
            bitrate: 0,
            packetsLost: 0,
            latency: 0
        };
        this.statsInterval = null;
        this.streamStartTime = null;

        // Relay mode
        this.isRelayMode = false;
        this.relayCanvas = null;
        this.relayCtx = null;

        // WebCodecs
        this.videoEncoder = null;
        this.videoDecoder = null;
        this.encoderConfig = null;
        this.pendingFrames = [];
        this.isEncoderReady = false;
        this.isDecoderReady = false;
        this.frameCounter = 0;
        this.keyFrameInterval = 60; // keyframe every 60 frames

        this.init();
    }

    init() {
        this.connectWebSocket();
        this.setupCameraSelect();
        this.setupQualityButtons();
        this.setupEventListeners();
    }

    // ==================== WebSocket ====================

    connectWebSocket() {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${location.host}/ws`;

        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
            console.log('WebSocket connected');
            // Broadcaster panel: "Connected"
            this.updateStatus('connected', 'Connected', 'broadcaster');
            // Viewer panel: "Connected to server"
            this.updateStatus('connected', 'Connected to server', 'viewer');
        };

        this.ws.onclose = () => {
            console.log('WebSocket disconnected');
            this.updateStatus('disconnected', 'Disconnected', 'both');
            setTimeout(() => this.connectWebSocket(), 3000);
        };

        this.ws.onerror = (error) => {
            console.error('WebSocket error:', error);
            this.showMessage('Connection error', 'error');
        };

        this.ws.onmessage = (event) => {
            if (typeof event.data === 'string') {
                this.handleMessage(JSON.parse(event.data));
            } else {
                // Binary data: relayed video frame
                this.handleRelayFrame(event.data);
            }
        };
    }

    handleMessage(data) {
        console.log('Received message:', data.type);

        switch (data.type) {
            case 'welcome':
                this.clientId = data.client_id;
                this.iceServers = data.ice_servers;
                console.log('Client ID:', this.clientId);
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
                this.showMessage('Switched to server relay mode', 'info');
                break;

            case 'codec_config':
                // Received codec config for decoder
                this.configureDecoder(data.codec, data.width, data.height);
                break;

            case 'error':
                this.showMessage(data.message, 'error');
                break;
        }
    }

    // ==================== Camera & quality ====================

    async setupCameraSelect() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const videoDevices = devices.filter(d => d.kind === 'videoinput');

            const select = document.getElementById('cameraSelect');
            select.innerHTML = '';

            videoDevices.forEach((device, index) => {
                const option = document.createElement('option');
                option.value = device.deviceId;
                option.text = device.label || `Camera ${index + 1}`;
                select.appendChild(option);
            });

            // Auto select first camera and preview
            if (videoDevices.length > 0) {
                select.value = videoDevices[0].deviceId;
                await this.previewCamera(select.value);
            }

            select.addEventListener('change', async () => {
                if (select.value && !this.isBroadcasting()) {
                    await this.previewCamera(select.value);
                }
            });

        } catch (err) {
            console.error('Failed to get camera list:', err);
        }
    }

    setupQualityButtons() {
        const buttons = document.querySelectorAll('.quality-btn');
        buttons.forEach(btn => {
            btn.addEventListener('click', () => {
                buttons.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.currentQuality = btn.dataset.quality;

                if (this.isBroadcasting()) {
                    this.updateEncodingParams();
                }
            });
        });
    }

    setupEventListeners() {
        // Room input: numbers only
        const roomInput = document.getElementById('roomIdInput');
        roomInput.addEventListener('input', (e) => {
            e.target.value = e.target.value.replace(/[^0-9]/g, '');
        });

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
            console.error('Failed to access camera:', err);
            this.showMessage('Cannot access camera: ' + err.message, 'error');
        }
    }

    // ==================== Broadcast ====================

    isBroadcasting() {
        return this.isBroadcaster && this.roomId !== null;
    }

    async startBroadcast() {
        const cameraSelect = document.getElementById('cameraSelect');
        const deviceId = (cameraSelect && cameraSelect.value) ? cameraSelect.value : undefined;

        // Get camera stream (or default camera)
        await this.previewCamera(deviceId);

        if (!this.localStream) {
            this.showMessage('Cannot get video stream', 'error');
            return;
        }

        this.isBroadcaster = true;

        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            this.showMessage('Connecting to server, please try again shortly', 'error');
            return;
        }

        this.send({ type: 'create_room' });

        document.getElementById('startBroadcastBtn').disabled = true;
        document.getElementById('stopBroadcastBtn').disabled = false;
        document.getElementById('cameraSelect').disabled = true;
    }

    handleRoomCreated(data) {
        this.roomId = data.room_id;

        document.getElementById('roomInfo').style.display = 'block';
        document.getElementById('roomIdDisplay').textContent = this.roomId;
        document.getElementById('liveBadge').style.display = 'block';
        document.getElementById('broadcasterStats').style.display = 'block';

        this.streamStartTime = Date.now();
        this.startStatsUpdate();

        this.showMessage(`Streaming started! Room ID: ${this.roomId}`, 'success');

        // Start relay backup
        this.startRelayFrameSender();
    }

    stopBroadcast() {
        this.peerConnections.forEach((pc) => {
            pc.close();
        });
        this.peerConnections.clear();

        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
        }

        this.send({ type: 'leave_room' });

        this.isBroadcaster = false;
        this.roomId = null;
        this.stopStatsUpdate();

        document.getElementById('startBroadcastBtn').disabled = false;
        document.getElementById('stopBroadcastBtn').disabled = true;
        document.getElementById('cameraSelect').disabled = false;
        document.getElementById('roomInfo').style.display = 'none';
        document.getElementById('liveBadge').style.display = 'none';
        document.getElementById('broadcasterStats').style.display = 'none';
        document.getElementById('localVideo').srcObject = null;

        this.showMessage('Streaming stopped', 'info');
    }

    handleViewerJoined(data) {
        const viewerId = data.viewer_id;
        console.log('New viewer:', viewerId);

        this.createPeerConnection(viewerId, true);

        this.showMessage(`New viewer joined (${data.viewer_count} watching)`, 'info');
    }

    handleViewerLeft(data) {
        const viewerId = data.viewer_id;

        if (this.peerConnections.has(viewerId)) {
            this.peerConnections.get(viewerId).close();
            this.peerConnections.delete(viewerId);
        }

        document.getElementById('viewerCount').textContent = data.viewer_count;
    }

    // ==================== Watch ====================

    joinRoom() {
        const roomId = document.getElementById('roomIdInput').value.trim();

        if (roomId.length !== 6 || !/^\d+$/.test(roomId)) {
            this.showMessage('Please enter a 6-digit numeric room ID', 'error');
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

        document.getElementById('roomIdInput').disabled = true;
        document.getElementById('joinRoomBtn').style.display = 'none';
        document.getElementById('leaveRoomBtn').style.display = 'inline-flex';
        document.getElementById('watchContainer').style.display = 'flex';
        document.getElementById('viewerStats').style.display = 'block';

        this.showMessage(`Joined room ${this.roomId}`, 'success');
        this.startStatsUpdate();
    }

    handleRoomClosed(data) {
        this.showMessage(data.message || 'Stream has ended', 'info');
        this.leaveRoom();
    }

    leaveRoom() {
        this.peerConnections.forEach((pc) => {
            pc.close();
        });
        this.peerConnections.clear();

        this.send({ type: 'leave_room' });

        this.roomId = null;
        this.isRelayMode = false;
        this.stopStatsUpdate();

        document.getElementById('roomIdInput').disabled = false;
        document.getElementById('roomIdInput').value = '';
        document.getElementById('joinRoomBtn').style.display = 'inline-flex';
        document.getElementById('leaveRoomBtn').style.display = 'none';
        document.getElementById('watchContainer').style.display = 'none';
        document.getElementById('viewerStats').style.display = 'none';
        document.getElementById('remoteVideo').srcObject = null;
    }

    // ==================== WebRTC P2P ====================

    createPeerConnection(peerId, isInitiator) {
        console.log(`Create PeerConnection: ${peerId}, isInitiator: ${isInitiator}`);

        const config = {
            iceServers: this.iceServers,
            iceCandidatePoolSize: 10
        };

        const pc = new RTCPeerConnection(config);
        this.peerConnections.set(peerId, pc);

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.send({
                    type: 'ice_candidate',
                    target_id: peerId,
                    candidate: event.candidate.toJSON()
                });
            }
        };

        pc.oniceconnectionstatechange = () => {
            console.log(`ICE state [${peerId}]:`, pc.iceConnectionState);

            if (pc.iceConnectionState === 'failed') {
                console.log('P2P connection failed, switching to server relay mode');
                this.requestRelayMode();
            } else if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
                this.updateConnectionType('P2P');
            }
        };

        pc.onconnectionstatechange = () => {
            console.log(`Connection state [${peerId}]:`, pc.connectionState);
        };

        pc.ontrack = (event) => {
            console.log('Received remote track:', event.track.kind);
            const video = document.getElementById('remoteVideo');
            if (video.srcObject !== event.streams[0]) {
                video.srcObject = event.streams[0];
            }
        };

        if (this.isBroadcaster && this.localStream) {
            this.localStream.getTracks().forEach(track => {
                pc.addTrack(track, this.localStream);
            });

            this.setEncodingParams(pc);
        }

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
            console.error('Failed to create offer:', err);
        }
    }

    async handleOffer(data) {
        const peerId = data.from_id;
        console.log('Received offer from:', peerId);

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
            console.error('Failed to handle offer:', err);
        }
    }

    async handleAnswer(data) {
        const peerId = data.from_id;
        const pc = this.peerConnections.get(peerId);

        if (pc) {
            try {
                await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
            } catch (err) {
                console.error('Failed to handle answer:', err);
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
                console.error('Failed to add ICE candidate:', err);
            }
        }
    }

    // ==================== Encoding params ====================

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

            sender.setParameters(params).catch(err => {
                console.warn('Failed to set encoding parameters:', err);
            });
        }
    }

    updateEncodingParams() {
        this.peerConnections.forEach((pc) => {
            this.setEncodingParams(pc);
        });
    }

    // ==================== Relay mode ====================

    requestRelayMode() {
        if (this.isRelayMode) return;

        this.isRelayMode = true;
        this.updateConnectionType('Relay');

        this.initVideoDecoder();

        this.send({
            type: 'request_relay',
            room_id: this.roomId
        });
    }

    // Init WebCodecs encoder (broadcaster)
    async initVideoEncoder() {
        if (!('VideoEncoder' in window)) {
            console.warn('WebCodecs not supported, falling back to JPEG mode');
            this.startJpegRelayFrameSender();
            return;
        }

        const quality = this.qualityPresets[this.currentQuality];

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
            console.warn('No supported video codec, falling back to JPEG');
            this.startJpegRelayFrameSender();
            return;
        }

        console.log(`Using codec: ${selectedCodec.name}`);

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
                    console.error('Encoder error:', e);
                }
            });

            await this.videoEncoder.configure(this.encoderConfig);
            this.isEncoderReady = true;

            this.send({
                type: 'codec_config',
                codec: selectedCodec.codec,
                width: quality.width,
                height: quality.height
            });

            console.log('Video encoder initialized');
            this.startWebCodecsFrameSender();
        } catch (e) {
            console.error('Failed to initialize encoder:', e);
            this.startJpegRelayFrameSender();
        }
    }

    // Init WebCodecs decoder (viewer)
    async initVideoDecoder() {
        if (!('VideoDecoder' in window)) {
            console.warn('WebCodecs not supported, using image display mode');
            return;
        }

        if (!this.relayCanvas) {
            this.relayCanvas = document.createElement('canvas');
            this.relayCtx = this.relayCanvas.getContext('2d');
        }

        this.videoDecoder = new VideoDecoder({
            output: (frame) => {
                this.renderDecodedFrame(frame);
            },
            error: (e) => {
                console.error('Decoder error:', e);
            }
        });

        this.isDecoderReady = false;
        console.log('Video decoder created, waiting for configuration...');
    }

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

            const video = document.getElementById('remoteVideo');
            if (!video.srcObject) {
                video.srcObject = this.relayCanvas.captureStream(30);
            }

            this.isDecoderReady = true;
            console.log(`Decoder configured: ${codec} ${width}x${height}`);
        } catch (e) {
            console.error('Failed to configure decoder:', e);
        }
    }

    handleEncodedChunk(chunk, metadata) {
        if (this.ws.readyState !== WebSocket.OPEN) return;

        const chunkData = new Uint8Array(chunk.byteLength);
        chunk.copyTo(chunkData);

        // [1 byte type][8 bytes timestamp][4 bytes duration][data]
        const header = new ArrayBuffer(13);
        const headerView = new DataView(header);
        headerView.setUint8(0, chunk.type === 'key' ? 1 : 0);
        headerView.setFloat64(1, chunk.timestamp, true);
        headerView.setUint32(9, chunk.duration || 0, true);

        const message = new Uint8Array(13 + chunkData.length);
        message.set(new Uint8Array(header), 0);
        message.set(chunkData, 13);

        this.ws.send(message.buffer);
    }

    renderDecodedFrame(frame) {
        if (!this.relayCtx) return;

        this.relayCtx.drawImage(frame, 0, 0);
        frame.close();
    }

    // WebCodecs frame sender
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

                const isKeyFrame = this.frameCounter % this.keyFrameInterval === 0;
                this.videoEncoder.encode(frame, { keyFrame: isKeyFrame });
                frame.close();

                this.frameCounter++;
            } catch (e) {
                console.warn('Failed to encode frame:', e);
            }

            const frameInterval = 1000 / this.encoderConfig.framerate;
            setTimeout(encodeFrame, frameInterval);
        };

        if (video.readyState >= 2) {
            encodeFrame();
        } else {
            video.addEventListener('loadeddata', encodeFrame, { once: true });
        }
    }

    // JPEG fallback (no WebCodecs)
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
                    blob.arrayBuffer().then(buffer => {
                        const header = new Uint8Array([0xFF]); // JPEG flag
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

        // JPEG (0xFF prefix)
        if (uint8[0] === 0xFF) {
            this.handleJpegFrame(uint8.slice(1));
            return;
        }

        // WebCodecs data
        if (!this.isDecoderReady) {
            console.warn('Decoder not ready, dropping frame');
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
            console.warn('Failed to decode frame:', e);
        }
    }

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

        this.initVideoEncoder();
    }

    // ==================== Stats ====================

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
        if (this.streamStartTime) {
            const duration = Math.floor((Date.now() - this.streamStartTime) / 1000);
            const minutes = Math.floor(duration / 60).toString().padStart(2, '0');
            const seconds = (duration % 60).toString().padStart(2, '0');

            const durationEl = document.getElementById('streamDuration');
            if (durationEl) {
                durationEl.textContent = `${minutes}:${seconds}`;
            }
        }

        let totalBytesSent = 0;
        let totalBytesReceived = 0;
        let bitrate = 0;

        for (const [, pc] of this.peerConnections) {
            try {
                const stats = await pc.getStats();

                stats.forEach(report => {
                    if (report.type === 'outbound-rtp' && report.kind === 'video') {
                        totalBytesSent += report.bytesSent || 0;

                        if (report.timestamp && this.lastStatsTimestamp) {
                            const timeDiff = report.timestamp - this.lastStatsTimestamp;
                            const bytesDiff = report.bytesSent - (this.lastBytesSent || 0);
                            bitrate = Math.round((bytesDiff * 8) / timeDiff);
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
                console.warn('Failed to get stats:', err);
            }
        }

        const bitrateEl = document.getElementById('currentBitrate') || document.getElementById('receivedBitrate');
        if (bitrateEl) {
            bitrateEl.textContent = bitrate;
        }

        const totalSentEl = document.getElementById('totalSent');
        if (totalSentEl) {
            totalSentEl.textContent = (totalBytesSent / 1024 / 1024).toFixed(2);
        }

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
                    <span>${minutes}m ${seconds}s</span>
                    <span class="connection-type ${viewer.is_p2p ? 'p2p' : 'relay'}">
                        ${viewer.is_p2p ? 'P2P' : 'Relay'}
                    </span>
                `;
                viewersList.appendChild(div);
            });
        } else {
            viewersList.innerHTML = '<div class="viewer-item" style="justify-content: center; color: #888;">No viewers yet</div>';
        }
    }

    // ==================== Helpers ====================

    send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }

    // target: 'broadcaster' | 'viewer' | 'both'
    updateStatus(state, text, target = 'both') {
        const pairs = [];

        if (target === 'both' || target === 'broadcaster') {
            pairs.push({
                indicatorId: 'broadcasterStatus',
                textId: 'broadcasterStatusText'
            });
        }

        if (target === 'both' || target === 'viewer') {
            pairs.push({
                indicatorId: 'viewerStatusIndicator',
                textId: 'viewerStatusText'
            });
        }

        pairs.forEach(({ indicatorId, textId }) => {
            const indicator = document.getElementById(indicatorId);
            const textEl = document.getElementById(textId);

            if (!indicator || !textEl) return;

            indicator.className = 'status-indicator ' + state;
            textEl.textContent = text;
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

// ==================== Global instance & UI ====================

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
        client.showMessage('Room ID copied', 'success');
    }).catch(() => {
        client.showMessage('Copy failed', 'error');
    });
}
