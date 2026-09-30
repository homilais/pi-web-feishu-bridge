#!/usr/bin/env bash
# 重启桥接服务：**必须非阻塞**（调用方 agent 正通过 bridge 与用户对话，
# 任何前台启动都会让工具调用永久挂死，会话直接断线）。
#
# 用法：
#   ./scripts/restart.sh          停止旧进程 → 后台启动 → 确认就绪
#   ./scripts/restart.sh --stop   只停止，不启动
#   ./scripts/restart.sh --logs   只看最近日志，不重启
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LOG="$ROOT/bridge.log"
MATCH="dist/cli.js"
READY_TIMEOUT="${READY_TIMEOUT:-25}"

stop() {
  local pids
  pids="$(pgrep -f "$MATCH" || true)"
  if [ -n "$pids" ]; then
    echo "▶ 停止旧进程: $(echo "$pids" | tr '\n' ' ')"
    pkill -f "$MATCH" 2>/dev/null || true
    sleep 1
  else
    echo "▶ 无运行中的桥接进程"
  fi
  pgrep -f "$MATCH" >/dev/null && { echo "  ⚠️ 仍有残留，强制结束"; pkill -9 -f "$MATCH" 2>/dev/null || true; }
}

if [ "${1:-}" = "--stop" ]; then stop; exit 0; fi
if [ "${1:-}" = "--logs" ]; then tail -30 "$LOG" 2>/dev/null; exit 0; fi

# 先构建：旧进程仍在服务，把断线窗口压到「停止→启动」这几秒。
# 构建失败则完全不碰旧进程，通信不会被打断。
echo "▶ 构建（旧进程继续服务中）"
if ! npm run build >/tmp/bridge-build.log 2>&1; then
  echo "  ❌ 构建失败，旧进程保持运行、未重启。错误："
  tail -20 /tmp/bridge-build.log
  exit 1
fi
echo "  ✓ 构建通过"

stop

echo "▶ 后台启动（nohup + disown，不阻塞）"
: > "$LOG"
# setsid/nohup 让进程脱离当前 shell，父 shell 退出也不会被 SIGHUP 带走
nohup node --env-file-if-exists=.env dist/cli.js >>"$LOG" 2>&1 &
NEWPID=$!
disown 2>/dev/null || true
echo "  pid=$NEWPID  日志→ $LOG"

echo "▶ 等待就绪（最多 ${READY_TIMEOUT}s）"
for ((i = 0; i < READY_TIMEOUT; i++)); do
  if grep -q "桥接已就绪" "$LOG" 2>/dev/null; then
    echo "  ✅ 就绪（${i}s）"
    echo
    grep -E "配置来源|· bot=|Pi-Web 连接|桥接已就绪" "$LOG" | sed 's/^/  /'
    exit 0
  fi
  if ! kill -0 "$NEWPID" 2>/dev/null; then
    echo "  ❌ 进程已退出，日志尾部："
    tail -25 "$LOG"
    exit 1
  fi
  if grep -qE "启动失败|无法连接 Pi-Web" "$LOG" 2>/dev/null; then
    echo "  ❌ 启动失败，日志尾部："
    tail -25 "$LOG"
    exit 1
  fi
  sleep 1
done

echo "  ⚠️ ${READY_TIMEOUT}s 内未确认就绪，进程仍在运行。日志尾部："
tail -15 "$LOG"
exit 2
