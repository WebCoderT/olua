# cocos-monster-ai（原文，合并前独立技能）

# 怪物 AI（#670 起：行为在服务端，客户端只演）

> **一句话**：客户端**没有任何**怪物行为决策。目标选择、待机游走、追击、普攻、技能、击退
> 全在 `server/src/modules/realtime/monster-ai.service.ts`；客户端 `ui/core/MonsterAI.ts`
> 只剩「朝服务端坐标趋近 + 按事件播动作」。
>
> 之前并存过一套本地 AI，只在「实时通道没连上」时跑。代价是同图两个客户端各跑一套随机行为：
> A 屏幕上怪在东边打人、B 屏幕上同一只怪在西边遛弯，而血量又都是服务端权威 —— 看起来像
> 「怪在远程打人」。删掉本地 AI 是为了**画面一致**，不是为了省代码。

## 一、三条一致性链路（少一条两端就不同步）

| 链路 | 机制 | 缺了会怎样 |
| --- | --- | --- |
| 位置 | world 快照发出前用 AI 实时坐标覆盖 `x/y`（`withLiveMonsterPositions`）+ `monster-ai` 增量帧 | 晚进图的人先看到**出生点**再等帧纠正；站着不动的怪永远不进增量帧（判据是「有变化才发」）→ 永远停在出生点 |
| 血量 | `monster-ai` 帧的 `hp/maxHp`（必填），血量变化本身也算「有变化」 | `hits` 只发给**结算给出手者本人**，别人打的伤害收不到 → 别人屏幕上怪满血 |
| 行为 | 客户端零决策，只有一条演出路径 | 两套 AI 各自游走/选目标，位置与动作都对不上 |

- `monster-ai` 帧的必发判据：`moved || turn || hurt`（位置变了 / 移动标记变了 / 血量变了）。
  **站着的怪不发第二遍**，所以「站着不动」这件事必须靠 world 快照的首帧正确。
- world 快照的 `x/y` 注释写的是「出生点」—— 那是**存库的出生点**，不是「他现在在哪」；
  通道发出前会被覆盖。改这块别按「出生点」理解。
- 客户端 `MonsterAiEntry.hp/maxHp` 是可选字段（旧服务端不发时不刷血条），服务端侧是必填。

## 二、客户端表现层（`ui/core/MonsterAI.ts`，静态类）

```ts
static tick(monsters: Map<Node, Monster>)                       // Game.update 每帧，只剩一条路
static applyServerState(node, x, y, moving)                     // 收到 monster-ai 帧：记目标点，首帧直接吸附
static playServerAction(node, action, direction?)               // hits / casts 事件：播动作
static replayCurrent(node)                                      // FINISHED 续播（一次性动作除外）
static die(node): boolean                                       // 死亡动画，播完销毁节点
```

- **首帧吸附**：`serverX === null` 时直接 `setWorldPosition`（服务端可能已经模拟了一段），
  之后才交给 `stepServer` 按帧趋近 —— 否则新刷出来的怪会从出生点「走」到真实位置。
- **同速趋近 + 差距大时追赶**：步长 = `max(monster.moveSpeed, distance / SERVER_CATCHUP_SECONDS)`，
  `SERVER_CATCHUP_SECONDS = 0.2`（一个广播周期）。只按 `moveSpeed` 走的话，一次 120px 的
  击退要拖一秒多才补齐，看起来像慢动作回放。
- **朝向由位移差量自算**（`getDirectionByVector(offsetX, offsetY)`），服务端不发朝向。
- 数据归 `MonsterManager`（节点↔数据、生命周期、血条、受击表现），行为归本类；
  AI 不 import 管理器（`Game` 同时 import 两者并接线），否则成环。
- 状态放 `WeakMap<Node, MonsterAIState>`（节点销毁自动回收），怪物数据对象上不挂运行时字段。
- `MonsterAIState` 只有表现字段：`action / dead / direction / serverX / serverY / serverMoving / serverStepAt`。
  `moveSpeed / aggressive / detectRange` 只是**服务端 AI 参数在客户端的只读副本**（快照下发，渲染用不到也别本地判）。

### 刻意不做（想做就得先让服务端知道）

