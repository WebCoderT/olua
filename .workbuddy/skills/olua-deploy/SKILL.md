---
name: olua-deploy
description: 把 olua（Docker Compose：NestJS 服务端 + React/nginx 管理端）发布与更新到腾讯云等国内云服务器。当用户要求「上线 / 部署 / 发布 / 更新线上 / 把改动推到服务器」，或需要排查线上容器、反代、端口、数据卷问题时使用。覆盖「先提交再归档发布」流程、deploy.env 密钥隔离规矩，以及国内云主机访问 GitHub 不可用、git archive 只导出已提交状态等一整套必踩坑。
agent_created: true
---

# olua 部署与更新

## Overview

把仓库里的改动送到线上服务器并跑起来。发布通道是**本地 `git archive` 导出 → 上传 → 解压 → `docker compose up -d --build`**，
不是 `git pull`。整套流程由 `scripts/deploy.sh` 固化；本文件说明它的前提、规矩与边界，
踩坑细节见 `references/gotchas.md`。

## 何时使用

- 「上线 / 部署 / 发布一版 / 更新线上」
- 「把这次改动推到服务器」
- 线上排障：容器起不来、502、接口 404、端口不对、数据卷相关

## 三条铁律

1. **先提交，再发布。** `git archive HEAD` 导出的是**已提交**状态 —— 未提交的改动根本不会上服务器，
   而且线上看起来「跑了但没变化」极难发现。改动必须先走 issue → PR → 合入 master，再从 master 归档。
2. **密钥只住 `deploy.env`。** 服务器 IP、SSH 私钥、邀请码、JWT 密钥**不写进任何记忆、不进版本库**。
   仓库只提交模板 `deploy.env.example`；真值填在根目录 `deploy.env`（已在 `.gitignore`）。
   同样地，`server/.env` 只在服务器上生成（`server/.gitignore` 已排除 `.env`）。
3. **不用 `git pull` 更新。** 实测国内云主机访问 GitHub 不可用（clone 10 分钟未完成、`curl github.com` 失败）。
   走归档导出，顺带保证不会把 `node_modules`、2.8G 素材、`deploy.env` 传上去。

## 拓扑（改任何一边前先认清）

```
浏览器 ──► :80  管理端容器(nginx)
              ├─ 静态页面 + 单页前端路由
              └─ /api/*  ──► 服务端容器(:3100，仅 compose 内网)
                                 └─ SQLite（具名卷 olua-data）
```

- 管理端与接口**同源** → 浏览器不发跨域请求 → 服务端**不需要** CORS。
- 服务端 `:3100` **不映射宿主机**（对外暴露只增加攻击面）；管理端经 compose 内网名字 `server:3100` 反代。
- 当前**不上 HTTPS**；将来要上就在宿主机加 nginx/Caddy 做 TLS 终结反代到 :80，不动 compose。

## 标准流程

在仓库根目录执行（脚本会读 `deploy.env`）：

```bash
bash ~/.workbuddy/skills/olua-deploy/scripts/deploy.sh            # 全量发布：代码 + 配置 + 重建
bash ~/.workbuddy/skills/olua-deploy/scripts/deploy.sh --no-build  # 只换代码，不重建镜像
bash ~/.workbuddy/skills/olua-deploy/scripts/deploy.sh --env-only  # 只更新 server/.env 并重启服务端
```

脚本内部顺序（**顺序不能换**）：
`git archive HEAD` → scp 归档 → 解压 → **再** scp `server/.env` → `compose up -d --build` → 验收。
`server/.env` 必须在解压**之后**传，否则 `server/` 目录还不存在会失败。

## 手动分步（脚本不适用时）

```bash
. ./deploy.env
git archive --format=tar.gz -o /tmp/olua-src.tgz HEAD
scp -i "$DEPLOY_KEY" /tmp/olua-src.tgz "$DEPLOY_USER@$DEPLOY_HOST:/tmp/olua-src.tgz"
ssh -i "$DEPLOY_KEY" "$DEPLOY_USER@$DEPLOY_HOST" \
  'cd /opt/olua && tar xzf /tmp/olua-src.tgz && rm -f /tmp/olua-src.tgz'
# server/.env：抄 server/.env.example，只覆盖 JWT_SECRET 与 ADMIN_REGISTER_CODE
scp -i "$DEPLOY_KEY" /tmp/olua-server.env "$DEPLOY_USER@$DEPLOY_HOST:/opt/olua/server/.env"
ssh -i "$DEPLOY_KEY" "$DEPLOY_USER@$DEPLOY_HOST" 'cd /opt/olua && docker compose up -d --build'
```

> ssh/scp 的 `-o` 选项**一律内联写**：zsh 不做变量分词，`$OPTS` 会被当成一个参数而报错。

## 验收

```bash
ssh -i "$DEPLOY_KEY" "$DEPLOY_USER@$DEPLOY_HOST" '
  cd /opt/olua
  docker compose ps                                            # admin 0.0.0.0:80->80；server 3100/tcp（无宿主映射）
  curl --noproxy "*" -s -o /dev/null -w "page=%{http_code}\n" http://127.0.0.1/
  curl --noproxy "*" -s http://127.0.0.1/api/health            # 期望 {"code":0,...,"status":"ok"}'
```

再从本机验证公网可达：`curl --noproxy "*" -s -o /dev/null -w '%{http_code}\n' http://$DEPLOY_HOST/`
（若不通，多半是云厂商控制台的防火墙/安全组没放行 80 —— 那只能在控制台点，脚本改不了）。

## 回滚

归档导出**旧提交**再走一遍发布：`git archive --format=tar.gz -o /tmp/olua-src.tgz <旧commit>`。
数据卷不受影响；但若新版改过库结构，回滚前先备份（见仓库 `docs/deploy.md` 第 7 节）。

## 已知边界

- **覆盖式解压不删除服务器上已删的文件**。若本次更新含文件删除，需先清空目录（保留 `server/.env` 与 `backup/`）再解压。
- 首次在服务器上跑 `server/.env` 里的 `ADMIN_REGISTER_CODE` 决定谁能注册首个管理员（首个自动超管）—— 让用户自己在页面注册，别代注册。
- 完整手册在仓库 `docs/deploy.md`（含备份、运维命令、故障表）。

## Resources

- `scripts/deploy.sh` —— 确定性发布脚本（只上传/解压/重建，**不做任何删除**）。
- `references/gotchas.md` —— 逐个踩坑的原理与正确写法（GitHub 不可达、归档语义、scp 顺序、
  `pkill` 自杀、zsh 分词、BSD sed 静默失效、`docker info` 误报等）。排查异常时优先读它。
