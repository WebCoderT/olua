#!/usr/bin/env bash
# ==============================================================================
#  发布 olua 到线上服务器（归档导出 → 上传 → 解压 → 配置 → 重建 → 验收）
#
#  用法（在仓库根目录执行）：
#      bash scripts/deploy.sh                 # 全量：代码 + server/.env + 重建镜像
#      bash scripts/deploy.sh --no-build      # 只换代码，不重建镜像
#      bash scripts/deploy.sh --env-only      # 只更新 server/.env 并重启服务端
#      bash scripts/deploy.sh --game [目录]   # 同步游戏 Web 产物到 :8080（默认 client/build/web-desktop-001）
#      bash scripts/deploy.sh --resources     # 同步管理端素材（image-manifest 等）到 game/resources/
#      # ↑ 这两个模式是唯一会拉起 game 容器的路径：game 挂 profiles:["game"]（#1314），
#      #   全量 / --no-build / --tls-init 的 up -d 都不会碰它；不部署客户端时 game.yimw.cn 502 属预期。
#      bash scripts/deploy.sh --tls-init      # 首次签发证书（OLUA_TLS=on 才用；跑一次就够）
#      bash scripts/deploy.sh --verify        # 只做验收检查
#
#  前置：
#    - 根目录存在 deploy.env（gitignored），含 DEPLOY_HOST/USER/KEY/DIR/JWT_SECRET/ADMIN_REGISTER_CODE，
#      可选 OLUA_SITE_DOMAINS / OLUA_ADMIN_DOMAIN / OLUA_GAME_DOMAIN（三站域名，不填用默认值）、
#      OLUA_TLS=on + OLUA_ACME_EMAIL（开 HTTPS，#742）
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
    --resources) MODE="resources" ;;
    --tls-init) MODE="tls-init" ;;
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
case "$PERM" in 600|400) ;; *) echo "✗ 私钥权限应为 600（当前 ${PERM}）：chmod 600 $KEY"; exit 1 ;; esac

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

# ---- 三站域名（admin/nginx.conf.template 的 envsubst 用）----
# 来源：deploy.env 的 OLUA_* 变量；没写就用与 Dockerfile/compose 一致的默认值。
# 写进服务器上 compose 目录的 `.env`（compose 插值读它）→ 换域名只改 deploy.env 重发 --env-only？
# 不行 —— .env 只在 `up -d` 时生效，脚本统一在每次部署时重新生成上传，本地与远端永不漂移。
SITE_DOMAINS="${OLUA_SITE_DOMAINS:-yimw.cn www.yimw.cn}"
ADMIN_DOMAIN="${OLUA_ADMIN_DOMAIN:-admin.yimw.cn}"
GAME_DOMAIN="${OLUA_GAME_DOMAIN:-game.yimw.cn}"
SITE_PRIMARY="$(printf '%s' "$SITE_DOMAINS" | awk '{print $1}')"

# ---- HTTPS（#742）：开关、账号邮箱，以及「一张证书覆盖哪些域名」----
TLS="${OLUA_TLS:-off}"
ACME_EMAIL="${OLUA_ACME_EMAIL:-}"
if [ "$TLS" = "on" ] && [ -z "$ACME_EMAIL" ]; then
  echo "✗ OLUA_TLS=on 但 deploy.env 里没有 OLUA_ACME_EMAIL（Let's Encrypt 需要一个账号邮箱）"
  exit 1
fi

# 证书的 SAN 列表 = 三个域名变量里出现过的全部（去重、保序）。
# 与 nginx 模板用的是同一组变量，所以「证书覆盖的域名」永远等于「nginx 认的域名」。
ALL_DOMAINS="$(printf '%s %s %s\n' "$SITE_DOMAINS" "$ADMIN_DOMAIN" "$GAME_DOMAIN" \
  | tr ' ' '\n' | awk 'NF && !seen[$0]++' | tr '\n' ' ' | sed 's/ *$//')"
DOMAIN_FLAGS=""
for d in $ALL_DOMAINS; do DOMAIN_FLAGS="$DOMAIN_FLAGS -d $d"; done

