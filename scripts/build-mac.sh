#!/usr/bin/env bash
#
# ============================================================
#  日程侧边栏 —— macOS 一键打包脚本
# ============================================================
#  前置条件：一台 Mac（Intel 或 Apple 芯片均可），已安装 Node.js 18+
#
#  用法（在项目根目录执行）：
#    bash scripts/build-mac.sh                 # 自动按当前 Mac 芯片打包
#    bash scripts/build-mac.sh --arm64         # 仅 Apple 芯片 (M1/M2/M3...)
#    bash scripts/build-mac.sh --x64           # 仅 Intel 芯片
#    bash scripts/build-mac.sh --universal     # 通用包（两种芯片都能跑，体积更大）
#    bash scripts/build-mac.sh --no-open       # 打完不自动打开 dist 文件夹
#
#  环境变量：
#    MIRROR=0  关闭国内二进制镜像（默认开启，加速 electron/工具下载；
#              只影响二进制下载，npm 包源不受影响）
#    FORCE_INSTALL=1  打包前强制重新 npm install
#
#  产物：dist/日程侧边栏-<版本>.dmg
# ============================================================

set -euo pipefail

# 定位到项目根目录（本脚本位于 scripts/ 下）
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ---------------- 参数解析 ----------------
ARCH="auto"
OPEN_DIR=1
for arg in "$@"; do
  case "$arg" in
    --arm64)     ARCH="arm64" ;;
    --x64)       ARCH="x64" ;;
    --universal) ARCH="universal" ;;
    --no-open)   OPEN_DIR=0 ;;
    -h|--help)
      sed -n '3,22p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "未知参数: $arg（用 --help 查看用法）" >&2
      exit 1
      ;;
  esac
done

# ---------------- 环境检查 ----------------
if [ "$(uname -s)" != "Darwin" ]; then
  echo "✗ 此脚本只能在 macOS 上运行（Windows 无法生成 .dmg）" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "✗ 未检测到 Node.js，请先安装 Node.js 18 或更高版本：https://nodejs.org/" >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "✗ Node.js 版本过低（当前 $(node -v)），需要 18 或更高版本" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "✗ 未检测到 npm，请重新安装 Node.js" >&2
  exit 1
fi
if ! command -v hdiutil >/dev/null 2>&1; then
  echo "✗ 未找到 hdiutil（macOS 自带工具），请确认在真实 macOS 环境运行" >&2
  exit 1
fi

# 架构归一：auto → 按当前机器芯片
if [ "$ARCH" = "auto" ]; then
  case "$(uname -m)" in
    arm64)  ARCH="arm64" ;;
    x86_64) ARCH="x64" ;;
    *)
      echo "✗ 无法识别的 CPU 架构: $(uname -m)" >&2
      exit 1
      ;;
  esac
fi
case "$ARCH" in
  arm64)     BUILDER_FLAG="--arm64" ;;
  x64)       BUILDER_FLAG="--x64" ;;
  universal) BUILDER_FLAG="--universal" ;;
esac

# ---------------- 打包环境变量 ----------------
# 默认走国内镜像下载 Electron 与 electron-builder 二进制（Mac 直连 GitHub 同样容易超时）
if [ "${MIRROR:-1}" != "0" ]; then
  export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
  export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
fi
# 本项目未购买 Apple 开发者证书：禁止 electron-builder 搜索钥匙串签名（否则可能卡住）
export CSC_IDENTITY_AUTO_DISCOVERY=false

echo "------------------------------------------------------------"
echo " 日程侧边栏 macOS 打包"
echo "  Node    : $(node -v)"
echo "  npm     : $(npm -v)"
echo "  macOS   : $(sw_vers -productVersion 2>/dev/null || echo '未知')"
echo "  目标架构: $ARCH"
echo "  国内镜像: $([ "${MIRROR:-1}" != "0" ] && echo '开启（MIRROR=0 可关闭）' || echo '关闭')"
echo "  代码签名: 否（未签名，分发时需右键打开）"
echo "------------------------------------------------------------"

# ---------------- 安装依赖（含 koffi 的 macOS 原生重建） ----------------
if [ ! -d node_modules ] || [ "${FORCE_INSTALL:-0}" = "1" ]; then
  echo "==> [1/3] 安装项目依赖 npm install …"
  npm install
else
  echo "==> [1/3] 已存在 node_modules，跳过依赖安装（FORCE_INSTALL=1 可强制重装）"
fi

# ---------------- 打包 ----------------
echo "==> [2/3] electron-builder 生成 .dmg（首次需下载打包工具，请耐心等待）…"
if [ "$ARCH" = "universal" ]; then
  echo "    提示：通用包要求 koffi 同时具备 arm64/x64 原生件，若此步失败，请改用 --arm64 或 --x64"
fi
npx electron-builder --mac dmg $BUILDER_FLAG

# ---------------- 产物确认 ----------------
echo "==> [3/3] 检查产物 …"
DMG="$(ls -t dist/*.dmg 2>/dev/null | head -1 || true)"
if [ -z "$DMG" ]; then
  echo "✗ 未在 dist/ 找到 .dmg 产物，打包失败，请向上滚动查看日志" >&2
  exit 1
fi

echo ""
echo "✅ 打包成功！"
echo "   产物: dist/$(basename "$DMG")  ($(du -h "$DMG" | cut -f1))"
echo "   完整路径: $ROOT/dist/$(basename "$DMG")"
echo ""
echo "分发说明（应用未签名）："
echo "  1. 把 .dmg 发给对方，打开后将 App 拖入「应用程序」文件夹"
echo "  2. 首次启动请在 App 上【右键 → 打开】确认；或执行："
echo "     xattr -dr com.apple.quarantine /Applications/日程侧边栏.app"
echo ""

if [ "$OPEN_DIR" = "1" ]; then
  open dist
fi
