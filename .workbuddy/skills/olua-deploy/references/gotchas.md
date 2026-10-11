# 部署踩坑清单（原理 + 正确写法）

每条都是实测踩过的。排查线上异常时优先对照这里。

## 1. `git archive` 导出的是「已提交」状态

**现象**：改了 `docker-compose.yml`（比如端口 8080→80），发布后线上**仍是旧值**，而本地和服务器上的文件看起来都"对"。

**原理**：`git archive HEAD` 取的是**提交对象**里的树，不看工作区。未提交的改动不在里面。

**正确做法**：发布前必须先提交并合入 master，再从 master 归档。脚本已打印 `HEAD=<短sha>`，发布后核对提交号。
这同时是好事 —— 线上跑的一定能在提交历史里追到。

## 2. 国内云主机访问 GitHub 不可用

**现象**：`git clone` 跑 10 分钟无进展；`curl https://github.com` 返回 `000`；`git ls-remote` 报
`GnuTLS recv error (-110): The TLS connection was non-properly terminated`。

**但别据此误判** —— 它**偶尔能通**：`git ls-remote` 重试后成功过，`codeload.github.com` 返回 301。
这种"时好时坏"最坑：第一次探查成功就以为路是通的，真跑 clone 时又卡死。

**结论**：不要把 `git pull` 作为更新通道。改走本地归档导出上传。
服务器上因此**没有 `.git`**，别在上面跑 git 命令。

## 3. scp 顺序：`server/.env` 必须在解压之后

先把归档解压出 `server/` 目录，才能把 `.env` 传进去。传早了会报：
`scp: dest open "/opt/olua/server/.env": No such file or directory`

## 4. `pkill -f "git clone"` 会把自己杀掉

`pkill -f` 匹配完整命令行，而**承载这条命令的 ssh shell 自身命令行里也含该字符串**，于是自杀，
表现为 ssh 会话直接断开、无任何输出、`/opt/olua` 状态不明。

**写法**：`pkill -f "git clon[e]"`（用字符类破坏自匹配）。

## 5. zsh 不做变量分词

```bash
OPTS="-o StrictHostKeyChecking=no -o ..."
scp -i "$PEM" $OPTS src dst    # 错：整串被当成一个参数
```
报错：`command-line line 0: keyword stricthostkeychecking extra arguments at end of line`。

同理 `SSH="ssh -i ..."` 然后 `$SSH host` 会变成"命令名 = 整个字符串" → `no such file or directory`。

**写法**：ssh/scp 的 `-o` 选项**内联写全**；确需变量就用 `${=VAR}`（zsh 强制分词）。

## 6. BSD `sed -i ''` 会静默失效（还会回显密钥）

在 macOS 上 `sed -i '' "s|^JWT_SECRET=.*|JWT_SECRET=xxx|" file` 报
`sed: s|...|: No such file or directory` —— 脚本被当成文件名，**替换没生效且不报错中断**，
同时把密钥原样打印到输出里。

**写法**：密钥替换用 `awk -v`（本技能 `deploy.sh` 的做法）或 Python `re.sub`。
**密钥一旦在输出/日志里露过面，就重新生成一把**（`openssl rand -hex 32`）。

## 7. `docker info` 会误报「Docker 没启动」

`ubuntu` 不在 docker 组时无权访问 `/var/run/docker.sock`，`docker info` 失败，
看起来像守护进程挂了；实际 `systemctl status docker` 是 `active (running)`。

**判断存活**：用 `systemctl status docker` 或 `pgrep dockerd`，别只用 `docker info`。
**修权限**：`sudo usermod -aG docker ubuntu`，**重新登录**（新 ssh 会话）才生效。

## 8. 私钥权限 644 会被 SSH 拒绝

`WARNING: UNPROTECTED PRIVATE KEY FILE`。发布前 `chmod 600`。
脚本已做权限预检，非 600/400 直接退出。

## 9. 覆盖式解压不删旧文件

`tar xzf` 只覆盖同名文件。仓库里删掉的文件，服务器上会**残留**。
含文件删除的更新，需先清空目录（保留 `server/.env` 与 `backup/`）再解压。

## 10. 大文件传输 / 构建会超前台时限

40M scp、`docker compose --build` 都容易超过 120s 前台上限被 SIGTERM（exit 137）。
**一律放后台跑**，不要靠"再试一次"。

## 11. 云厂商防火墙只能在控制台开

服务器内 `iptables`/`ufw` 放行不算数，腾讯云的防火墙/安全组是独立一层。
端口不通时先确认控制台是否放行 80/443 —— 这一层脚本改不了，需要用户去点。

## 12. 关于「去掉 3100 对外暴露」

compose 里删掉 server 的 `ports` 后，`docker compose ps` 显示 server 是 `3100/tcp` 而非 `0.0.0.0:3100->3100`，
这是**正确**状态：容器内监听、仅 compose 内网可达。管理端 nginx 用 `set $olua_api http://server:3100`
+ `resolver 127.0.0.11` 解析，与宿主机端口映射无关。
要本地调试再临时 `docker run -p 3100:3100` 或打开 compose 里注释掉的那两行。
