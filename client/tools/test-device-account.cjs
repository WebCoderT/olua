#!/usr/bin/env node
/**
 * 本机账号（ui/utils/net/DeviceAccount）的自动化验证
 *
 * 跑**真实代码**：`prepare()` 把 DeviceAccount.ts 编进沙箱，cc 垫片只补 `sys.localStorage`（内存 Map，
 * 语义照引擎：getItem / setItem / removeItem / clear）。于是「生成规则 / 落盘 / 读容错」都是真跑的。
 *
 * 盯的不变量（改生成规则或存储格式后必须全绿）：
 * · 生成的账号密码落在服务端 `RegisterDto` 的校验区间内（账号 3~20 位 /^[A-Za-z0-9_]{3,20}$/、密码 6~32 位）
 *   —— 区间直接从服务端 DTO 源码里读，不是在这边再抄一份数字
 * · 连续生成不重样（撞名有服务端唯一性+重试兜底，但不该高概率撞）
 * · 存 / 读往返一致；clear 之后读不到
 * · 脏数据（坏 JSON / 缺字段 / 空串 / 非对象）一律当「本机没有账号」返回 null，绝不抛异常
 * · 存储键与 Session 的分开（`clear()` 只清登录态，本机账号必须活过清缓存）
 *
 * 用法：node client/tools/test-device-account.cjs
 * 找不到 tsc 时可用环境变量指定：TSC=/path/to/typescript/bin/tsc node client/tools/test-device-account.cjs
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, loadCcShim, check, finish, fail } = require("./lib/configs-sandbox.cjs");

const DEVICE_ACCOUNT_FILE = path.join(PROJECT_ROOT, "assets/ui/utils/net/DeviceAccount.ts");
const SESSION_FILE = path.join(PROJECT_ROOT, "assets/ui/utils/net/Session.ts");
// PROJECT_ROOT 指 client/（见 lib/configs-sandbox.cjs），服务端在它旁边
const REPO_ROOT = path.resolve(PROJECT_ROOT, "..");
const REGISTER_DTO_FILE = path.join(REPO_ROOT, "server/src/modules/auth/dto/register.dto.ts");

/** 追加到 cc 垫片末尾：引擎里 DeviceAccount 只用到 sys.localStorage */
const STORAGE_SHIM = `
const __store = new Map();
const sys = {
  localStorage: {
    getItem: (key) => (__store.has(key) ? __store.get(key) : null),
    setItem: (key, value) => { __store.set(key, String(value)); },
    removeItem: (key) => { __store.delete(key); },
    clear: () => { __store.clear(); },
  },
};
module.exports.sys = sys;
module.exports.__store = __store;
`;

let outDir;
try {
  outDir = prepare("olua-device-account", ["ui/utils/net/DeviceAccount.ts"], STORAGE_SHIM);
} catch (error) {
  fail(`沙箱准备失败：${error.message}`);
  return;
}

const DeviceAccount = require(path.join(outDir, "ui/utils/net/DeviceAccount.js")).default;
const cc = loadCcShim(outDir);
const store = cc.__store;

/** 每个用例前清场（DeviceAccount 自己也只用这一个键，但脏数据用例会往里塞别的值） */
const reset = () => store.clear();