build_compose_env() {
  {
    echo "# 由 deploy.sh 生成（compose 插值用），真源是 deploy.env 的 OLUA_* 几项"
    echo "OLUA_SITE_DOMAINS=$SITE_DOMAINS"
    echo "OLUA_ADMIN_DOMAIN=$ADMIN_DOMAIN"
    echo "OLUA_GAME_DOMAIN=$GAME_DOMAIN"
    if [ "$TLS" = "on" ]; then
      # 这三行是 TLS 的接线，必须跟域名写在同一个文件里（人手工补必然漏）：
      #   COMPOSE_PROFILES=tls  → edge / certbot 两个服务才会被 `up -d` 拉起来
      #   OLUA_ADMIN_BIND/PORT  → 把宿主机 :80 让给 edge（admin 退回回环，本机仍能直连验收）
      # TLS 关掉时这里不写 → compose 退回默认值，明文 :80 恢复，等于干净的「回滚开关」。
      echo "COMPOSE_PROFILES=tls"
      echo "OLUA_ADMIN_BIND=127.0.0.1"
      echo "OLUA_ADMIN_PORT=8081"
    fi
  } > /tmp/olua-compose.env
  local extra=""
  [ "$TLS" = "on" ] && extra=" + TLS（admin 退回 127.0.0.1:8081，:80/:443 归 edge）"
  echo "  已生成 compose .env（${SITE_PRIMARY} / ${ADMIN_DOMAIN} / ${GAME_DOMAIN}）${extra}"
}

