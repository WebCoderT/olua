---
name: cocos-node-sandbox-test
description: 在 node 里跑 Cocos Creator 3.x 项目的**核心代码**（管理器 / 存储层 / 战斗结算这类 import 了 UI 与引擎的类）做单测的成套做法：把真实文件复制到沙箱、只把指向 UI 层的 import 改写成 stub、用最小 `cc` 垫片（含内存版 `sys.localStorage`）顶替引擎，于是能对**真实的 StorageManager 之类的类**跑断言而不是复刻一份逻辑。含 tsc 的 files 入口技巧、paths 不支持相对说明符的绕法、stub 签名用 any 消噪、直接读垫片内存核对存档、以及对「按钮建了没绑事件」这类 UI 接线做源码正则断言。触发场景：用户说"给 XX 写单测/加验证"、"破坏性操作要有自动化验证"、"核心逻辑没法测因为它 import 了 UI"、"存档/数据层要回归测试"、"删角色/回收/穿戴/扣物品要验证"、"测试要跑真实代码不要复刻"。
agent_created: true
---

# 在 node 沙箱里跑 Cocos 核心代码做单测

适用场景：想给 `StorageManager`（存档读写）、`SkillManager`（伤害/冷却）、`DropManager` 这类**核心类**写单测，
但它们直接 `import` 了 UI 层（`GameUiHelper` / `LayerManager` / `RoleUIManager`）与 `cc` 的界面类
（`Node` / `Sprite` / `Label`）—— 在 node 里 require 就炸。

判据（哪些逻辑值得这么折腾）：**改错了会静默破坏玩家数据**。删存档、扣物品、结算货币、发奖励都属于
"跑一次就不敢重来"的操作，正是最该有自动化证据的地方。

目标 = 在 node 里 require **真实的那个类**（不是复刻实现），用内存版存储跑断言。

## 一、三步做法

### 1. 复制：入口类 + 它真正需要的部分

把入口类、`entities/`、`configs/`、`types/`、少数纯函数 `utils/` 复制到 `os.tmpdir()/<name>/src/`，
**保持原来的相对目录结构**（后面要靠相对路径解析）。

`configs/` 整目录复制没关系 —— tsc 的 `files` 只列了入口，
**只有顺着 import 走到的文件才会被编译**，同目录下的无关文件（尤其是历史上 `import` 了 UI 的配置）
不会参与编译，不会把界面层拖进来。

### 2. 改写：把指向 UI 的 import 换成 stub

```js
/** 入口类里指向 UI / 环依赖的 import → 沙箱内 stub 模块 */
const STUB_IMPORTS = {
  "./RoleUIManager": "../../stubs/RoleUIManager",
  "../helpers/GameUiHelper": "../../stubs/GameUiHelper",
  // configs/skill 会 import skills/* → ui/core/*（配置反向依赖 UI 的历史遗留），必须顶掉
  "../../configs/skill": "../../stubs/configs-skill",
};
source = source.split(`from "${specifier}"`).join(`from "${replacement}"`);
```

**关键坑：不要试图用 tsconfig 的 `paths` 做这件事。** `paths` 只匹配**非相对**说明符
（对 `"cc"` 这种包名有效），`"./GameHelper"`、`"../helpers/GameUiHelper"` 这类相对路径**命中不了**。
字符串替换是最省事且可控的做法，而且"哪些依赖被 stub 掉"一眼可查（配一张表，加一条 = 让更多真代码进沙箱）。

### 3. 垫片：手写最小 `cc`（按需要的层递进）

- **配置层**只需 `Vec2` / `Vec3` / `Size` / `Color`（纯数据构造，无行为）
- **存储层**再加 `sys.localStorage`（Map 内存实现）
- **把内部 Map 一起导出**：`module.exports = { ..., __memory: memory }`
  —— 测试才能直接核对"存档里到底写了什么"

垫片放在沙箱的 `node_modules/cc/`（配合 `package.json` 的 `main`），运行期 require 自然命中。

## 二、tsc / 沙箱的五个事实

1. **编译报错不一定致命**：stub 与真实模块签名有差异必然报几条 `TS2339`（如 `reason.key` 不存在于 `unknown`）。
   处理：stub 的返回类型直接写 `any` 消噪；同时把 `error TS\d+` 的行数打印出来（**别静默跑空**）；
   判据用「产物文件是否存在」而不是「退出码是否为 0」（配 `noEmitOnError: false`）。