- **待机随机换动作 / 随机小走**：会让同一只怪在两个人屏幕上动得不一样。待机 = 服务端说停就站定，游走由服务端模拟并广播。
- **击退位移**：服务端模拟（`MonsterAiService.applyPush`），落点走普通位置广播；客户端只趋近。本地自己推一下，别人屏幕上怪根本不动。
- **玩家侧伤害结算**：怪打人的伤害由服务端算（`hits` 帧）。`MonsterManager.onPlayerServerHit` 是**唯一入口**
  （`StorageManager.applyMonsterHit` + 飘字 + 红闪 + `playInjured`）；`BattleMath.applyHitDamage` 现在
  没有生产调用方，保留为「玩家状态参与结算」的口径规格（`test-status-combat` 覆盖）。

## 三、服务端 AI 的形状（`server/src/modules/realtime/monster-ai.service.ts`）

- **tick 住 realtime 模块**（每 `MONSTER_AI_TICK_MS`），广播每 `MONSTER_AI_BROADCAST_MS`。
  每只**有人看的图**上的存活怪一份 `MonsterRuntime`；没人看的图整份清掉。
- **目标选择**：主动怪常驻发现；被动怪被打伤后记恨打它的人（结算侧 `provoke`）；
  玩家离开检测范围即丢失目标（记恨不清，回来继续被追）。
- **⚠️ 出手结算不出来 = 目标作废**（#670 的真正修法）：`RolesService.applyMonsterHit` 返回 `null`
  意味着这具尸体再也打不动（玩家已倒下 / 不在线）。以前只当「这一下落空」→ `runtime.target`
  不清、位置缓存里那条 hp>0 的记录不删 → 下一拍又把尸体选成目标，客户端就在演
  「怪对着尸体放技能」。现在一律 `forgetTarget(accountId)`：删位置缓存 + 清掉**所有**怪身上
  指向该账号的 `target`。
- **先结算再落账**：`castSkill()` 拿不到 hit 就整次作废 —— 不记冷却、不进硬直、不发 `casts`，
  返回 `false`；`tryCast()` 据此判断「是否还要再试普攻」。冷却/硬直只写在成功路径上。
- **击退在服务端**：结算侧（`CombatSettlementService.settleNew` 非击杀分支）读 `skill.pushDistance`，
  调 `applyPush(instanceId, fromAccountId, distance)`；方向 = 施法者 → 怪，时长取
  `runtime_params.monster_ai.pushDuration`（出厂 200ms）。`stepMonster` 里击退**优先于**施法硬直。
  **不需要新协议帧**，落点跟位置广播走。
- **参数全在库里**：`runtime_params.monster_ai`（attackInterval / attackRange / attackActionTime /
  pushDuration / idleMoveInterval / idleMoveDuration / idleMoveSpeedScale / wanderRadius）+
  `monster_presentation`（aggressive / detectRange / moveSpeed）。代码里的 `FALLBACK_AI` 只是
  读不出数据时的兜底（全部取 0 会每 tick 出手一次，比不跑更糟），不是出厂值的第二份。
- **缓存 1 秒 TTL**：管理端与实时是**两个进程**，只能靠共享 SQLite 交换改动，没法通知；
  每 tick 查三张表在几十只怪时是纯浪费。
- **位置不落盘**：坐标的持久真相是出生点，重启后怪回出生点重新游走 —— 几秒钟的表现层状态不值得加表。

### 键名陷阱：`skillOf()` 返回的是归一化后的驼峰对象

`applySkillOverrides` 之后字段是 `damageCoefficients / castLockMs / pushDistance`，
**没有** `push_distance` 这种蛇形列名。写 `Number(skill.push_distance)` 拿到 `undefined`，
击退会静默失效且不报错。要加技能字段：`SkillSource` 补列 → `applySkillOverrides` 映射 → 消费方读驼峰。

### 观测出口：`onLog` 单向回调（#745）

管理端的「每一下伤害 / 追击起止」不靠快照差分，靠 AI 自己往外说。这一条也是排查线上
「怪为什么追着我不放 / 怎么突然不追了」的唯一线索：

```ts
export type MonsterAiLogEvent =
  | { type: "chase"; instanceId; monsterKey; label; x; y; target; targetAccountId;
      phase: "start" | "end"; reason: string; distance: number }
  | { type: "cast"; ...; skillId; skillLabel; target; targetAccountId; damage; hp; maxHp }
  | { type: "hit";  ...; target; targetAccountId; damage; hp; maxHp };

onLog: ((event: MonsterAiLogEvent) => void) | null = null;   // 未接线则无人听
```

- **不能改成注入 `MapMonitorService`**：监控服务构造时已经依赖 AI（采样要读 `livePositionOf`），
  反向注入立刻循环依赖。与 `onBroadcast` 同一手法，宿主在 bootstrap 里赋值、销毁时置 `null`；
