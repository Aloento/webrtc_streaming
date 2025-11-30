@echo off
echo ========================================
echo   WebRTC 视频直播系统 启动脚本
echo ========================================
echo.

cd /d "%~dp0"

echo [1/2] 检查Python依赖...
pip install -r requirements.txt -q

echo [2/2] 启动服务器...
echo.
echo 服务器地址: http://localhost:8080
echo.
echo 按 Ctrl+C 停止服务器
echo ========================================
echo.

python server.py

pause
