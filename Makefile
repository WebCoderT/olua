# ==============================================================================
#  olua 开发命令
#
#  仓库是三端平级结构：
#    client/  Cocos Creator 3.8.7 + TypeScript 客户端（没有 npm 脚本，用编辑器打开）
#    server/  NestJS 12 + node:sqlite 服务端（同时是接口契约的唯一源头）
#    admin/   React 19 + Vite + Tailwind v4 管理端
#    tools/   跨端脚本（gen-api + 6 个 gen/audit）
#
#  常用：
#    make install          首次拉仓库：装 server / admin 依赖
#    make env              生成 server/.env
#    make dev              同时起服务端与管理端开发服务器
#    make client-test      客户端 24 套单测（需要本机 Cocos 工程）
#    make verify           一条命令跑完全部门禁（含三端构建与四套 e2e）
#    make ci               CI 跑的那一条（服务端 + 管理端 + 审计，不含客户端）
#
#  完整清单：make / make help
# ==============================================================================

SHELL := /bin/bash
.DEFAULT_GOAL := help

# e2e 会真实起服务、真实占端口，并行的 `make -j verify` 只会互相打架 —— 全串行。
.NOTPARALLEL:

# ------------------------------------------------------------------------------
#  运行环境
# ------------------------------------------------------------------------------
# 受限终端（如 WorkBuddy 沙箱）会往环境里注入 NODE_OPTIONS，指向一个模块垫片，
# 会让 node 子进程**不打日志、不监听端口**地静默起不来（症状：e2e 等待服务启动超时）。
# 这里统一清掉；普通终端下 `env -u` 对未设置的变量是无害 no-op。
# 想用原始环境跑：make RUN_ENV= <目标>
RUN_ENV ?= env -u NODE_OPTIONS
NODE    := $(RUN_ENV) node
NPM     := $(RUN_ENV) npm

# Cocos Creator 自带的 tsc（客户端工程不装 typescript）。
# 换版本或换机器时覆盖即可：make TSC=/path/to/tsc client-check
TSC ?= /Applications/Cocos/Creator/3.8.7/CocosCreator.app/Contents/Resources/app.asar.unpacked/node_modules/typescript/bin/tsc

# 客户端测试需要的临时日志目录（失败时保留现场）
LOGDIR ?= /tmp

# 用编辑器打开客户端工程时的 App 名（macOS）
CREATOR ?= CocosCreator

.PHONY: help info install install-ci env \
        dev dev-server dev-admin \
        check test verify ci audit audit-generated audit-hardcode audit-config audit-click audit-deploy \
        audit-battle-rules audit-combat-parity \
        docker-build docker-up docker-down docker-logs \
        client-check client-test client-test-one client-gen-monster client-gen-drops \
        client-clean-frames client-clean-frames-apply client-open \
        server-dev server-build server-start server-e2e server-e2e-roles server-e2e-guard \
        server-e2e-mail server-e2e-backup server-verify db-backup db-restore gen-api \
        admin-dev admin-build admin-typecheck admin-preview \
        clean

# ==============================================================================
#  总览
# ==============================================================================

help: ## 显示这份帮助
	@printf '\nolua 开发命令（用法：make <目标>）\n\n'
	@grep -hE '^[a-zA-Z0-9_-]+:.*## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN { FS = ":.*?## " } { printf "  \033[36m%-26s\033[0m %s\n", $$1, $$2 }'
	@printf '\n可覆盖的变量：\n'
	@printf '  %-12s %s\n' "RUN_ENV" "清环境变量的前缀（默认 env -u NODE_OPTIONS）"
	@printf '  %-12s %s\n' "TSC" "Cocos 自带 tsc 的路径"
	@printf '  %-12s %s\n' "T" "单跑客户端单测时的脚本名（make client-test-one T=test-bag-tidy）"
	@printf '  %-12s %s\n\n' "LOGDIR" "测试失败日志目录（默认 /tmp）"

info: ## 打印当前工具链版本与关键路径
	@printf '\n工具链\n'
	@printf '  node          %s\n' "$$( $(NODE) -v )"
	@printf '  npm           %s\n' "$$( $(NPM) -v )"
	@printf '  tsc(客户端)   %s\n' "$(TSC)"
	@printf '  make          %s\n' "$$( make -v | head -1 )"
	@printf '\n工程\n'
	@for d in client server admin tools; do \
		if [ -d "$$d" ]; then printf '  %-12s ✓\n' "$$d/"; else printf '  %-12s ✗ 缺失\n' "$$d/"; fi; \
	done
	@printf '  %-12s %s\n' "server/.env" "$$( [ -f server/.env ] && echo '已生成' || echo '未生成（make env）' )"
	@for d in server/node_modules admin/node_modules; do \
		printf '  %-12s %s\n' "$$d" "$$( [ -d "$$d" ] && echo '已安装' || echo '未安装（make install）' )"; \
	done
	@printf '\n'

