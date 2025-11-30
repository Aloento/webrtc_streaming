"""
WebRTC Video Streaming Server
============================
支持功能:
- WebRTC P2P视频传输
- NAT打洞 (STUN/TURN)
- 服务器转发回退
- 多客户端观看
- 6位UUID房间系统
- 实时统计信息
"""

import json
import logging
import random
import string
import time
import uuid
from typing import Dict, Set, Optional
from dataclasses import dataclass, field

from aiohttp import web
from aiohttp.web import WebSocketResponse
import aiohttp_cors

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def generate_room_id() -> str:
    """生成6位数字房间ID"""
    return ''.join(random.choices(string.digits, k=6))


@dataclass
class ViewerStats:
    """观看者统计信息"""
    client_id: str
    connected_at: float = field(default_factory=time.time)
    bytes_sent: int = 0
    is_p2p: bool = False
    bitrate: float = 0.0


@dataclass
class BroadcastRoom:
    """直播房间"""
    room_id: str
    broadcaster_ws: Optional[WebSocketResponse] = None
    broadcaster_id: str = ""
    viewers: Dict[str, WebSocketResponse] = field(default_factory=dict)
    viewer_stats: Dict[str, ViewerStats] = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)
    total_bytes_sent: int = 0
    current_bitrate: float = 0.0
    # 服务器转发相关
    relay_connections: Set[str] = field(default_factory=set)
    # 存储最新的视频帧用于服务器转发
    latest_frame: Optional[bytes] = None
    frame_timestamp: float = 0.0
    # 编解码器配置
    codec_config: Optional[dict] = None


