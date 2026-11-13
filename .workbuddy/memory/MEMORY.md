# olua 长期记忆（索引）

> 跨域硬纪律 → 本文件；**按域不变量** → `topics/架构不变量.md`；查坑 → `topics/踩坑速查.md`；「做过没有」→
> `topics/进度年表.md`；登记清单 → `topics/登记清单.md`；展开做法 → `.workbuddy/skills/`；系统全貌 → `docs/21~38`。
> 2026-11-08 起不写日报（正文在 git 历史）。

## 纪律（不可绕过）
- issue → 分支 `type/n-slug` → PR（写「关联 #n」，**不写 `Closes`**）→ CI 绿 → squash → 手动 `gh issue close`。
- 仓库 PUBLIC：密钥 / IP / 邀请码 / JWT 不进记忆、不进版本库（只放 gitignore 的 `deploy.env`）。**`website/` 永不改动**。
- 新 issue 至少一个 `功能:` 标签（29 域见 `docs/38`，最多 3）；docs-only 可直接推 master；长正文一律 `--body-file`
  （内联反引号会被 zsh 吞）。
- **现状 ≠ 正确，issue 正文也不是事实**：先按它指的行号实测 `server/src` + `admin/src`；收窄范围要写进 issue 并改验收。
- **待决定项实时问**（AskUserQuestion，一轮 1~4 个）；文档禁写「不做」（写「暂时放置 + 重开条件」，「已定」只标
  用户亲口拍过的）。用户说「我自己细化 / 我在改」→ 改完本地就停（不 push、不盯 CI、不合并）。
- **改数据的五处/三处登记清单见 `topics/登记清单.md`**（漏一处 = 静默失效，尤其「新增一列」的仓储写入列清单）。

## 测试与门禁
- **反证前确认 build 真过了**：`npm run build 2>&1 | tail -N && 跑测试` 退出码来自 `tail` → 不加管道或 `pipefail`。
- e2e：期望值从快照算 · 播种在 `startServer()` 之后 · 改 `server/src` 先 build · 本机绿 ≠ CI 绿；`e2e-quest`
  成功静默，判绿看 exit code；`make e2e-all` 要重定向日志后台跑（约 8~9 分钟）。
- **锁格式与行为，不锁数值**；**显示效果不写断言**；**假绿 > 漏检**（断模块数 / 精确文案 / TTL 压 0 都危险）。
- **帧只发「有变化」的东西**：断「路过某点」要扫**帧历史**；命中帧先按 `hit.accountId` 过滤。
- **源码断言钉在方法体上**（`methodBody`），别用全文件 `includes`；断言口径过期比红更危险。
- **血量类断言别用「窗口净变化」**（回血把 DoT 变锯齿）→ 数「比上一次低」的次数。
- **时序用例别赌 wall-clock 窗口**：满负载并行 tick 会被挤后（#833 追击段）。
- 工具链：只信 Grep 工具；批量替换 `perl -pi -e`；`curl --noproxy '*'`；`ps`/`pgrep` 被禁用 `kill -0`；并发异常先
  `reflog` + `stash list`。

## 架构不变量（细节见 `topics/架构不变量.md`）
- **服务端权威**：`@ApiAdminDoc({permissions})` · `BizException` 默认 400 · 乐观锁 409 + **20006** · 校验 **40000** ·
  失败 `data` 恒 `null`（数量给 `details`）· 客户端零决策、乐观锁「拉最新 + 丢弃本轮」不重推。
- 方向恒 `apply-snapshot → game-config → types`；**一份数据一个来源**（库表 → 快照段 → `apply*` 整表重建）。
- 客户端只报格子 / 增量，数值直读回执；**进 `SERVER_INVENTORY_FIELDS` 的字段不得写、也不得补默认值**。
- 纯服务端消费的参数别并进 `RuntimeParamsDto`（那是客户端快照形状，加一段动五处）。
- 已展开域（一句话见 topic）：战斗 #822~#825 · 状态两侧 #826 · 怪物 AI #853~#858 · 背包装备 #835~#842/#838 ·
  邮件 #866~#870 · 冷却 #847/#848 · 版本链 #881~#883 · 商城 #846 · 进图 #859/#861 · 任务周期 #862~#865 ·
  拾取 #817 · 帮会 #871/#872 · 点数 #828/#833 · 刷怪密度 #930 · **移动三道校验 #811**（单帧即拒 + 回「上次被接受
  的坐标」· 出口只有换图/复活/突进 `posCredit≤320` · 兜底 `off` ≠ 出厂 `log` · `maxSpeed` 全局尺子）。

## 引擎坑（→ `cocos-*` 技能）
指针事件配 `UITransform`；`AnimationState` 手动 stop、`isValid(node,true)`；Game 挂 Canvas → 五世界层建好再
`setWorldPosition(0,0,0)`；**显隐与摆位绑「片段是否就绪」**。

## 部署（→ olua-deploy）
compose **五个**服务：admin:80（唯一入口）/ game:8080 / server:3100 / realtime:3101 / website（不映射端口）。镜像
context = 仓库根，出厂快照打进镜像（`.dockerignore` 放行 `data/config-sync.sql`），卷 `olua_olua-data`。客户端地址由
`DEV_MODE` 唯一开关决定；资源发布 `make resources-manifest/pack/upload VERSION=x`。

## 进度
- 逐批细节 → `topics/进度年表.md`（450+ 条）。最近五条：**#811 移动三道校验（`7f1bcb5f` / PR #941）** ·
  #932 任务域四缺口（`01b42dd0`）· #826 战斗六项（`0ae851d2`）· #833 属性点（`7e1eadc9`）· #838 穿戴校验（`2e05228d`）。
  已关但别忘：#925/#926 bindGold 收敛 · #930 刷怪密度 · #921 商城限购。
- 当前 open：#9 包体积 · #12~#19 素材 · #295 阶段三 · #403 帮会战 · #742 TLS · **#808 地图重构（剩 #809 Room/AOI）** ·
  #801~#805 掉落重构 · #772 分片 · #438 群发。**保持现状**：技能 1011 / 快捷键 6 格 / 装备 7 部位。
- **`docs/14` 没有生成脚本**（「自动生成」已过期）：改接口**手工**加行 + 重算三段。现口径 **246 = 7 + 65 + 174**；
  是 `role.attrsAllocate/attrsReset`（带 s）。
- **client 单测可当门禁（#928）**：65 通过 / 0 失败；**git worktree 里跑会假绿/假红**（要 `cp -R` 补声明）。
- **`docs/37` 是最高优先单一来源**。推翻旧设计的四条：删元宝/银子且金币不可流通、存档版本不符**拒登录**、
  换图即移除旧图观看者、补种改每秒按密度补缺（#930）。