# ==============================================================================
#  安装与配置
# ==============================================================================

install: ## 安装 server 与 admin 的 npm 依赖
	@echo "==> 安装服务端依赖"
	@cd server && $(NPM) install
	@echo "==> 安装管理端依赖"
	@cd admin && $(NPM) install
	@echo "==> 完成（客户端是 Cocos 工程，不需要 npm install）"

install-ci: ## 按锁文件精确安装依赖（CI 用；锁文件与 package.json 不一致会直接失败）
	@echo "==> 按锁文件安装服务端依赖（npm ci）"
	@cd server && $(NPM) ci
	@echo "==> 按锁文件安装管理端依赖（npm ci）"
	@cd admin && $(NPM) ci

env: ## 生成 server/.env（已存在则跳过）
	@if [ -f server/.env ]; then \
		echo "  server/.env 已存在，跳过"; \
	else \
		cp server/.env.example server/.env; \
		echo "  已从 .env.example 生成 server/.env"; \
		echo "  注意：生产环境必须改 JWT_SECRET 与 ADMIN_REGISTER_CODE"; \
	fi
	@echo "  管理端的 .env.development / .env.production 已随仓库提供，无需生成"

# ==============================================================================
#  开发服务器
# ==============================================================================

dev: ## 同时启动服务端与管理端开发服务器（Ctrl-C 一起退出）
	@echo "服务端 :3100  ·  管理端 :5173   ·  Ctrl-C 退出"
	@# set -m：让两个后台任务各自成为一个进程组，收尾时按「进程组」杀，
	@# 这样 npm 下面的 node / ts-node 一起走，也不会误伤调用方所在的进程组。
	@set -m; \
	( cd server && $(NPM) run dev ) & srv=$$!; \
	( cd admin  && $(NPM) run dev ) & adm=$$!; \
	trap 'trap - INT TERM; kill -TERM -$$srv -$$adm 2>/dev/null' INT TERM; \
	wait

dev-server: server-dev ## dev 的别名：只起服务端

dev-admin: admin-dev ## dev 的别名：只起管理端

# ==============================================================================
#  客户端（client/）
# ==============================================================================

client-check: ## 客户端类型检查（Cocos 自带 tsc，0 错才算过）
	@echo "==> 客户端类型检查"
	@cd client && $(NODE) "$(TSC)" -p tools/tsconfig.check.json && echo "  0 错"

client-test: ## 跑客户端全部单测（client/tools/test-*.cjs）
	@echo "==> 客户端单测"
	@pass=0; fail=0; \
	for t in client/tools/test-*.cjs; do \
		name=$$(basename $$t); \
		if $(NODE) "$$t" > "$(LOGDIR)/olua-$$name.log" 2>&1; then \
			printf '  \033[32mPASS\033[0m %s\n' "$$name"; pass=$$((pass+1)); \
		else \
			printf '  \033[31mFAIL\033[0m %s\n' "$$name"; fail=$$((fail+1)); \
		fi; \
	done; \
	printf '  -------------------------------\n'; \
	printf '  %d 通过 / %d 失败\n' "$$pass" "$$fail"; \
	if [ $$fail -ne 0 ]; then \
		echo "  失败现场：$(LOGDIR)/olua-test-*.log（tail 一下即可）"; exit 1; \
	fi

client-test-one: ## 单跑一套客户端单测：make client-test-one T=test-bag-tidy
	@if [ -z "$(T)" ]; then echo "用法：make client-test-one T=test-bag-tidy"; exit 1; fi
	@if [ ! -f "client/tools/$(T).cjs" ]; then \
		echo "找不到 client/tools/$(T).cjs"; \
		echo "可选："; ls client/tools/test-*.cjs | sed 's#.*/##; s#\.cjs$$##; s#^#  #'; \
		exit 1; \
	fi
	@echo "==> $(T)"
	@$(NODE) client/tools/$(T).cjs

client-gen-monster: ## 重写 configs/monster.ts（几何取自素材 .meta，保留手工字段）
	@echo "==> 重新生成怪物配置"
	@$(NODE) client/tools/gen-monster-config.cjs
	@echo "  改完务必跑：make client-test-one T=test-monster-config"