verify() {
  echo "==> 验收"
  # TLS 部署下宿主机 :80 是 edge 的，admin 退到回环 8081（见 build_compose_env）：
  #   - 对外入口一律从 edge 打（https + 用 IP 打时证书名对不上，所以 -k）；
  #   - 想验后端本身有没有起来，仍可以直接打 admin 的内网口。
  if [ "$TLS" = "on" ]; then
    ADMIN_PROBE="https://127.0.0.1"
    ADMIN_INNER="http://127.0.0.1:8081"
    CURL_TLS="-k"
  else
    ADMIN_PROBE="http://127.0.0.1"
    ADMIN_INNER="http://127.0.0.1"
    CURL_TLS=""
  fi
  # 内网口只有 TLS 模式才值得单独看一眼（明文部署下它与「admin page」是同一个地址）
  if [ "$TLS" = "on" ]; then
    INNER_LINE="echo -n 'admin 内网口: '; curl --noproxy '*' -s -o /dev/null -w '%{http_code}\\n' --max-time 10 $ADMIN_INNER/"
  else
    INNER_LINE=":"
  fi
  # `docker compose up -d` 返回时容器**还没开始服务**：上一轮就是在这里读到 502 的假故障
  # （nginx 已经在，后面 server 还在 starting）。先等健康检查转绿，再打接口。
  "${SSH[@]}" "$TARGET" "cd '$DEPLOY_DIR'
    for i in \$(seq 1 40); do
      bad=\$(docker compose ps --format '{{.Service}} {{.Status}}' | grep -cE 'starting|unhealthy|Exit|Restarting' || true)
      [ \"\$bad\" = 0 ] && break
      sleep 2
    done
    docker compose ps
    echo -n 'admin page: '; curl --noproxy '*' $CURL_TLS -s -o /dev/null -w '%{http_code}\n' --max-time 10 $ADMIN_PROBE/
    echo -n 'admin api: ';  curl --noproxy '*' $CURL_TLS -s --max-time 10 $ADMIN_PROBE/api/health; echo
    $INNER_LINE
    # game 挂了 profiles:["game"]（#1314）默认不启动：探针只在容器真的在跑时才输出，
    # 不部署客户端的时期不再出现一串 502 噪音
    game_up=\$(docker ps -q --filter 'name=olua-game-1\$' --filter 'status=running' | wc -l | tr -d ' ')
    if [ \"\$game_up\" != 0 ]; then
      echo -n 'game page: ';  curl --noproxy '*' -s -o /dev/null -w '%{http_code}\n' --max-time 10 http://127.0.0.1:${GAME_PORT}/
      echo -n 'game api: ';   curl --noproxy '*' -s --max-time 10 http://127.0.0.1:${GAME_PORT}/api/health; echo
    else
      echo 'game page/api: 跳过（game 容器未运行，默认不启动，#1314）'
    fi
    echo '--- 三域名分流（Host 头模拟，不依赖本机 DNS）'
    echo -n \"site($SITE_PRIMARY): \";  curl --noproxy '*' $CURL_TLS -s -H \"Host: $SITE_PRIMARY\" -o /dev/null -w '%{http_code}\n' --max-time 10 $ADMIN_PROBE/
    echo -n \"admin($ADMIN_DOMAIN): \"; curl --noproxy '*' $CURL_TLS -s -H \"Host: $ADMIN_DOMAIN\" -o /dev/null -w '%{http_code}\n' --max-time 10 $ADMIN_PROBE/
    if [ \"\$game_up\" != 0 ]; then
      echo -n \"game($GAME_DOMAIN): \"; curl --noproxy '*' $CURL_TLS -s -H \"Host: $GAME_DOMAIN\" -o /dev/null -w '%{http_code}\n' --max-time 10 $ADMIN_PROBE/
    else
      echo \"game($GAME_DOMAIN): 跳过（game 容器未运行）\"
    fi
    echo -n 'image-manifest: ';         curl --noproxy '*' $CURL_TLS -s -H \"Host: $ADMIN_DOMAIN\" -o /dev/null -w '%{http_code}\n' --max-time 10 $ADMIN_PROBE/game-resources/image-manifest.json"
  if [ "$TLS" = "on" ]; then
    # TLS 专项：这三条正是 #742 的验收项（跳转 / 证书链完整 / 到期时间）
    "${SSH[@]}" "$TARGET" "cd '$DEPLOY_DIR'
      echo '--- HTTPS 专项'
      echo -n 'http→https: '; curl --noproxy '*' -s -o /dev/null -w '%{http_code} → %{redirect_url}\n' --max-time 10 -H 'Host: $ADMIN_DOMAIN' http://127.0.0.1/
      echo -n '证书到期: '; echo | openssl s_client -connect 127.0.0.1:443 -servername '$ADMIN_DOMAIN' 2>/dev/null | openssl x509 -noout -enddate
      echo -n '证书 SAN: '; echo | openssl s_client -connect 127.0.0.1:443 -servername '$ADMIN_DOMAIN' 2>/dev/null | openssl x509 -noout -ext subjectAltName | tail -n 1"
  fi
}

# 首次签发证书（#742）：**用 standalone，不用 webroot**
#
# 理由是鸡生蛋：webroot 校验需要 :80 上有人把 /.well-known/acme-challenge/ 供出来，
# 而 :80 归 edge，edge 又要证书才能起 nginx（配置里有 listen 443 ssl）。
# 所以第一次反过来做：先把 edge 停掉（:80 空出来），让 certbot 自己占 :80 应答校验，
# 签完再起 edge。之后所有续期都走 webroot（edge 已在服务，见 compose 的 certbot 服务）。
tls_init() {
  [ "$TLS" = "on" ] || { echo "✗ deploy.env 里 OLUA_TLS 不是 on —— 先改成 on 再来签发"; exit 1; }
  echo "==> 首次签发证书，覆盖：$ALL_DOMAINS"
  echo "    前提：这些域名都已解析到 ${DEPLOY_HOST}，控制台放行了 80 与 443"
  build_compose_env
  "${SCP[@]}" /tmp/olua-compose.env "$TARGET:$DEPLOY_DIR/.env"
  # 只起后端与静态站：**不起 edge**（:80 要空出来给 certbot 的 standalone），也不起 game（默认不在 up 里，#1314）
  "${SSH[@]}" "$TARGET" "cd '$DEPLOY_DIR' && docker compose stop edge 2>/dev/null || true"
  "${SSH[@]}" "$TARGET" "cd '$DEPLOY_DIR' && docker compose up -d --build server server-realtime admin website"
  echo "==> 申请证书（--cert-name olua：目录固定，换域名不用改 nginx）"
  "${SSH[@]}" "$TARGET" "cd '$DEPLOY_DIR' && docker compose --profile tls run --rm -p 80:80 --entrypoint certbot certbot certonly \
    --standalone --cert-name olua $DOMAIN_FLAGS \
    --email '$ACME_EMAIL' --agree-tos --no-eff-email --non-interactive"
  echo "==> 起 edge 与 certbot（此时证书已就位；certbot 一起起来才有续期循环）"
  "${SSH[@]}" "$TARGET" "cd '$DEPLOY_DIR' && docker compose up -d"
  verify
}

# 同步管理端素材（client/assets/resources）→ 服务器 game/resources/：
# 管理端的 /game-resources/ 反代到 game 容器的 /resources/，图片选择器 / 装备对齐工作台
# / 音效配置页的生产数据源（image-manifest.json / audio-manifest.json）都在这里面。
# 与 --game 是两份来源（构建产物 vs 素材包），所以拆成两个模式分别增量同步。
sync_resources() {
  local src="client/assets/resources"
  # 防呆：清单不在 = 素材不完整，直接停（否则 --delete 会把服务器上的 resources 清残）
  [ -f "$src/image-manifest.json" ] || { echo "✗ $src 里没有 image-manifest.json（先跑 make image-manifest）"; exit 1; }
  echo "  源：$src  体积：$(du -sh "$src" 2>/dev/null | awk '{print $1}')"
  echo "==> rsync 增量同步 → $DEPLOY_DIR/game/resources/（首次全量约 2.4G，之后只传差异）"
  # 不用 -z：素材主体是已压缩的 PNG/WAV，压缩零收益白耗 CPU（同 sync_game 的结论）
  rsync -a --delete --stats \
    -e "ssh -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null" \
    "$src/" "$TARGET:$DEPLOY_DIR/game/resources/" || { echo "✗ rsync 失败"; exit 1; }
  echo "==> 起/更新 game 容器（--profile game 显式打开；不写 profile 时它默认不启动，#1314）"
  "${SSH[@]}" "$TARGET" "cd '$DEPLOY_DIR' && docker compose --profile game up -d game"
}

# 同步游戏 Web 产物：首次全量（2~3G，耗时以小时计），之后只传差异
sync_game() {
  local src="${GAME_SRC:-client/build/web-desktop-001}"
  [ -d "$src" ] || { echo "✗ 找不到构建产物目录：$src"; exit 1; }
  # 防呆：源不像一份完整产物就直接停——否则 --delete 会把服务器上的游戏清成空目录
  [ -f "$src/index.html" ] || { echo "✗ $src 里没有 index.html（不像完整的 Cocos Web 产物）"; exit 1; }
  echo "  源：$src  体积：$(du -sh "$src" 2>/dev/null | awk '{print $1}')"
  echo "==> rsync 增量同步 → $DEPLOY_DIR/game/（首次全量，之后只传差异）"
  # 这里**不用 rsync 的 -z**：产物主体是已经压过的 PNG（实测 200MB → gzip 195MB，
  # 几乎零收益），压缩只会白耗本机与服务器两端 CPU，反而拖慢传输。
  rsync -a --delete --stats \
    -e "ssh -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null" \
    "$src/" "$TARGET:$DEPLOY_DIR/game/" || { echo "✗ rsync 失败"; exit 1; }
  echo "==> 起/更新 game 容器（--profile game 显式打开；不写 profile 时它默认不启动，#1314）"
  "${SSH[@]}" "$TARGET" "cd '$DEPLOY_DIR' && docker compose --profile game up -d game"
}

case "$MODE" in
  verify) verify; exit 0 ;;
  game) sync_game; verify; exit 0 ;;
  resources) sync_resources; verify; exit 0 ;;
  tls-init) tls_init; exit 0 ;;
  env-only)
    echo "==> 只更新 server/.env"
    build_env
    "${SCP[@]}" /tmp/olua-server.env "$TARGET:$DEPLOY_DIR/server/.env"
    "${SSH[@]}" "$TARGET" "cd '$DEPLOY_DIR' && docker compose restart server"
    verify; exit 0 ;;
