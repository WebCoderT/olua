#!/usr/bin/env node
/**
 * 帧动画「销毁前停状态」专项（#560）
 *
 * 引擎坑（Cocos 3.8.7，官方论坛同栈确认）：
 * 带循环片段的节点被 destroy() 之后，引擎不保证把 AnimationState 从**全局** AnimationManager 摘掉 ——
 * `Animation.onDestroy` 走 `AnimationState.destroy()`，而后者只在「正在播」时才 removeAnimation；
 * 组件若没走过 onLoad（我们大量节点是运行时 addComponent 出来的）连 onDestroy 都不会走。
 * 残留状态每帧继续往已销毁的 Sprite 写 spriteFrame：
 *   `Sprite._applySpriteSize` 里 `self.node._uiProps` → TypeError: Cannot read properties of null
 * 表现为控制台一帧一条、永不停歇（打怪 / 换图这类「建了又销毁」的节点最容易命中）。
 *
 * AnimationHelper 的对策：给每个起动画的节点挂 `NODE_DESTROYED` 钩子（引擎在销毁子节点与组件
 * **之前**发这个事件），逐个 `state.stop()` 把状态摘干净；并且拒绝在「已进销毁队列」的节点上起动画。
 *
 * 这套单测用最小 cc 垫片跑**真实的 AnimationHelper**（不是复刻逻辑）：
 * 垫片里的 Animation.stop() 故意**只停 cross-fade、不动状态**（照抄引擎实现），
 * 所以「管理器里还剩几个在播的状态」就是判据 —— 谁把 guardDestroy/stopStates 删了，这里立刻红。
 *
 * 用法：node client/tools/test-animation-destroy.cjs
 * 找不到 tsc 时可用环境变量指定：TSC=/path/to/typescript/bin/tsc node client/tools/test-animation-destroy.cjs
 */
