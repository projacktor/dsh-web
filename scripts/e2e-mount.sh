#!/usr/bin/env bash
# =============================================================================
# dsh-web 聚合包挂载冒烟编排（CI + 本地）：
#
#   1. `pnpm pack` 打出聚合包 tarball（workspace:* 依赖被 pnpm 改写为真实
#      版本号，与发布产物一致）；
#   2. 用官方 CLI 把 tarball 真实挂载进一个全新 scratch profile
#      （`dsh plugin --profile web add file:<tarball>`，与用户安装路径一致）；
#   3. 启动真实 `dsh web`（keyless，--port 0 取 OS 分配端口）；
#   4. 运行 tests/e2e 无头渲染 lane（Playwright Chromium）：以宿主官方帧
#      锚定启动、断言不内置的 better-sidebar 与被排除的 archive-manager 都
#      缺席、无崩溃标记；fork-isolation 另断言页面无 telemetry/like/
#      Turnstile/Cloudflare 出站请求。
#
# 用法：
#   bash scripts/e2e-mount.sh
#
# 依赖改写（scripts/e2e-mount-rewrite，默认 auto 模式）：本仓 workspace 构建
# 的 @linxin666/* 依赖一律打包为 file: tarball 挂载——npm 上同版本号的是上游
# 代码（仍带 telemetry/cloudflared 面，上游 remote-web-ui@0.4.5 直接依赖
# cloudflared），企业 fork 的门禁不挂载它；非本仓 workspace 的家族依赖
# （satellite）仍走 registry。FAMILY_TGZS_DIR 手工目录覆盖保留：给出时把
# 家族依赖改写为目录内同名 tarball；workspace 包缺 tarball 仍是硬失败。
#
# 环境变量（均可省略）：
#   DSH_CMD             dsh 命令；缺省 PATH 上的 `dsh`，首词不在 PATH 时回退
#                       npx 拉官方包；支持多词命令（如 pnpm --dir <path> dsh）
#   WEB_UI_ALL_DIR      聚合包目录；缺省 packages/dsh-web-all
#   FAMILY_TGZS_DIR     本地家族 tarball 目录（手工覆盖，优先级高于 auto
#                       模式）：给出时把家族依赖改写为 file:<目录内同名
#                       tarball>。已迁出为独立仓库、从 npm 消费的家族包
#                       （宠物 / 皮肤中心 / 社区索引）仍走 registry；
#                       workspace 包缺 tarball 仍是硬失败。
#   PORT                固定端口（默认 0 = OS 分配，从日志解析 URL）
#   DSH_HOME_BASE       覆盖 scratch 根目录（默认 mktemp -d）；指向真实 home 时
#                       直接拒绝，且调用方给出的根目录不会被整棵删除
#   KEEP_HOME           非空时保留 scratch home（调试用）
#
# 退出码 = playwright 的退出码；服务器与 scratch 目录由 trap 兜底清理。
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DSH_CMD="${DSH_CMD:-dsh}"
PORT="${PORT:-0}"
WEB_UI_ALL_DIR="${WEB_UI_ALL_DIR:-$ROOT/packages/dsh-web-all}"
FAMILY_TGZS_DIR="${FAMILY_TGZS_DIR:-}"

say()  { printf '\033[32m[e2e-mount]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[e2e-mount]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[e2e-mount]\033[0m %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "未找到 node（DSH 运行需要 Node.js >= 20）"
command -v pnpm >/dev/null 2>&1 || die "未找到 pnpm（dsh plugin 转发给 pnpm）"

# dsh CLI 解析：DSH_CMD 首词在 PATH 上优先（支持 "pnpm --dir <path> dsh"
# 这类多词命令），否则 npx 拉官方包
read -r -a DSH_CMD_WORDS <<< "$DSH_CMD"
if ! command -v "${DSH_CMD_WORDS[0]}" >/dev/null 2>&1; then
  if command -v npx >/dev/null 2>&1; then
    say "PATH 上无 ${DSH_CMD_WORDS[0]}，回退 npx -y --package @deepseek-ai/dsh"
    DSH_CMD="npx -y --package @deepseek-ai/dsh dsh"
  else
    die "未找到 $DSH_CMD 或 npx；请先安装 DSH CLI（npm i -g @deepseek-ai/dsh）或用 DSH_CMD 指定"
  fi
fi

[ -f "$WEB_UI_ALL_DIR/package.json" ] || die "聚合包目录不存在：$WEB_UI_ALL_DIR"

# scratch home（每次全新，绝不触碰真实 ~/.dsh）
OWNED_SCRATCH=""
if [ -n "${DSH_HOME_BASE:-}" ]; then
  # 调用方给根目录时先挡住真实 home：该值下面会被当作 scratch 使用与清理。
  _base_real="$(cd "$DSH_HOME_BASE" 2>/dev/null && pwd -P || printf '%s' "$DSH_HOME_BASE")"
  _home_real="$(cd "$HOME" 2>/dev/null && pwd -P || printf '%s' "$HOME")"
  case "$_base_real" in
    "/"|"$_home_real"|"$_home_real/.dsh") die "DSH_HOME_BASE 指向真实 home（$_base_real）；请改用一个专门的 scratch 目录" ;;
  esac
  SCRATCH="$DSH_HOME_BASE"
