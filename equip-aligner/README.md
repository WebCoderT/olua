# 装备人工对齐器

给装备外观（out）的 **8 方向偏移 `outPositions` 与缩放 `outScale`** 做可视化对齐的本地小工具：网页里把装备帧叠在参考外观上拖动对齐，导出 JSON，再用脚本写回 `assets/configs/equipments.ts`。纯前端、零依赖、不用构建。

## 快速开始

1. 在**项目根目录**启动 Live Server（VSCode 右下角「Go Live」，默认端口 5500）；
2. 浏览器打开 `http://127.0.0.1:5500/equip-aligner/index.html`；
3. 左侧选装备 → 拖动中间画布里的装备帧 → 右侧「下载 offsets.json」；
4. 项目根执行写回：

```bash
node equip-aligner/apply-offsets.cjs offsets.json             # 写回（自动备份 .bak）
node equip-aligner/apply-offsets.cjs offsets.json --dry-run  # 只看会改什么
```

> Live Server 的根目录必须是项目根（这样 `../assets/...` 才通）；如果从别的目录启动，把页面顶部的「资源根」改成正确相对路径即可。
> 不要用 `file://` 直接双击打开——浏览器会拦 fetch，读不到 configs。

## 画布操作

| 操作 | 效果 |
|---|---|
| 左键拖动 | 移动装备帧（吸附 0.1，与配置的数值精度一致） |
| 方向键 | 微调 1（Shift = 10，Alt = 0.1） |
| 滚轮 | 以鼠标为中心缩放视图 |
| 右键拖动 | 平移视图 |
| 数字键 1~8 | 切换方向 |
| F | 下一帧 |

工具条上可以切换动作（站立/走/跑/攻击…）与帧内序号——`outPositions` 对所有动作生效，但建议至少在站立与一个攻击帧下核对。

## 多方向

- 每个方向的位置独立保存，方向按钮上带 `•` 表示该方向与第 0 向不同；
- 大多数装备 8 向同值：调好一个方向后点「**应用当前方向到全部 8 向**」；
- 改动实时存浏览器 localStorage，刷新不丢；右侧列表可单件丢弃或整体清空。

## 参考外观（底图）

默认取 `configs/role` 的 `ROLE_DEFAULT_CLOTH_OUT`，该目录没有素材时自动回退到第一件有外观的装备（当前即 `clothes/out/005`，也就是新手衣服）。下拉里可选任意装备外观作为底图，选中的底图会按它自己的偏移渲染（接近游戏内真实叠加效果）。

## 写回脚本

```bash
node equip-aligner/apply-offsets.cjs offsets.json [--dry-run] [--file assets/configs/equipments.ts]
cat offsets.json | node equip-aligner/apply-offsets.cjs -
```

- 只替换目标条目的 `outPositions` 块与 `outScale`，**其余字段、注释、格式一字不动**；方向注释（`// up` 等）按 `configs/animation.directions` 生成；
- 数值等价时不碰原文本（源文件里 `-10.0` 这类写法不会被改成 `-10`）；
- 写回前自动备份 `equipments.ts.bak`；
- 找不到的 key 会列出并以退出码 2 结束。

写回后建议：等 20 秒 grep 复查磁盘内容（编辑器有周期性回写），再跑工程 tsc 与 `tools/test-*.cjs`。

## 自检

```bash
node equip-aligner/selfcheck.cjs
```

三项检查：解析自检（条目数/方向/帧号公式）、**往返一致**（全量导出→写回→与源文件逐字节相同）、改值写回（diff 只落在目标装备）。改完 `index.html` 或写回脚本后跑一遍即可回归。

## 渲染口径（为什么网页画的就是游戏里看到的）

- 角色节点锚点 `(0.5, 0)`、原点在**脚底中心**；外观是它的子节点，位置 = `outPositions[方向下标]`、缩放 = `outScale`（见 `RoleAppearance.applyOutTransform`）；
- 外观 Sprite 为 RAW 尺寸 + 默认锚点 `(0.5, 0.5)`：节点位置就是**帧原始画布的中心**。帧即使被 auto-trim，引擎也会把裁剪内容按 offset 贴回原始画布——所以网页直接画 PNG 全图、图中心对齐节点位置，与游戏渲染完全等价；
- 帧号 = 动作段起始 + 方向下标 × 该动作每方向帧数 + 帧内下标（`configs/animation` 的 `fillAnimationMap`），帧文件名 = 帧号补 5 位 + `.PNG`。

装备表、动作表、方向顺序全部**现场解析自项目源码**，本目录不维护第二份数据；改了 configs 点「重新载入配置」即生效。

## 第一版边界

- 只对齐**外观（out）**；内观 `inPosition` / `inScaleX/Y` / `inRotate` 未做（导出 JSON 里不含这些字段，写回脚本也不会碰它们）；
- `out: ""`（无外观素材）的装备会在列表里置灰，选中可看但拖动没有意义；
- 15 个前后缀变体共用同一份外观，对齐基础件即可，写回也只落在基础条目上。
