#!/usr/bin/env node
/**
 * 远端玩家外观单测（client/tools/test-other-player.cjs，issue #383）
 *
 * 盯的不变量（改互见 / 外观链后必须全绿）：
 * A. 协议两端同形：server 的 RealtimePlayerAppearance 与 client 的 PlayerAppearance 字段一致
 *    —— 两份接口是手抄的，漂移了各自都能编译通过，只有跑到一起才炸
 * B. 装配复用：客户端走 RoleAppearance，不再自绘占位圆；占位配置已退役
 * C. 取源与兜底：空串 -> null、时装透传、缺字段回落默认外观
 * D. 演出节奏：只在朝向 / 动作真的变了才切动画（每帧 crossFade 会让动画停在第一帧）
 * E. 服务端：外观懒刷新 + 换装进增量判据（站着不动也要广播）
 *
 * 表现层依赖 cc 引擎（Node / UITransform / Animation），沙箱起不来 —— 这里只做
 * 源码契约断言，真正的行为由 e2e-combat 第八组（服务端帧内容）与实机双窗口验证。
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, check, finish, fail } = require("./lib/configs-sandbox.cjs");

const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");
/** PROJECT_ROOT 是 client/ 目录，服务端与根目录下的文件要往上走一层 */
const readRepo = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, "..", rel), "utf8");

const SERVER_PROTOCOL = "server/src/modules/realtime/realtime.protocol.ts";
const SERVER_PRESENCE = "server/src/modules/realtime/player-presence.service.ts";
const SERVER_CONFIG = "server/src/config/configuration.ts";
const SERVER_ENV_EXAMPLE = "server/.env.example";
const CLIENT_CHANNEL = "assets/ui/utils/net/CombatChannel.ts";
const CLIENT_MANAGER = "assets/ui/core/OtherPlayerManager.ts";
const CLIENT_EFFECT = "assets/configs/effect.ts";

/** 从一段源码里抽出某个 interface 的字段名（两空格缩进 + 可选 ?；注释行不匹配） */
function fieldNames(source, interfaceName) {
  const block = new RegExp(`export interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`).exec(source);
  if (!block) return null;
  return Array.from(block[1].matchAll(/^ {2}(\w+)\??:/gm)).map((match) => match[1]);
}