client-gen-drops: ## 重新生成怪物掉落配置
	@echo "==> 重新生成掉落配置"
	@$(NODE) client/tools/gen-monster-drops.cjs

client-clean-frames: ## 预演清理 role 空帧（只列清单，不动文件）
	@$(NODE) client/tools/clean-role-empty-frames.cjs

client-clean-frames-apply: ## 备份并删除 role 空帧（会写到 .workbuddy/backup/）
	@echo "==> 备份到 .workbuddy/backup/ 后删除空帧"
	@$(NODE) client/tools/clean-role-empty-frames.cjs --apply

client-open: ## 用 Cocos Creator 打开客户端工程（macOS）
	@open -a "$(CREATOR)" client && echo "  已用 $(CREATOR) 打开 client/"

# ==============================================================================
#  服务端（server/）
# ==============================================================================

server-dev: ## 服务端开发模式（ts-node 直接跑源码，端口 3100）
	@cd server && $(NPM) run dev

server-build: ## 编译服务端到 server/dist
	@cd server && $(NPM) run build

server-start: ## 跑服务端已构建产物（需先 make server-build）
	@cd server && $(NPM) run start

server-e2e: ## 服务端主 e2e（248 条断言）
	@cd server && $(NPM) run test:e2e

server-e2e-roles: ## 服务端角色管理专项 e2e（77 条）
	@cd server && $(NPM) run test:e2e:roles

server-e2e-guard: ## 服务端运营与安全底座专项 e2e（279 条）
	@cd server && $(NPM) run test:e2e:guard

server-e2e-backup: ## 服务端备份 / 恢复 e2e（25 条：运行中备份 / 恢复留档 / 保护性拒绝）
	@cd server && $(NPM) run test:e2e:backup

server-e2e-mail: ## 服务端邮件通道专项 e2e（假发信器：入队 / 投递 / 重试上限 / 未启用时禁用）
	@cd server && $(NPM) run test:e2e:mail

server-verify: ## 服务端一条命令全验（编译 + 五套 e2e + 生成物审计）
	@cd server && $(NPM) run verify

db-backup: ## 备份 SQLite 数据文件（VACUUM INTO，服务运行中也能备；默认留最近 7 份）
	@cd server && $(NPM) run db:backup

db-restore: ## 恢复数据（用法：make db-restore FILE=server/backups/olua-20261009-153000.db，FORCE=1 跳过在跑检查）
	@if [ -z "$(FILE)" ]; then echo "  用法：make db-restore FILE=<备份文件>（可加 FORCE=1）"; exit 1; fi
	@cd server && $(NPM) run db:restore -- $(FILE) $(if $(FORCE),--force,)

gen-api: ## 重新生成接口契约（openapi.json + 客户端与管理端生成物）
	@echo "==> swagger:emit + gen-api"
	@cd server && $(NPM) run gen:api
	@$(NODE) tools/audit-api-generated.cjs > /dev/null && echo "  生成物一致性 ✓"
	@echo "  下一步：管理端 make admin-build，客户端 make client-check（签名不一致会直接编译报错）"

gen-battle-rules: ## 重新生成服务端战斗规则快照（来源 = client/assets/configs）
	@echo "==> 编译客户端纯配置 + 快照"
	@$(NODE) tools/gen-battle-rules.cjs
	@$(NODE) tools/audit-battle-rules.cjs > /dev/null && echo "  生成物一致性 ✓"

# ==============================================================================
#  管理端（admin/）
# ==============================================================================

admin-dev: ## 管理端开发服务器（Vite，默认 5173）
	@cd admin && $(NPM) run dev

admin-typecheck: ## 管理端只做类型检查（不产出）
	@cd admin && $(NPM) run typecheck

admin-build: ## 管理端类型检查 + 构建到 admin/dist
	@cd admin && $(NPM) run build

admin-preview: ## 预览管理端已构建产物（需先 make admin-build）
	@cd admin && $(NPM) run preview

# ==============================================================================
#  审计（tools/，跨端静态检查）
# ==============================================================================

audit: ## 跑全部跨端审计（生成物 / 硬编码 / 配置外泄 / 点击穿透 / 部署接线 / 战斗规则两端一致）
	@echo "==> 跨端审计"
	@fail=0; \
	for t in tools/audit-*.cjs; do \
		name=$$(basename $$t .cjs); \
		if $(NODE) "$$t" > "$(LOGDIR)/olua-$$name.log" 2>&1; then \
			printf '  \033[32mPASS\033[0m %s\n' "$$name"; \
		else \
			printf '  \033[31mFAIL\033[0m %s\n' "$$name"; tail -12 "$(LOGDIR)/olua-$$name.log"; fail=$$((fail+1)); \
		fi; \
	done; \
	if [ $$fail -ne 0 ]; then echo "  失败项见 $(LOGDIR)/olua-audit-*.log"; exit 1; fi; \
	echo "  $$(ls tools/audit-*.cjs | wc -l | tr -d ' ') 个审计全部通过"