console.log("\n== A. 生成规则落在服务端 RegisterDto 的校验区间内 ==");
{
  // 区间从服务端 DTO 源码里读：账号 @Matches(/^[A-Za-z0-9_]{3,20}$/)、密码 @Length(6, 32)
  const dto = fs.readFileSync(REGISTER_DTO_FILE, "utf8");
  const usernameRange = /@Matches\(\/\^\[A-Za-z0-9_\]\{(\d+),(\d+)\}\$\//.exec(dto);
  const passwordRange = /@Length\((\d+),\s*(\d+)/.exec(dto);
  check(!!usernameRange && !!passwordRange, "服务端 RegisterDto 的账号 / 密码区间可解析", usernameRange ? `账号 ${usernameRange[1]}~${usernameRange[2]} 位` : "解析失败");

  const [userMin, userMax] = usernameRange ? [Number(usernameRange[1]), Number(usernameRange[2])] : [3, 20];
  const [pwdMin, pwdMax] = passwordRange ? [Number(passwordRange[1]), Number(passwordRange[2])] : [6, 32];

  let bad = 0;
  const usernames = new Set();
  for (let index = 0; index < 200; index++) {
    const credentials = DeviceAccount.generate();
    const userOk = new RegExp(`^[A-Za-z0-9_]{${userMin},${userMax}}$`).test(credentials.username);
    const pwdOk = credentials.password.length >= pwdMin && credentials.password.length <= pwdMax;
    if (!userOk || !pwdOk) bad++;
    usernames.add(credentials.username);
  }
  check(bad === 0, "连续生成 200 套都符合服务端格式（不会因格式被 400）");
  check(usernames.size === 200, "连续生成 200 套账号名不重样", `唯一 ${usernames.size} / 200`);

  const sample = DeviceAccount.generate();
  check(/^olua_[a-z0-9]{10}$/.test(sample.username), "账号形如 olua_ + 10 位小写字母/数字", sample.username);
  check(/^[a-z0-9]{20}$/.test(sample.password), "密码为 20 位小写字母/数字", `${sample.password.length} 位`);
  check(typeof sample.createdAt === "number" && sample.createdAt > 0, "createdAt 是毫秒时间戳");
}

console.log("\n== B. 存 / 读往返 ==");
{
  reset();
  check(DeviceAccount.load() === null, "本机没有凭据时读回 null");
  const credentials = DeviceAccount.generate();
  DeviceAccount.save(credentials);
  const loaded = DeviceAccount.load();
  check(!!loaded, "save 之后能读回");
  check(loaded.username === credentials.username, "账号一致");
  check(loaded.password === credentials.password, "密码一致");
  check(loaded.createdAt === credentials.createdAt, "createdAt 一致");
  check(store.has("olua.deviceAccount"), "存储键是 olua.deviceAccount");
}

console.log("\n== C. clear 之后回到「本机没有账号」 ==");
{
  const credentials = DeviceAccount.generate();
  DeviceAccount.save(credentials);
  DeviceAccount.clear();
  check(DeviceAccount.load() === null, "clear 后 load 返回 null");
  check(!store.has("olua.deviceAccount"), "键已从 localStorage 删除（不是写空串）");
}

console.log("\n== D. 脏数据一律当「没有账号」，不抛异常 ==");
{
  const KEY = "olua.deviceAccount";
  const cases = [
    ["坏 JSON", "{not json"],
    ["JSON 数组", "[]"],
    ["null", "null"],
    ["缺 password", JSON.stringify({ username: "olua_abcdefghij" })],
    ["缺 username", JSON.stringify({ password: "0123456789abcdefghij" })],
    ["空串字段", JSON.stringify({ username: "", password: "" })],
    ["字段类型不对", JSON.stringify({ username: 1, password: 2 })],
    ["纯数字字符串", "123456"],
  ];
  cases.forEach(([label, raw]) => {
    reset();
    store.set(KEY, raw);
    let result;
    let threw = false;
    try {
      result = DeviceAccount.load();
    } catch (error) {
      threw = true;
    }
    check(!threw && result === null, `脏数据「${label}」→ null（不抛异常）`);
  });
}

console.log("\n== E. 与 Session 的存储键分开 ==");
{
  const session = fs.readFileSync(SESSION_FILE, "utf8");
  const device = fs.readFileSync(DEVICE_ACCOUNT_FILE, "utf8");
  const sessionKeys = [...session.matchAll(/(?:TOKEN_KEY|ACCOUNT_KEY)\s*=\s*"([^"]+)"/g)].map((match) => match[1]);
  const deviceKey = /KEY\s*=\s*"([^"]+)"/.exec(device);
  check(!!deviceKey, "DeviceAccount 的存储键可读");
  check(sessionKeys.length === 2, "Session 的令牌 / 账号键可读", sessionKeys.join(" / "));
  check(!!deviceKey && sessionKeys.every((key) => key !== deviceKey[1]), "本机凭据与 Session 的键互不相同（清缓存不换号）", deviceKey ? deviceKey[1] : "");
  // StorageManager.clear 只删 roles / selectedRole + Session.clear —— 源码断言，防止有人顺手把本机凭据塞进去
  const storage = fs.readFileSync(path.join(PROJECT_ROOT, "assets/ui/core/StorageManager.ts"), "utf8");
  const clearBody = /static clear\(\)\s*\{([\s\S]*?)\n  \}/.exec(storage);
  check(!!clearBody, "StorageManager.clear 的实现在源码里可定位");
  check(!!clearBody && !/deviceAccount/i.test(clearBody[1]), "StorageManager.clear 不碰本机凭据（否则清缓存就丢号）");
}

console.log("\n== F. 源码接线断言 ==");
{
  const device = fs.readFileSync(DEVICE_ACCOUNT_FILE, "utf8");
  const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const code = strip(device);
  check(/Math\.random\(\)/.test(code) && !/crypto\./.test(code), "随机只依赖 Math.random（原生平台不保证有 crypto.getRandomValues）");
  check(/JSON\.parse\(/.test(code) && /catch\s*\{/.test(code), "load 用 try/catch 兜住坏 JSON");
  check(!/console\.(log|warn|error)/.test(code), "DeviceAccount 不打日志（登录页入口不刷屏）");
}

finish("全部通过：本机账号的生成规则、存取与容错都符合预期");