try {
  const serverProtocol = readRepo(SERVER_PROTOCOL);
  const serverPresence = readRepo(SERVER_PRESENCE);
  const serverConfig = readRepo(SERVER_CONFIG);
  const serverEnv = readRepo(SERVER_ENV_EXAMPLE);
  const clientChannel = read(CLIENT_CHANNEL);
  const clientManager = read(CLIENT_MANAGER);
  const clientEffect = read(CLIENT_EFFECT);

  //#region A. 协议两端同形

  console.log("\n— A. 协议两端同形 —");

  const serverFields = fieldNames(serverProtocol, "RealtimePlayerAppearance");
  const clientFields = fieldNames(clientChannel, "PlayerAppearance");
  check(Array.isArray(serverFields), "服务端有 RealtimePlayerAppearance 接口");
  check(Array.isArray(clientFields), "客户端有 PlayerAppearance 接口");
  const expectedFields = "sex,cloth,weapon,fashion";
  check(serverFields && serverFields.join(",") === expectedFields, `服务端字段是 sex/cloth/weapon/fashion（实得 ${serverFields && serverFields.join("/")}）`);
  check(clientFields && clientFields.join(",") === expectedFields, `客户端字段同形（实得 ${clientFields && clientFields.join("/")}）`);
  check(
    !!serverFields && !!clientFields && serverFields.join(",") === clientFields.join(","),
    "两端字段集合完全一致（手抄的两份接口靠这条锁住，漂移了会各自编译通过）",
  );
  check(/appearance: RealtimePlayerAppearance;/.test(serverProtocol), "服务端互见条目带 appearance（必填）");
  check(/appearance\?: PlayerAppearance;/.test(clientChannel), "客户端互见条目 appearance 可选（旧服务端不发时能兜底）");
  check(/sex: string;/.test(serverProtocol), "sex 用字符串（与客户端 SEX 枚举 \"1\"/\"2\" 同形，不是数字）");

  //#endregion

  //#region B. 装配复用

  console.log("\n— B. 装配复用（不自绘一套） —");

  check(/import RoleAppearance/.test(clientManager), "远端玩家复用 RoleAppearance（主角那套装配代码）");
  check(!/\bGraphics\b/.test(clientManager), "不再自绘占位圆（外观交给 RoleAppearance）");
  check(!/otherPlayerGhost/.test(clientEffect), "占位圆配色配置已退役（configs/effect 里不再有）");
  check(!/otherPlayerGhost/.test(clientManager), "远端玩家不再引用占位配置");
  check((clientManager.match(/new RoleAppearance\(/g) || []).length === 1, "只在一处构造外观（避免同一节点叠两套动画组件互相抢帧）");

  //#endregion

  //#region C. 取源与兜底

  console.log("\n— C. 取源与兜底 —");

  const toSource = /function toOutSource\([\s\S]*?\n\}/.exec(clientManager);
  check(!!toSource, "有 toOutSource（协议 -> 装配数据的唯一转换点）");
  const toSourceBody = toSource ? toSource[0] : "";
  check((toSourceBody.match(/\|\| null/g) || []).length === 3, "三处空串转 null（衣服 / 武器 / 时装：协议用空串、客户端槽位用 null）");
  check(/sex: appearance\.sex as SEX/.test(toSourceBody), "性别按 SEX 枚举透传（未知值由 getRoleDefaultCloth 回落男性）");
  check(/speedRate: defaultRoleSpeedRate/.test(toSourceBody), "速度倍率取默认值（远端属性不随互见帧下发）");
  check(/DEFAULT_APPEARANCE[^=]*=\s*\{[^}]*sex: SEX\.BOY[^}]*cloth: ""[^}]*weapon: ""[^}]*fashion: ""/.test(clientManager), "有兜底外观（男性 / 没穿没拿），旧服务端不发时也能画出完整身体");
  check((clientManager.match(/entry\.appearance \?\? DEFAULT_APPEARANCE/g) || []).length === 2, "创建与更新两处都走兜底（缺字段不会画出半个人）");

  //#endregion

  //#region D. 演出节奏

  console.log("\n— D. 演出节奏 —");

  const tick = /static tick\([\s\S]*?\n  \}/.exec(clientManager);
  check(!!tick, "有 tick");
  const tickBody = tick ? tick[0] : "";
  check(/if \(changed\) view\.appearance\.play\(/.test(tickBody), "只在变了才切动画（每帧 crossFade 会把动画永远重启在第一帧）");
  check((tickBody.match(/\.appearance\.play\(/g) || []).length === 1, "tick 里只有一处切动画");
  check(/view\.moving \? ACTION\.WALK : ACTION\.STAND/.test(tickBody), "走 / 站以服务端的移动标记为准（不是看插值走完没）");
  check(/getDirectionByVector\(new Vec2\(dx, dy\)\)/.test(tickBody), "朝向按剩余位移算八方向（与主角同一套 BattleMath）");
  check(/Math\.abs\(dx\) \+ Math\.abs\(dy\) > 1/.test(tickBody), "差量太小时不转向（否则站着不动会被几像素误差转得乱转）");
  check(!/\.hp\b/.test(tickBody.replace(/\/\*[\s\S]*?\*\//g, "")), "tick 不碰血量（血量只在 upsert 里变）");

  //#endregion

  //#region E. 服务端

  console.log("\n— E. 服务端（懒刷新 + 换装进判据） —");

  check(/private appearanceRefreshMs\(\): number \{/.test(serverPresence), "有外观懒刷新间隔（不每帧查库）");
  check(
    /existed\.updatedAt - existed\.appearanceAt > this\.appearanceRefreshMs\(\)/.test(serverPresence),
    "按间隔重读在线角色（roles.online 是 DB 读，4Hz × 人数会很快放大）",
  );
  check(
    /if \(!moved && !turned && !hurt && !redressed && !maxHpChanged\) continue;/.test(serverPresence),
    "外观变化进增量判据（否则站着不动换装别人看不到）",
  );
  check(/const redressed = this\.appearanceKey\(entry\.appearance\) !== entry\.sentAppearance;/.test(serverPresence), "换装判据用外观键比较");
  check(/typeof sex === "number" \? String\(sex\)/.test(serverPresence), "性别兼容历史数字形状（旧存档里见过 1/2）");
  check(/typeof data\.fashionCloth === "string" \? data\.fashionCloth : ""/.test(serverPresence), "时装只认字符串（历史的数字一律当没穿）");
  check(
    /existed\.maxHp = summary && summary\.maxHp > 0 \? summary\.maxHp : Math\.max\(1, existed\.hp\);/.test(serverPresence),
    "懒刷新顺带对齐血条分母（换装 / 升级都会改 maxHp，只在首见算一次会冻住）",
  );
  check(/const maxHpChanged = entry\.maxHp !== entry\.sentMaxHp;/.test(serverPresence), "分母变化也进增量判据（血量没动时别人也看得到）");
  check(/appearance: \{ \.\.\.entry\.appearance \}/.test(serverPresence), "广播时复制一份外观（在场表里的会被下次懒刷新整份替换）");
  check(/playerAppearanceRefreshMs: Number\(process\.env\.PLAYER_APPEARANCE_REFRESH_MS \?\? 5000\)/.test(serverConfig), "配置默认 5 秒");
  check(/^PLAYER_APPEARANCE_REFRESH_MS=5000$/m.test(serverEnv), ".env.example 已登记");

  //#endregion

  finish("PASS：远端玩家外观（协议同形 / 装配复用 / 取源兜底 / 演出节奏 / 服务端懒刷新）全部通过");
} catch (error) {
  fail(`远端玩家外观单测异常：${error.message}`);
  process.exitCode = 1;
}