- **回调必须吞异常只 warn**：写日志失败不能影响战斗，`emitLog` 里自己 `try/catch`；
- **身份四件套进运行时**（`zoneId / mapId / instanceId / monsterKey`）：`MonsterRuntime` 不随重生
  保留，重生时重建，所以这些是**快照值**而不是每次去 `world` 里查；
- **技能名在读库时就带进 `CastPlan`**（`buildCastPlan` 返回 `label`），不在 tick 里查库；
- **「目标丢了」的四种成因分开写**（`目标离线` / `目标倒下` / `目标换图` / `位置上报超时`）：
  页面上这是四个完全不同的故事。判定顺序就是 `!position` → `hp<=0` → 区图不同 → 超时；
- **每个结局都要有终点**：`forgetTarget`（出手结算不出来）与 `onMonsterKilled`（怪被打死）也要补
  一条 `chase.end`，否则文字流里会留下永远没有结局的追击；
- start 的成因只有两种：`进入检测范围` 与 `被打之后记恨`（`runtime.provoked === best` 判定）。

## 四、位移与碰撞（客户端）

```ts
// ui/utils/physics/MonsterCollider.ts
const rigidBody = node.addComponent(RigidBody2D);
rigidBody.type = ERigidBody2DType.Kinematic;       // ← 静态体挪不动
const collider = node.addComponent(BoxCollider2D);
collider.size = node.getComponent(UITransform).contentSize;
```

- **别用静态刚体（Static）做会动的怪**。两个非动态刚体之间也**不产生碰撞**：怪彼此不阻挡、也不被静态障碍挡住（会穿树穿墙，见「已知限制」）。
- **⚠️ 运动学刚体会把主角顶开**：主角是动态刚体（`gravityScale = 0`），Box2D 里运动学体质量无限大。
  要"谁都不推动谁"必须 `collider.sensor = true` + 手动阻挡预测。
- 现在的位移来源是 `setWorldPosition`（趋近），`stopMoving` 只兜住残留速度（`linearVelocity = Vec2.ZERO`）。

### 碰撞盒属性什么时候生效（必踩）

`Collider2D` 的夹具不在 `addComponent` 时建：`onEnable → PhysicsSystem2D._callAfterStep` 才 `_init`，
一次性读走 `size / offset / sensor / group`。

- `addComponent` 之后**同一帧内**写 `collider.size / sensor` 有效；
- 夹具已建好再改：只改组件字段、不碰夹具，必须显式 `collider.apply()`；
- `worldAABB` / `getWorldPoints` 读的是**实际夹具**，不会被组件字段骗到。

## 五、谁推动谁

| 关系 | 做法 |
| --- | --- |
| 静态障碍（树/墙/NPC） | 静态刚体 `addObstacleCollider`，引擎自带阻挡 |
| 怪物 ↔ 角色 | 怪物 `Kinematic` + `collider.sensor = true`（谁都不推动谁）+ **手动阻挡预测** |
| 技能击退 | 服务端模拟位移，客户端只趋近（见第二节） |

手动阻挡在 `ui/utils/physics/MoveBlocking.ts`（纯函数，角色与怪物共用）。`resolveBlockedMove` 两条关键规则：

1. **只挡「本来没重叠、这一步会重叠」的移动** —— 已重叠直接放行，否则贴身后任何方向都被判碰撞、永久卡死。
2. **整体位移被挡就依次试单轴**（`(dx,0)` / `(0,dy)`）→ 贴着侧滑而不是整帧停住。
   `Rect.intersects` 用严格 `<`，边贴边也算相交 → 正好停在贴身处。

**追击不套阻挡**（服务端做，客户端不掺和）：`attackRange` 常常小于双方体积之和，一按体积挡就会
停在攻击距离外永远打不到人。**已知取舍**：怪贴上来时与角色是重叠的，角色可以走开也可以穿过去。

## 六、动画状态机（最容易做错的地方）

**引擎事实**：`AnimationHelper.createAnimation` 建出的 clip 一律 `WrapMode.Normal`（播一次就停），
**播放器不会自己循环**。循环靠 `FINISHED` 事件重新 `play(当前动作名)` 实现（`replayCurrent`）。

```ts
private static playAction(animate, state, action, direction) {
  const resolved = animate.getState(getAnimationName(action, direction)) ? action : ACTION.STAND;
  if (state.action === resolved && state.direction === direction) return;   // ← 不加这句必卡第 1 帧
  state.action = resolved; state.direction = direction;
  animate.crossFade(getAnimationName(resolved, direction), 0.2);
}
```

