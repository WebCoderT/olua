#!/usr/bin/env node
/**
 * 客户端网络层（二次封装 / 统一调度）的自动化验证
 *
 * 一半跑**真实代码**：tools/lib/net-sandbox.cjs 把 ui/utils/net/* 与 configs/network 编进沙箱，
 * 只换掉 `entities/Role`（当类型用的空壳）与 `cc`（只要 sys.localStorage），
 * XMLHttpRequest 由本测试注入 —— 于是「发出去的 url / 请求头 / body」与「错误怎么归一」都是真跑的，不是复刻。
 * 另一半是源码断言（接线有没有齐、业务层有没有绕过请求层）。
 *
 * 盯的不变量（改网络层或接新接口后必须全绿）：
 * · 成功响应只把 data 交出去（包裹留在请求层，业务层见不到 code/message）
 * · 失败一律归一成 ApiError：网络/超时（可重试并重试 networkConfig.retry 次）、非包裹、业务失败（不重试）
 * · 地址只由 configs/network.baseUrl + ApiRoutes 拼成，查询参数空值自动跳过
 * · 已登录自动注入 Bearer 令牌（唯一注入口在请求层），登录/注册（auth:false）不带令牌
 * · 静默请求失败不弹全局提示，但令牌失效仍然回登录场景
 * · 角色进度同步是防抖的（只推最后一份）、flush 立即推、连续失败只提示一次
 * · Session 读写与脏数据兜底；飘字在非游戏场景也挂得上（登录/选角的错误提示靠它）
 *
 * 用法：node tools/test-client-net.cjs
 * 找不到 tsc 时可用环境变量指定：TSC=/path/to/typescript/bin/tsc node tools/test-client-net.cjs
 */
const fs = require("fs");
const path = require("path");
const { prepareNet } = require("./lib/net-sandbox.cjs");
const { PROJECT_ROOT, check, finish, fail } = require("./lib/configs-sandbox.cjs");

const ASSETS = path.join(PROJECT_ROOT, "assets");
const FILE = {
  helper: path.join(ASSETS, "ui/helpers/GameUiHelper.ts"),
  setup: path.join(ASSETS, "ui/utils/net/NetworkSetup.ts"),
  storage: path.join(ASSETS, "ui/core/StorageManager.ts"),
  game: path.join(ASSETS, "ui/Game.ts"),
  login: path.join(ASSETS, "ui/Login.ts"),
  selector: path.join(ASSETS, "ui/RoleSelector.ts"),
  network: path.join(ASSETS, "configs/network.ts"),
};
const read = (file) => fs.readFileSync(file, "utf8");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let net;
try {
  net = prepareNet("olua-client-net");
} catch (error) {
  fail(`沙箱准备失败：${error.message}`);
  return;
}
const { HttpClient, ApiError, ApiErrorKind, describeError, Session, Api, ApiRoutes, RoleSync, networkConfig, sys, ROLE_SYNC_BIZ_CODES } = net;

//#region XMLHttpRequest 替身（测试逐条断言发出去的东西）

/** 本次测试收到的全部请求（每次用例前清空） */
const requests = [];
/** 全局提示出口记录（请求层把失败交给它） */
const failures = [];
/** 重登出口记录 */
const relogins = [];
/** 当前响应脚本（由用例改写） */
let responder = () => ({ kind: "ok", status: 200, text: envelope(0, "请求成功", null) });

/** 造一个统一响应包裹 */
function envelope(code, message, data) {
  return JSON.stringify({ code, message, data, timestamp: Date.now() });
}

class FakeXHR {
  constructor() {
    this.method = "";
    this.url = "";
    this.headers = {};
    this.timeout = 0;
    this.status = 0;
    this.responseText = "";
    this.body = null;
  }
  open(method, url) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(key, value) {
    this.headers[key] = value;
  }
  send(body) {
    this.body = body;
    requests.push(this);
    const reply = responder(this);
    // 真实 XHR 是异步回调：统一在下一个宏任务里回调，避免同步回调掩盖时序问题
    if (reply.kind === "error") {
      this.status = 0;
      setTimeout(() => this.onerror && this.onerror(), 0);
    } else if (reply.kind === "timeout") {
      setTimeout(() => this.ontimeout && this.ontimeout(), 0);
    } else {
      this.status = reply.status;
      this.responseText = reply.text;
      setTimeout(() => this.onload && this.onload(), 0);
    }
  }
}
global.XMLHttpRequest = FakeXHR;

