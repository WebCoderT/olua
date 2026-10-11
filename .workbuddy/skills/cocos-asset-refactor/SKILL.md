---
name: cocos-asset-refactor
description: 在 Cocos Creator 3.x 项目里安全地对 assets 下脚本做文件级重构（移动/重命名/分目录、批量改引用），并规避「编辑器回写覆盖」这个高频事故。含 .ts 与 .meta 成对移动、新目录/新文件补 meta、以及 5 项自动化校验脚本。触发场景：用户提到"整理/重构某个目录"、"按语义命名"、"组件化拆分"、"移动/重命名脚本"、"改名后引用报 Cannot find module"、"改动被覆盖/丢失"、"tsc 报的行号对不上"。
agent_created: true
---

# Cocos Creator 项目文件级重构（安全版）

## 何时用

用户要求整理/重命名/分目录/组件化 `assets` 下的脚本，需要移动文件 + 批量改 import 时。**核心风险不是改代码，而是「资源 UUID 断裂」与「编辑器回写覆盖」这两件事。**

## 铁律

### 1. 移动脚本必须 `.ts` 与 `.ts.meta` 成对移动

```bash
mv old/Name.ts new/Name.ts && mv old/Name.ts.meta new/Name.ts.meta
```

`.meta` 里是资源 UUID，场景/预制体引用依赖它。只搬 `.ts` 而让编辑器重新生成 meta = UUID 变化 = 引用断裂。**不要用 `git mv` 单独搬 ts**，meta 通常被 `.gitignore` 忽略（不在版本控制里，丢了没法恢复）。

### 2. 新目录、新文件都必须补 `.meta`

目录 meta（`dir.meta`）：

```json
{ "ver": "1.2.0", "importer": "directory", "imported": true, "uuid": "<uuidgen>", "files": [], "subMetas": {}, "userData": {} }
```

TypeScript 文件 meta（`Name.ts.meta`）：

```json
{ "ver": "4.0.24", "importer": "typescript", "imported": true, "uuid": "<uuidgen>", "files": [], "subMetas": {}, "userData": {} }
```

`uuid` 用 `uuidgen | tr 'A-Z' 'a-z'`（小写）。最省事的做法是直接复制同类型现有 meta 再换 uuid。**`ver` 字段照抄项目里同类文件**（不同 Creator 版本数值不同，写错会被判为损坏）。

### 3. 顺序：先 mv 文件 → 再改文件内容与引用 → 最后统一校验

`&&` 串起来的 mv 链**一旦中途失败会中断后续全部命令**（例如某个 `.meta` 已被编辑器吃掉，报 ENOENT 后面的 mv 全部不执行）。所以：

- 每个 mv 之间要能容忍失败，或分步执行后**用 `find` 复核实际结果**，不要假设链条跑完了。
- 移动完成后先 `find <目录> -type f | sort` 确认落位，再动内容。

## ⚠️ 最大的坑：Cocos Creator 运行时会回写覆盖你的修改

编辑器打开着工程时，它会**周期性地把「上一代」内容写回磁盘**（脚本 watcher / asset-db 的缓存同步）。症状与识别：

- 文件里出现**新旧内容混合**（例如 import 还是旧的、函数调用已经是新的）。
- `tsc` 报出的错误行号与实际文件内容对不上。
- 同一批 Edit 里，**靠后的修改存活、靠前的被覆盖**（回写事件插在中间）。
- `.meta` 会被编辑器自行删除/新建（移动前还在，移动时就 ENOENT）。
- 佐证命令（macOS，`ps` 可能被沙箱拒，用 `pgrep`）：

```bash
pgrep -fl "CocosCreator"      # 输出里有 --project <你的工程路径> 就是在跑
```

应对策略（按优先级）：

1. **大批量重构前先让用户关掉编辑器**——最省事、最可靠。
2. 不关的话：每批修改后用 `sed -n 'Np' 文件` / Read **核对磁盘真实内容**，再 `sleep 8~12` 后**延时复检一次**，被覆盖的重新施加。收敛判据 = 延时复检仍与预期一致。
3. 复查到某处被覆盖时，只重做那一处（不要整批重来）。

> 曾经的事故：静态图层重建逻辑被回写丢失，导致重进场景黑屏崩溃，且反复复现。

## 批量改引用的做法

1. 先把新旧路径对照表列出来（`Grep` 找所有引用方）。
2. 旧的直接删/移后，用 `Grep` 扫旧模块名（`import ... from "../utils/OldName"`）+ 旧类名，确认引用方清单完整。
3. 逐个 `Edit` 改 import 与调用点（改名后连调用点的限定名 `XxxHelper.foo()` 也要改成裸函数名）。
4. **别忘 `assets` 之外的引用方**（如 `assets/skills/`、`assets/scripts/`、根目录脚本）。

## 收尾校验（5 项，全过才算完）

项目里通常有一个「排除 temp/library/node_modules」的临时 tsconfig（示例 `/tmp/tsconfig.check.json`）。**Cocos 工程 tsc 会有一批引擎 `.d.ts` 噪声（本项目基线 63 条：TypedArray、GPUBuffer、`__private`、computed property names、pal/audio 模块缺失等），只看 `assets/` 下的错误**。

```bash
# ① 类型检查：过滤引擎噪声
node <tsc> -p /tmp/tsconfig.check.json 2>&1 | grep "error TS" | grep "assets/"    # 期望：空

# ② 旧名/旧路径残留 + 相对 import 可解析 + meta 配齐 + UUID 唯一（见下）
```

```js
// ② 旧名残留扫描（bad 数组换成本次改掉的旧模块名/旧类名/旧函数名）
const bad = ["OldHelper", "utils/oldPath", "oldFunctionName"];
// 遍历 assets 下所有 .ts，src.includes(b) 即残留 → 期望 0 命中
```

```js
// ③ 相对 import 全部可解析（from "..." 里以 . 开头的）
const base = path.resolve(path.dirname(file), spec);
const ok = [base + ".ts", base + "/index.ts"].some((x) => fs.existsSync(x));
```

```js
// ④ 每个 .ts 有同名 .ts.meta，每个目录有 dir.meta
// ⑤ 全 assets 的 meta uuid 唯一且 JSON 合法（模板复制的 meta 最容易撞 uuid）
```

## 命名约定（本项目 olua 的落地，可迁移）

- 分层决定后缀：`ui/helpers` = UI 工厂（Helper）、`ui/core` = 静态类管理器（Manager）、`ui/utils` = **无状态纯函数（具名导出，不用 Helper/Util/Manager 后缀）**、`ui/components` = 节点组件（文件名 = 类名）。
- 文件夹名 = 类名；容器组件只做聚合与转发，具体渲染交子组件。
- 语义化重命名时优先消灭「名字乱码 / 名不符实 / 与别层撞后缀」三类，而不是为了好看乱改。
