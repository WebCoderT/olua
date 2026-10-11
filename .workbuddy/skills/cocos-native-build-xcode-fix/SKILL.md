---
name: cocos-native-build-xcode-fix
description: 排查并修复 Cocos Creator 3.x 原生（macOS/iOS）打包在 Xcode 命令行阶段的失败，尤其是新版本 Xcode（16/26/27+）下报 "run cmake failed"、"Run build stage[make] failed"、"No CMAKE_CXX_COMPILER could be found"、"deployment target 不在支持范围"、make 阶段找不到 .xcodeproj 等。触发场景：用户在 Cocos Creator 里构建/打包原生平台（mac、iOS）时报错，或提到 native-pack-tool、cfg.cmake、TARGET_OSX_VERSION、olua.xcodeproj、xcodebuild 失败。
agent_created: true
---

# Cocos Creator 原生构建（Xcode 阶段）失败排查

## 用途

Cocos Creator 的原生打包链路是：`Cocos 构建面板` → `native-pack-tool`（Node 脚本）→ 写 `cfg.cmake` → 跑 `cmake -GXcode` → 跑 `xcodebuild`。

本地报错信息往往只有一句「run cmake failed」或「Run build stage[make] failed」，**不带真实原因**。
本技能给出把真实原因挖出来的固定顺序，以及新 Xcode 下的高频根因与修法。

## 核心原则：不要相信表面报错，也不要相信用户的环境判断

- 「cmake 没装」几乎从不是原因。Cocos **自带** cmake，路径为
  `<CocosCreator.app>/Contents/Resources/tools/cmake/bin/cmake`（3.8.7 自带 3.24.3）。
  验证方法：看 `build/<平台>/proj/CMakeCache.txt` 里的 `CMAKE_COMMAND`。
- 用户说「我在命令行 cmake/make 都能跑」时，说明问题在 Cocos 的调用参数或其依赖的 Xcode 状态，不在 cmake 本身。

## 排查顺序（照做，不要跳）

### 第 1 步：原样复现 cmake，拿真实报错

从报错文本里抄出完整命令（Cocos 会把命令打在错误信息里），用**自带 cmake** 跑一遍：

```bash
CM=<CocosCreator.app>/Contents/Resources/tools/cmake/bin/cmake
"$CM" -S "<项目>/native/engine/mac" -GXcode -T buildsystem=12 \
  -B"<项目>/build/mac/proj" -DCMAKE_SYSTEM_NAME=Darwin \
  -DRES_DIR="<项目>/build/mac" -DAPP_NAME="<名字>" -DLAUNCH_TYPE="Release" \
  -DCMAKE_SUPPRESS_REGENERATION=ON
```

看是否报 `No CMAKE_CXX_COMPILER could be found`。

### 第 2 步：看 cmake 自己的错误日志，不要只看 stdout

```bash
grep -A40 "Compiling the CXX compiler identification" <builddir>/CMakeFiles/CMakeError.log
```

CMake 用 **Xcode 生成器**时，探测编译器的方式是「生成临时 Xcode 工程 → 调 `xcodebuild` 编译 `CMakeCXXCompilerId.cpp`」。
所以 **`xcodebuild` 挂了，cmake 就报「找不到编译器」**。日志里会露出真正的 `xcodebuild` 报错。

### 第 3 步：检查 Xcode 首次启动是否完成

```bash
xcodebuild -checkFirstLaunchStatus; echo "exit=$?"     # 0 才是正常
ls -d /Library/Developer/PrivateFrameworks/CoreSimulator.framework
```

若 `checkFirstLaunchStatus` 非 0、或 `CoreSimulator.framework` 不存在，则 `xcodebuild` 会因加载
`IDESimulatorFoundation` 插件失败而**直接退出**，日志形如：

```
Failed to load code for plug-in com.apple.dt.IDESimulatorFoundation
Reason: Library not loaded: /Library/Developer/PrivateFrameworks/CoreSimulator.framework/.../CoreSimulator
A required plugin failed to load. ... try running 'xcodebuild -runFirstLaunch'
```

**修法**：`sudo xcodebuild -runFirstLaunch`，然后重跑第 1 步确认能 `Configuring done / Generating done`。

## make 阶段「找不到 .xcodeproj」的根因

`native-pack-tool/source/platforms/mac-os.ts:85-87`：

```js
const projs = fs.readdirSync(nativePrjDir).filter((x) => x.endsWith('.xcodeproj'));
if (projs.length === 0) throw new Error(`can not find xcode project file in ${nativePrjDir}`);
```

所以 `Run build stage[make] failed` 常常只是**上一次 cmake 失败留下的后遗症**：
`build/<平台>/proj/` 里有了 `CMakeCache.txt` + `CMakeFiles/`，但没有 `.xcodeproj`。

处理：让工程重新生成（见下方「强制重新生成」）。

## 高频根因 2：部署目标超出 Xcode 支持范围

Xcode 27 的 macOS 支持范围是 `12.0 ~ 27.0.x`。工程若还是 `10.14`，xcodebuild 逐 target 报：

```
error: The macOS deployment target 'MACOSX_DEPLOYMENT_TARGET' is set to 10.14,
but the range of supported deployment target versions is 12.0 to 27.0.x.
```

### 值的完整链路（要改最上游）

```
<项目>/profiles/v2/packages/mac.json 的 "targetVersion"
        ↓  app.asar 内映射（不在引擎脚本里，需按字节搜 app.asar）
i.cMakeConfig.TARGET_OSX_VERSION = `set(TARGET_OSX_VERSION ${mac.targetVersion || "10.14"})`
        ↓  native-pack-tool/source/base/default.ts:445 generateCMakeConfig()
<项目>/build/mac/proj/cfg.cmake     →  set(TARGET_OSX_VERSION <值>)
        ↓  native/engine/mac/CMakeLists.txt  set(CMAKE_OSX_DEPLOYMENT_TARGET ${TARGET_OSX_VERSION})
<项目>/build/mac/proj/olua.xcodeproj/project.pbxproj → MACOSX_DEPLOYMENT_TARGET = <值>
```