- **绝不能每帧 `play()/crossFade()`**：每帧重启 → 动画永远停在第一帧（"怪走路像贴图"）。
- `Animation.getState(name)` 在 clip 不存在时**返回 null（.d.ts 骗人说是 AnimationState）**，必须用它做守卫。
- 切动作前先问"这个方向有帧吗"：220 个怪物帧目录里**只有 stand/walk/run/test1 八向齐全**，
  `attack_near` 只有部分方向，`attack_skill_1/test3/attack_far/injured/a1/die` 全无 → 缺帧回退该朝向的 stand。
- **一次性动作**（`ONCE_ACTIONS = [ACTION.INJURED]`）播完要切回待机，不能 `play` 回受伤动作（否则怪卡在挨打）。

## 七、客户端怎么消费三类帧（`MonsterManager`）

- **位置 + 血量**（`applyServerAi`）：先刷血条再趋近。`entry.hp <= 0` 走死亡清场；否则 `monster.hp = entry.hp`、`updateHead`、再 `MonsterAI.applyServerState`。
- **`casts`**（`{instanceId, skillId, statusId?}`）= 放技能了 → 播动作（取技能配置的 `action`）+ 特效（`EffectManager.playAt`）。
  `SkillEffectConfig` / `SkillEffectActor` 是 `Pick<>` 收窄过的类型，让 `SkillData`（没有 `onClick`）也能传。
- **普攻没有单独事件**：用同帧 `hits` 反推，凡没被 `casts` 覆盖的 instanceId 补播 `ACTION.ATTACK_NEAR`（用 `castIds` 去重，别让一次出手播两遍）。
- **状态型技能**（狂怒 / 硬化皮肤）没有伤害，只有 `casts.statusId` → 挂一份循环特效子节点（随怪移动/销毁），台账 `MonsterManager.statusEffects`，每帧按 `expireAt` 清理。**不要复用 `StatusManager`**（它是「单 owner + 图标栏」的形状）。
- **`kills`**（#689 `{instanceId, accountId, x, y, drops[]}`）= 有玩家打死了它 → 观看者做死亡清场 + 掉落铺场（`DropManager.spawnRemoteDrops`：纯演出、不可拾取）。
  **自己的击杀按 accountId 跳过**（击杀者那份已由 settle 帧的 reward 演过，重复处理会双份掉落）。

## 八、验证清单

1. 服务端改完 `npm run build`（e2e 跑 `dist/`），再 `npm run test:e2e:monster-ai`。
2. 该套件用 `pickPointInArea(cx, cy, 0, 0)`（恒定落在中心点）把怪钉死，位置断言才可复现；
   断言「停稳后再量距离」（连续两拍位移 < 0.5px），别在半路量 —— 广播 100ms 一拍、击退 200ms，量到的常是推了一半的帧。
3. 客户端 `make client-check`（0 错）+ `make client-test`；`make audit`（`audit-world-authority` 守着
   「AI 参数不许回到客户端配置」，`BEHAVIOR_FIELDS` 是反向白名单）。
4. 显示效果（帧率/尺寸/坐标/颜色/对齐）不写断言，人眼看。
5. 监控日志（#745）走 `npm run test:e2e:map-monitor` 的「二·五」段：站到怪身上 → 打一下 →
   断言 `damage`（血量自洽 `hpBefore - hpAfter === amount`）、`chase.start`（成因 `被打之后记恨`）、
   `hit`、`chase.end`（停报 3s 后成因变 `位置上报超时`）。管理端界面只做 build + 人眼看。

## 九、已知限制（提前跟用户讲清，别当成 bug）

- **无寻路**：直线追击。运动学刚体不与静态障碍碰撞解析 → 怪可能穿树穿墙。
- **位置重启归位**：重启后怪回出生点重新游走（位置不落盘）。
- **玩家侧状态数值不参与服务端结算**（格挡/防御修正仍是客户端 StatusManager 的本地增益），服务端按裸属性算。
- **怪物不消耗魔法值**：技能表的 `mpCost` 只对角色生效。
- 怪物 `contentSize` 是 `new Size()`（0×0）时碰撞盒退化成一个点 —— 配置缺口，不是 AI 的问题。
- 客户端 `serverX === null` 期间（还没收到第一帧）怪原地站着，这是设计（不猜）。
