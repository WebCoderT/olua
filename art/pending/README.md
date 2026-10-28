# 待入库素材（art/pending）

**放什么**：已经定版、但还没进远程 Release 的素材。

**为什么需要这个目录**：`client/assets/resources/` 以**远程 Release 为唯一来源**（见 `.workbuddy/skills/olua-resources`），
本地手工塞图会与 `resources.manifest.json` 不一致，`resources_sync.py verify` 会红；
而新素材如果只躺在某个人的机器上，下一次重打 Release 时很容易丢。所以先在这里入库留档，
重打 Release 时按下面步骤挪进资源包，挪完把这里的文件删掉。

## 清单

| 文件 | 用途 | 规格 | 来源 issue |
| --- | --- | --- | --- |
| `bottom-nav-bar/chat.png` | 底部导航栏「聊天」入口图标 | 42×42 PNG，青铜浮雕对话气泡 + 金色宋体「聊天」 | #468 |

底栏其余九枚（`bag` / `config` / `group` / `horse` / `mall` / `role` / `skill` / `task` / `friend`）
都在 `resources/bottom-nav-bar/`，同一套调子：上方物件 + 底部金色中文。
新图标是按这套口径做的（气泡取自一张 1024 生成图，中文用系统宋体重排，保证 42px 下笔画不糊）。

## 接入步骤（重打 Release 时）

1. 把 `bottom-nav-bar/chat.png` 放进 `client/assets/resources/bottom-nav-bar/`（在 Cocos 里导入生成 `.meta`）；
2. `python3 client/tools/resources_sync.py pack` 重打 Release、更新 `resources.manifest.json`；
3. 改 `client/assets/configs/bottomNav.ts`：聊天入口的图从 `friend`（临时复用，见 #468）换成 `chat`；
4. 删掉本目录的这份文件，并在 #468 里留一句「已随 `<release 版本>` 接入」。