const path = require("path");
const { prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");

/**
 * cc 垫片追加部分：Node / Animation / AnimationClip / isValid
 * 语义照抄引擎（3.8.7）：
 * · Node.destroy() 先发 NODE_DESTROYED，再销毁子节点（引擎 _onPreDestroyBase 的顺序）
 * · Node 进销毁队列后 isValid(node) 仍为 true，isValid(node, true) 才是 false（ToDestroy 位）
 * · Animation.stop() 只停 cross-fade，**不**摘状态（这正是引擎的坑）
 * · AnimationState.stop() 才把自己从全局管理器里摘掉
 */
const CC_EXTRA = `
//#region 动画契约垫片（test-animation-destroy.cjs 用）
/** 全局动画管理器：真实引擎里 AnimationManager.update 每帧遍历它，残留状态就是这么炸的 */
const animationManager = { states: [] };

class SpriteFrame {
  constructor(name = "") {
    this.name = name;
  }
}

class SpriteAtlas {
  getSpriteFrames() {
    return [];
  }
}

/** 只有「动画节点的 Sprite 存在」这一点对判据有意义（引擎里它才是炸 _uiProps 的那个） */
class Sprite {}

class AnimationClip {
  constructor() {
    this.name = "";
    this.wrapMode = 0;
    this.enableTrsBlending = true;
  }

  static createWithSpriteFrames(frames, sample) {
    const clip = new AnimationClip();
    clip.frames = frames;
    clip.sample = sample;
    return clip;
  }
}
AnimationClip.WrapMode = { Normal: 1, Loop: 2 };

class AnimationState {
  constructor(animate, name) {
    this.animate = animate;
    this.name = name;
    this.isPlaying = false;
    this.isPaused = false;
    /** 被 stop 过几次（判据：钩子到底有没有调 state.stop） */
    this.stoppedAt = 0;
  }

  play() {
    this.isPlaying = true;
    if (animationManager.states.indexOf(this) < 0) animationManager.states.push(this);
  }

  stop() {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    this.stoppedAt += 1;
    const index = animationManager.states.indexOf(this);
    if (index >= 0) animationManager.states.splice(index, 1);
  }
}

class Animation {
  constructor() {
    this.node = null;
    this.clips = [];
    this._states = new Map();
    this._listeners = [];
  }

  addClip(clip, name) {
    this.clips.push(clip);
    this._states.set(name, new AnimationState(this, name));
  }

  play(name) {
    const state = this._states.get(name);
    if (state) state.play();
  }

  getState(name) {
    return this._states.get(name) || null;
  }

  /** 引擎实现：只停 cross-fade，不动状态（坑就在这里） */
  stop() {
    this._crossFaded = true;
  }

  once(type, callback, target) {
    this._listeners.push({ type, callback, target, once: true });
  }

  on(type, callback, target) {
    this._listeners.push({ type, callback, target, once: false });
  }

  emit(type) {
    const keep = [];
    for (const entry of this._listeners) {
      if (entry.type !== type) {
        keep.push(entry);
        continue;
      }
      entry.callback();
      if (!entry.once) keep.push(entry);
    }
    this._listeners = keep;
  }
}
Animation.EventType = { FINISHED: "finished" };

class Node {
  constructor(name = "") {
    this.name = name;
    this.children = [];
    this.parent = null;
    this.layer = 0;
    this._components = [];
    this._listeners = [];
    /** 销毁状态（引擎里是 _objFlags 的 Destroyed / ToDestroy 位） */
    this.destroyed = false;
    this.toDestroy = false;
    /** destroy 被调用几次（判据：重复销毁要安全） */
    this.destroyCount = 0;
  }

  addChild(child) {
    if (child.parent) child.parent.removeChild(child);
    child.parent = this;
    this.children.push(child);
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index === -1) return;
    this.children.splice(index, 1);
    child.parent = null;
  }

  addComponent(ctor) {
    const component = new ctor();
    component.node = this;
    this._components.push(component);
    return component;
  }

  getComponent(ctor) {
    return this._components.find((component) => component instanceof ctor) || null;
  }

  getComponentsInChildren(ctor, out = []) {
    for (const component of this._components) {
      if (component instanceof ctor) out.push(component);
    }
    for (const child of this.children) child.getComponentsInChildren(ctor, out);
    return out;
  }

  once(type, callback) {
    this._listeners.push({ type, callback, once: true });
  }

  on(type, callback) {
    this._listeners.push({ type, callback, once: false });
  }

  emit(type) {
    const keep = [];
    for (const entry of this._listeners) {
      if (entry.type !== type) {
        keep.push(entry);
        continue;
      }
      entry.callback();
      if (!entry.once) keep.push(entry);
    }
    this._listeners = keep;
  }

  destroy() {
    this.destroyCount += 1;
    if (this.toDestroy) return true;
    // 引擎顺序：先进销毁队列（isValid(x, true) 立刻为 false）→ 发 NODE_DESTROYED → 销毁子节点 → 销毁组件
    this.toDestroy = true;
    this.emit(Node.EventType.NODE_DESTROYED);
    for (const child of [...this.children]) child.destroy();
    this.children.length = 0;
    this.destroyed = true;
    return true;
  }
}
Node.EventType = { NODE_DESTROYED: "node-destroyed" };

function isValid(value, strictMode) {
  if (!value) return false;
  if (value.destroyed) return false;
  return !(strictMode && value.toDestroy);
}

const resources = {
  loadDir() {
    throw new Error("这套单测不该走资源加载（全部用 playLoopWithFrames 直接给帧）");
  },
};

const cc = module.exports;
cc.Node = Node;
cc.Animation = Animation;
cc.AnimationClip = AnimationClip;
cc.SpriteFrame = SpriteFrame;
cc.SpriteAtlas = SpriteAtlas;
cc.Sprite = Sprite;
cc.resources = resources;
cc.isValid = isValid;
cc.animationManager = animationManager;
//#endregion
`;

function frames(count) {
  const list = [];
  for (let index = 0; index < count; index++) list.push(new (requireSf())(`f${index}`));
  return list;
}

let SpriteFrameCtor = null;
function requireSf() {
  return SpriteFrameCtor;
}

function main() {
  let outDir;
  try {
    outDir = prepare("olua-animation-destroy", ["ui/helpers/AnimationHelper.ts"], CC_EXTRA);
  } catch (error) {
    fail(`沙箱准备失败：${error.message}`);
    return;
  }

  const cc = require(path.join(path.dirname(outDir), "node_modules/cc/index.js"));
  SpriteFrameCtor = cc.SpriteFrame;
  const AnimationHelper = require(path.join(outDir, "ui/helpers/AnimationHelper.js")).default;
  const { animationManager } = cc;

  const group = (title) => console.log(`\n【${title}】`);
  /** 新造一棵「怪物」：根节点 + 身体节点（动画挂在身体上，与 createMonsterBody 同形状） */
  const makeMonster = () => {
    const root = new cc.Node("monster");
    const body = new cc.Node("monster_animation");
    body.addComponent(cc.Sprite);
    root.addChild(body);
    return { root, body };
  };

  group("一、正常播：状态在全局管理器里");
  {
    const { body } = makeMonster();
    AnimationHelper.playLoopWithFrames("stand", body, frames(4), 10);
    check(animationManager.states.length === 1, "循环动画已进全局管理器", `states=${animationManager.states.length}`);
    check(animationManager.states[0].isPlaying === true, "状态处于播放中");
  }

  group("二、销毁节点：状态必须被摘干净（这是本套单测的判据）");
  {
    animationManager.states.length = 0;
    const { root, body } = makeMonster();
    AnimationHelper.playLoopWithFrames("stand", body, frames(4), 10);
    root.destroy();
    check(animationManager.states.length === 0, "销毁后全局管理器里没有残留状态（引擎自己摘不干净，靠钩子）", `states=${animationManager.states.length}`);
    check(root.destroyed === true, "节点已销毁");
  }

  group("三、销毁父节点：子节点上的动画同样被停");
  {
    animationManager.states.length = 0;
    const { root, body } = makeMonster();
    AnimationHelper.playLoopWithFrames("stand", body, frames(4), 10);
    AnimationHelper.playLoopWithFrames("attack", body, frames(3), 10);
    check(animationManager.states.length === 2, "两条状态都在管理器里", `states=${animationManager.states.length}`);
    root.destroy();
    check(animationManager.states.length === 0, "父节点销毁 → 子节点两条状态全停");
  }

  group("四、已进销毁队列的节点：不再起新动画（否则状态起完就没人停）");
  {
    animationManager.states.length = 0;
    const { root, body } = makeMonster();
    // destroy() 与异步回调同帧：此刻 isValid(node) 仍是 true，只有严格模式能拦住
    body.toDestroy = true;
    AnimationHelper.playLoopWithFrames("stand", body, frames(4), 10);
    check(animationManager.states.length === 0, "销毁队列里的节点不会再挂状态");
    check(cc.isValid(body) === true && cc.isValid(body, true) === false, "垫片与引擎同口径：严格模式才看得见 ToDestroy");
    root.toDestroy = true;
  }

  group("五、幂等与复用：重复播放不重复挂钩子、重复销毁安全");
  {
    animationManager.states.length = 0;
    const { root, body } = makeMonster();
    AnimationHelper.playLoopWithFrames("stand", body, frames(4), 10);
    AnimationHelper.playLoopWithFrames("walk", body, frames(4), 10);
    const hooks = body._listeners.filter((entry) => entry.type === cc.Node.EventType.NODE_DESTROYED);
    check(hooks.length === 1, "同一节点只挂一个销毁钩子", `hooks=${hooks.length}`);
    root.destroy();
    root.destroy();
    check(animationManager.states.length === 0, "重复销毁后依然没有残留状态");
    check(root.destroyCount === 2 && root.destroyed === true, "重复 destroy 不炸");
  }

  group("六、一次性动画：播完自行销毁节点（FINISHED → destroy）");
  {
    animationManager.states.length = 0;
    const node = new cc.Node("effect");
    node.addComponent(cc.Sprite);
    AnimationHelper.playOnceWithFrames("boom", node, frames(3), 0.3);
    const animate = node.getComponent(cc.Animation);
    check(animationManager.states.length === 1, "一次性动画也已进管理器");
    animate.emit(cc.Animation.EventType.FINISHED);
    check(node.destroyed === true, "FINISHED 后节点被销毁");
    check(animationManager.states.length === 0, "销毁后状态同样被摘干净");
  }

  finish("PASS：帧动画的销毁清理（钩子挂载、状态摘除、严格存活判断、一次性播放后销毁）全部通过。");
}

main();
