#!/usr/bin/env node
/**
 * 怪物动作锁专项（#1240）
 *
 * 背景：怪物普攻/施法动作由服务端事件驱动（`playServerAction`），而 `stepServer` 的站定分支
 * **每帧**都会把动作切回待机 —— 没有动作锁时，攻击起播后下一帧就被 `crossFade(stand)` 打断，
 * 实际只能看到约 0.2 秒的半截混合（用户实测「怪物没播攻击动画」的第二层根因；
 * 第一层是素材包没有攻击帧，见 configs/animation.ts 的 monsterActionSpecs 注释）。
 *
 * 这套单测用最小 cc 垫片跑**真实的 MonsterAI**（同 test-animation-destroy 的做法）：
 * · 攻击片段存在 → 上锁，站定多帧不被覆盖；FINISHED 解锁切回待机；超时兜底解锁；移动立即解锁
 * · 攻击片段缺失（怪物包现状）→ 回退待机、不上锁 —— 与缺帧现状观感一致
 *
 * 用法：node client/tools/test-monster-action-lock.cjs
 */
const fs = require("fs");
const path = require("path");
const { prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");

/**
 * cc 垫片追加部分：Node.getChildByName / Animation.crossFade / RigidBody2D
 * 语义照抄引擎（3.8.7）：
 * · crossFade(name, dur) 记录调用并让目标状态进入播放（本测试只看「切了哪个动作」）
 * · AnimationState.duration = 片段时长（秒），锁的到期时刻按它 + 边距折算
 * · FINISHED 事件不会自动发：replayCurrent 由 MonsterManager 的监听触发，测试里直接调
 */
const CC_EXTRA = `
//#region 动作契约垫片（test-monster-action-lock.cjs 用）
/** 引擎里 crossFade 的调用会被这里记下来，判据就是「切了哪个动作、什么时候切的」 */
const crossFadeCalls = [];

class AnimationState2 {
  constructor(animate, name, duration) {
    this.animate = animate;
    this.name = name;
    this.duration = duration;
    this.isPlaying = false;
  }

  play() {
    this.isPlaying = true;
  }
}

class Animation2 {
  constructor() {
    this._states = new Map();
    this.node = null;
  }

  addState(name, duration) {
    this._states.set(name, new AnimationState2(this, name, duration));
  }

  getState(name) {
    return this._states.get(name) || null;
  }

  crossFade(name, duration) {
    crossFadeCalls.push({ name, duration, at: Date.now() });
    const state = this._states.get(name);
    if (state) state.play();
  }

  play(name) {
    const state = this._states.get(name);
    if (state) state.play();
  }
}
Animation2.EventType = { FINISHED: "finished" };

class RigidBody2D {}

class Node {
  constructor(name = "") {
    this.name = name;
    this.children = [];
    this._components = [];
    this.destroyed = false;
    this.toDestroy = false;
  }

  addChild(child) {
    child.parent = this;
    this.children.push(child);
  }

  /** 测试里世界坐标 = 本地坐标（没有层级变换） */
  getWorldPosition(out = new Vec3()) {
    out.x = this._wx ?? 0;
    out.y = this._wy ?? 0;
    out.z = this._wz ?? 0;
    return out;
  }

  setWorldPosition(x, y, z) {
    this._wx = x;
    this._wy = y;
    this._wz = z;
  }

  /** MonsterAI.getAnimate 走这里找 monster_animation 节点 */
  getChildByName(name) {
    return this.children.find((child) => child.name === name) || null;
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
}

function isValid(value, strictMode) {
  if (!value) return false;
  if (value.destroyed) return false;
  return !(strictMode && value.toDestroy);
}

const cc = module.exports;
cc.Node = Node;
cc.Animation = Animation2;
cc.RigidBody2D = RigidBody2D;
cc.isValid = isValid;
cc.crossFadeCalls = crossFadeCalls;
//#endregion
`;

/** 动作片段表（垫片 Animation 里的状态名 → 时长秒）：与 MonsterAI 的 getAnimationName 同口径 */
const CLIPS = {
  stand_down: 1,
  stand_right: 1,
  walk_down: 1,
  walk_right: 1,
  attack_near_down: 0.5,
  attack_skill_1_down: 0.8,
  die_down: 1.2,
};

let MonsterAI = null;
let cc = null;
/** 全局假时钟（模块级：快照工具函数也要读它） */
let fakeNow = 0;

/** 新造一只怪：根节点 + monster_animation 身体节点（与 createMonsterBody 同形状） */
function makeMonster() {
  const root = new cc.Node("monster");
  const body = new cc.Node("monster_animation");
  const animate = body.addComponent(cc.Animation);
  for (const [name, duration] of Object.entries(CLIPS)) animate.addState(name, duration);
  root.addChild(body);
  return root;
}

/** 造一份能过 hp 检查的怪物数据（stepServer 只读 hp） */
function makeMonsterData() {
  return { hp: 100 };
}

/** 站定快照：两条同位置、moving=false，渲染时刻夹在中间 */
function pushStationary(node, serverNow) {
  MonsterAI.applyServerState(node, 100, 100, false, serverNow - 300);
  MonsterAI.applyServerState(node, 100, 100, false, serverNow - 50);
}

/** 行走快照：位置在推进、moving=true（时间戳必须单调递增，插值器按时间回放）。
 * 渲染时刻滞后 120ms，所以「移动段」必须盖住 fakeNow-120 这个点：
 * 首次推两条盖住 [fakeNow-250, fakeNow-100]，之后每 tick 推一条接续 */
let movingX = 100;
function pushMovingFirst(node) {
  movingX = 100;
  // 先把时钟推过站定段：渲染时刻（fakeNow-120）要落进移动段，且快照时间戳单调递增
  fakeNow += 250;
  MonsterAI.applyServerState(node, movingX, 100, true, fakeNow - 250);
  MonsterAI.applyServerState(node, 130, 100, true, fakeNow - 100);
}
function pushMovingMore(node) {
  movingX += 30;
  MonsterAI.applyServerState(node, movingX, 100, true, fakeNow - 100);
}

function crossFades() {
  return cc.crossFadeCalls.map((entry) => entry.name);
}

function main() {
  let outDir;
  try {
    outDir = prepare("olua-monster-action-lock", ["ui/core/MonsterAI.ts"], CC_EXTRA);
  } catch (error) {
    fail(`沙箱准备失败：${error.message}`);
    return;
  }
  cc = require(path.join(path.dirname(outDir), "node_modules/cc/index.js"));
  MonsterAI = require(path.join(outDir, "ui/core/MonsterAI.js")).default;

  const realNow = Date.now;
  // 把全局时钟拨到 fakeNow（MonsterAI / ServerClock 都走 Date.now()，同一进程内生效）
  fakeNow = realNow();
  Date.now = () => fakeNow;
  const advance = (ms) => {
    fakeNow += ms;
  };

  const group = (title) => console.log(`\n【${title}】`);

  // ServerClock.offset = 0：帧里的 t 直接用本地时刻口径构造
  const serverNow = () => fakeNow;

  group("一、普攻命中：非循环动作上锁，站定多帧不被覆盖回待机");
  let lockWindowMs = 0;
  {
    const node = makeMonster();
    pushStationary(node, serverNow());
    MonsterAI.tick(new Map([[node, makeMonsterData()]]));
    check(crossFades().length === 0, "站定首帧不切动画（已是待机）", crossFades().join(","));

    MonsterAI.playServerAction(node, "attack_near");
    check(crossFades().join(",") === "attack_near_down", "攻击动作起播（attack_near_down）", crossFades().join(","));

    crossFadeCallsReset();
    advance(50);
    MonsterAI.tick(new Map([[node, makeMonsterData()]]));
    MonsterAI.tick(new Map([[node, makeMonsterData()]]));
    check(crossFades().length === 0, "锁住期间站定帧不把攻击覆盖回待机", crossFades().join(","));

    // 锁窗口 = 片段时长 0.5s + 边距 1s = 1500ms：窗口内不放行，过窗口后由超时兜底解锁
    lockWindowMs = 1500;
    advance(lockWindowMs - 100);
    MonsterAI.tick(new Map([[node, makeMonsterData()]]));
    check(crossFades().length === 0, "锁窗口尾段仍未被覆盖", crossFades().join(","));
  }

  group("二、超时兜底：FINISHED 丢失也会解锁切回待机（不会永久卡在攻击态）");
  {
    const node = makeMonster();
    pushStationary(node, serverNow());
    MonsterAI.playServerAction(node, "attack_near");
    crossFadeCallsReset();
    advance(1500 + 50);
    MonsterAI.tick(new Map([[node, makeMonsterData()]]));
    check(crossFades().join(",") === "stand_down", "锁过期后站定帧切回待机", crossFades().join(","));
  }

  group("三、动画 FINISHED：解锁并切回待机（一次性动作不循环重播）");
  {
    const node = makeMonster();
    pushStationary(node, serverNow());
    MonsterAI.playServerAction(node, "attack_skill_1");
    crossFadeCallsReset();
    MonsterAI.replayCurrent(node); // MonsterManager 在 FINISHED 里做的事
    check(crossFades().length === 0 && playedStand(node), "FINISHED 后直接 play 待机（不 crossFade 也不再重播攻击）", crossFades().join(","));
    advance(50);
    MonsterAI.tick(new Map([[node, makeMonsterData()]]));
    check(crossFades().length === 0, "解锁后站定帧保持待机不再切换", crossFades().join(","));
  }

  group("四、服务端说在移动：立即解锁，走路段不被锁拖住");
  {
    const node = makeMonster();
    pushStationary(node, serverNow());
    MonsterAI.playServerAction(node, "attack_near");
    crossFadeCallsReset();
    pushMovingFirst(node); // x 100 → 130：位移朝右
    MonsterAI.tick(new Map([[node, makeMonsterData()]]));
    check(crossFades().join(",") === "walk_right", "移动帧立刻切走路（锁不拦移动）", crossFades().join(","));
    crossFadeCallsReset();
    advance(50);
    pushMovingMore(node);
    MonsterAI.tick(new Map([[node, makeMonsterData()]]));
    check(crossFades().length === 0, "持续移动不再重复切换", crossFades().join(","));
  }

  group("五、片段缺失（怪物包现状）：回退待机、不上锁 —— 与缺帧观感一致");
  {
    crossFadeCallsReset();
    const node = makeMonster();
    pushStationary(node, serverNow());
    MonsterAI.playServerAction(node, "attack_far"); // 素材包没有 attack_far 帧
    check(!crossFades().includes("attack_far_down"), "缺帧动作不进 crossFade（回退待机）", crossFades().join(","));
    advance(50);
    MonsterAI.tick(new Map([[node, makeMonsterData()]]));
    check(crossFades().length === 0, "缺帧回退后没有锁残留（站定帧照常接管）", crossFades().join(","));

    // 反证法口径：给一个缺帧动作、但此刻正处于攻击锁内 —— 旧锁必须被清掉
    // （循环片段没有 FINISHED，靠超时解锁太慢）。回退本身会 crossFade 切回待机：
    const node2 = makeMonster();
    pushStationary(node2, serverNow());
    MonsterAI.playServerAction(node2, "attack_near");
    crossFadeCallsReset();
    advance(50);
    MonsterAI.playServerAction(node2, "attack_far");
    check(crossFades().join(",") === "stand_down", "锁内给缺帧动作：回退待机并把旧锁清掉", crossFades().join(","));
    crossFadeCallsReset();
    advance(50);
    MonsterAI.tick(new Map([[node2, makeMonsterData()]]));
    check(crossFades().length === 0, "回退后站定帧保持待机、无锁残留", crossFades().join(","));
  }

  group("六、接线守点（源码断言，改实现必须保留这四件事）");
  {
    const source = fs.readFileSync(path.join(__dirname, "../assets/ui/core/MonsterAI.ts"), "utf8");
    const hit = (re) => {
      const match = source.match(re);
      return match ? match[0] : "";
    };
    check(
      hit(/LOOP_ACTIONS\.indexOf\(resolved\) < 0/) !== "",
      "锁只给非循环动作（循环片段没有 FINISHED，锁上去只能等超时）",
    );
    check(hit(/Date\.now\(\) < state\.lockExpireAt/) !== "", "stepServer 站定分支有锁窗口判断（超时兜底放行）");
    check(hit(/actionFinishTimeoutMarginSeconds/) !== "", "锁边距取 configs/animation 的常量（不写裸阈值）");
    check(
      (source.match(/state\.locked = false/g) || []).length >= 3,
      "三条解锁路径齐全：移动解锁 / 超时解锁 / FINISHED 解锁（含缺帧清锁）",
      String((source.match(/state\.locked = false/g) || []).length),
    );
  }

  group("七、普攻动作选择守点（#1249：普攻命中播怪物专用 attack 段）");
  {
    const mmSource = fs.readFileSync(path.join(__dirname, "../assets/ui/core/MonsterManager.ts"), "utf8");
    /**
     * 按大括号配对切方法体（不按缩进）；只认**声明形态**（`名字(参数) [: 返回类型] {`），
     * 跳过 `this.xxx(...)` 这类调用点 —— 方法名找不到声明返回空串（空串一律判失败）。
     */
    const methodBody = (src, methodName) => {
      const decl = new RegExp(methodName + "\\s*\\([^)]*\\)\\s*(?::\\s*[^{]+)?\\{");
      const match = src.match(decl);
      if (!match) return "";
      const open = match.index + match[0].length - 1;
      let depth = 0;
      for (let i = open; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") {
          depth--;
          if (depth === 0) return src.slice(open, i + 1);
        }
      }
      return "";
    };
    const attackBody = methodBody(mmSource, "playServerAttack");
    check(attackBody !== "", "反证法：playServerAttack 方法名写错必须拿到空串", attackBody.length ? "方法体已切出" : "空串");
    check(
      /playServerAction\(node,\s*ACTION\.ATTACK\)/.test(attackBody),
      "普攻命中播怪物专用 attack 段（素材包只有 stand/walk/attack/injured/die）",
    );
    check(
      attackBody.indexOf("ATTACK_NEAR") < 0,
      "普攻不再写死角色专用 attack_near（怪物素材包没有这段，播它会静默回退待机）",
    );
    // #1251：怪物攻击不区分远近动画，施法同样统一播 attack，不再读技能配置的 action 键
    const castBody = methodBody(mmSource, "playServerCast");
    check(castBody !== "", "反证法：playServerCast 方法名写错必须拿到空串", castBody.length ? "方法体已切出" : "空串");
    check(
      /playServerAction\(node,\s*ACTION\.ATTACK\)/.test(castBody),
      "施法演出统一播 attack 段（出厂技能配的 attack_skill_1/a1 怪物素材包全无）",
    );
    check(
      castBody.indexOf("config.action") < 0,
      "施法不再读技能配置的 action 键（那是角色素材的远近之分，怪物素材没有）",
    );
  }

  Date.now = realNow;
  finish("怪物动作锁全绿：事件动作播完/超时/移动才解锁，缺帧回退不上锁");
}

function crossFadeCallsReset() {
  cc.crossFadeCalls.length = 0;
}

/** 待机是否被 play 过（FINISHED 解锁走 play 不走 crossFade） */
function playedStand(node) {
  const body = node.getChildByName("monster_animation");
  const animate = body.getComponent(cc.Animation);
  return animate.getState("stand_down").isPlaying === true;
}

main();
