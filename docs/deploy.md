# 部署与更新手册

> 目标机器：腾讯云 **Ubuntu 24.04 LTS**（Docker CE 应用模板），代码目录 `/opt/olua`。
>  服务器 IP / 登录密钥 / 邀请码 / JWT 密钥**一律不进版本库**，只放在根目录 `deploy.env`（见[第 2 节](#2-配置文件deployenv密钥只住在这里)）。

---

## 1. 拓扑：这套部署长什么样

```
浏览器 ──► :80    管理端容器(nginx)
              │    静态页面 + 单页前端路由
              └─►  /api/*  ──┐

浏览器 ──► :8080 游戏容器(nginx)
              │    Cocos Web 构建产物（静态）
              └─►  /api/*  ──┤
                             ▼
                服务端容器(:3100，仅 compose 内网可达)
                             └─► SQLite（具名卷 olua-data）
```

三条设计约束，改动时别破坏：

| 约束 | 为什么 |
| --- | --- |
| 管理端与接口**同源**（都从 :80 进，`/api` 由 nginx 反代） | 浏览器压根不发跨域请求 → 服务端**不需要配 CORS**，少一处会配错且配错难发现的地方 |
| 服务端 `:3100` **不映射到宿主机** | 对外多开一个端口只是把签名接口和 Swagger 一并暴露，没有收益。要本地调试就把 `docker-compose.yml` 里那四行注释打开 |
| **不上 HTTPS**（当前决定） | 先跑通。将来要上就在宿主机加一层 nginx/Caddy 做 TLS 终结、反代到 :80，不动 compose |

数据落在具名卷 `olua-data`，`docker compose down` **不会**删它；只有 `down -v` 才会。

---

## 2. 配置文件 `deploy.env`：密钥只住在这里

仓库根目录这两个文件，**只提交模板**：

| 文件 | 是否提交 | 内容 |
| --- | --- | --- |
| `deploy.env.example` | ✅ 提交 | 模板：字段 + 注释，值全是占位符 |
| `deploy.env` | ❌ **永不提交**（已在 `.gitignore`） | 真实值：`DEPLOY_HOST` / `DEPLOY_USER` / `DEPLOY_KEY` / 邀请码 / JWT 密钥 |

首次配置：

```bash
cp deploy.env.example deploy.env
$EDITOR deploy.env      # 填真实值
```

`JWT_SECRET` 必须是随机长串，别手编：`openssl rand -hex 32`

> **安全红线**：`.gitignore` 已排除 `deploy.env` 与 `*.pem`（`server/.gitignore` 也排除了 `server/.env`）。
>  仓库是公开的 —— 任何一次把 `deploy.env`、`olua.pem` 或 `server/.env` 提交上去，
>  都等同于把服务器交出去。提交前 `git status` 看一眼，它们**不该出现**在待提交列表里。

---

## 3. 代码怎么上服务器：**归档导出**，不是 git pull

> **为什么不用 `git pull`**：实测这台服务器访问 GitHub 极不稳定（clone 跑 10 分钟未完成，
>  `curl https://github.com` 直接失败，只有 `codeload` 偶尔能通）。
>  所以改为**从管理机（本地仓库）导出归档再上传** —— 确定性高、不受 GitHub 连通性影响，
>  且 `git archive` 天然只含**已提交文件**，不会把 `node_modules`、素材、`deploy.env` 带上去。

前提（一次性）：服务器装好 Docker CE、`ubuntu` 在 docker 组、控制台防火墙放行 **80**（将来上 HTTPS 再放 443）。

```bash
# 0) 读配置
. ./deploy.env

# 1) 导出当前提交的代码（只含已跟踪文件）
git archive --format=tar.gz -o /tmp/olua-src.tgz HEAD

# 2) 上传 + 解压到部署目录
scp -i "$DEPLOY_KEY" /tmp/olua-src.tgz "$DEPLOY_USER@$DEPLOY_HOST:/tmp/olua-src.tgz"
ssh -i "$DEPLOY_KEY" "$DEPLOY_USER@$DEPLOY_HOST" \
  'cd /opt/olua && tar xzf /tmp/olua-src.tgz && rm -f /tmp/olua-src.tgz'

# 3) 生成服务端配置（抄模板，只覆盖两个密钥；其余保持模板默认）
cp server/.env.example /tmp/olua-server.env
#   JWT_SECRET=<deploy.env 里的随机长串>
#   ADMIN_REGISTER_CODE=<deploy.env 里的邀请码>
scp -i "$DEPLOY_KEY" /tmp/olua-server.env "$DEPLOY_USER@$DEPLOY_HOST:/opt/olua/server/.env"

# 4) 构建并起（首次几分钟）
ssh -i "$DEPLOY_KEY" "$DEPLOY_USER@$DEPLOY_HOST" 'cd /opt/olua && docker compose up -d --build'
```

> compose 会用 `environment` 覆盖 `DB_PATH` / `TRUST_PROXY` / `CORS_ORIGINS` / `NODE_ENV`，
>  所以 `server/.env` 里这几项保持模板默认即可，不用改。

验收：

```bash
ssh -i "$DEPLOY_KEY" "$DEPLOY_USER@$DEPLOY_HOST" '
  cd /opt/olua
  docker compose ps
  curl --noproxy "*" -s http://127.0.0.1/api/health
  curl --noproxy "*" -s -o /dev/null -w "page=%{http_code}\n" http://127.0.0.1/'
```

浏览器打开 `http://<服务器公网IP>` → 管理端注册页，用 `deploy.env` 里的邀请码注册**第一个管理员**（第一个自动成为超管）。

---

## 4. 日常更新

在**管理机**上跑一遍第 3 节的第 1、2、4 步（代码有改动才需要重新上传；只改配置就只传 `.env`）：

```bash
. ./deploy.env
git archive --format=tar.gz -o /tmp/olua-src.tgz HEAD
scp -i "$DEPLOY_KEY" /tmp/olua-src.tgz "$DEPLOY_USER@$DEPLOY_HOST:/tmp/olua-src.tgz"
ssh -i "$DEPLOY_KEY" "$DEPLOY_USER@$DEPLOY_HOST" \
  'cd /opt/olua && tar xzf /tmp/olua-src.tgz && rm -f /tmp/olua-src.tgz && docker compose up -d --build'
```

两点注意：

- **覆盖式解压不会删除服务器上已删掉的文件**。若本次更新包含文件删除，先清空目录再解压
  （注意**保留** `server/.env` 与 `backup/`）：
  ```bash
  ssh ... 'cd /opt/olua && cp server/.env /tmp/env.keep \
           && find . -mindepth 1 -maxdepth 1 ! -name backup -exec rm -rf {} + \
           && mkdir -p server && cp /tmp/env.keep server/.env'
  ```
  然后再上传解压。
- 改了 `docker-compose.yml` / `admin/nginx.conf` / 任一 `Dockerfile`，先在本机跑 `make audit`
  （其中 `audit-deploy` 会校验服务名、端口、卷、反代前缀、密钥隔离是否还接得上）。

---

## 5. 回滚

回滚 = 导出**旧提交**的归档重新上传：

```bash
git log --oneline -5
git archive --format=tar.gz -o /tmp/olua-src.tgz <旧commit>
# 再走第 3 节的上传 + 解压 + up -d --build
```

数据卷不受影响；但若新版本的**数据库结构**变过，回滚后可能不兼容 —— 先备份（第 7 节）。

---

## 6. 运维常用命令

```bash
cd /opt/olua
docker compose ps                     # 容器状态
docker compose logs -f server         # 服务端日志（Ctrl-C 退出）
docker compose logs -f admin          # 管理端 nginx 日志
docker compose restart server         # 只重启服务端
docker compose down                   # 收（数据卷保留）
docker compose down -v                # 收并删卷 —— **会丢库**，别乱用
docker system prune -a                # 清无用镜像层（磁盘紧张时用）
```

---

## 7. 数据备份

SQLite 库在具名卷 `olua-data` 里。备份 = 把库文件拷出来：

```bash
mkdir -p /opt/olua/backup
docker run --rm -v olua-data:/data -v /opt/olua/backup:/backup \
  alpine sh -c 'cp /data/olua.db /backup/olua-$(date +%F).db'
```

恢复是反向 `cp`，然后 `docker compose restart server`。

> 备份自动化见 issue #22。

---

## 8. 故障排查

| 现象 | 先看这里 |
| --- | --- |
| `docker info` 报权限错误 | `ubuntu` 不在 docker 组 → `sudo usermod -aG docker ubuntu`，**重新登录**才生效 |
| 看起来「Docker 没启动」 | 别只信 `docker info`（它受 socket 权限影响），看 `systemctl status docker` |
| 管理端 502 | nginx 反代用的 `server:3100` 是 compose 内网域名；`docker compose logs server` 看服务端是否真起来了 |
| 页面能开但接口 404 | 反代前缀 `/api/` 必须与服务端 `API_PREFIX=api` 一致（`make audit` 会查） |
| 登录限流把所有人锁死 | `TRUST_PROXY` 必须为 `true`（compose 已设），否则来源 IP 全是 nginx 容器的 |
| 上传 40M 归档被中断 | `scp` 可能超过前台命令时限，放到后台跑即可，不是网络故障 |
| `pkill -f "git clone"` 把自己也杀了 | 模式会匹配到自身命令行，写成 `pkill -f "git clon[e]"` |
| 管理端注册不了 | 配了 `ADMIN_REGISTER_CODE` 就必须带相同邀请码；**留空不等于开放注册**（需显式 `ADMIN_REGISTER_OPEN=true`） |

---

## 9. 游戏客户端（Web 端，:8080）

游戏是**本机 Cocos Creator 构建出来的静态产物**，用 nginx 托管在与管理端**互不干扰的独立端口**。

```
本机 Cocos Creator（GUI 构建）
      └─► client/build/web-desktop-001/     ← 不在版本库里（client/build/ 已 gitignore）
              └─ rsync ──► 服务器 /opt/olua/game/  ← 挂载给 game 容器
```

### 9.1 产物为什么得在 GUI 里构建

`client/build/` 体积 3G 量级且全是二进制，**有意不入库**；服务器也没有构建环境。
命令行构建（Cocos Creator CLI）在本机走不通，原因是链式的，每一层都误导过一次排查：

1. Electron 的命令行模式会被环境变量 `ELECTRON_RUN_AS_NODE=1` 劫持成纯 node
   （表现为 `--help` 吐出 node 的用法说明）→ 需要 `env -u ELECTRON_RUN_AS_NODE` 调用。
2. 即便如此，Chromium 派生 GPU / 网络子进程会被拒（`sandbox initialization failed`）
   → GPU 进程连崩 → `FATAL: GPU process isn't usable`。
3. 用 `--disable-gpu` 绕开，会触发 Sentry 上报的**自激循环**（上报失败抛异常、抛异常又上报），
   几十万行日志把进程拖死。
4. 脱离工具沙箱重跑，`sandbox initialization failed` 依旧 —— 是本机环境层面挡的。

所以：**用 Cocos Creator 打开 `client/`，在构建面板构建 `web-desktop` 平台**，产物落在
`client/build/web-desktop-001/`（有同名目录时会自动加后缀，同步前确认自己要的是哪一份）。

判断是否是一份完整产物：**顶层必须有 `index.html`**。缺了就是构建没跑完或被中断了。

### 9.2 同步到服务器

```bash
bash .workbuddy/skills/olua-deploy/scripts/deploy.sh --game                       # 默认 web-desktop-001
bash .workbuddy/skills/olua-deploy/scripts/deploy.sh --game client/build/web-desktop
```

脚本会：校验源目录有 `index.html`（防把空目录 rsync 上去）→ `rsync -az --delete` 同步 → `docker compose up -d game` → 验收。

### 9.3 体积与耗时（做好心理预期）

| 项 | 事实 |
| --- | --- |
| 产物体积 | 约 3G，其中 **99% 是素材**（角色帧序列 / 背景图 / 配置 json），代码只占几 MB |
| 能不能压小 | **压缩基本无效**：抽样 200MB → gzip 195MB。素材里主要是已经压过的 PNG |
| 首传耗时 | 约 1 小时（放到后台跑，`scp` 会超时但 rsync 不会） |
| 之后每次更新 | **很快** —— rsync 只传差异，游戏资源变动通常很小 |

### 9.4 三个容易踩的点

- **接口地址不用为不同环境改**：`client/assets/configs/network.ts` 会按 `location.hostname` 判断，
  本地（localhost/127.0.0.1）走 `http://localhost:3100/api`，线上走同源 `/api`。**一份产物两处通用**。
- **缺资源必须报 404**：`deploy/nginx-game.conf` **故意不写** SPA 那种 `try_files $uri /index.html`，
  否则缺图时会回一段 HTML 给资源加载器，错误极难定位。
- **缓存策略**：构建没开 `md5Cache`，文件名不带内容哈希 → 资源只能短期缓存（`assets/` 设 1 小时）；
  `index.html` 完全不缓存，保证发版立刻生效。

### 9.5 防火墙

`:8080` 要在云厂商控制台放行，**这台机器上的 `ufw`/iptables 改不了那层**。