class WebRTCSignalingServer:
    """WebRTC信令服务器"""
    
    # 公共STUN/TURN服务器列表
    ICE_SERVERS = [
        # STUN服务器
        {"urls": "stun:stun.relay.metered.ca:80"},
        {"urls": "stun:stun.l.google.com:19302"},
        {"urls": "stun:stun1.l.google.com:19302"},
        # TURN服务器 (metered.ca)
        {
            "urls": "turn:global.relay.metered.ca:80",
            "username": "391551fe038ffcd6d41221de",
            "credential": "c7Iz2LKjKk6iuuM3"
        },
        {
            "urls": "turn:global.relay.metered.ca:80?transport=tcp",
            "username": "391551fe038ffcd6d41221de",
            "credential": "c7Iz2LKjKk6iuuM3"
        },
        {
            "urls": "turn:global.relay.metered.ca:443",
            "username": "391551fe038ffcd6d41221de",
            "credential": "c7Iz2LKjKk6iuuM3"
        },
        {
            "urls": "turns:global.relay.metered.ca:443?transport=tcp",
            "username": "391551fe038ffcd6d41221de",
            "credential": "c7Iz2LKjKk6iuuM3"
        }
    ]
    
    def __init__(self):
        self.rooms: Dict[str, BroadcastRoom] = {}
        self.client_to_room: Dict[str, str] = {}
        self.websockets: Dict[str, WebSocketResponse] = {}
        self.app = web.Application()
        self._setup_routes()
        self._setup_cors()
        
    def _setup_routes(self):
        """设置路由"""
        self.app.router.add_get('/', self.index_handler)
        self.app.router.add_get('/ws', self.websocket_handler)
        self.app.router.add_get('/api/rooms', self.list_rooms_handler)
        self.app.router.add_get('/api/ice-servers', self.ice_servers_handler)
        self.app.router.add_static('/static/', path='static', name='static')
        
    def _setup_cors(self):
        """设置CORS"""
        cors = aiohttp_cors.setup(self.app, defaults={
            "*": aiohttp_cors.ResourceOptions(
                allow_credentials=True,
                expose_headers="*",
                allow_headers="*",
            )
        })
        for route in list(self.app.router.routes()):
            try:
                cors.add(route)
            except ValueError:
                pass

    async def index_handler(self, request: web.Request) -> web.Response:
        """主页面处理"""
        with open('static/index.html', 'r', encoding='utf-8') as f:
            content = f.read()
        return web.Response(text=content, content_type='text/html')
    
    async def ice_servers_handler(self, request: web.Request) -> web.Response:
        """返回ICE服务器配置"""
        return web.json_response({"iceServers": self.ICE_SERVERS})
    
    async def list_rooms_handler(self, request: web.Request) -> web.Response:
        """列出活跃房间"""
        rooms_info = []
        for room_id, room in self.rooms.items():
            if room.broadcaster_ws:
                rooms_info.append({
                    "room_id": room_id,
                    "viewers": len(room.viewers),
                    "created_at": room.created_at
                })
        return web.json_response({"rooms": rooms_info})

    async def websocket_handler(self, request: web.Request) -> WebSocketResponse:
        """WebSocket连接处理"""
        ws = WebSocketResponse()
        await ws.prepare(request)
        
        client_id = str(uuid.uuid4())[:8]
        self.websockets[client_id] = ws
        
        logger.info(f"新客户端连接: {client_id}")
        
        # 发送客户端ID和ICE服务器配置
        await ws.send_json({
            "type": "welcome",
            "client_id": client_id,
            "ice_servers": self.ICE_SERVERS
        })
        
        try:
            async for msg in ws:
                if msg.type == web.WSMsgType.TEXT:
                    await self._handle_message(client_id, ws, json.loads(msg.data))
                elif msg.type == web.WSMsgType.BINARY:
                    # 处理二进制数据（服务器转发模式的视频帧）
                    await self._handle_binary(client_id, msg.data)
                elif msg.type == web.WSMsgType.ERROR:
                    logger.error(f"WebSocket错误: {ws.exception()}")
        except Exception as e:
            logger.error(f"处理消息错误: {e}")
        finally:
            await self._handle_disconnect(client_id)
            
        return ws

    async def _handle_message(self, client_id: str, ws: WebSocketResponse, data: dict):
        """处理WebSocket消息"""
        msg_type = data.get("type")
        
        if msg_type == "create_room":
            await self._create_room(client_id, ws)
            
        elif msg_type == "join_room":
            room_id = data.get("room_id")
            await self._join_room(client_id, ws, room_id)
            
        elif msg_type == "leave_room":
            await self._leave_room(client_id)
            
        elif msg_type == "offer":
            await self._relay_signaling(client_id, data)
            
        elif msg_type == "answer":
            await self._relay_signaling(client_id, data)
            
        elif msg_type == "ice_candidate":
            await self._relay_signaling(client_id, data)
            
        elif msg_type == "stats_update":
            await self._update_stats(client_id, data)
            
        elif msg_type == "request_relay":
            # 请求服务器转发模式
            await self._enable_relay(client_id, data.get("room_id"))
            
        elif msg_type == "codec_config":
            # 主播发送编解码器配置
            await self._handle_codec_config(client_id, data)
            
        elif msg_type == "relay_frame":
            # 主播发送视频帧用于服务器转发
            pass  # 二进制数据在_handle_binary中处理

    async def _handle_binary(self, client_id: str, data: bytes):
        """处理二进制数据（视频帧转发）"""
        room_id = self.client_to_room.get(client_id)
        if not room_id or room_id not in self.rooms:
            return
            
        room = self.rooms[room_id]
        if room.broadcaster_id != client_id:
            return
            
        # 存储最新帧并转发给需要服务器转发的观看者
        room.latest_frame = data
        room.frame_timestamp = time.time()
        room.total_bytes_sent += len(data)
        
        # 转发给所有relay连接的观看者
        for viewer_id in list(room.relay_connections):
            if viewer_id in room.viewers:
                try:
                    await room.viewers[viewer_id].send_bytes(data)
                    if viewer_id in room.viewer_stats:
                        room.viewer_stats[viewer_id].bytes_sent += len(data)
                except Exception as e:
                    logger.error(f"转发帧到 {viewer_id} 失败: {e}")
                    room.relay_connections.discard(viewer_id)

    async def _create_room(self, client_id: str, ws: WebSocketResponse):
        """创建直播房间"""
        # 生成唯一的6位房间ID
        room_id = generate_room_id()
        while room_id in self.rooms:
            room_id = generate_room_id()
            
        room = BroadcastRoom(
            room_id=room_id,
            broadcaster_ws=ws,
            broadcaster_id=client_id
        )
        self.rooms[room_id] = room
        self.client_to_room[client_id] = room_id
        
        logger.info(f"房间创建: {room_id} by {client_id}")
        
        await ws.send_json({
            "type": "room_created",
            "room_id": room_id
        })

    async def _join_room(self, client_id: str, ws: WebSocketResponse, room_id: str):
        """加入直播房间"""
        if not room_id or room_id not in self.rooms:
            await ws.send_json({
                "type": "error",
                "message": "房间不存在"
            })
            return
            
        room = self.rooms[room_id]
        if not room.broadcaster_ws:
            await ws.send_json({
                "type": "error", 
                "message": "主播已离开"
            })
            return
            
        room.viewers[client_id] = ws
        room.viewer_stats[client_id] = ViewerStats(client_id=client_id)
        self.client_to_room[client_id] = room_id
        
        logger.info(f"观看者 {client_id} 加入房间 {room_id}")
        
        # 通知观看者加入成功
        await ws.send_json({
            "type": "room_joined",
            "room_id": room_id,
            "broadcaster_id": room.broadcaster_id
        })
        
        # 通知主播有新观看者
        await room.broadcaster_ws.send_json({
            "type": "viewer_joined",
            "viewer_id": client_id,
            "viewer_count": len(room.viewers)
        })

    async def _leave_room(self, client_id: str):
        """离开房间"""
        room_id = self.client_to_room.get(client_id)
        if not room_id or room_id not in self.rooms:
            return
            
        room = self.rooms[room_id]
        
        if room.broadcaster_id == client_id:
            # 主播离开，关闭房间
            for viewer_id, viewer_ws in room.viewers.items():
                try:
                    await viewer_ws.send_json({
                        "type": "room_closed",
                        "message": "主播已结束直播"
                    })
                except:
                    pass
            del self.rooms[room_id]
            logger.info(f"房间关闭: {room_id}")
        else:
            # 观看者离开
            if client_id in room.viewers:
                del room.viewers[client_id]
            if client_id in room.viewer_stats:
                del room.viewer_stats[client_id]
            room.relay_connections.discard(client_id)
            
            if room.broadcaster_ws:
                try:
                    await room.broadcaster_ws.send_json({
                        "type": "viewer_left",
                        "viewer_id": client_id,
                        "viewer_count": len(room.viewers)
                    })
                except:
                    pass
                    
        if client_id in self.client_to_room:
            del self.client_to_room[client_id]

    async def _relay_signaling(self, client_id: str, data: dict):
        """转发信令消息"""
        target_id = data.get("target_id")
        room_id = self.client_to_room.get(client_id)
        
        if not target_id or not room_id:
            return
            
        room = self.rooms.get(room_id)
        if not room:
            return
            
        # 找到目标WebSocket
        target_ws = None
        if target_id == room.broadcaster_id:
            target_ws = room.broadcaster_ws
        elif target_id in room.viewers:
            target_ws = room.viewers[target_id]
            
        if target_ws:
            data["from_id"] = client_id
            try:
                await target_ws.send_json(data)
            except Exception as e:
                logger.error(f"转发信令失败: {e}")

    async def _update_stats(self, client_id: str, data: dict):
        """更新统计信息"""
        room_id = self.client_to_room.get(client_id)
        if not room_id or room_id not in self.rooms:
            return
            
        room = self.rooms[room_id]
        
        if room.broadcaster_id == client_id:
            # 主播更新统计
            room.current_bitrate = data.get("bitrate", 0)
            
            # 发送统计汇总给主播
            stats = {
                "type": "stats_summary",
                "viewer_count": len(room.viewers),
                "total_bytes_sent": room.total_bytes_sent,
                "current_bitrate": room.current_bitrate,
                "viewers": []
            }
            
            for vid, vstat in room.viewer_stats.items():
                stats["viewers"].append({
                    "id": vid,
                    "is_p2p": vstat.is_p2p,
                    "bytes_sent": vstat.bytes_sent,
                    "connected_duration": time.time() - vstat.connected_at
                })
                
            try:
                await room.broadcaster_ws.send_json(stats)
            except:
                pass
        else:
            # 观看者更新统计
            if client_id in room.viewer_stats:
                room.viewer_stats[client_id].is_p2p = data.get("is_p2p", False)
                room.viewer_stats[client_id].bytes_sent = data.get("bytes_received", 0)

    async def _enable_relay(self, client_id: str, room_id: str):
        """启用服务器转发模式"""
        if not room_id or room_id not in self.rooms:
            return
            
        room = self.rooms[room_id]
        room.relay_connections.add(client_id)
        
        if client_id in room.viewer_stats:
            room.viewer_stats[client_id].is_p2p = False
            
        logger.info(f"客户端 {client_id} 启用服务器转发模式")
        
        # 通知客户端已切换到转发模式
        if client_id in room.viewers:
            await room.viewers[client_id].send_json({
                "type": "relay_enabled",
                "message": "已切换到服务器转发模式"
            })
            
            # 如果有编解码器配置，发送给新的relay客户端
            if room.codec_config:
                await room.viewers[client_id].send_json({
                    "type": "codec_config",
                    **room.codec_config
                })

    async def _handle_codec_config(self, client_id: str, data: dict):
        """处理主播的编解码器配置"""
        room_id = self.client_to_room.get(client_id)
        if not room_id or room_id not in self.rooms:
            return
            
        room = self.rooms[room_id]
        if room.broadcaster_id != client_id:
            return
            
        # 保存编解码器配置
        room.codec_config = {
            "codec": data.get("codec"),
            "width": data.get("width"),
            "height": data.get("height")
        }
        
        logger.info(f"房间 {room_id} 编解码器配置: {room.codec_config}")
        
        # 转发给所有relay连接的观看者
        for viewer_id in room.relay_connections:
            if viewer_id in room.viewers:
                try:
                    await room.viewers[viewer_id].send_json({
                        "type": "codec_config",
                        **room.codec_config
                    })
                except Exception as e:
                    logger.error(f"发送编解码器配置到 {viewer_id} 失败: {e}")

    async def _handle_disconnect(self, client_id: str):
        """处理客户端断开连接"""
        await self._leave_room(client_id)
        if client_id in self.websockets:
            del self.websockets[client_id]
        logger.info(f"客户端断开: {client_id}")

    def run(self, host: str = "0.0.0.0", port: int = 8080):
        """启动服务器"""
        logger.info(f"启动WebRTC流媒体服务器: http://{host}:{port}")
        web.run_app(self.app, host=host, port=port)


if __name__ == "__main__":
    server = WebRTCSignalingServer()
    server.run()
