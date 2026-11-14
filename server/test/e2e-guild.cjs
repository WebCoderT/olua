#!/usr/bin/env node
/**
 * 帮会专项 e2e（server/test/e2e-guild.cjs，issue #388）
 *
 * 盯的不变量（改帮会逻辑后必须全绿）：
 * 一、建帮：建帮人自动成为帮主（`guilds.leader_id` 与成员表两处同时成立）；
 *     一个人只能在一个帮会（50103）、帮会名全局唯一（50102）；列表带帮主名与人数
 * 二、申请：**重复申请只覆盖留言**，不会给帮主堆出两条待办；申请 ≠ 入帮（mine 仍为 null）
 * 三、审批权限：不在帮会 → 50104；普通成员审批 → 50105；
 *     拒绝不写成员（申请直接删掉）；通过后人数与职位如实变化；
 *     人数上限**读配置**（本套把 GUILD_MEMBER_LIMIT 压到 3 来验，不复用默认 50）
 * 四、踢人 / 转让 / 退出：副帮主之间不能互踢、都不能踢帮主（50106）、不能踢自己（50108）；
 *     转让是**双方职位互换**，且 `leaderId` 同步改；帮主不能直接退出（50106）
 * 五、解散：管理端强制解散时成员与**待审批申请一并清除**（外键级联），玩家侧 mine 立刻变 null；
 *     删过的 id 再删是 50101
 * 六、建帮门槛（#872）：等级不足 50147、余额不足 20011、**扣款与建帮同一事务**（被拒不落库不扣钱、
 *     成功恰好推进一次修订号）、花费为 0 时免费且不写钱包
 * 七、任命副帮主（#871）：仅帮主（成员 50105）、名额 1 个（超出 50148）、帮主自己与非本帮成员 50108、
 *     重复任命幂等、`rank=member` 即卸任、`rank=leader` 不给走（40000）
 * 八、申请限额（#873，独立进程压小上限）：每帮待处理上限（第 4 条被拒 50146）、
 *     每角色同时申请上限、重复申请不涨数（幂等）、TTL 过期（懒清理：名单消失 /
 *     名额腾出 / 审批过期申请 50108）
 *
 * 与 e2e-zone 同款：**临时文件库**（要直接查 guild_members / guild_applications 确认级联）。
 */
const { spawn } = require("child_process");
const net = require("net");
const os = require("os");
const path = require("path");

const SERVER_DIR = path.join(__dirname, "..");
const ENTRY = path.join(SERVER_DIR, "dist", "main.js");

/** 本套把人数上限定成 3：第 4 个人连申请都进不来（50107），不必造几十个账号 */
const MEMBER_LIMIT = 3;

//#region 断言小工具（与 e2e-zone 同款口径）

const failures = [];
let passed = 0;
let failed = 0;

function check(ok, label, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  [OK] ${label}${detail ? " —— " + detail : ""}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  [!!] ${label}${detail ? " —— " + detail : ""}`);
  }
}

function checkEqual(actual, expected, label) {
  return check(actual === expected, `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
}

function group(label) {
  console.log(`\n▶ ${label}`);
}

//#endregion

/** 取一个空闲端口（避免与开发中的服务撞端口） */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 起一台服务（文件库；ADMIN_REGISTER_CODE 让 e2e 能开超级管理员；extraEnv 覆盖单条配置） */
async function startServer(dbPath, extraEnv = {}) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ENTRY], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      API_PREFIX: "api",
      DB_PATH: dbPath,
      JWT_SECRET: "e2e-guild-secret",
      JWT_EXPIRES_IN: "1h",
      LOG_REQUESTS: "false",
      ADMIN_REGISTER_CODE: "guild-admin-code",
      // 人数上限压到 3：验的是「上限读配置」而不是那个默认值
      GUILD_MEMBER_LIMIT: String(MEMBER_LIMIT),
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(String(chunk)));
  child.stderr.on("data", (chunk) => chunks.push(String(chunk)));

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`服务进程提前退出（code=${child.exitCode}）\n${chunks.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return { baseUrl, port, child, logs: () => chunks.join("") };
    } catch {
      /* 还没起来 */
    }
    await sleep(100);
  }
  throw new Error("等待服务启动超时");
}

/** 发一次请求，返回唯一包裹体（code / message / data） */
/** 管理端请求所在的区（#960）：一个 e2e 进程只在一个区里干活，管理端请求统一带它 */
const ADMIN_ZONE = 1;

async function api(baseUrl, method, route, options = {}) {
  const headers = { "Content-Type": "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  // 管理端单区上下文（#960）：控制台前端在请求拦截器里统一带 X-Zone-Id，测试里对等模拟
  if (options.zoneId !== undefined) headers["X-Zone-Id"] = String(options.zoneId);
  const response = await fetch(`${baseUrl}/api/${route}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return body;
}