else
  SCRATCH="$(mktemp -d /tmp/dsh-web-ui-e2e.XXXXXX)"
  OWNED_SCRATCH=1
fi
export DSH_HOME="$SCRATCH/home"
WORKSPACE_DIR="$SCRATCH/workspace"
LOG_DIR="$SCRATCH"
WEB_LOG="$LOG_DIR/web.log"
mkdir -p "$DSH_HOME/profiles/web" "$WORKSPACE_DIR"
say "scratch home: ${DSH_HOME}（DSH_HOME=${DSH_HOME}）"

SERVER_PID=""
SERVER_PGRP=""
cleanup() {
  local code=$?
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    # 多词 DSH_CMD（如 pnpm --dir <path> dsh）的 pnpm 包装器不转发也不响应
    # SIGTERM，单杀 $! 会让 node 服务器变孤儿、wait 永不返回。setsid 启动时
    # 整组 TERM，宽限 5s 后整组 KILL；无 setsid 的环境退回单进程 kill。
    if [ -n "$SERVER_PGRP" ]; then
      kill -TERM -- "-$SERVER_PID" 2>/dev/null || true
      for _ in $(seq 1 50); do
        kill -0 "$SERVER_PID" 2>/dev/null || break
        sleep 0.1
      done
      kill -KILL -- "-$SERVER_PID" 2>/dev/null || true
    else
      kill "$SERVER_PID" 2>/dev/null || true
    fi
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ -z "${KEEP_HOME:-}" ]; then
    if [ -n "$OWNED_SCRATCH" ]; then
      rm -rf "$SCRATCH"
    else
      # 调用方提供的根目录只清理本次运行自己的子目录，绝不整棵删除。
      rm -rf "$SCRATCH/home" "$SCRATCH/workspace"
    fi
  else
    warn "KEEP_HOME 已设置，保留 $SCRATCH"
  fi
  exit "$code"
}
trap cleanup EXIT

# 步骤 1：打包聚合包（workspace:* 被 pnpm pack 改写为真实版本号）
say "打包聚合包：pnpm pack（${WEB_UI_ALL_DIR}）..."
TARBALL="$(cd "$WEB_UI_ALL_DIR" && pnpm pack --silent 2>/dev/null | tail -1)"
TARBALL="$(cd "$WEB_UI_ALL_DIR" && pwd)/$TARBALL"
[ -f "$TARBALL" ] || die "pnpm pack 未产出 tarball（${WEB_UI_ALL_DIR}）"
say "tarball: $TARBALL"

# 步骤 1b：解析聚合包 tarball 依赖（scripts/e2e-mount-rewrite）。auto 模式
# 把本仓 workspace 的 @linxin666/* 依赖一律改写为本地 file: tarball；
# FAMILY_TGZS_DIR 为手工目录覆盖，优先级高于 auto 模式。
if [ -n "$FAMILY_TGZS_DIR" ]; then
  [ -d "$FAMILY_TGZS_DIR" ] || die "FAMILY_TGZS_DIR 不存在：$FAMILY_TGZS_DIR"
fi
say "解析聚合包 tarball 依赖（auto=本仓 workspace 走本地；FAMILY_TGZS_DIR=${FAMILY_TGZS_DIR:-无}）"
REWRITE_DIR="$SCRATCH/tarball-rewrite"
mkdir -p "$REWRITE_DIR"
# GNU tar reads a "C:\..." argument as a remote host spec; --force-local keeps
# it a local path on the Windows/MSYS lane. Empty everywhere else.
TAR_LOCAL=()
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) TAR_LOCAL=(--force-local) ;; esac
tar ${TAR_LOCAL[@]+"${TAR_LOCAL[@]}"} -xzf "$TARBALL" -C "$REWRITE_DIR"
PACKAGE_JSON="$REWRITE_DIR/package/package.json"
REWRITE_ARGS=(--root "$ROOT")
if [ -n "$FAMILY_TGZS_DIR" ]; then
  REWRITE_ARGS+=(--family-dir "$FAMILY_TGZS_DIR")
