#!/usr/bin/env bash
# ==============================================================================
#  发布 olua 到线上服务器（归档导出 → 上传 → 解压 → 配置 → 重建 → 验收）
#
#  用法（在仓库根目录执行）：
#      bash scripts/deploy.sh                 # 全量：代码 + server/.env + 重建镜像
#      bash scripts/deploy.sh --no-build      # 只换代码，不重建镜像
#      bash scripts/deploy.sh --env-only      # 只更新 server/.env 并重启服务端
#      bash scripts/deploy.sh --game [目录]   # 同步游戏 Web 产物到 :8080（默认 client/build/web-desktop-001）
#      bash scripts/deploy.sh --verify        # 只做验收检查
#
#  前置：
#    - 根目录存在 deploy.env（gitignored），含 DEPLOY_HOST/USER/KEY/DIR/JWT_SECRET/ADMIN_REGISTER_CODE
#    - **改动已提交并合入 master**（git archive 只导出已提交状态，未提交的改动不会上线）
#    - 本机私钥权限 600（chmod 600），否则 SSH 直接拒绝
#
#  本脚本**不做任何删除**：不在服务器上 rm 目录，也不 down -v。
#  注意：覆盖式解压不会删掉服务器上已删的文件；若本次更新含文件删除，需手工清空后再发。
# ==============================================================================
set -euo pipefail

MODE="full"
GAME_SRC=""
for arg in "$@"; do
  case "$arg" in
    --no-build) MODE="no-build" ;;
    --env-only) MODE="env-only" ;;
    --game)     MODE="game" ;;
    --verify)   MODE="verify" ;;
    -h|--help)  sed -n '2,22p' "$0"; exit 0 ;;
    -*) echo "未知参数：$arg"; exit 2 ;;
    *) [ -z "$GAME_SRC" ] || { echo "多余的源目录参数：$arg"; exit 2; }
       GAME_SRC="$arg" ;;
  esac
done

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$ROOT" ] || { echo "✗ 请在 git 仓库内执行"; exit 1; }
cd "$ROOT"

[ -f deploy.env ] || { echo "✗ 缺少 deploy.env（cp deploy.env.example deploy.env 后填写）"; exit 1; }
set -a; . ./deploy.env; set +a

for v in DEPLOY_HOST DEPLOY_USER DEPLOY_KEY DEPLOY_DIR JWT_SECRET ADMIN_REGISTER_CODE; do
  [ -n "${!v:-}" ] || { echo "✗ deploy.env 缺少 $v"; exit 1; }
done

# 私钥：相对路径按仓库根解析
KEY="$DEPLOY_KEY"
if [ "$KEY" = "${KEY#/}" ]; then KEY="$ROOT/$DEPLOY_KEY"; fi   # 相对路径按仓库根解析
[ -r "$KEY" ] || { echo "✗ 读不到私钥：$KEY"; exit 1; }
PERM="$(stat -f '%OLp' "$KEY" 2>/dev/null || stat -c '%a' "$KEY" 2>/dev/null || echo '?')"
case "$PERM" in 600|400) ;; *) echo "✗ 私钥权限应为 600（当前 $PERM）：chmod 600 $KEY"; exit 1 ;; esac

SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=30)
SCP=(scp -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=30)
TARGET="$DEPLOY_USER@$DEPLOY_HOST"

# ---- 生成 server/.env：抄模板，只覆盖两个密钥（awk 替换，避开 BSD sed 的 -i 坑）----
build_env() {
  awk -v s="$JWT_SECRET" -v c="$ADMIN_REGISTER_CODE" '
    /^JWT_SECRET=/         { print "JWT_SECRET=" s;         next }
    /^ADMIN_REGISTER_CODE=/{ print "ADMIN_REGISTER_CODE=" c; next }
                           { print }
  ' server/.env.example > /tmp/olua-server.env
  echo "  已生成 server/.env（$(wc -l < /tmp/olua-server.env) 行）"
}

GAME_PORT="${GAME_PORT:-8080}"

verify() {
  echo "==> 验收"
  "${SSH[@]}" "$TARGET" "cd '$DEPLOY_DIR'
    docker compose ps
    echo -n 'admin page: '; curl --noproxy '*' -s -o /dev/null -w '%{http_code}\n' --max-time 10 http://127.0.0.1/
    echo -n 'admin api: ';  curl --noproxy '*' -s --max-time 10 http://127.0.0.1/api/health; echo
    echo -n 'game page: ';  curl --noproxy '*' -s -o /dev/null -w '%{http_code}\n' --max-time 10 http://127.0.0.1:${GAME_PORT}/
    echo -n 'game api: ';   curl --noproxy '*' -s --max-time 10 http://127.0.0.1:${GAME_PORT}/api/health; echo"
}

# 同步游戏 Web 产物：首次全量（2~3G，耗时以小时计），之后只传差异
sync_game() {
  local src="${GAME_SRC:-client/build/web-desktop-001}"
  [ -d "$src" ] || { echo "✗ 找不到构建产物目录：$src"; exit 1; }
  # 防呆：源不像一份完整产物就直接停——否则 --delete 会把服务器上的游戏清成空目录
  [ -f "$src/index.html" ] || { echo "✗ $src 里没有 index.html（不像完整的 Cocos Web 产物）"; exit 1; }
  echo "  源：$src  体积：$(du -sh "$src" 2>/dev/null | awk '{print $1}')"
  echo "==> rsync 增量同步 → $DEPLOY_DIR/game/（首次全量，之后只传差异）"
  rsync -az --delete --stats \
    -e "ssh -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null" \
    "$src/" "$TARGET:$DEPLOY_DIR/game/" || { echo "✗ rsync 失败"; exit 1; }
  echo "==> 起/更新 game 容器"
  "${SSH[@]}" "$TARGET" "cd '$DEPLOY_DIR' && docker compose up -d game"
}

case "$MODE" in
  verify) verify; exit 0 ;;
  game) sync_game; verify; exit 0 ;;
  env-only)
    echo "==> 只更新 server/.env"
    build_env
    "${SCP[@]}" /tmp/olua-server.env "$TARGET:$DEPLOY_DIR/server/.env"
    "${SSH[@]}" "$TARGET" "cd '$DEPLOY_DIR' && docker compose restart server"
    verify; exit 0 ;;
esac

echo "==> 1/5 导出归档（HEAD=$(git rev-parse --short HEAD)，未提交改动不会包含）"
git archive --format=tar.gz -o /tmp/olua-src.tgz HEAD
ls -lh /tmp/olua-src.tgz | awk '{print "  "$5" "$9}'

echo "==> 2/5 上传"
"${SCP[@]}" /tmp/olua-src.tgz "$TARGET:/tmp/olua-src.tgz"

echo "==> 3/5 解压"
"${SSH[@]}" "$TARGET" "cd '$DEPLOY_DIR' && tar xzf /tmp/olua-src.tgz && rm -f /tmp/olua-src.tgz"

echo "==> 4/5 传 server/.env（必须在解压之后）"
build_env
"${SCP[@]}" /tmp/olua-server.env "$TARGET:$DEPLOY_DIR/server/.env"

if [ "$MODE" = "no-build" ]; then
  echo "==> 5/5 跳过重建（--no-build）"
else
  echo "==> 5/5 docker compose up -d --build（耗时，放到后台跑更稳）"
  "${SSH[@]}" "$TARGET" "cd '$DEPLOY_DIR' && docker compose up -d --build"
fi

verify
echo "==> 完成"