2. **default export 取法**：`const X = require(file).default ?? require(file)`，编译目标设 `esModuleInterop: true`。
3. **写死结构数字前先核对配置**：例如"装备槽有 9 个"实际是 13 个 —— 断言失败先怀疑自己的假设，
   查一眼 `types/good.EQUIPMENT_TYPE` 再改，别顺手把断言放宽。
4. **被测代码若用时间戳生成 id，同毫秒会撞**（`new Date().getTime()`）：测试里显式赋 id，
   否则多个测试对象互相干扰，失败现场极难读。
5. **CommonJS 模块里顶层 `return` 是合法的**：沙箱准备失败时可以直接 `return`（配合 `process.exitCode = 1`），
   不必把整段断言包进 `try`。

## 三、断言怎么写（两条经验）

1. **存档断言看"存档本身"**，不从业务接口倒推。
   例：想验证"删掉选中角色后 `selectedRole` 被清空"，用 `findOnlineRole() === undefined` **不够** ——
   它同时也会因为"注册表为空""id 不匹配"而返回 undefined，区分不出是哪种。
   直接读垫片内存里的 `selectedRole` 才能断言到点子上。
2. **UI 接线用源码正则单独断言**。数据层测不到这三类 bug，而它们恰是这类功能最常翻车的地方：
   - 按钮**建了没绑事件**（`createTexturedButton(...)` 后忘了 `.on(TOUCH_END, ...)`）
   - 节点**挂错父节点**导致事件被吞（子节点挂在自带 `TOUCH_END` 的节点下 → 点击冒泡成父节点的行为）
   - 定时器/监听**没清理**（`onDestroy` 里漏了复位）

   ```js
   check(/manageRoleButton\.on\(Node\.EventType\.TOUCH_END, \(\) => this\.toggleManageRole\(\)\)/.test(src),
     "「管理」按钮已绑定 toggleManageRole");
   ```

   这类断言很"廉价"，但正好锁住了"功能明明写了却不生效"的回归。

## 四、与 configs-sandbox 的分工

| 沙箱 | 编什么 | 需要 stub 吗 |
|---|---|---|
| `configs-sandbox.cjs` | 只编**配置表**（纯数据） | 不需要 |
| `storage-sandbox.cjs` | 编**核心类**（含 UI 依赖） | 需要 stub 表 |

两者共用 `findTsc`（环境变量 `TSC` → 工程 `node_modules` → Cocos 自带）与
`check` / `finish` / `fail` 三个断言小工具（`finish` 统一打印总结并置退出码）。

## 五、本项目落地位置

- 沙箱：`tools/lib/configs-sandbox.cjs`、`tools/lib/storage-sandbox.cjs`
- 用例：`tools/test-bag-tidy.cjs`（22 项）、`tools/test-bag-recycle.cjs`（26 项）、`tools/test-role-delete.cjs`（31 项）
- 配套验收组合：`tsc`（0 新错）→ `node tools/audit-config-leak.cjs`（配置外泄 + 文案 key 覆盖）→
  `node tools/audit-ui-click-through.cjs`（点击穿透/按压归属）→ 上面这些单测 → `sleep 25s` 回写复检

### 共享的沙箱长什么样（storage 版骨架）

```js
function prepareStorage(sandboxName) {
  fs.rmSync(sandbox, { recursive: true, force: true });
  // 1) cc 垫片（含 sys.localStorage + 导出的 __memory）
  // 2) stub 表逐个写入 src/stubs/
  // 3) copyDir(configs/types) + copy(Role.ts / MpHelper.ts) + copy(StorageManager.ts, 改写 import)
  // 4) tsconfig：rootDir=src、outDir=out、files=[入口]、paths 只映射 "cc" → 工程声明
  spawnSync(process.execPath, [tscPath, "-p", tsconfigPath]);
  // 5) 产物存在即视为成功；返回 { StorageManager, Role, outDir, shim }
}
```

## 六、相关

- 配置表单测（不需要 stub 的那种）：skill `cocos-bag-tidy`
- 配置与代码的边界、双向审计（含"配置反向依赖 UI"这个必须检查的方向）：skill `cocos-ui-layout-config`
- 动态视图的销毁判据（测试里若涉及节点生命周期会用到）：skill `cocos-view-lifecycle`