fi
node "$ROOT/scripts/e2e-mount-rewrite" "$PACKAGE_JSON" "${REWRITE_ARGS[@]}"
TARBALL="$SCRATCH/dsh-web-all-rewritten.tgz"
tar ${TAR_LOCAL[@]+"${TAR_LOCAL[@]}"} -czf "$TARBALL" -C "$REWRITE_DIR" package
say "改写后 tarball: $TARBALL"

# 步骤 2：引导 scratch profile（web 模板；先写 pnpm-workspace.yaml 的
# allowBuilds / minimumReleaseAgeExclude，避免 pnpm 11 strict-dep-builds
# 拦截 node-pty/protobufjs 或拒绝 <24h 新版本——同 install.sh）
PROFILE_DIR="$DSH_HOME/profiles/web"
cat > "$PROFILE_DIR/package.json" <<EOF
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]
    }
  }
}
EOF
printf '[]\n' > "$PROFILE_DIR/cordis.patch.yml"
cat > "$PROFILE_DIR/pnpm-workspace.yaml" <<'EOF'
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false

allowBuilds:
  node-pty: true
  protobufjs: true
  cpu-features: true
  ssh2: true

minimumReleaseAgeExclude:
  - '@linxin666/*'
EOF

# 步骤 3：官方 CLI 安装 tarball + bundle 协调（真实挂载路径）
say "执行 dsh plugin --profile web add file:$TARBALL ..."
$DSH_CMD plugin --profile web add "file:$TARBALL"

# 步骤 4：校验挂载生效（dsh.profile.bundles 含聚合包）
if ! node -e '
  const fs = require("fs");
  const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const bundles = p.dsh?.profile?.bundles ?? [];
  process.exit(bundles.some(b => b === "@linxin666/dsh-web-all") ? 0 : 1);
' "$PROFILE_DIR/package.json"; then
  warn "dsh-web-all 未出现在 dsh.profile.bundles 中——挂载未注册"
  cat "$PROFILE_DIR/package.json"
  exit 1
fi
say "挂载已注册：dsh.profile.bundles 包含 @linxin666/dsh-web-all"

# 步骤 5：启动 dsh web（--port 0 = OS 分配；keyless 可起）。setsid 让服务器
# 自成进程组，cleanup 可整组 TERM/KILL（见 cleanup 注释）。
say "启动 dsh web（port=${PORT}）..."
if command -v setsid >/dev/null 2>&1; then
  setsid $DSH_CMD web --port "$PORT" > "$WEB_LOG" 2>&1 &
  SERVER_PGRP=1
else
  $DSH_CMD web --port "$PORT" > "$WEB_LOG" 2>&1 &
fi
SERVER_PID=$!

URL=""
for _ in $(seq 1 150); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "=== dsh web 提前退出，日志尾部 ===" >&2
    tail -30 "$WEB_LOG" >&2 || true
    exit 1
  fi
  # alpha.2 hosts print the tokenized root URL (`?token=<launch token>`) and
  # serve the browser-auth fence against it; the token must survive the parse
  # or Playwright lands on the 401 page. Capture up to the next token boundary
  # (the line ends after the URL or at the ` (LAN: ...)` suffix).
  if URL="$(grep -oE 'dsh web: http://127\.0\.0\.1:[0-9]+[^ )]*' "$WEB_LOG" | head -1 | awk '{print $3}')" && [ -n "$URL" ]; then
    break
  fi
  sleep 1
done
[ -n "$URL" ] || { echo "=== 150s 内未等到 dsh web 就绪，日志尾部 ===" >&2; tail -40 "$WEB_LOG" >&2 || true; exit 1; }
say "dsh web 就绪：${URL}（pid ${SERVER_PID}）"

# 步骤 6：运行无头渲染 lane（挂载冒烟 + fork 隔离断言）
say "运行 Playwright 无头渲染 lane..."
DSH_E2E_URL="$URL" DSH_E2E_WORKSPACE="$WORKSPACE_DIR" \
  pnpm exec playwright test

say "通过：聚合包挂载到真实 DSH 后无头渲染未崩溃，页面无 telemetry/like/Turnstile/Cloudflare 出站请求，不内置的 better-sidebar 与被排除的 archive-manager 均缺席"