/** 注册账号 + 建一个在线角色，返回 { token, roleId }（#597：id 由服务端生成） */
async function preparePlayer(baseUrl, username, roleName) {
  const reg = await api(baseUrl, "POST", "auth/register", { body: { username, password: "pass1234" } });
  const token = reg.data && reg.data.token;
  const created = await api(baseUrl, "POST", "roles", { token, body: { name: roleName, occupation: "1", sex: "1" } });
  const roleId = created.data && created.data.id;
  return { token, roleId };
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-guild-${Date.now()}.db`);
  const server = await startServer(dbPath);
  try {
    const { baseUrl } = server;

    //#region 准备：四个玩家 + 一个超级管理员

    group("准备：四个玩家（各一个在线角色）+ 超级管理员");
    const A = await preparePlayer(baseUrl, "guild_player_a", "帮主甲");
    const B = await preparePlayer(baseUrl, "guild_player_b", "成员乙");
    const C = await preparePlayer(baseUrl, "guild_player_c", "成员丙");
    const D = await preparePlayer(baseUrl, "guild_player_d", "成员丁");
    check(!!(A.token && B.token && C.token && D.token), "四个账号都注册并建好在线角色");

    const adminReg = await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "guild_super", password: "super-pass-1", registerCode: "guild-admin-code" },
    });
    const adminToken = adminReg.data && adminReg.data.token;
    checkEqual(adminReg.data && adminReg.data.admin.role, "super_admin", "准备：超级管理员已注册");

    // #872：建帮门槛（等级 10 + 10 万绑定元宝）出厂是**开着**的，而下面一到五组验的是帮会
    // 逻辑本身（建帮 / 申请 / 审批 / 踢人 / 转让 / 解散），不该被门槛挡住 —— 先归零。
    // 门槛自己由「七、建帮门槛」专门验（那里会重新打开、逐条踩边界），八、九组继续用归零的状态。
    const relaxGate = await api(baseUrl, "PATCH", "admin/runtime-params", {
      token: adminToken, zoneId: ADMIN_ZONE,
      body: { guild: { createLevelMin: 0, createCostBindGold: 0 } },
    });
    check(
      relaxGate.code === 0 && relaxGate.data.guild.createLevelMin === 0 && relaxGate.data.guild.createCostBindGold === 0,
      "准备：建帮门槛先归零（门槛专项在第七组）",
      JSON.stringify(relaxGate.data && { level: relaxGate.data.guild.createLevelMin, gold: relaxGate.data.guild.createCostBindGold }),
    );

    //#endregion

    //#region 一、建帮与重名

    group("一、建帮：帮主身份 / 一人一会 / 名字唯一 / 列表口径");
    const mineA0 = await api(baseUrl, "GET", "guilds/me", { token: A.token });
    checkEqual(mineA0.code, 0, "未加入时 GET /guilds/me 正常返回（200）");
    checkEqual(mineA0.data, null, "未加入时 data 为 null（客户端据此显示「创建 / 申请」）");

    const created = await api(baseUrl, "POST", "guilds", { token: A.token, body: { name: "测试帮", notice: "先立个规矩" } });
    const guildId = created.data && created.data.id;
    check(!!guildId && created.data.name === "测试帮" && created.data.notice === "先立个规矩", "建帮成功，名字与公告如实返回", JSON.stringify(created.data && { id: guildId, name: created.data.name }));
    check(created.data && created.data.myRank === "leader" && created.data.myRankLabel === "帮主", "建帮人自动成为帮主（myRank=leader）", created.data && `${created.data.myRank}/${created.data.myRankLabel}`);
    check(created.data && created.data.memberCount === 1 && created.data.members.length === 1 && created.data.members[0].roleId === A.roleId, "成员表只有建帮人一行（不是 0 也不是 2）");
    check(created.data && created.data.canReview === true && created.data.canManage === true && created.data.canDisband === true, "帮主三个能力位全开");
    checkEqual(created.data && created.data.memberLimit, MEMBER_LIMIT, "人数上限来自配置（GUILD_MEMBER_LIMIT）");

    const againA = await api(baseUrl, "POST", "guilds", { token: A.token, body: { name: "第二个帮" } });
    checkEqual(againA.code, 50103, "同一个人再建帮被拒（GUILD_ALREADY_IN 50103）", againA.message);

    const dupName = await api(baseUrl, "POST", "guilds", { token: B.token, body: { name: "测试帮" } });
    checkEqual(dupName.code, 50102, "帮会名被占用时建帮被拒（GUILD_NAME_EXISTS 50102）", dupName.message);

    const list = await api(baseUrl, "GET", "guilds", { token: B.token });
    const row = Array.isArray(list.data) && list.data[0];
    check(!!row && row.name === "测试帮" && row.leaderName === "帮主甲" && row.memberCount === 1, "列表带帮主名与人数（一行看全）", JSON.stringify(row));
    checkEqual(list.data && list.data.length, 1, "列表只有刚建的那一个帮会");

    const adminList0 = await api(baseUrl, "GET", "admin/guilds", { token: adminToken, zoneId: ADMIN_ZONE });
    check(Array.isArray(adminList0.data) && adminList0.data.length === 1, "管理端也能看到这个帮会");

    //#endregion

    //#region 一·五、帮会规则门槛读运行时参数（#605）

    group("一·五、帮会规则读运行时参数（管理端「运行时参数」页可改）");

    const rulesBefore = await api(baseUrl, "GET", "admin/runtime-params", { token: adminToken, zoneId: ADMIN_ZONE });
    checkEqual(rulesBefore.data && rulesBefore.data.guild.nameMax, 12, "帮会名上限出厂 12 字（seed 自 shared/runtime-seed）");

    const tighten = await api(baseUrl, "PATCH", "admin/runtime-params", {
      token: adminToken, zoneId: ADMIN_ZONE,
      body: { guild: { nameMax: 4, noticeMax: 6, applicationMessageMax: 5 } },
    });
    checkEqual(tighten.code, 0, "把名字上限收到 4 字 / 公告 6 字 / 留言 5 字");

    const nameTooLong = await api(baseUrl, "POST", "guilds", { token: B.token, body: { name: "六个字的名字" } });
    checkEqual(nameTooLong.code, 40000, "名字超上限被拒（40000 参数非法）", nameTooLong.message);
    check(
      typeof nameTooLong.message === "string" && nameTooLong.message.indexOf("2~4 字") >= 0,
      "提示里带的是**当前配置**的区间（不是写死的 2~12）",
      nameTooLong.message,
    );
    const noticeTooLong = await api(baseUrl, "POST", "guilds", { token: B.token, body: { name: "四字帮", notice: "这条公告明显超过六个字" } });
    checkEqual(noticeTooLong.code, 40000, "公告超上限被拒", noticeTooLong.message);
    const messageTooLong = await api(baseUrl, "POST", `guilds/${guildId}/applications`, { token: B.token, body: { message: "六个字的留言" } });
    checkEqual(messageTooLong.code, 40000, "申请留言超上限被拒", messageTooLong.message);

    // 两条被拒的建帮都没有落库：帮会表里还是只有 A 建的那一个
    const guildsAfterReject = await api(baseUrl, "GET", "admin/guilds", { token: adminToken, zoneId: ADMIN_ZONE });
    checkEqual(guildsAfterReject.data && guildsAfterReject.data.length, 1, "被拒的建帮没有落库（先校验后写）");

    const restoreRules = await api(baseUrl, "PATCH", "admin/runtime-params", {
      token: adminToken, zoneId: ADMIN_ZONE,
      body: { guild: { nameMax: 12, noticeMax: 200, applicationMessageMax: 50 } },
    });
    checkEqual(restoreRules.code, 0, "复原出厂规则");
    // 复原后同一条留言（13 字 > 刚才的 5 字上限）能提交 —— 证明规则是**每次现读**的，不是启动时定死
    const messageAfterRestore = await api(baseUrl, "POST", `guilds/${guildId}/applications`, { token: B.token, body: { message: "复原后这条留言足够长了吧" } });
    checkEqual(messageAfterRestore.code, 0, "复原后同样超长的留言能提交（规则现读，不是缓存）", messageAfterRestore.message);

    //#endregion

    //#region 二、申请与重复申请

    group("二、申请：重复申请只覆盖留言 / 申请不等于入帮");
    const applyB1 = await api(baseUrl, "POST", `guilds/${guildId}/applications`, { token: B.token, body: { message: "带我一个" } });
    checkEqual(applyB1.code, 0, "B 申请入帮成功");

    const mineA1 = await api(baseUrl, "GET", "guilds/me", { token: A.token });
    check(
      mineA1.data && mineA1.data.applicants.length === 1 && mineA1.data.applicants[0].message === "带我一个" && mineA1.data.applicants[0].roleId === B.roleId,
      "帮主看到一条待审批（申请人角色与留言都对）",
      JSON.stringify(mineA1.data && mineA1.data.applicants),
    );

    const applyB2 = await api(baseUrl, "POST", `guilds/${guildId}/applications`, { token: B.token, body: { message: "改个留言" } });
    checkEqual(applyB2.code, 0, "B 重复申请仍然成功（不报错）");
    const mineA2 = await api(baseUrl, "GET", "guilds/me", { token: A.token });
    check(
      mineA2.data && mineA2.data.applicants.length === 1 && mineA2.data.applicants[0].message === "改个留言",
      "重复申请只有一条：留言被覆盖，不堆出两条待办",
      JSON.stringify(mineA2.data && mineA2.data.applicants.map((item) => item.message)),
    );

    const mineB0 = await api(baseUrl, "GET", "guilds/me", { token: B.token });
    checkEqual(mineB0.data, null, "申请未通过时 B 仍然「没有帮会」（申请 ≠ 入帮）");

    //#endregion

    //#region 三、审批权限与人数上限

    group("三、审批：不在帮会 / 越权 / 拒绝 / 通过 / 上限");
    const reviewByB0 = await api(baseUrl, "POST", `guilds/me/applications/${B.roleId}/review`, { token: B.token, body: { approve: true } });
    checkEqual(reviewByB0.code, 50104, "不在帮会里的人审批被拒（GUILD_NOT_IN 50104）", reviewByB0.message);

    const approveB = await api(baseUrl, "POST", `guilds/me/applications/${B.roleId}/review`, { token: A.token, body: { approve: true } });
    checkEqual(approveB.data && approveB.data.memberCount, 2, "通过后成员数 2");
    check(
      approveB.data && approveB.data.applicants.length === 0 && approveB.data.members.some((item) => item.roleId === B.roleId && item.rank === "member"),
      "通过后申请列表清空、B 以普通成员入帮",
    );

    const mineB1 = await api(baseUrl, "GET", "guilds/me", { token: B.token });
    check(mineB1.data && mineB1.data.myRank === "member" && mineB1.data.myRankLabel === "成员", "B 的职位是普通成员", mineB1.data && mineB1.data.myRankLabel);
    check(mineB1.data && mineB1.data.canReview === false && mineB1.data.canManage === false && mineB1.data.canDisband === false, "普通成员三个能力位全关");
    checkEqual(mineB1.data && mineB1.data.applicants.length, 0, "普通成员看不到待审批名单（服务端不下发）");

    const applyC = await api(baseUrl, "POST", `guilds/${guildId}/applications`, { token: C.token, body: { message: "收我吗" } });
    checkEqual(applyC.code, 0, "C 申请入帮成功");

    const reviewByMember = await api(baseUrl, "POST", `guilds/me/applications/${C.roleId}/review`, { token: B.token, body: { approve: true } });
    checkEqual(reviewByMember.code, 50105, "普通成员审批被拒（GUILD_PERMISSION_DENIED 50105）", reviewByMember.message);

    const rejectC = await api(baseUrl, "POST", `guilds/me/applications/${C.roleId}/review`, { token: A.token, body: { approve: false } });
    check(rejectC.data && rejectC.data.applicants.length === 0 && rejectC.data.memberCount === 2, "拒绝后申请消失、成员数不变（拒绝不写成员）");
    const mineC0 = await api(baseUrl, "GET", "guilds/me", { token: C.token });
    checkEqual(mineC0.data, null, "被拒的 C 仍然没有帮会");

    const reviewGone = await api(baseUrl, "POST", `guilds/me/applications/${C.roleId}/review`, { token: A.token, body: { approve: true } });
    checkEqual(reviewGone.code, 50108, "对已经处理过的申请再审 = 50108（GUILD_TARGET_INVALID）", reviewGone.message);

    await api(baseUrl, "POST", `guilds/${guildId}/applications`, { token: C.token, body: { message: "再试一次" } });
    const approveC = await api(baseUrl, "POST", `guilds/me/applications/${C.roleId}/review`, { token: A.token, body: { approve: true } });
    checkEqual(approveC.data && approveC.data.memberCount, MEMBER_LIMIT, "C 重新申请被通过，成员数到达上限");

    const applyD = await api(baseUrl, "POST", `guilds/${guildId}/applications`, { token: D.token, body: { message: "还有位置吗" } });
    checkEqual(applyD.code, 50107, "人满时第 4 个人连申请都进不来（GUILD_FULL 50107）", applyD.message);

    //#endregion

    //#region 四、踢人 / 转让 / 退出

    group("四、踢人 / 转让 / 退出：职位规则与帮主的两份身份");
    const kickByMember = await api(baseUrl, "POST", `guilds/me/members/${C.roleId}/kick`, { token: B.token });
    checkEqual(kickByMember.code, 50105, "普通成员踢人被拒（50105）", kickByMember.message);

    const kickSelf = await api(baseUrl, "POST", `guilds/me/members/${A.roleId}/kick`, { token: A.token });
    checkEqual(kickSelf.code, 50108, "帮主不能踢自己（50108，退出请用专门接口）", kickSelf.message);

    const transferByMember = await api(baseUrl, "POST", "guilds/me/transfer", { token: B.token, body: { roleId: C.roleId } });
    checkEqual(transferByMember.code, 50105, "普通成员转让帮会被拒（50105）", transferByMember.message);

    const kickOutsider = await api(baseUrl, "POST", `guilds/me/members/${D.roleId}/kick`, { token: A.token });
    checkEqual(kickOutsider.code, 50108, "踢一个不在本帮的人 = 50108", kickOutsider.message);

    const kickC = await api(baseUrl, "POST", `guilds/me/members/${C.roleId}/kick`, { token: A.token });
    checkEqual(kickC.data && kickC.data.memberCount, MEMBER_LIMIT - 1, "帮主踢掉 C 后成员数 -1");
    const mineC1 = await api(baseUrl, "GET", "guilds/me", { token: C.token });
    checkEqual(mineC1.data, null, "被踢的 C 立刻没有帮会（成员行真的删了）");

    const transfer = await api(baseUrl, "POST", "guilds/me/transfer", { token: A.token, body: { roleId: B.roleId } });
    check(
      transfer.data && transfer.data.myRank === "member" && transfer.data.canDisband === false,
      "转让后我变成普通成员（canDisband 关闭）",
      transfer.data && transfer.data.myRank,
    );
    checkEqual(transfer.data && transfer.data.leaderId, B.roleId, "guilds.leader_id 同一事务里改成了 B");

    const mineB2 = await api(baseUrl, "GET", "guilds/me", { token: B.token });
    check(
      mineB2.data && mineB2.data.myRank === "leader" && mineB2.data.canDisband === true && mineB2.data.leaderName === "成员乙",
      "B 变成帮主（职位与 leaderId 两处一致，没有「显示是帮主却没权限」）",
      JSON.stringify(mineB2.data && { rank: mineB2.data.myRank, leader: mineB2.data.leaderName }),
    );

    const leaveAsLeader = await api(baseUrl, "POST", "guilds/me/leave", { token: B.token });
    checkEqual(leaveAsLeader.code, 50106, "帮主不能直接退出（GUILD_LEADER_LOCKED 50106）", leaveAsLeader.message);

    const kickLeader = await api(baseUrl, "POST", `guilds/me/members/${B.roleId}/kick`, { token: A.token });
    checkEqual(kickLeader.code, 50105, "普通成员踢帮主被拒（先判职位，50105）", kickLeader.message);

    const leaveAsMember = await api(baseUrl, "POST", "guilds/me/leave", { token: A.token });
    checkEqual(leaveAsMember.code, 0, "普通成员可以退出（200）");
    const mineA3 = await api(baseUrl, "GET", "guilds/me", { token: A.token });
    checkEqual(mineA3.data, null, "退出后 A 没有帮会");

    const mineB3 = await api(baseUrl, "GET", "guilds/me", { token: B.token });
    checkEqual(mineB3.data && mineB3.data.memberCount, 1, "退出后帮会只剩帮主一人");

    const noticeByLeader = await api(baseUrl, "POST", "guilds/me/notice", { token: B.token, body: { notice: "新规矩三条" } });
    checkEqual(noticeByLeader.data && noticeByLeader.data.notice, "新规矩三条", "帮主改公告生效（写接口返回最新的我）");

    //#endregion

    //#region 五、解散与级联

    group("五、解散 / 管理端：成员与待审批申请一并清除");
    const reapplyA = await api(baseUrl, "POST", `guilds/${guildId}/applications`, { token: A.token, body: { message: "我回来了" } });
    checkEqual(reapplyA.code, 0, "退出的 A 可以重新申请（申请行独立于成员行）");
    const mineB4 = await api(baseUrl, "GET", "guilds/me", { token: B.token });
    checkEqual(mineB4.data && mineB4.data.applicants.length, 1, "帮主看到 A 的重新申请");

    const adminDetail = await api(baseUrl, "GET", `admin/guilds/${guildId}`, { token: adminToken, zoneId: ADMIN_ZONE });
    check(
      adminDetail.data && adminDetail.data.members.length === 1 && adminDetail.data.members[0].rankLabel === "帮主",
      "管理端详情带成员名单与职位中文名",
      JSON.stringify(adminDetail.data && adminDetail.data.members),
    );

    const adminRename = await api(baseUrl, "PATCH", `admin/guilds/${guildId}`, {
      token: adminToken, zoneId: ADMIN_ZONE,
      body: { name: "改名帮", notice: "运营改名" },
    });
    check(adminRename.data && adminRename.data.name === "改名帮" && adminRename.data.notice === "运营改名", "管理端可改名与改公告");
    const mineB5 = await api(baseUrl, "GET", "guilds/me", { token: B.token });
    checkEqual(mineB5.data && mineB5.data.name, "改名帮", "改名对玩家侧立即生效（同一个帮会 id，不是新建）");

    const adminRemove = await api(baseUrl, "DELETE", `admin/guilds/${guildId}`, { token: adminToken, zoneId: ADMIN_ZONE });
    checkEqual(adminRemove.code, 0, "管理端强制解散成功");

    const mineB6 = await api(baseUrl, "GET", "guilds/me", { token: B.token });
    checkEqual(mineB6.data, null, "解散后帮主的 mine 变 null");
    const mineA4 = await api(baseUrl, "GET", "guilds/me", { token: A.token });
    checkEqual(mineA4.data, null, "解散后待审批的 A 也没有帮会（申请随帮会一起没了）");

    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const guildRows = db.prepare("SELECT COUNT(*) AS n FROM guilds").get();
    const memberRows = db.prepare("SELECT COUNT(*) AS n FROM guild_members").get();
    const applicationRows = db.prepare("SELECT COUNT(*) AS n FROM guild_applications").get();
    db.close();
    checkEqual(guildRows.n, 0, "库里 guilds 已清空");
    checkEqual(memberRows.n, 0, "成员行被外键级联删掉（没有孤儿成员）");
    checkEqual(applicationRows.n, 0, "待审批申请同样被级联删掉");

    const removeAgain = await api(baseUrl, "DELETE", `admin/guilds/${guildId}`, { token: adminToken, zoneId: ADMIN_ZONE });
    checkEqual(removeAgain.code, 50101, "删过的 id 再删 = 50101（GUILD_NOT_FOUND）", removeAgain.message);

    const patchMissing = await api(baseUrl, "PATCH", "admin/guilds/g_not_exists", { token: adminToken, zoneId: ADMIN_ZONE, body: { notice: "x" } });
    checkEqual(patchMissing.code, 50101, "改不存在的帮会 = 50101", patchMissing.message);

    //#endregion

    //#region 六、建帮门槛（#872）：等级与绑定元宝，扣款与建帮同一事务

    group("六、建帮门槛（#872）：等级不足 / 余额不足 / 扣款与建帮同一事务");

    /** 帮会表当前行数（判「被拒的建帮一行都没留」） */
    const guildCount = async () => {
      const res = await api(baseUrl, "GET", "admin/guilds", { token: adminToken, zoneId: ADMIN_ZONE });
      return Array.isArray(res.data) ? res.data.length : -1;
    };
    /** 角色存档里的绑定元宝（读权威那一份，不看接口回显） */
    const bindGoldOf = async (player) => {
      const res = await api(baseUrl, "GET", `roles/${player.roleId}`, { token: player.token });
      return res.data && res.data.data ? Number(res.data.data.bindGold) || 0 : -1;
    };

    const gateOn = await api(baseUrl, "PATCH", "admin/runtime-params", {
      token: adminToken, zoneId: ADMIN_ZONE,
      body: { guild: { createLevelMin: 10, createCostBindGold: 100000 } },
    });
    check(
      gateOn.data && gateOn.data.guild.createLevelMin === 10 && gateOn.data.guild.createCostBindGold === 100000,
      "门槛打开：等级 10 + 绑定元宝 100000（改完即是生效值，不用重启）",
      JSON.stringify(gateOn.data && gateOn.data.guild),
    );

    const countBeforeGate = await guildCount();
    const levelLow = await api(baseUrl, "POST", "guilds", { token: A.token, body: { name: "等级不够帮" } });
    checkEqual(levelLow.code, 50147, "等级不够建帮被拒（GUILD_CREATE_LEVEL_LOW 50147）", levelLow.message);
    check(
      typeof levelLow.message === "string" && levelLow.message.indexOf("10 级") >= 0,
      "提示里带门槛与当前等级（玩家知道差多少）",
      levelLow.message,
    );
    checkEqual(await guildCount(), countBeforeGate, "等级被拒的建帮没有落库");

    // 等级够了、钱包空的：钱不够是**20011**（与「等级不够」分开，客户端据此提示去攒钱）
    const raiseLevel = await api(baseUrl, "PATCH", `admin/roles/${A.roleId}`, { token: adminToken, zoneId: ADMIN_ZONE, body: { level: 10 } });
    checkEqual(raiseLevel.code, 0, "管理端把 A 提到 10 级");
    checkEqual(await bindGoldOf(A), 0, "A 的绑定元宝是 0（余额不足的前提）");
    const poorCreate = await api(baseUrl, "POST", "guilds", { token: A.token, body: { name: "没钱包" } });
    checkEqual(poorCreate.code, 20011, "余额不足建帮被拒（MALL_BIND_GOLD_NOT_ENOUGH 20011）", poorCreate.message);
    checkEqual(await guildCount(), countBeforeGate, "余额不足的建帮没有落库（先判后写）");
    checkEqual(await bindGoldOf(A), 0, "被拒之后钱包一个子儿都没动（没有半扣）");

    // 钱够：扣款与建帮同一事务 —— 建成的同时余额清零，revision 只推进一次
    const grantGold = await api(baseUrl, "PATCH", `admin/roles/${A.roleId}`, { token: adminToken, zoneId: ADMIN_ZONE, body: { bindGold: 100000 } });
    checkEqual(grantGold.code, 0, "管理端给 A 充值 100000 绑定元宝");
    const afterGrant = await api(baseUrl, "GET", `roles/${A.roleId}`, { token: A.token });
    const revisionBeforeCreate = afterGrant.data && afterGrant.data.revision;
    const richCreate = await api(baseUrl, "POST", "guilds", { token: A.token, body: { name: "门槛帮" } });
    const gateGuildId = richCreate.data && richCreate.data.id;
    checkEqual(richCreate.code, 0, "等级与余额都够时建帮成功（201）", richCreate.message);
    check(!!gateGuildId && richCreate.data.myRank === "leader", "建帮人自动成为帮主");
    checkEqual(await bindGoldOf(A), 0, "建成的同时扣掉 100000（余额归零）");
    checkEqual(await guildCount(), countBeforeGate + 1, "帮会表正好多一行");

    const walletAfter = await api(baseUrl, "GET", `roles/${A.roleId}`, { token: A.token });
    check(
      walletAfter.data && walletAfter.data.revision === revisionBeforeCreate + 1,
      "扣款恰好推进一次修订号（客户端下一次 roleUpdate 拿到新余额）",
      JSON.stringify({ before: revisionBeforeCreate, after: walletAfter.data && walletAfter.data.revision }),
    );

    // 花费归零后同一个人（已 10 级、余额 0）再建一个 —— 证明门槛真的每次现读配置
    const freeAgain = await api(baseUrl, "PATCH", "admin/runtime-params", {
      token: adminToken, zoneId: ADMIN_ZONE,
      body: { guild: { createCostBindGold: 0 } },
    });
    checkEqual(freeAgain.data && freeAgain.data.guild.createCostBindGold, 0, "把建帮花费改成 0（免费）");
    const cLeave = await api(baseUrl, "POST", "guilds/me/leave", { token: A.token });
    checkEqual(cLeave.code, 50106, "帮主不能直接退出（先解散，50106）");
    const disbandGate = await api(baseUrl, "DELETE", "guilds/me", { token: A.token });
    checkEqual(disbandGate.code, 0, "解散门槛帮（腾出位置给免费那一建）");
    const freeCreate = await api(baseUrl, "POST", "guilds", { token: A.token, body: { name: "免费帮" } });
    checkEqual(freeCreate.code, 0, "花费为 0 且等级够时建帮成功（不需要钱）", freeCreate.message);
    checkEqual(await bindGoldOf(A), 0, "免费建帮不写钱包（余额仍是 0）");

    // 收尾：把门槛恢复成「免费」，后面两组（任命 / 申请限额）不关心门槛
    const gateOff = await api(baseUrl, "PATCH", "admin/runtime-params", {
      token: adminToken, zoneId: ADMIN_ZONE,
      body: { guild: { createLevelMin: 0, createCostBindGold: 0 } },
    });
    checkEqual(gateOff.code, 0, "门槛复原成 0 / 0（后面两组用免费状态）");

    //#endregion

    //#region 七、任命副帮主（#871）：只有帮主能派、名额 1 个、同一个接口卸任

    group("七、任命副帮主（#871）：仅帮主 / 名额上限 / 卸任 / 幂等");

    const currentGuildId = freeCreate.data && freeCreate.data.id;
    await api(baseUrl, "POST", `guilds/${currentGuildId}/applications`, { token: B.token, body: { message: "来" } });
    await api(baseUrl, "POST", `guilds/${currentGuildId}/applications`, { token: C.token, body: { message: "也来" } });
    const approveB2 = await api(baseUrl, "POST", `guilds/me/applications/${B.roleId}/review`, { token: A.token, body: { approve: true } });
    checkEqual(approveB2.data && approveB2.data.memberCount, 2, "B 入帮（帮主 + B 两人）");
    const approveC2 = await api(baseUrl, "POST", `guilds/me/applications/${C.roleId}/review`, { token: A.token, body: { approve: true } });
    checkEqual(approveC2.data && approveC2.data.memberCount, MEMBER_LIMIT, "C 入帮（到人数上限，任命用例只要 3 人）");

    const rankOf = (guild, roleId) => {
      const member = guild && Array.isArray(guild.members) ? guild.members.find((item) => item.roleId === roleId) : null;
      return member ? member.rank : "";
    };

    const appointByMember = await api(baseUrl, "POST", "guilds/me/rank", { token: B.token, body: { roleId: C.roleId, rank: "vice" } });
    checkEqual(appointByMember.code, 50105, "普通成员任命副帮主被拒（50105）", appointByMember.message);

    const appointB = await api(baseUrl, "POST", "guilds/me/rank", { token: A.token, body: { roleId: B.roleId, rank: "vice" } });
    checkEqual(rankOf(appointB.data, B.roleId), "vice", "帮主把 B 任命为副帮主（成员行 rank = vice）");
    check(
      appointB.data && appointB.data.canAppoint === true && appointB.data.canDisband === true,
      "帮主的 canAppoint / canDisband 仍为 true（任命别人不影响自己）",
      JSON.stringify(appointB.data && { appoint: appointB.data.canAppoint, disband: appointB.data.canDisband }),
    );

    const appointSecond = await api(baseUrl, "POST", "guilds/me/rank", { token: A.token, body: { roleId: C.roleId, rank: "vice" } });
    checkEqual(appointSecond.code, 50148, "名额只有 1 个：再任命一个人被拒（GUILD_VICE_LIMIT 50148）", appointSecond.message);
    checkEqual(rankOf(appointSecond.data, C.roleId), "", "被拒之后 C 的职位没变（响应为空，看原名单）");

    const appointLeader = await api(baseUrl, "POST", "guilds/me/rank", { token: A.token, body: { roleId: A.roleId, rank: "member" } });
    checkEqual(appointLeader.code, 50108, "帮主自己的职位不能从这里改（50108，换帮主走转让）", appointLeader.message);

    const appointOutsider = await api(baseUrl, "POST", "guilds/me/rank", { token: A.token, body: { roleId: D.roleId, rank: "vice" } });
    checkEqual(appointOutsider.code, 50108, "任命一个不在本帮的人 = 50108", appointOutsider.message);

    const appointAgain = await api(baseUrl, "POST", "guilds/me/rank", { token: A.token, body: { roleId: B.roleId, rank: "vice" } });
    checkEqual(appointAgain.code, 0, "对已经是副帮主的人再任命一次是幂等成功（不占两个名额）", appointAgain.message);
    checkEqual(rankOf(appointAgain.data, B.roleId), "vice", "幂等任命后职位仍是副帮主");

    const mineB7 = await api(baseUrl, "GET", "guilds/me", { token: B.token });
    check(
      mineB7.data && mineB7.data.myRank === "vice" && mineB7.data.myRankLabel === "副帮主" && mineB7.data.canManage === true,
      "B 侧看到自己是副帮主（中文名由服务端给，管理位打开）",
      JSON.stringify(mineB7.data && { rank: mineB7.data.myRank, label: mineB7.data.myRankLabel }),
    );
    check(mineB7.data && mineB7.data.canAppoint === false && mineB7.data.canDisband === false, "副帮主不能任命、不能解散（canAppoint / canDisband 关闭）");

    const demoteB = await api(baseUrl, "POST", "guilds/me/rank", { token: A.token, body: { roleId: B.roleId, rank: "member" } });
    checkEqual(rankOf(demoteB.data, B.roleId), "member", "帮主把 B 卸任回普通成员（同一接口 rank=member）");
    const mineB8 = await api(baseUrl, "GET", "guilds/me", { token: B.token });
    check(mineB8.data && mineB8.data.canManage === false, "卸任后 B 的管理位关闭");

    const appointCAfterDemote = await api(baseUrl, "POST", "guilds/me/rank", { token: A.token, body: { roleId: C.roleId, rank: "vice" } });
    checkEqual(rankOf(appointCAfterDemote.data, C.roleId), "vice", "卸任腾出名额后可以任命别人（名额是按现有人数算的）");

    const badRank = await api(baseUrl, "POST", "guilds/me/rank", { token: A.token, body: { roleId: B.roleId, rank: "leader" } });
    checkEqual(badRank.code, 40000, "rank 只认 vice / member（传 leader 是 40000 参数非法，不给绕过转让留缝）", badRank.message);

    //#endregion

    //#region 八、申请限额（#873，独立进程压小上限）

    // 上限与 TTL 都压小才能在测试里踩到边界：每帮 3 / 每人 2 / TTL 800ms（真值 50 / 5 / 24h
    // 的「读配置」由本套第一台服务间接保证 —— memberLimit 同款口径，生产值由 .env.example 登记）。
    // 「24h 过期」的假时钟就是压 TTL：过期判断读的是同一个 Date.now()，压短等价于把时钟拨快。
    group("八、申请限额（#873）：每帮上限 / 每人上限 / TTL 过期（独立进程）");
    const limitDbPath = path.join(os.tmpdir(), `olua-e2e-guild-limit-${Date.now()}.db`);
    const limitServer = await startServer(limitDbPath, {
      GUILD_APPLICATION_LIMIT_PER_GUILD: "3",
      GUILD_APPLICATION_LIMIT_PER_ROLE: "2",
      GUILD_APPLICATION_TTL_MS: "800",
    });
    try {
      const lb = limitServer.baseUrl;

      // #872：这台独立进程读的是**出厂**运行时参数（建帮门槛 10 级 + 10 万绑定元宝是开着的），
      // 而本组只验申请配额，三个帮主都是刚建号的 1 级：先归零，否则连帮会都建不出来。
      const limitAdminReg = await api(lb, "POST", "admin/auth/register", {
        body: { username: "guild_limit_super", password: "super-pass-1", registerCode: "guild-admin-code" },
      });
      const limitAdminToken = limitAdminReg.data && limitAdminReg.data.token;
      const limitGateOff = await api(lb, "PATCH", "admin/runtime-params", {
        token: limitAdminToken, zoneId: ADMIN_ZONE,
        body: { guild: { createLevelMin: 0, createCostBindGold: 0 } },
      });
      check(limitGateOff.code === 0, "（独立进程）建帮门槛先归零（1 级新号才建得了帮）", JSON.stringify(limitGateOff.message));

      const L1 = await preparePlayer(lb, "guild_limit_l1", "一帮帮主");
      const L2 = await preparePlayer(lb, "guild_limit_l2", "二帮帮主");
      const L3 = await preparePlayer(lb, "guild_limit_l3", "三帮帮主");
      const g1 = await api(lb, "POST", "guilds", { token: L1.token, body: { name: "一帮" } });
      const g2 = await api(lb, "POST", "guilds", { token: L2.token, body: { name: "二帮" } });
      const g3 = await api(lb, "POST", "guilds", { token: L3.token, body: { name: "三帮" } });
      const g1id = g1.data && g1.data.id;
      const g2id = g2.data && g2.data.id;
      const g3id = g3.data && g3.data.id;
      check(!!g1id && !!g2id && !!g3id, "三个帮会就绪");

      const P1 = await preparePlayer(lb, "guild_limit_p1", "申请一");
      const P2 = await preparePlayer(lb, "guild_limit_p2", "申请二");
      const P3 = await preparePlayer(lb, "guild_limit_p3", "申请三");
      const P4 = await preparePlayer(lb, "guild_limit_p4", "申请四");

      // —— 每帮待处理上限：第 4 条被拒 ——
      const a1 = await api(lb, "POST", `guilds/${g1id}/applications`, { token: P1.token, body: { message: "1" } });
      const a2 = await api(lb, "POST", `guilds/${g1id}/applications`, { token: P2.token, body: { message: "2" } });
      const a3 = await api(lb, "POST", `guilds/${g1id}/applications`, { token: P3.token, body: { message: "3" } });
      check(a1.code === 0 && a2.code === 0 && a3.code === 0, "前三条申请都进得来（配额 3）");
      const a4 = await api(lb, "POST", `guilds/${g1id}/applications`, { token: P4.token, body: { message: "4" } });
      check(
        a4.code === 50146 && typeof a4.message === "string" && a4.message.includes("名额已满"),
        "第 4 条申请被拒（GUILD_APPLICATION_LIMIT 50146，文案指向本帮名额）",
        `${a4.code} ${a4.message}`,
      );

      // —— 每角色同时申请上限：P1 已挂 G1 一条，再挂 G2 可以，挂 G3 被拒 ——
      const p1g2 = await api(lb, "POST", `guilds/${g2id}/applications`, { token: P1.token, body: { message: "也想去二帮" } });
      checkEqual(p1g2.code, 0, "P1 挂第二个帮的申请成功（每人配额 2）");
      const p1g3 = await api(lb, "POST", `guilds/${g3id}/applications`, { token: P1.token, body: { message: "三帮也要" } });
      check(
        p1g3.code === 50146 && typeof p1g3.message === "string" && p1g3.message.includes("同时最多申请 2 个"),
        "P1 挂第三个帮的申请被拒（50146，文案指向自己的申请数）",
        `${p1g3.code} ${p1g3.message}`,
      );

      // —— 幂等回归：重复申请只覆盖留言，配额不涨 ——
      const p1g2again = await api(lb, "POST", `guilds/${g2id}/applications`, { token: P1.token, body: { message: "改留言" } });
      checkEqual(p1g2again.code, 0, "重复申请仍然成功（幂等）");
      const mineL2 = await api(lb, "GET", "guilds/me", { token: L2.token });
      check(
        mineL2.data && mineL2.data.applicants.length === 1 && mineL2.data.applicants[0].message === "改留言",
        "二帮帮主仍只看到一条，且留言是最新的（配额没被重复申请吃掉）",
        JSON.stringify(mineL2.data && mineL2.data.applicants.map((item) => item.message)),
      );

      // —— TTL 过期（懒清理）：等过 TTL，名单清空、名额腾出、审批过期申请 50108 ——
      await sleep(1200);
      const mineL2after = await api(lb, "GET", "guilds/me", { token: L2.token });
      check(
        mineL2after.data && mineL2after.data.applicants.length === 0,
        "超过 TTL 后帮主名单里的过期申请消失（看名单时懒清理）",
        JSON.stringify(mineL2after.data && mineL2after.data.applicants && mineL2after.data.applicants.length),
      );
      const p4retry = await api(lb, "POST", `guilds/${g1id}/applications`, { token: P4.token, body: { message: "4" } });
      checkEqual(p4retry.code, 0, "过期申请不再占配额：P4 现在申请得进来");
      const reviewExpired = await api(lb, "POST", `guilds/me/applications/${P1.roleId}/review`, { token: L2.token, body: { approve: true } });
      checkEqual(reviewExpired.code, 50108, "审批一条已过期的申请 = 50108（当作不存在）", reviewExpired.message);
    } finally {
      limitServer.child.kill();
      await sleep(100);
    }

    //#endregion
  } finally {
    server.child.kill();
  }

  if (failed > 0) {
    console.log(`\n❌ 帮会 e2e：${failed} 条失败`);
    for (const item of failures) console.log(`   - ${item}`);
    process.exitCode = 1;
  } else {
    console.log(`\n✅ 帮会 e2e 全绿（${passed} 条断言）`);
  }
})();
