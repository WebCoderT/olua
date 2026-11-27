# olua

> [English](README.en.md) | 简体中文

**一个打开浏览器就能玩的 2D 角色扮演游戏。** 创建角色、跑地图、打怪、捡装备、升级、加帮会 —— 一整套玩法已经跑通，
不是演示片段。项目**免费开源**，任何人都能自己部署一套；线上的游戏服务器目前暂停，只保留了官网。

| 想做什么 | 去哪里 |
| --- | --- |
| 看玩法、截图与完整图文教程 | <https://yimw.cn>（官网） |
| **下载发布版客户端（v1.0.0）** | 加入 QQ 群 **1124215785**，从群文件获取安装包（Windows / macOS） |
| 自己搭一套开玩 | 下文「自己搭一套」，Docker 两条命令 |

> 线上的游戏与管理后台**暂时停开**（只保留官网）；**v1.0.0 发布版客户端已上线**（2026-11-27），
> 加入 QQ 群 **1124215785** 即可从群文件下载，连接自己部署的服务器开玩。

> 代码在 [GitHub](https://github.com/WebCoderT/olua)，[Gitee](https://gitee.com/putiwan/olua) 是只读镜像。
> 觉得有意思可以点个 **Star ⭐**。

## 这是个什么游戏

斜 45 度俯视的 2D 画面，键盘走位、鼠标点怪，玩法接近早年网吧里的传奇类网游，但把繁琐的部分都砍掉了：
没有复杂的合成表，没有必须氪金的数值墙，也不用组队才能玩。

你从选角界面创建一个角色，出生在新手地图，跟着 6 步引导学会走路、攻击、捡东西、开背包；
之后有 28 环主线任务带着你一张图一张图往前推，也可以自己决定往哪走：

- **想变强**：打怪有经验，升级会补满血蓝、解锁更高的地图；主线任务每一环都发经验和绑定元宝，
  装备靠打怪掉落，也能在商城直接买。
- **想好看**：装备有前缀和后缀，同一件装备会因为词缀不同变成不同的品质，边框会发光、详情面板有专属背景动画。
- **想收集**：战魂 37 阶、称号 34 阶、军衔 100 阶，三条成长线各自加属性，也都显示在角色头上。
- **想热闹**：同屏能看到其他玩家，能加好友、拉黑、举报，能建帮会收人、发公告，还能组队一起打、经验按比例分。
- **想省事**：有自动战斗和寻路，点一下怪就自己跑过去打；背包有一键整理和一键回收。

死了不惩罚：原地复活，或者回城满血复活。

## 界面长什么样

下面全部是本地部署后的真机截图。**完整图文教程（含管理端每个页面的说明）在官网：
<https://yimw.cn/tutorial.html>**。

客户端：

<p align="center">
  <img src="website/assets/img/登录.jpg" width="32%" alt="登录：账号、密码、选服务器" />
  <img src="website/assets/img/选择区服.jpg" width="32%" alt="选择区服：区服状态与开服时间" />
  <img src="website/assets/img/创建角色.jpg" width="32%" alt="创建角色：战士 / 法师 / 道士" />
</p>
<p align="center"><sub>登录 · 选服 · 创建角色</sub></p>

<p align="center">
  <img src="website/assets/img/角色选择.jpg" width="32%" alt="角色选择：账号下已有角色" />
  <img src="website/assets/img/新手村.jpg" width="32%" alt="新手村：NPC、怪物与主界面" />
  <img src="website/assets/img/过渡场景.jpg" width="32%" alt="进图过场：燃烧的城门" />
</p>
<p align="center"><sub>角色选择 · 新手村 · 进图过场</sub></p>

<p align="center">
  <img src="website/assets/img/角色信息.jpg" width="32%" alt="角色信息：等级、战力与装备" />
  <img src="website/assets/img/属性点.jpg" width="32%" alt="属性点：战斗属性与四维加点" />
  <img src="website/assets/img/背包.jpg" width="32%" alt="背包：物品格子、整理与回收" />
</p>
<p align="center"><sub>角色信息 · 属性点 · 背包</sub></p>

<p align="center">
  <img src="website/assets/img/物品掉落.jpg" width="32%" alt="地面掉落：品质光柱" />
  <img src="website/assets/img/小地图.jpg" width="32%" alt="小地图：怪物红点与寻路" />
  <img src="website/assets/img/地图传送官.jpg" width="32%" alt="地图传送官：按等级分组的传送" />
</p>
<p align="center"><sub>物品掉落 · 小地图 · 地图传送官</sub></p>

<p align="center">
  <img src="website/assets/img/战魂.jpg" width="32%" alt="战魂：37 阶成长线" />
  <img src="website/assets/img/称号.jpg" width="32%" alt="称号：34 阶称号链" />
  <img src="website/assets/img/军衔.jpg" width="32%" alt="军衔：100 阶军衔" />
</p>
<p align="center"><sub>战魂 37 阶 · 称号 34 阶 · 军衔 100 阶</sub></p>

<p align="center">
  <img src="website/assets/img/社交.jpg" width="32%" alt="社交：好友、敌人、黑名单与举报" />
  <img src="website/assets/img/商城.jpg" width="32%" alt="商城：装备与道具分页浏览" />
  <img src="website/assets/img/时装.jpg" width="32%" alt="时装：只改外观不改数值" />
</p>
<p align="center"><sub>社交 · 商城 · 时装</sub></p>

运营后台（浏览器打开，给运营改数据用的）：

<p align="center">
  <img src="website/assets/img/admin/01-overview.jpg" width="32%" alt="后台概览：账号、角色、在线与增长趋势" />
  <img src="website/assets/img/admin/02-accounts.jpg" width="32%" alt="账号管理：筛选、封禁与重置口令" />
  <img src="website/assets/img/admin/03-roles.jpg" width="32%" alt="角色管理：多条件筛选与角色档案" />
</p>
<p align="center"><sub>概览 · 账号管理 · 角色管理</sub></p>

<p align="center">
  <img src="website/assets/img/admin/16-equip-align.jpg" width="32%" alt="装备对齐：8 方向动作帧逐帧对位" />
  <img src="website/assets/img/admin/26-maps.jpg" width="32%" alt="地图管理：NPC、刷怪区与碰撞盒" />
  <img src="website/assets/img/admin/22-drops.jpg" width="32%" alt="掉落表配置：条目池、权重与概率" />
</p>
<p align="center"><sub>装备对齐 · 地图管理 · 掉落表配置</sub></p>

<p align="center">
  <img src="website/assets/img/admin/30-runtime-params.jpg" width="32%" alt="运行时参数：战斗、移动与 AOI" />
  <img src="website/assets/img/admin/45-audit-logs.jpg" width="32%" alt="操作日志：谁在什么时候改了什么" />
  <img src="website/assets/img/admin/47-config-versions.jpg" width="32%" alt="配置版本：差异对比与回滚" />
</p>
<p align="center"><sub>运行时参数 · 操作日志 · 配置版本</sub></p>

管理端的**全部功能页**都有截图，每个页面的用途与操作都写在
[使用教程](https://yimw.cn/tutorial.html) 里。

## 你能玩到什么

### 账号与角色

- 注册、登录、选服，一个账号最多 3 个角色；战士 / 法师 / 道士三职业，角色数据存在服务器上，换电脑继续玩。
- 进度自动保存：边玩边存，切地图和退出前会立刻再存一次，不会因为关页面丢进度。
- 选角界面可以删角色（两步确认，防手滑）。

### 地图与探索

- 62 张地图，每张有自己的等级和战力门槛，不够会被传送官拦下并告诉你差多少。
- 进图有进度条；每张图有复活点，进出地图都从那里开始。
- 右上角小地图跟着你走，红点是怪物的真实位置；点小地图能放大，左键自动寻路、右键直接传送。
- 走路会绕开树和墙，不会卡在障碍物里。

### 任务

- 28 环主线任务（星灯纪）：找 NPC 接任务，剧情文案一路读下去，完成打怪目标后交任务拿经验和绑定元宝。
- 每一环环环相扣、有等级门槛，跟着主线走就能把前期的地图和系统都过一遍。

### 打怪与战斗

- 220 种怪物散布在 62 张地图里，按物种成群出没，掉落各不相同。
- 键盘 WASD 移动，左键走、右键跑，点怪就攻击；也有屏幕摇杆，手机浏览器能玩。
- 技能有冷却和耗蓝，打出去有特效和飘字；怪也会放技能。
- 伤害由服务器计算，所有人看到的血量一致，不会出现「我这边打死了、你那边还站着」。
- 死了停住画面，可以原地复活，也可以回城满血复活。

### 成长

- 打怪拿经验，等级越高属性越强；等级差太多的小怪不给经验，避免一直刷新手怪。
- 战魂（37 阶）、称号（34 阶）、军衔（100 阶）三条线，花游戏里赚的元宝升级，加的属性都算进战斗力。
- 战斗力是一个数字，也是进高级地图的门槛。

### 装备与物品

- 装备分部位、分等级，穿上就加属性，换装立刻重算，外观也会跟着变（8 个方向都有）。
- 每件装备有「前缀 + 后缀」组合，品质不同，背包格子上的边框和详情页的背景会播放不同动画。
- 打怪掉装备：地上会出现光柱，品质越高越显眼，走过去自动捡。
- 背包能整理、能拖动、能一键回收成元宝，也能把不要的东西拖出窗口直接丢掉；
  还能勾选自动回收（背包装满自动腾格子再拾取）、自动使用、自动穿戴，挂机更省心。
- 商城把全部装备自动上架，翻页挑、买了直接进背包；还有 20 件只换外观不改数值的时装。

### 社交

- 同屏能看到别的玩家，名字按关系上色：好友绿、队友金、同帮蓝、敌人红、拉黑灰。
- 好友要双方同意；敌人是单向的，对方不会收到通知。
- 帮会可以建、可以申请、可以审批，能踢人、转让、解散，帮主能改帮会公告。
- 队伍邀请即建队，队长带队，队长退出会自动移交；同图队友能分到经验。
- 排行榜分等级、战力、击杀三张，离线也留在榜上。
- 有成就系统，达成就领奖，背包满了奖励会转到游戏内邮件。

### 界面

- 血球、魔法球、经验条、快捷键栏、小地图一屏放得下。
- 弹窗点哪个哪个浮到最上层，不会互相遮挡点不到。
- 鼠标停在技能和状态图标上会显示说明和剩余时间。
- 第一次进游戏有 6 步新手引导，只高亮不挡操作。

## 自己搭一套

### 最省事：一台装了 Docker 的服务器

```bash
git clone https://github.com/WebCoderT/olua.git && cd olua
cp server/.env.example server/.env      # 至少填 JWT_SECRET 与 ADMIN_REGISTER_CODE 两个密钥
docker compose up -d --build
```

跑完会起四个容器：网站、管理后台、接口服务、实时服务，对外只开 80。
游戏网页端默认不启动（`profiles: ["game"]`，#1314）；要发客户端跑
`bash .workbuddy/skills/olua-deploy/scripts/deploy.sh --game`，详见 [`docs/deploy.md`](docs/deploy.md)。
域名、HTTPS、备份、升级、回滚等完整步骤见 [`docs/deploy.md`](docs/deploy.md)。

### 本机开发：三条命令

```bash
cd server && npm install && cp .env.example .env && npm run dev   # 接口 :3100
cd admin  && npm install && cp .env.example .env.development && npm run dev   # 后台 :5173
# 客户端用 Cocos Creator 3.8.7 打开 client/ 目录，点预览
```

服务端起好以后，打开 <http://localhost:3100/api-docs> 能看到全部接口文档；
后台第一次注册的账号自动是超级管理员。

> 游戏素材（2.4G）不在代码仓库里，打开 Cocos 工程前先按文末「素材」一节把资源下载下来。

## 这个项目是怎么写出来的

**每一行代码都是 AI 写的。** 人只做三件事：提需求、看效果、说不满意。

所以这个仓库除了游戏本身，也是一份「AI 能不能独立写完一个完整项目」的实测记录：
需求怎么拆、AI 写歪了怎么纠、哪些地方必须人来拍板，都留在提交历史和 `docs/` 里。

技术上它和常见的开源游戏项目没区别：客户端 Cocos Creator，服务端 NestJS，后台 React，数据库 SQLite。
区别在于**没有一行是人手敲的**。

## 给想改代码的人

仓库分成三个平级的端，各自有独立的 README 和常见问题：

| 端 | 是什么 | 用什么写的 | 目录 |
| --- | --- | --- | --- |
| 客户端 | 玩家玩的游戏 | Cocos Creator 3.8.7 + TypeScript | [`client/`](client/) · [README](client/README.md) |
| 服务端 | 存档、战斗结算、各种接口 | NestJS + SQLite | [`server/`](server/) · [README](server/README.md) |
| 管理端 | 运营改数据用的后台 | React + Vite + Tailwind | [`admin/`](admin/) · [README](admin/README.md) |

两条规矩值得先知道：

1. **服务器说了算。** 客户端的血、伤害、掉落、背包都只是显示，真正的数据在服务端；断线时客户端不会自己算一套假的。
2. **接口只写一遍。** 接口定义在服务端，客户端和后台的接口文件由工具自动生成，改字段忘了同步会直接编译报错。

常用命令（在仓库根执行，`make help` 看全部）：

```bash
make install        # 装依赖
make dev            # 同时起服务端和后台
make check          # 类型检查 + 跨端审计
make test           # 客户端单测 + 服务端端到端测试
make verify         # 提交前跑这个：上面全部 + 三端构建
```

更细的文档：

| 文档 | 内容 |
| --- | --- |
| [`docs/`](docs/README.md) | 40 篇代码文档：每条链路从数据库讲到屏幕 |
| [`FAQ.md`](FAQ.md) | 常见问题：为什么这么设计、踩过哪些坑 |
| [`website/`](website/index.html) | 官网：玩法细节、完整使用教程、架构图、工程管理、设计取舍 |

## 许可

[MIT](LICENSE)：可以自由修改、分发，也可以商用，保留版权声明即可。
商用产生的一切工作（部署、扩容、合规、售后）由使用者自己承担，作者不提供免费的技术支持。
问题欢迎提 issue，但不保证响应时间。

## 素材

游戏素材有 2.4G，**有意不放进代码仓库**。原先的「清单 + GitHub Release 分卷」分发渠道已下线
（资源包由维护者自行保管，新机器不再有公开下载来源）；仓库里的清单 `resources.manifest.json`
与同步脚本 `client/tools/resources_sync.py` 保留，仅用于本地核对与打包：

```bash
python3 client/tools/resources_sync.py verify   # 核对本地素材与清单是否一致
```

## 联系

![QQ 群](website/assets/img/QQ群.jpg)
