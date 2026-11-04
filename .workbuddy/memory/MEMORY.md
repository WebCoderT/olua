# olua 长期记忆（索引；细节在 `.workbuddy/skills/` 与 `memory/2026-*.md`）

> **纪律**：issue → 分支 `type/n-slug` → PR（「关联 #n」）→ 本地 `make test-changed` → CI 绿 → squash。
> 仓库 PUBLIC —— 密钥 / IP / 邀请码不进记忆。**website/ 永不改动**。docs-only 用户口头「更新」可直接推 master。
> 本机待办 `TODO-FOR-USER.md`（gitignore）。

## 过程纪律
- **测试锁「字段格式 + 行为」不锁数值**（运营随时改数）；用户说「数据我改过」= 停追红，改断言口径。
- **e2e**：期望值从快照算（`server/test/lib/config-snapshot.cjs` 的 rows/index/group）；播种放 `startServer()` 之后；`checkEqual` 是 `===`；改 `server/src` 先 `npm run build`（e2e 跑 `dist/`）；本机绿 ≠ CI 绿（耦合断言等一帧同时满足两边，超时盖过一个冷却周期）。
- **假绿 > 漏检**：扫描器断言模块数、错误精确匹配文案、缓存 TTL 压 0。
- **新增一张表的登记四处**：`config-tables.cjs` 两份清单 + `gen-api.cjs` MODULES + `audit-server-boundaries` REPO_EDGES + `audit-target.decorator` 类型。快照加段 = DTO / `snapshot()` / 客户端 `game-config.ts` 区 0 三处 + `audit-snapshot-contract` 守点。
- **config-sync.sql 加表**：只拼新增表的节 + 手改表头三行（整份重导会有几千行假 diff）；`cp` 库前 `PRAGMA wal_checkpoint(TRUNCATE)`；校验拿「同 schema 库副本」做 `config-import --db`。**`make config-check` 红在用户正在改的表时别整份 config-export**。
- 改 DTO 连描述都算改契约 → `swagger:emit` + `node tools/gen-api.cjs`；「管理页看不到新行」= 服务端 seed 没跑 → 重启 3100。
- **一份数据一个来源**（库表 → 快照段 → `apply*` 整表重建）；整表重建后派生 Map 必须重建。
- babel loose：`Array.from` 替 `[...map.values()]`；客户端 tsconfig 无 ES2017 不用 `Object.entries`。
- 工具：只信 Grep 工具（BSD grep 交替恒空）；批量替换 `perl -pi -e`（`sed -i ''` 异常、perl 里 `$(` 特殊）；`curl --noproxy '*'`；起端口前 `lsof`；行尾 `grep -c $'\r'`。

## 引擎坑（细节 → skills）
- 指针事件配 `UITransform`；`AnimationState` 手动 stop、`isValid(node, true)`；几何锚点是画布中心；自适应三层；**Game 挂 Canvas → 五世界层建好后 `setWorldPosition(0,0,0)`**（#692）。

## 架构不变量（→ skills olua-server / olua-admin / olua-client）
- **服务端权威**；管理端接口 `@ApiAdminDoc({permissions})`、`BizException` 默认 400、乐观锁 409+20006。
- `configs/`/`types/` 不引 UI 组件；方向恒为 `apply-snapshot → game-config → types`。
- 门禁看 CI（PR 跑一次）；`make test-changed` 定向回归；client-test 基线 4 红（素材未入库）。

## 部署（→ skill olua-deploy）
- compose 四服务：admin:80（唯一入口）/ game:8080 / server:3100 / realtime:3101。
- 管理端镜像 context 必须是**仓库根**（引 server 常量）；出厂快照打进镜像：`server/.dockerignore` = `data/*` + `!data/config-sync.sql`，compose 给 `CONFIG_SNAPSHOT_PATH`；验收前等健康检查；卷 `olua_olua-data`、数据在 `-wal`。
- `game.yimw.cn` 走管理端 nginx 按 server_name 反代 `game:80`；客户端 `network.ts` 按 host 判本机/公网。
- 资源发布：`make resources-manifest/pack/upload VERSION=x`；清单先合 master 再传 Release。

## 进度
- 已收官（细节见日报 / skills）：#25~#37 战斗权威 · #259/#564 管理端 · #293 对接 · #387/#394 社交玩法 · #556 背包穿戴 · #566~#586 地图与世界 · #597/#598 · #437/#439 邮件 · #596 存档权威 · #603/#604/#626 出厂数据上服务端 + 快照层 · #605 运营参数收权 · #643 药品 · #646/#648/#651 选择器体系 · #653 配置同步 · #655 派生数据落库 · #667/#672/#676 刷怪区/NPC/碰撞收后台 · #680/#683/#685 音效 · #689 击杀跨端（观看端掉落纯演出）· #693 玩家动作跨端（三路负载合并成一帧）。
- **#695 装备外观收权（PR #696 / `b31b9203`）**：`equipment_appearance` 单行表（四 JSON 列：15 组前后缀→边框/背景 + 特殊装备自定义）+ `GET/PATCH /admin/equipment-appearance` + 快照段 `equipmentAppearance` + 管理端「装备外观」棋盘页。**资源清单（key↔磁盘图集）留客户端**，服务端只存 key 只校格式、不校素材存在；坏数据自愈（映射坏整份回落出厂、自定义坏条目丢弃）；客户端无本地兜底（快照前 Map 为空）。旧客户端不消费新段，安全。改动要等客户端重新打包才可见。
- open：#669 刷怪区即时生效 · #670 打尸体仍放技能 · #8 官网 · #9 包体积 · #12~#19 素材 · #295 阶段三 · #403 帮会战 · #606 地图门槛。
- 定保持现状：技能 1011 / 快捷键 6 格 / 装备 7 部位。
