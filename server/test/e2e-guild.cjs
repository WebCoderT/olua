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
const EXPECTED_ASSERTIONS = 60;

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

function assertExpectedCount() {
  if (passed === EXPECTED_ASSERTIONS) return;
  console.log(`\n❌ 断言条数变了：期望 ${EXPECTED_ASSERTIONS}，实际 ${passed + failed}`);
  console.log("   改了断言就同步这个常量，以及文档里的 e2e 总数（make audit 会比对）");
  process.exitCode = 1;
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

/** 起一台服务（文件库；ADMIN_REGISTER_CODE 让 e2e 能开超级管理员） */
async function startServer(dbPath) {
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
async function api(baseUrl, method, route, options = {}) {
  const headers = { "Content-Type": "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
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

/** 一份最小可建号的角色文档（e2e-zone 同款口径） */
function roleData(id, name) {
  return { id, name, occupation: "1", sex: "1", level: 1, hp: 100, mp: 50, equipments: {}, bag: [], skills: {} };
}

/** 注册账号 + 建一个在线角色，返回 { token, roleId } */
async function preparePlayer(baseUrl, username, roleId, roleName) {
  const reg = await api(baseUrl, "POST", "auth/register", { body: { username, password: "pass1234" } });
  const token = reg.data && reg.data.token;
  await api(baseUrl, "POST", "roles", { token, body: { data: roleData(roleId, roleName) } });
  return { token, roleId };
}

(async () => {
  const dbPath = path.join(os.tmpdir(), `olua-e2e-guild-${Date.now()}.db`);
  const server = await startServer(dbPath);
  try {
    const { baseUrl } = server;

    //#region 准备：四个玩家 + 一个超级管理员

    group("准备：四个玩家（各一个在线角色）+ 超级管理员");
    const A = await preparePlayer(baseUrl, "guild_player_a", "guild_role_a", "帮主甲");
    const B = await preparePlayer(baseUrl, "guild_player_b", "guild_role_b", "成员乙");
    const C = await preparePlayer(baseUrl, "guild_player_c", "guild_role_c", "成员丙");
    const D = await preparePlayer(baseUrl, "guild_player_d", "guild_role_d", "成员丁");
    check(!!(A.token && B.token && C.token && D.token), "四个账号都注册并建好在线角色");

    const adminReg = await api(baseUrl, "POST", "admin/auth/register", {
      body: { username: "guild_super", password: "super-pass-1", registerCode: "guild-admin-code" },
    });
    const adminToken = adminReg.data && adminReg.data.token;
    checkEqual(adminReg.data && adminReg.data.admin.role, "super_admin", "准备：超级管理员已注册");

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

    const adminList0 = await api(baseUrl, "GET", "admin/guilds", { token: adminToken });
    check(Array.isArray(adminList0.data) && adminList0.data.length === 1, "管理端也能看到这个帮会");

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

    const adminDetail = await api(baseUrl, "GET", `admin/guilds/${guildId}`, { token: adminToken });
    check(
      adminDetail.data && adminDetail.data.members.length === 1 && adminDetail.data.members[0].rankLabel === "帮主",
      "管理端详情带成员名单与职位中文名",
      JSON.stringify(adminDetail.data && adminDetail.data.members),
    );

    const adminRename = await api(baseUrl, "PATCH", `admin/guilds/${guildId}`, {
      token: adminToken,
      body: { name: "改名帮", notice: "运营改名" },
    });
    check(adminRename.data && adminRename.data.name === "改名帮" && adminRename.data.notice === "运营改名", "管理端可改名与改公告");
    const mineB5 = await api(baseUrl, "GET", "guilds/me", { token: B.token });
    checkEqual(mineB5.data && mineB5.data.name, "改名帮", "改名对玩家侧立即生效（同一个帮会 id，不是新建）");

    const adminRemove = await api(baseUrl, "DELETE", `admin/guilds/${guildId}`, { token: adminToken });
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

    const removeAgain = await api(baseUrl, "DELETE", `admin/guilds/${guildId}`, { token: adminToken });
    checkEqual(removeAgain.code, 50101, "删过的 id 再删 = 50101（GUILD_NOT_FOUND）", removeAgain.message);

    const patchMissing = await api(baseUrl, "PATCH", "admin/guilds/g_not_exists", { token: adminToken, body: { notice: "x" } });
    checkEqual(patchMissing.code, 50101, "改不存在的帮会 = 50101", patchMissing.message);

    //#endregion
  } finally {
    server.child.kill();
  }

  assertExpectedCount();
  if (failed > 0) {
    console.log(`\n❌ 帮会 e2e：${failed} 条失败`);
    for (const item of failures) console.log(`   - ${item}`);
    process.exitCode = 1;
  } else {
    console.log(`\n✅ 帮会 e2e 全绿（${passed} 条断言）`);
  }
})();