**关键坑**：`mac.targetVersion || "10.14"` —— **空值会回落成 10.14**。
所以 `targetVersion` 是空字符串时，等价于 10.14，一样会失败。

**修法**：把 `<项目>/profiles/v2/packages/mac.json` 里所有 `"targetVersion"` 改成 `"12.0"`（或更高）。
构建面板里该项是**自由文本输入**（提示文案 `Default: 10.14`），不是下拉框，所以填任意合法版本号都可以。
改完校验 JSON 合法性，并确认 `"options"` 与 `"builder.taskOptionsMap"` **两处都改了**（前者容易漏）。

## 强制重新生成工程（改完配置必做）

`native-pack-tool/source/platforms/mac-os.ts:33-39` `shouldSkipGenerate()`：

```js
if (options.skipUpdateXcodeProject && fs.existsSync(ps.join(nativePrjDir, 'CMakeCache.txt'))) {
    console.log('Skip xcode project update');
    return true;   // 连 cmake 都不跑
}
```

**只要 `skipUpdateXcodeProject=true` 且 `proj/CMakeCache.txt` 存在，cmake 完全不重跑，
cfg.cmake / targetVersion 的任何改动都不会生效。** 这是最容易白忙一场的地方。

强制重新生成的三选一：

1. 移走整个 `build/<平台>/proj` 目录（推荐，最干净）：
   `mv build/mac/proj build/mac/proj.bak-$(date +%s)`
2. 只删 `proj/CMakeCache.txt`
3. 在构建面板取消勾选「跳过更新 Xcode 工程」

> 注意：移走 `proj` 后**不要**立刻手动跑 cmake 验证 —— `native/engine/common/CMakeLists.txt` 第 38 行是
> `include(${RES_DIR}/proj/cfg.cmake)`，而 `cfg.cmake` 是 **Cocos 在 cmake 之前生成的**（`default.ts:447`）。
> 手工移走 proj 后直接跑 cmake 会报 `COCOS_X_PATH is not set!`，这是缺 cfg.cmake 的假象，不是真故障。
> 要么把旧 `cfg.cmake` 拷回来（只改 `TARGET_OSX_VERSION` 那一行），要么直接让 Cocos 重新构建。

## 验证修复是否生效（不依赖完整编译）

xcodebuild 的完整构建可能因权限/沙箱跑不通，但**配置级验证足够证明该报错已消除**：

```bash
grep -c "MACOSX_DEPLOYMENT_TARGET = 10.14;" <proj>/olua.xcodeproj/project.pbxproj   # 应为 0
grep -c "MACOSX_DEPLOYMENT_TARGET = 12.0;"  <proj>/olua.xcodeproj/project.pbxproj   # 应为 target 数（通常 4）
cd <proj> && xcodebuild -project olua.xcodeproj -configuration Release -showBuildSettings \
  | grep -E "^ *(MACOSX_DEPLOYMENT_TARGET|SDKROOT|ARCHS) "
```

`-showBuildSettings` 能跑通且 `MACOSX_DEPLOYMENT_TARGET` 落在 `SDKROOT` 支持范围内，即配置正确。

## 常用定位路径速查

| 内容 | 路径 |
|---|---|
| Cocos 自带 cmake | `<CocosCreator.app>/Contents/Resources/tools/cmake/bin/cmake` |
| 原生打包脚本 | `<CocosCreator.app>/Contents/Resources/resources/3d/engine/scripts/native-pack-tool/source/` |
| mac 平台逻辑 | 上述目录 `platforms/mac-os.ts`、`platforms/mac.ts` |
| cfg.cmake 生成 | 上述目录 `base/default.ts:445 generateCMakeConfig()` |
| 构建面板字段/文案 | `<CocosCreator.app>/Contents/Resources/app.asar` |
| 构建配置（持久化） | `<项目>/profiles/v2/packages/<平台>.json` |
| 引擎模板 | `<项目>/native/engine/{common,mac}/`，用户覆盖点 `native/engine/common/localCfg.cmake` |

## 从 app.asar 里挖构建配置字段

`app.asar` 有几百 MB，`grep -a -o` 常常挖不到。用 Python 按字节搜更可靠：

```python
import re
p = "<CocosCreator.app>/Contents/Resources/app.asar"
data = open(p, 'rb').read()
for m in re.finditer(rb'targetVersion', data):
    s, e = max(0, m.start() - 300), min(len(data), m.end() + 600)
    print(data[s:e].decode('utf-8', 'replace'))
```

同样方法可用来确认某字段的**默认值、校验规则、提示文案**（例如 mac 的 `targetVersionDefault: "Default: 10.14"`）。

## 已确认的环境基线

- Cocos Creator 3.8.7 自带 cmake **3.24.3**；`mac.json` 的 `targetVersion` 默认 **10.14**（已过时）。
- `cmake -T buildsystem=12`（legacy build system）在新 Xcode 下不报错，可保留。
- Xcode 27（SDK 27.0）支持部署目标下限 **12.0**。
- `native/engine/common/localCfg.cmake` 是引擎预留的用户覆盖入口（`common/CMakeLists.txt:42` include），
  但它在 `native/engine/mac/CMakeLists.txt:8` 设置 `CMAKE_OSX_DEPLOYMENT_TARGET` **之后**才被 include，
  因此不适合用来改部署目标。