HttpClient.setFailureHandler((error) => failures.push(error));
HttpClient.setUnauthorizedHandler(() => relogins.push(error => error));

/** 每个用例前清场 */
function reset() {
  requests.length = 0;
  failures.length = 0;
  relogins.length = 0;
}

/** 断言「调用必定失败」，返回归一后的错误 */
async function expectFailure(action) {
  try {
    await action();
  } catch (error) {
    return error;
  }
  return null;
}

//#endregion

(async () => {
  //#region A. 行为（真实请求层 + XHR 替身）

  console.log("— A. 统一响应包裹：成功只交 data，失败归一成 ApiError —");

  reset();
  responder = () => ({ kind: "ok", status: 200, text: envelope(0, "请求成功", { id: "role_1", name: "战士甲" }) });
  const detail = await HttpClient.get(ApiRoutes.role.online);
  check(!!detail && detail.id === "role_1" && detail.name === "战士甲", "成功响应把 data 交出去（不是整个包裹）");
  check(requests.length === 1 && requests[0].url === `${networkConfig.baseUrl}/roles/online`, "地址 = configs/network.baseUrl + ApiRoutes 路径", requests[0].url);
  check(requests[0].method === "GET" && requests[0].headers["Content-Type"] === "application/json", "方法与被要求的 JSON 头正确");

  reset();
  await HttpClient.get("/roles", { query: { page: 1, size: 20, keyword: "", missing: undefined } });
  check(requests[0].url === `${networkConfig.baseUrl}/roles?page=1&size=20`, "查询参数拼接：空串/undefined 自动跳过", requests[0].url);

  reset();
  responder = () => ({ kind: "ok", status: 200, text: envelope(20005, "角色名称重复", null) });
  const bizError = await expectFailure(() => Api.RoleApi.create({ id: "role_x", name: "战士甲" }));
  check(
    bizError instanceof ApiError && bizError.kind === ApiErrorKind.Business && bizError.code === 20005,
    "业务失败归一成 ApiError(Business) 并带业务码",
    `${bizError && bizError.kind}/${bizError && bizError.code}`,
  );
  check(describeError(bizError) === "角色名称重复", "提示优先用服务端文案（不是文案 key）", describeError(bizError));
  check(requests.length === 1, "业务失败不重试（重试还是同样的结果）", `${requests.length} 次`);
  check(failures.length === 1 && failures[0] === bizError, "失败交到全局提示出口（界面层接它弹提示）", `${failures.length} 次`);

  reset();
  responder = () => ({ kind: "error" });
  const netError = await expectFailure(() => HttpClient.get(ApiRoutes.auth.me));
  check(netError && netError.kind === ApiErrorKind.Network && netError.retryable === true, "连不上 → ApiError(Network) 且标记可重试");
  check(requests.length === networkConfig.retry + 1, "网络层失败按 configs/network.retry 重试", `${requests.length} 次`);
  check(describeError(netError) === net.getText("net_unreachable_tip"), "网络失败用本地兜底文案（服务端给不出话）", describeError(netError));

  reset();
  responder = () => ({ kind: "timeout" });
  const timeoutError = await expectFailure(() => HttpClient.get(ApiRoutes.auth.me));
  check(timeoutError && timeoutError.kind === ApiErrorKind.Timeout && timeoutError.retryable === true, "超时 → ApiError(Timeout) 且可重试");

  reset();
  responder = () => ({ kind: "ok", status: 502, text: "<html>bad gateway</html>" });
  const parseError = await expectFailure(() => HttpClient.get(ApiRoutes.auth.me));
  check(parseError && parseError.kind === ApiErrorKind.Http && parseError.status === 502, "非统一包裹 → ApiError(Http) 并保留状态码");
  check(describeError(parseError) === net.getText("net_parse_tip"), "非包裹响应用「数据异常」兜底文案", describeError(parseError));
  check(requests.length === 1, "非包裹响应不重试（重试救不了网关错误）", `${requests.length} 次`);

  console.log("— A. 令牌：登录后自动注入，登录/注册不带 —");

  reset();
  Session.clear();
  Session.save("tk_demo", { id: "acc_1", username: "user001", status: "active", onlineRoleId: null, createdAt: 0, lastLoginAt: null });
  responder = () => ({ kind: "ok", status: 200, text: envelope(0, "ok", { id: "acc_1", username: "user001", status: "active", onlineRoleId: null, createdAt: 0, updatedAt: 0, lastLoginAt: null }) });
  await HttpClient.get(ApiRoutes.auth.me);
  check(requests[0].headers.Authorization === "Bearer tk_demo", "已登录自动注入 Bearer 令牌（业务层不碰 Authorization）", String(requests[0].headers.Authorization));

  reset();
  Session.clear();
  await Api.AuthApi.login("user001", "123456");
  check(requests[0].headers.Authorization === undefined, "auth:false 的接口不带令牌（登录 / 注册）");

  console.log("— A. 静默模式：后台同步失败不刷屏，但令牌失效照样回登录 —");

  reset();
  responder = () => ({ kind: "error" });
  await expectFailure(() => Api.RoleApi.save("role_1", { id: "role_1" }, true));
  check(failures.length === 0, "静默请求失败不弹全局提示（调用方自己决定怎么提示）", `${failures.length} 次`);

  reset();
  responder = () => ({ kind: "ok", status: 200, text: envelope(40100, "未登录", null) });
  await expectFailure(() => Api.RoleApi.save("role_1", { id: "role_1" }, true));
  check(relogins.length === 1, "静默模式下令牌失效仍然回登录场景（闷掉会卡在永远失败的游戏里）", `${relogins.length} 次`);
  check(net.RELOGIN_BIZ_CODES.indexOf(40100) !== -1, "40100 登记在需要重登的业务码里");

  console.log("— A. 角色进度同步：防抖 / flush / 失败只提示一次 —");

  networkConfig.roleSyncDelay = 20; // as const 只是类型约束；这里缩短等待，不改配置默认值
  responder = () => ({ kind: "ok", status: 200, text: envelope(0, "ok", {}) });

  reset();
  RoleSync.schedule({ id: "role_1", level: 2, exp: 10 });
  RoleSync.schedule({ id: "role_1", level: 3, exp: 20 });
  RoleSync.schedule({ id: "role_1", level: 4, exp: 30 });
  await delay(60);
  check(requests.length === 1, "连续改动只推最后一份（打怪升级不会每级发一次请求）", `${requests.length} 次`);
  check(requests[0].method === "PUT" && requests[0].url === `${networkConfig.baseUrl}${ApiRoutes.role.save("role_1")}`, "保存走 PUT + ApiRoutes.role.save(id)", requests[0].url);
  const pushed = JSON.parse(requests[0].body);
  check(pushed.data && pushed.data.level === 4 && pushed.data.exp === 30, "推的是最后一份数据", JSON.stringify(pushed.data));

  reset();
  RoleSync.schedule({ id: "role_1", level: 5, exp: 40 });
  await RoleSync.flush();
  check(requests.length === 1, "flush() 立即推，不等防抖窗口");
  await delay(60);
  check(requests.length === 1, "flush 之后定时器已清掉，不会再补发一次");

  reset();
  responder = () => ({ kind: "error" });
  let notified = 0;
  RoleSync.onFailed = () => (notified += 1);
  RoleSync.schedule({ id: "role_1", level: 6, exp: 50 });
  await delay(60);
  RoleSync.schedule({ id: "role_1", level: 7, exp: 60 });
  await delay(60);
  check(notified === 1, "同步连续失败只提示一次（后端挂了也不刷屏）", `${notified} 次`);
  check(failures.length === 0, "同步请求本身是静默的（提示走 RoleSync.onFailed，不重复弹）", `${failures.length} 次`);

  responder = () => ({ kind: "ok", status: 200, text: envelope(0, "ok", {}) });
  RoleSync.schedule({ id: "role_1", level: 8, exp: 70 });
  await delay(60);
  responder = () => ({ kind: "error" });
  RoleSync.schedule({ id: "role_1", level: 9, exp: 80 });
  await delay(60);
  check(notified === 2, "中间成功过一次之后，新的失败会重新提示（notified 复位）", `${notified} 次`);
  RoleSync.onFailed = null;

  console.log("— A. 角色进度同步：修订号（乐观锁）—");

  reset();
  responder = () => ({ kind: "ok", status: 200, text: envelope(0, "ok", { id: "role_1", revision: 9 }) });
  let savedRevision = null;
  RoleSync.onSaved = (roleId, revision) => (savedRevision = `${roleId}:${revision}`);
  const versioned = { id: "role_1", level: 5, revision: 4 };
  RoleSync.schedule(versioned);
  await delay(60);
  check(JSON.parse(requests[0].body).revision === 4, "推送带上本地修订号（服务端据此判冲突）", requests[0].body);
  check(versioned.revision === 9, "推送成功后把服务端给的新修订号记回本地对象（否则下次会拿旧版本撞自己）", String(versioned.revision));
  check(savedRevision === "role_1:9", "onSaved 交回角色 id 与新修订号（存储层据此更新基线）", String(savedRevision));
  RoleSync.onSaved = null;

  reset();
  responder = () => ({ kind: "ok", status: 200, text: envelope(0, "ok", {}) });
  RoleSync.schedule({ id: "role_1", level: 2, exp: 10 });
  await delay(60);
  check(
    Object.prototype.hasOwnProperty.call(JSON.parse(requests[0].body), "revision") === false,
    "版本未知（旧存档里没有 revision）时不带该字段，服务端按旧行为处理（向后兼容）",
    requests[0].body,
  );

  console.log("— A. 角色进度同步：后台改动 / 角色被删的自愈 —");

  reset();
  let conflictFresh = null;
  let conflictFailed = 0;
  RoleSync.onConflict = (fresh) => (conflictFresh = fresh);
  RoleSync.onFailed = () => (conflictFailed += 1);
  responder = (request) =>
    request.method === "GET"
      ? { kind: "ok", status: 200, text: envelope(0, "ok", { id: "role_1", revision: 12, data: { id: "role_1", level: 42 } }) }
      : { kind: "ok", status: 200, text: envelope(20006, "该角色已在别处被修改，请先同步最新数据", null) };
  RoleSync.schedule({ id: "role_1", level: 5, revision: 4 });
  await delay(60);
  check(requests.length === 2 && requests[1].method === "GET" && requests[1].url.indexOf(ApiRoutes.role.detail("role_1")) !== -1, "撞乐观锁（20006）→ 自动再拉一次角色详情", `${requests.length} 次`);
  check(conflictFresh && conflictFresh.revision === 12 && conflictFresh.data.level === 42, "把服务端最新数据交给 onConflict（后台改动优先，本地那份丢弃）", JSON.stringify(conflictFresh));
  check(conflictFailed === 0, "冲突已被接管，不再走普通失败提示（玩家看到的是「已同步最新」而不是报错）", `${conflictFailed} 次`);
  check(ROLE_SYNC_BIZ_CODES.revisionConflict === 20006, "冲突业务码与服务端约定一致（20006）");

  reset();
  let missingRoleId = null;
  let missingFailed = 0;
  RoleSync.onConflict = null;
  RoleSync.onMissing = (roleId) => (missingRoleId = roleId);
  RoleSync.onFailed = () => (missingFailed += 1);
  responder = () => ({ kind: "ok", status: 200, text: envelope(20002, "角色不存在", null) });
  RoleSync.schedule({ id: "role_gone", level: 1, revision: 2 });
  await delay(60);
  check(missingRoleId === "role_gone", "角色已被删除（20002）→ 交给 onMissing（上层清缓存并回选角场景）", String(missingRoleId));
  check(missingFailed === 0, "角色不存在也走自愈分支，不当作普通同步失败", `${missingFailed} 次`);
  check(ROLE_SYNC_BIZ_CODES.missing === 20002, "角色不存在业务码与服务端约定一致（20002）");
  RoleSync.onMissing = null;
  RoleSync.onFailed = null;

  console.log("— A. 会话存储：读写与脏数据兜底 —");

  Session.clear();
  check(!Session.isLoggedIn && Session.account === null, "未登录时令牌为空、账号为 null");
  const account = { id: "acc_1", username: "user001", status: "active", onlineRoleId: null, createdAt: 0, lastLoginAt: null };
  Session.save("tk_2", account);
  check(Session.isLoggedIn && Session.token === "tk_2", "保存会话后 isLoggedIn / token 生效");
  Session.updateAccount({ ...account, onlineRoleId: "role_1" });
  check(Session.account && Session.account.onlineRoleId === "role_1", "updateAccount 覆盖账号信息（在线角色变化）");
  sys.localStorage.setItem("olua.account", "{坏掉的 json");
  check(Session.account === null, "账号缓存损坏不抛异常（当成未登录）");
  Session.clear();
  check(!Session.isLoggedIn && Session.account === null, "clear 清掉令牌与账号");

  //#endregion

  //#region B. 接线（源码断言）

  console.log("— B. 接线：请求层不认识场景/飘字，出口必须接上 —");

  const setupSource = read(FILE.setup);
  check(/let installed = false/.test(setupSource) && /if \(installed\) return/.test(setupSource), "installNetwork 幂等（登录/游戏场景都调也只接一次）");
  check(/HttpClient\.setUnauthorizedHandler\(/.test(setupSource) && /Session\.clear\(\)/.test(setupSource) && /loadScene\("Login"\)/.test(setupSource), "重登出口 = 清会话 + 回登录场景");
  check(/HttpClient\.setFailureHandler\(/.test(setupSource) && /createErrorTipText\(describeError\(error\)\)/.test(setupSource), "失败出口 = 统一飘字（文案由 ApiError 归一）");
  check(/installNetwork\(\)/.test(read(FILE.login)), "登录场景调 installNetwork");
  check(/installNetwork\(\)/.test(read(FILE.selector)), "选角场景调 installNetwork");

  const helperSource = read(FILE.helper);
  check(/private static mountFloatingTip\(tip: Node\)/.test(helperSource) && /uiLayer\.scene/.test(helperSource), "飘字挂载点跨场景可用（游戏内走 UI 图层，登录/选角挂场景根）");
  check(/director\.getScene\(\)/.test(helperSource), "非游戏场景的兜底挂载点是当前场景根");

  console.log("— B. 客户端：角色数据以服务端为准 —");

  const storageSource = read(FILE.storage);
  check(/static cacheRole\(role: Role\)/.test(storageSource), "StorageManager.cacheRole 存在（服务端完整数据写进本地缓存）");
  check(
    /static cacheServerRole\(detail: \{ data: unknown; revision: number \}\)/.test(storageSource) &&
      /static applyServerRevision\(roleId: string, revision: number\)/.test(storageSource),
    "StorageManager 提供 cacheServerRole（连修订号一起缓存）与 applyServerRevision（推送成功后对齐基线）",
  );
  check(/static createRole\(/.test(storageSource) === false, "本地 createRole 已移除（创建必须走服务端）");
  check(/this\.setRoles\(roles\);\s*\n\s*RoleSync\.schedule\(role\);/.test(storageSource), "updateOnlineRole 落盘后安排一次同步（本地落盘唯一出口 = 同步唯一触发点）");
  check(/const revision = typeof role\.revision === "number" \? role\.revision : i\.revision;/.test(storageSource), "updateOnlineRole 不会被 Object.assign 抹掉已存下的修订号（否则退回无乐观锁）");
  check(/RoleSync\.schedule\(role\)/.test(storageSource) && /Session\.clear\(\)/.test(storageSource), "clear() 同时清掉会话（清存档别留着登录态）");

  const selectorSource = read(FILE.selector);
  check(
    /await RoleApi\.select\(roleId\)/.test(selectorSource) && /StorageManager\.cacheServerRole\(detail\)/.test(selectorSource),
    "进游戏：服务端 select 返回完整数据（含修订号）→ 写本地缓存",
  );
  check(/await RoleApi\.create\(new Role\(name, occupation, sex\)\)/.test(selectorSource) && /StorageManager\.cacheServerRole\(detail\)/.test(selectorSource), "创建角色：服务端落库后回传的完整数据（含修订号）写进缓存");
  const removeIndex = selectorSource.indexOf("await RoleApi.remove(roleId)");
  const deleteIndex = selectorSource.indexOf("StorageManager.deleteRole(roleId)");
  check(removeIndex > 0 && deleteIndex > removeIndex, "删除角色：先服务端删成功，再清本地缓存（顺序反了角色会复活）");
  check(/maxRoleCount/.test(selectorSource), "创建前按 configs/role.maxRoleCount 先拦一道（服务端仍是权威）");

  const gameSource = read(FILE.game);
  check(/installNetwork\(\)/.test(gameSource), "游戏场景调 installNetwork（令牌失效回登录）");
  check(/RoleSync\.onFailed = \(error\) => GameUiHelper\.createErrorTipText\(describeError\(error\)\)/.test(gameSource), "游戏场景接上进度同步的失败提示");
  check(
    /RoleSync\.onSaved = \(roleId, revision\) => StorageManager\.applyServerRevision\(roleId, revision\)/.test(gameSource),
    "游戏场景接上 onSaved：把服务端的新修订号写回存储（推送成功后的基线）",
  );
  check(
    /RoleSync\.onConflict = \(fresh\) => \{[\s\S]*?StorageManager\.cacheServerRole\(fresh\)[\s\S]*?createTip\("role_sync_conflict_tip"\)/.test(gameSource),
    "游戏场景接上 onConflict：以后台最新数据为基线 + 提示「已同步最新」（否则后台改动会被旧存档抹掉）",
  );
  check(
    /RoleSync\.onMissing = \(roleId\) => \{[\s\S]*?StorageManager\.deleteRole\(roleId\)[\s\S]*?loadScene\("RoleSelector"\)/.test(gameSource),
    "游戏场景接上 onMissing：角色被后台删掉时清本地缓存并回选角场景（不卡在永远失败的游戏里）",
  );
  check(/onDestroy\(\)[\s\S]*?RoleSync\.flush\(\)/.test(gameSource), "场景销毁前 flush 未推送的进度（切地图/退出不丢改动）");
  check(
    /onDestroy\(\)[\s\S]*?RoleSync\.onMissing = null/.test(gameSource),
    "场景销毁时摘掉全部同步回调（场景根都没了，回调里再飘字/切场景会出问题）",
  );

  const roleSyncSource = read(path.join(ASSETS, "ui/utils/net/RoleSync.ts"));
  check(/RoleApi\.save\(role\.id, role, true, revision\)/.test(roleSyncSource), "推送时把修订号交给请求层（乐观锁的唯一来源）");
  check(
    /ROLE_SYNC_BIZ_CODES\.revisionConflict/.test(roleSyncSource) && /await RoleApi\.detail\(role\.id, true\)/.test(roleSyncSource),
    "撞乐观锁时先静默拉一次最新数据再交给上层（不重试、不覆盖、不额外弹错误）",
  );
  check(/ROLE_SYNC_BIZ_CODES\.missing/.test(roleSyncSource) && /this\.onMissing\?\.\(role\.id\)/.test(roleSyncSource), "角色不存在的分支交给上层自愈");

  const roleEntitySource = read(path.join(ASSETS, "entities/Role.ts"));
  check(/revision\?: number;/.test(roleEntitySource), "Role 实体有可选的 revision（缺省 = 版本未知，推送时不带）");

  const textsSource = read(path.join(ASSETS, "configs/texts.ts"));
  check(
    /role_sync_conflict_tip:/.test(textsSource) && /role_sync_missing_tip:/.test(textsSource),
    "自愈用的两条文案都登记在 configs/texts（代码里不写中文）",
  );

  const networkSource = read(FILE.network);
  check(/baseUrl:\s*"http/.test(networkSource), "configs/network 是客户端唯一地址来源（自查 tools/audit-api-hardcode.cjs）");

  //#endregion

  finish("PASS：客户端网络层（包裹解包 / 令牌 / 静默 / 防抖同步 / 接线）行为与接线全部通过。");
})().catch((error) => {
  fail(`测试异常终止：${error && error.stack ? error.stack : error}`);
});