esac

echo "==> 1/6 导出归档（HEAD=$(git rev-parse --short HEAD)，未提交改动不会包含）"
git archive --format=tar.gz -o /tmp/olua-src.tgz HEAD
ls -lh /tmp/olua-src.tgz | awk '{print "  "$5" "$9}'

echo "==> 2/6 上传"
"${SCP[@]}" /tmp/olua-src.tgz "$TARGET:/tmp/olua-src.tgz"

echo "==> 3/6 解压"
"${SSH[@]}" "$TARGET" "cd '$DEPLOY_DIR' && tar xzf /tmp/olua-src.tgz && rm -f /tmp/olua-src.tgz"

echo "==> 4/6 传 server/.env（必须在解压之后）"
build_env
"${SCP[@]}" /tmp/olua-server.env "$TARGET:$DEPLOY_DIR/server/.env"

echo "==> 5/6 传 compose .env（三站域名，nginx 模板的 envsubst 用）"
build_compose_env
"${SCP[@]}" /tmp/olua-compose.env "$TARGET:$DEPLOY_DIR/.env"

if [ "$TLS" = "on" ]; then
  # 证书还没签的话，edge 会一直等着（不是崩，见 deploy/edge-entrypoint.sh）——
  # 这里提前说一声，省得看到验收里 https 打不通再去翻容器日志。
  # 用 `compose run` 探而不是猜卷名：卷的真名带 compose 项目前缀，猜错就是静默不报警。
  if ! "${SSH[@]}" "$TARGET" "cd '$DEPLOY_DIR' && docker compose --profile tls run --rm --entrypoint sh certbot -c 'test -f /etc/letsencrypt/live/olua/fullchain.pem'" >/dev/null 2>&1; then
    echo "  ⚠ 服务器上还没有证书：edge 会先等着。首次部署请跑一次 --tls-init"
  fi
fi

if [ "$MODE" = "no-build" ]; then
  echo "==> 6/6 跳过重建（--no-build）"
else
  echo "==> 6/6 docker compose up -d --build（耗时，放到后台跑更稳；game 挂 profiles:[\"game\"] 不会被拉起，#1314）"
  "${SSH[@]}" "$TARGET" "cd '$DEPLOY_DIR' && docker compose up -d --build"
fi

verify
echo "==> 完成"
