import { isValid, Node } from "cc";

/**
 * 引擎坑兜底：兄弟重排队列里残留**已销毁节点**（#1184）
 *
 * ## 崩溃现场
 *
 * ```
 * TypeError: Cannot read properties of null (reading 'length')
 *     at Node._updateSiblingIndex
 *     at Map.forEach            ← UITransform.priorityChangeNodeMap
 *     at UITransform._sortSiblings
 *     at Director.emit (AFTER_UPDATE)
 * ```
 *
 * ## 为什么会这样（引擎侧，3.8.7）
 *
 * `UITransform.onLoad()` / `_parentChanged()`（任何 `addChild` / 换父 / 摘除都会触发）把**父节点**
 * 塞进静态的 `priorityChangeNodeMap`，等本帧 `AFTER_UPDATE` 统一重排子节点顺序。若那个父节点
 * 在同一帧里被销毁，`_destruct` 会把它的 `_children` 置成 null，重排时
 *
 * ```js
 * priorityChangeNodeMap.forEach((node) => {
 *   UITransform._sortChildrenSibling(node);   // node.children 为 null → 有判空，跳过
 *   node._updateSiblingIndex();               // this._children.length → 💥 崩在这里
 *   node.emit("childrenSiblingOrderChanged"); // 若上一步被兜住，这里又撞 _eventProcessor 为 null
 * });
 * priorityChangeNodeMap.clear();              // 崩了就执行不到 → 之后每帧同一个节点再崩
 * ```
 *
 * 与 cocos-engine#17890（在 EditBox 事件里销毁祖先节点）是同一类问题：销毁一个正在参与
 * UI 排序的节点。我们这边能撞上的路径是「同一帧内先给节点挂子节点、再销毁该节点」
 * （进图播种怪物 / 换图清场 / 状态特效挂成怪物子节点等）。
 *
 * ## 兜底做在哪
 *
 * 只动 `Node` 的两个**公开**方法，不碰引擎私有成员（`_sortSiblings` / `priorityChangeNodeMap`
 * 在 release 构建里可能被 mangle 改名，按名字去取会静默失效 —— 兜底必须 release 也成立）：
 *
 * 1. `_updateSiblingIndex`：已销毁节点直接跳过（不再读 null 的 `_children`）；
 * 2. `emit`：已销毁节点没有监听者，直接返回（引擎重排末尾那句 `childrenSiblingOrderChanged`
 *    不会再撞到已销毁的 `_eventProcessor`）。
 *
 * 跳过时把节点名打到控制台（有上限，不刷屏），把「到底是谁被同帧销毁」留在日志里 —— 便于回去修根因。
 * 引擎修掉这个 bug 之后这一层可以删（`test-engine-guard` 守着下面几条语义：
 * 活节点照常重排 / 死节点跳过且不打断整帧 / 重复安装只换绑一次 / 打印有上限）。
 */

/** 打印上限：这是引擎 bug 的兜底日志，不该变成每帧刷屏的日志源 */
const REPORT_LIMIT = 20;

/** 已打印过的「节点 <- 父节点」组合（同一个现场只报一次） */
const reported = new Set<string>();

/** 节点的引擎内部形状（已销毁时 `_children` 被 `_destruct` 置 null） */
interface NodeInternals {
  _children: Node[] | null;
  _updateSiblingIndex: () => void;
  __siblingSortGuarded?: boolean;
  __emitGuarded?: boolean;
}

/** 把「谁被同帧销毁了」写成一句能直接定位的日志 */
function reportDestroyed(node: Node): void {
  if (reported.size >= REPORT_LIMIT) return;
  const parent = node.parent as Node | null;
  const key = `${node.name || "(未命名)"} <- ${parent ? parent.name || "(未命名)" : "(父节点已销毁)"}`;
  if (reported.has(key)) return;
  reported.add(key);
  console.warn(
    `[engine-guard] 跳过已销毁节点的兄弟重排：${key} —— 该节点在本帧被销毁前被挂过子节点（引擎 priorityChangeNodeMap 残留，见 cocos-engine#17890 同类问题）`,
  );
}

/**
 * 安装兜底（幂等：每处补丁只包一层）
 *
 * 必须在引擎跑到第一帧 AFTER_UPDATE 之前装好 —— 调用点在 Loading / Game 两个入口场景的模块顶层。
 */
export function installSiblingSortGuard(): void {
  const proto = Node.prototype as unknown as NodeInternals;

  if (!proto.__siblingSortGuarded) {
    proto.__siblingSortGuarded = true;
    const originalUpdate = proto._updateSiblingIndex;
    proto._updateSiblingIndex = function guardedUpdateSiblingIndex(this: Node): void {
      if (!(this as unknown as NodeInternals)._children) {
        reportDestroyed(this);
        return;
      }
      originalUpdate.call(this);
    };
  }

  if (!proto.__emitGuarded) {
    proto.__emitGuarded = true;
    const originalEmit = Node.prototype.emit as unknown as (this: Node, ...args: unknown[]) => void;
    Node.prototype.emit = function guardedEmit(this: Node, ...args: unknown[]): void {
      // 已销毁节点没有监听者（`_eventProcessor` 已销毁）：引擎销毁后仍可能 emit（重排收尾），吞掉
      if (!isValid(this)) return;
      originalEmit.apply(this, args);
    } as typeof Node.prototype.emit;
  }
}

/** 复位打印记录（只给单测用，运行时不调用） */
export function resetSiblingSortGuardReports(): void {
  reported.clear();
}
