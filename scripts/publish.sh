#!/usr/bin/env bash
# 发布脚本：一次走完 build → pack → 试装 → version → publish
#
# 用法：
#   ./scripts/publish.sh              # 默认 patch 版本
#   ./scripts/publish.sh minor        # 小版本
#   ./scripts/publish.sh major        # 大版本
#   ./scripts/publish.sh dry-run      # 只做前 4 步，不真的 publish
#
# 前置：已 npm login 且 npm whoami 能返回用户名
set -euo pipefail

VERSION="${1:-patch}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

step() { printf "\n\033[1;34m▶ %s\033[0m\n" "$1"; }

step "1/5 类型检查 + 构建"
npm run prepublishOnly

step "2/5 打包并检查包内容"
rm -f pi-web-feishu-bridge-*.tgz
npm pack --silent
TARBALL=$(ls -1 pi-web-feishu-bridge-*.tgz | tail -1)
echo "  📦 $TARBALL ($(du -h "$TARBALL" | cut -f1))"

echo "  包内容清单："
tar tzf "$TARBALL" | sed 's/^/    /'

# 敏感文件白名单检查
echo "  检查敏感文件是否混入包..."
FORBIDDEN_RE='(^|/)(\.env$|registry\.json$|learning/|docs/|src/|\.log$|\.DS_Store$|\.git/)'
BAD=$(tar tzf "$TARBALL" | grep -E "$FORBIDDEN_RE" || true)
if [ -n "$BAD" ]; then
  echo "❌ 发现不应发布的文件："
  echo "$BAD"
  exit 1
fi
echo "  ✓ 白名单正确"

step "3/5 本地试装（真用户视角）"
SMOKE_DIR="$(mktemp -d)"
trap 'rm -rf "$SMOKE_DIR"' EXIT
pushd "$SMOKE_DIR" >/dev/null
npm init -y --silent >/dev/null
npm install --silent --no-audit --no-fund "$ROOT/$TARBALL"
echo "  ✓ npm install 成功"

# 验证 CLI 命令可执行
if command -v npx >/dev/null; then
  npx pi-web-feishu-bridge --help >/dev/null 2>&1 && echo "  ✓ npx 命令可执行" \
    || echo "  ⚠ npx 命令执行（可能是需要真启动，忽略）"
fi

# 验证 main 入口可 import
node -e "import('./node_modules/pi-web-feishu-bridge/dist/index.js').then(()=>console.log('  ✓ dist/index.js import 成功'))"
popd >/dev/null

if [ "$VERSION" = "dry-run" ]; then
  step "dry-run 模式，跳过 publish"
  echo "✅ dry-run 完成，未真的发布。包文件：$TARBALL"
  exit 0
fi

step "4/5 版本号 $VERSION"
npm version "$VERSION" --no-git-tag-version || npm version "$VERSION"

step "5/5 发布到 npm"
npm publish --registry=https://registry.npmjs.org/

echo
echo "🎉 发布完成！"
echo "   包名：pi-web-feishu-bridge@$(npm pkg get version | tr -d '\"')"
echo "   页面：https://www.npmjs.com/package/pi-web-feishu-bridge"