audit-generated: ## 生成物与 openapi.json 是否逐字节一致
	@$(NODE) tools/audit-api-generated.cjs

audit-hardcode: ## 接口地址 / 请求出口 / 路径是否只有一处来源
	@$(NODE) tools/audit-api-hardcode.cjs

audit-config: ## 可配置项有没有外泄到逻辑里
	@$(NODE) tools/audit-config-leak.cjs

audit-click: ## 全屏模态是否两条路都拦住了点击穿透
	@$(NODE) tools/audit-ui-click-through.cjs

audit-deploy: ## Docker / compose / nginx 的跨文件接线是否对得上
	@$(NODE) tools/audit-deploy.cjs

audit-battle-rules: ## 战斗规则快照是否与客户端 configs 逐字节一致（数据漂移）
	@$(NODE) tools/audit-battle-rules.cjs

audit-combat-parity: ## 服务端算的角色属性是否与客户端 combatCalc 一致（算法漂移）
	@$(NODE) tools/audit-combat-parity.cjs

# ==============================================================================
#  部署（Docker / docker compose）
# ==============================================================================
docker-build: ## 构建服务端与管理端镜像
	@docker compose build

docker-up: ## 起一套（前置：cp server/.env.example server/.env 并改密钥）
	@if [ ! -f server/.env ]; then echo "  缺少 server/.env —— 先 cp server/.env.example server/.env 并改 JWT_SECRET / ADMIN_REGISTER_CODE"; exit 1; fi
	@docker compose up -d --build
	@echo ""
	@echo "  管理端：http://localhost:$${OLUA_ADMIN_PORT:-8080}"
	@echo "  接口文档：http://localhost:$${OLUA_SERVER_PORT:-3100}/api-docs"
	@echo "  看日志：make docker-logs   收起：make docker-down"

docker-down: ## 停掉并删除容器（数据在具名卷里，不会丢）
	@docker compose down

docker-logs: ## 跟服务端日志（Ctrl+C 退出）
	@docker compose logs -f server

# ==============================================================================
#  组合门禁
# ==============================================================================

check: client-check admin-typecheck audit ## 快速静态检查：客户端 tsc + 管理端 typecheck + 全部审计
	@echo ""
	@echo "✓ 静态检查通过（未跑测试）"

test: client-test server-e2e server-e2e-roles server-e2e-guard server-e2e-mail server-e2e-backup ## 全部测试：客户端 25 套 + 服务端五套 e2e
	@echo ""
	@echo "✓ 测试全部通过"

verify: check server-build test admin-build ## 完整门禁：三端静态检查 + 三端构建 + 全部测试（含五套服务端 e2e）
	@echo ""
	@echo "✓ 全部门禁通过（提交前跑这个）"

# ------------------------------------------------------------------------------
#  CI（.github/workflows/ci.yml 只调这一条，门禁清单只此一处）
#
#  CI 上**没有** Cocos Creator，也**没有** assets/resources 素材（体积大、有意不入库，
#  见 .gitignore）—— 而 25 套客户端单测里有 10 套是断言素材磁盘内容的。所以客户端门禁
#  （client-check + 25 套单测）是「本地专属」，不在 CI 覆盖范围内，别把它当成漏跑。
# ------------------------------------------------------------------------------

ci: install-ci audit server-build admin-build server-e2e server-e2e-roles server-e2e-guard server-e2e-mail server-e2e-backup ## CI 门禁：服务端五套 e2e + 管理端构建 + 跨端审计（不含客户端）
	@echo ""
	@echo "✓ CI 门禁通过"
	@echo "  未覆盖（本地专属）：make client-check、make client-test —— 需要本机 Cocos 工程与 assets/resources 素材"

# ==============================================================================
#  清理
# ==============================================================================

clean: ## 清理构建产物与临时日志（不动 assets 与 client 缓存目录）
	@rm -rf server/dist admin/dist
	@rm -f "$(LOGDIR)"/olua-*.log
	@echo "已清理 server/dist · admin/dist · $(LOGDIR)/olua-*.log"
	@echo "（client/library · client/temp · client/build 交给 Cocos 编辑器管理，未动）"
