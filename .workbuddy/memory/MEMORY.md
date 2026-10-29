# olua 长期记忆（索引，细节见 skills 与 2026-*.md）

> 纪律：一切提交走 issue → 分支 `type/n-slug` → PR（`Closes #n`）→ CI 绿 → squash；docs/记忆同样；写日志前先切分支。一个 PR = 一个功能；全绿才提交（`make ci`，数字实测）。记忆/技能随仓库提交，走同样流程；仓库 PUBLIC —— **IP / 私钥 / 邀请码 / JWT 不进记忆**。
> master = 横屏 1624×750；portrait = 竖屏 750×1624（竖屏只进 portrait）。

## 会再犯的坑（守点 = 脚本，细节见对应 skill / 日志）
- **环境相关不进生成物**：`resources/` 是 gitignore（只从 Release 来），清单带 `hasAsset` 会让逐字节守点在 CI 必然假红 → 改运行时 `HEAD` 探测（403/404/410 才算缺）。
- 只信 Grep 工具（BSD grep 不吃 `\|`，恒空≠已改完）；批量替换 `perl -pi -e`；改完看行尾（`GameUiHelper.ts` 是 CRLF）与 `make client-check`；编辑器回写要 `sleep 20` 复检。
- 服务端/子进程 `env -u NODE_OPTIONS`；`curl --noproxy '*'`；起端口前 `lsof` 探占用。
- **代码生成/快照**：一份数据只能有一个来源（`configs` → `game-data.generated.ts`；管理端工作台用 `equip-align.catalog.json`），守点是「重生成 + 逐字节 + 结构断言」。派生清单不钉住会静默毁数据（旧值调完再写回 = 覆盖上一次成果）。
- **babel loose**：`[...map.values()]` 装的是迭代器不是内容 → Map/Set 一律 `Array.from`（守点 `audit-iterator-spread`）。
- **指针事件必须配 `UITransform`**（3.8.7）：否则每次派发抛 `cameraPriority` 空指针、输入全废；防呆静默跳过会吞证据，判据要问「前提在不在」。
- **自适应分三层**（模板 / `applyScreenPolicy` / 场景贴边），模板只在 GUI 构建生效；游戏内坐标一律以相机为准。
- **飘字**跨场景挂场景里的 `Canvas`（不是场景根）；行内文字按 bbox 验（CLAMP + 左对齐从框左缘起排），单行 CLAMP 装不下要 `enableWrapText` + 行高自适应。
- **几何**：位置类按帧内容 bbox 运行时算、配置只当微调（内容中心 = 节点中心 + `offset`，y 向上；衣服节点缩放要乘；空帧按面积判 `BLANK_FRAME_MAX_AREA = 4`；轮廓按 alpha>200，裁剪框含影子）；plist `spriteSourceSize` 只有 2 个数。改语义要渐进（如 `outManual` 勾了才用绝对值）。
- **假绿 > 漏检**：扫描器吞异常会「扫 0 个模块也全绿」（必须断言模块数）；期望值与被测代码可能各错一半；错误断言要精确匹配文案；重试写进被测助手；缓存逻辑把 TTL 压 0；压配置别压掉被测语义。
- **节点名用 key 不用图标**（同名节点 `find()[0]` 会拿错）；空态/等待态文案不能跨状态复用；服务端 `{type:"error"}` 是拒绝的唯一出口，客户端少接 = 静默拒绝；乐观 UI 要用服务端既有信号确认。
- **文档数字**：加审计/单测会连坐 README/FAQ/resume/官网/skills（`audit-doc-numbers` 给行号），双语还要数字出现次数相等（`audit-docs-en`）。
- 真机验证：真实 Chrome `headless:false` + playwright-core；自适应只测真实窗口（`viewport:null`）；`window.__cc` 只在 `__v.ready()` 后存在，`reload` 后要重新 `ready()`。

## 架构不变量（细节 skill `olua-server` / `olua-admin` / `olua-client`）
- 服务端权威：伤害/掉落/经验/进度/金币一律服务端算，客户端只演。
- 管理端接口必须 `@ApiAdminDoc({permissions})`；角色数据是不透明文档（`guide` 例外：只校验结构、**不补默认值**）；修订号乐观锁 409+20006；`whitelist` 要 DTO + `@Type` + 登记 `SWAGGER_MODELS`；排序白名单 `sort-specs.ts`；文本主键 `findByKey`；`BizException` 默认 400。
- 部署：compose 四服务（admin:80 / game:8080 / server:3100 / realtime:3101），`/api` 与 `/game-resources/` 都反代到内网；密钥只在 `deploy.env`；先合 master 再发布；Cocos 只能 GUI 打包。
- 本机 client-test 基线 **56 套 / 51 过 5 红**（红全是素材未入库）；CI 不跑它，门禁看 `make ci`。

## 进度（细节见 2026-*.md）
- 已收官：战斗权威 #25~#37 · 管理端 epic #259 · 客户端对接 #293 · 社交 #387 · **玩法补全 #394 十二刀全收**（聊天/任务/经济/屏蔽举报/组队/排行榜/成就/引导/邮件/成就扩容/频道）。
- 2026-10-29：窗体感收尾 → 真机验证第三轮（#491~#498）→ 装备位置对齐 #505/#506 → **管理端对齐工作台 #509/#510**（`/equip-align`，裸模为唯一基准 8 方向，导出 JSON 由 `tools/apply-equip-align.cjs` 写回）。
- open：#8 官网 / #9 包体积 / #12~#19 素材 / #295 阶段三 / #403 帮会战。已定保持现状：技能 1011 / 快捷键 6 格 / 药品 3 档 / 装备 7 部位。
- 数字基线（#510 后）：154 接口 / 128 路径 / 233 模型 / 25 权限点 / 43 表 / 35 仓储；e2e 2271（22 套）；单测 56；回归守卫 69；审计 13。
