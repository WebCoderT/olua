#!/bin/sh
# ==============================================================================
#  边缘容器的入口（#742）
#
#  镜像自带的 /docker-entrypoint.sh 只做两件事：跑 /docker-entrypoint.d/ 里的脚本
#  （其中 20-envsubst 把 /etc/nginx/templates/*.template 渲染成 conf.d/default.conf）、
#  然后 exec 真正的 CMD。这里在它之前加两步，不改官方脚本：
#
#    1. **等证书**：证书是 certbot 容器写进具名卷的。首次部署时它还不存在，直接起
#       nginx 会以 `cannot load certificate` 崩溃，日志里只有一行 nginx 报错 ——
#       所以这里等它出现，并打出该跑哪条命令去签。签完 `up -d edge` 重建即过。
#    2. **定期 reload**：certbot 在**另一个容器**里续期，边缘没有 Docker socket，
#       喊不动 nginx 去重读证书。所以自己每 6 小时 reload 一次。
#       reload 是热操作（不断连接、不换 worker 之外的任何东西），而续期窗口是
#       「剩 30 天才续」，6 小时的延迟对 90 天证书毫无影响。
# ==============================================================================
set -e

CERT="/etc/letsencrypt/live/olua/fullchain.pem"

if [ ! -f "$CERT" ]; then
  echo "[edge] 还没有证书：$CERT"
  echo "[edge] 首次部署先签证书（在仓库根执行）：bash .workbuddy/skills/olua-deploy/scripts/deploy.sh --tls-init"
  echo "[edge] 之后本容器会被重建；如果你正在手工排查，签完执行 docker compose up -d edge 即可。"
  while [ ! -f "$CERT" ]; do
    sleep 10
  done
  echo "[edge] 证书已就位，继续启动 nginx"
fi

# 后台每 6 小时 reload 一次（21600 秒；不用 `6h` 这种后缀，busybox 各版本支持不一）
(
  while :; do
    sleep 21600
    nginx -s reload || true
  done
) &

# 交回官方入口：它跑 docker-entrypoint.d/*.sh（含 envsubst）再 exec `nginx -g 'daemon off;'`
exec /docker-entrypoint.sh nginx -g "daemon off;"
