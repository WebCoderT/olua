#!/usr/bin/env node
/**
 * 角色管理专项端到端验证（服务端）
 *
 * 与 test/e2e.cjs 的关系：那份覆盖全链路（含账号 / 权限 / 文档分组），这一份只盯**角色管理**这一块，
 * 所以新能力（筛选、更多可编辑字段、批量删除、修订号乐观锁）都在这里逐条钉死，改坏了单独跑它就够。
 *
 * 覆盖：
 * · 玩家侧：revision 从 1 起、每次落库 +1；带旧 revision 保存被拒（20006）；不带 revision 仍是旧行为（向后兼容）
 * · 管理端列表：online / occupation / sex / minLevel / maxLevel / keyword / accountId 筛选，等级区间写反报参数错误
 * · 管理端修改：基础信息（含时装 / 头像 / 所在地图）、装备表 / 技能表 / 背包格子（结构化校验）、同账号重名校验
 * · 批量删除：按 id 删（幂等）、清空某账号全部角色、在线标记被顺带清掉
 * · 权限：只读观察员调写接口一律 403 / 30006
 * · 派生属性：详情带服务端重算的战斗属性；与客户端上报值比对（不一致可观测）；
 *   管理端改等级后立即重算；列表**不带**（只有详情带）；等级不在曲线里时如实给 null
 * · 文档：新接口落在「管理端」分组且带权限点标注
 *
 * 用法：先 `npm run build`，再 `node test/e2e-roles.cjs`
 */
process.env.DB_PATH = ":memory:";
process.env.ADMIN_REGISTER_CODE = "test-admin-code";
process.env.JWT_SECRET = "test-secret";
process.env.LOG_REQUESTS = "false";

process.env.CORS_ORIGINS = "*";

const { NestFactory } = require("@nestjs/core");
const { ValidationPipe } = require("@nestjs/common");
const { AppModule } = require("../dist/app.module");
const { AllExceptionsFilter } = require("../dist/common/filters/all-exceptions.filter");
const { TransformInterceptor } = require("../dist/common/interceptors/transform.interceptor");
const { setupSwagger } = require("../dist/swagger/setup");

//#region 断言小工具

/**
 * 期望的断言条数（全绿时必须恰好这么多）
 *
 * 为什么要有这个数：`README.md` 与 `docs/resume.md` 里都写着「服务端 N 条 e2e」，
 * 而那个 N 是六套之和。没有它，加/删一条断言不会有人发现，总数只会一年一年地漂 ——
 * 本仓库的原则是「把坑变成脚本」，所以这里让条数变化**当场**报错。
 *
 * 改了断言就改这个数，然后跑 `make audit`（`audit-doc-numbers` 会比对文档里的数字）。
 */
const EXPECTED_ASSERTIONS = 119;

/** 条数对不上就退出（有失败时不重复报 —— 那时本来就会 FAIL） */
function assertExpectedCount(passedCount, failureCount) {
  if (failureCount !== 0) return;
  if (passedCount === EXPECTED_ASSERTIONS) return;
  console.log(`\n❌ 断言条数变了：期望 ${EXPECTED_ASSERTIONS}，实际 ${passedCount}`);
  console.log("   改了断言就同步这个常量，以及文档里的 e2e 总数（README.md / docs/resume.md；make audit 会比对）");
  process.exit(1);
}

let passed = 0;
const failures = [];

function check(condition, label, extra) {
  if (condition) {
    passed += 1;
    return true;
  }
  failures.push(extra === undefined ? label : `${label}（实际：${extra}）`);
  return false;
}

function finish(message) {
  console.log("");
  if (failures.length === 0) {
    assertExpectedCount(passed, failures.length);
    console.log(`${message}（共 ${passed} 条断言）`);
    process.exit(0);
  }
  console.log(`FAIL：${failures.length} 条断言未通过（通过 ${passed} 条）`);
  failures.forEach((item, index) => console.log(`  ${index + 1}. ${item}`));
  process.exit(1);
}

//#endregion

let baseUrl = "";

/**
 * 发一次请求，返回归一后的结果
 * @returns {Promise<{ status: number, code: number, message: string, data: any }>}
 */
async function api(method, path, options = {}) {
  const headers = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(`${baseUrl}/${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const envelope = await response.json().catch(() => null);
  return {
    status: response.status,
    code: envelope ? envelope.code : -1,
    message: envelope ? envelope.message : "",
    data: envelope ? envelope.data : null,
  };
}

/** 造一份合法的角色数据（服务端只校验结构 + 索引字段） */
function roleData(id, name, occupation, level) {
  return {
    id,
    name,
    occupation,
    sex: "1",
    level,
    gold: 1000,
    bindGold: 0,
    silver: 0,
    exp: 0,
    bag: [[null, null], [null, null]],
    equipments: { WEAPON: null, HELMET: null },
    skills: { "1001": 1 },
    shortcutKeys: [],
    onMap: "0",
  };
}

(async () => {
  const app = await NestFactory.create(AppModule.register({ realtime: true }), { logger: false });
  app.setGlobalPrefix("api");
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, transformOptions: { enableImplicitConversion: true } }));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new TransformInterceptor());
  // 文档挂载点与 main.ts 同一份实现（否则测试验的就不是真正跑起来的那份文档）
  setupSwagger(app);
  await app.listen(0);
  baseUrl = `${await app.getUrl()}/api`;

  /** 后端：注册超管 + 两个玩家账号 + 一个只读观察员 */
  const superAdmin = await api("POST", "admin/auth/register", {
    body: { username: "gm_role", password: "pass1234", registerCode: "test-admin-code" },
  });
  const adminToken = superAdmin.data.token;
  check(superAdmin.code === 0 && !!adminToken, "准备：注册管理员拿到令牌", superAdmin.message);

  const viewer = await api("POST", "admin/auth/register", { body: { username: "gm_view", password: "pass1234", registerCode: "test-admin-code" } });
  const viewerToken = viewer.data.token;
  await api("PATCH", `admin/admins/${viewer.data.admin.id}`, { token: adminToken, body: { role: "viewer" } });
  const viewerMe = await api("GET", "admin/auth/me", { token: viewerToken });
  check(viewerMe.data.role === "viewer", "准备：只读观察员已就位", viewerMe.data && viewerMe.data.role);

  const playerA = await api("POST", "auth/register", { body: { username: "role_player_a", password: "pass1234" } });
  const playerB = await api("POST", "auth/register", { body: { username: "role_player_b", password: "pass1234" } });
  const tokenA = playerA.data.token;
  const tokenB = playerB.data.token;
  const accountA = playerA.data.account.id;
  const accountB = playerB.data.account.id;
  check(!!tokenA && !!tokenB, "准备：注册两个玩家账号");

  //#region 一、玩家侧：修订号（乐观锁）

  console.log("— 一、玩家侧：修订号从 1 起，每次落库 +1 —");

  const roleA1 = await api("POST", "roles", { token: tokenA, body: { data: roleData("role_a1", "甲一", "1", 5) } });
  check(roleA1.code === 0 && roleA1.data.revision === 1, "新建角色 revision 从 1 开始", JSON.stringify(roleA1.data && roleA1.data.revision));
  check(roleA1.data.online === true, "第一个角色自动成为在线角色");
  check(roleA1.data.data.revision === undefined, "revision 是索引列，不会留在角色文档里", JSON.stringify(roleA1.data.data.revision));

  const roleA2 = await api("POST", "roles", { token: tokenA, body: { data: roleData("role_a2", "甲二", "2", 10) } });
  const roleA3 = await api("POST", "roles", { token: tokenA, body: { data: roleData("role_a3", "甲三", "3", 20) } });
  check(roleA2.code === 0 && roleA3.code === 0, "同一账号可连续创建多个角色（数量不设上限）");

  const saved1 = await api("PUT", "roles/role_a1", { token: tokenA, body: { data: roleData("role_a1", "甲一", "1", 6) } });
  check(saved1.code === 0 && saved1.data.revision === 2, "不带 revision 保存仍然可用（向后兼容），revision 递增到 2", JSON.stringify(saved1.data && saved1.data.revision));

  const saved2 = await api("PUT", "roles/role_a1", { token: tokenA, body: { data: roleData("role_a1", "甲一", "1", 7), revision: 2 } });
  check(saved2.code === 0 && saved2.data.revision === 3, "带正确 revision 保存成功，revision 到 3", JSON.stringify(saved2.data && saved2.data.revision));

  const stale = await api("PUT", "roles/role_a1", { token: tokenA, body: { data: roleData("role_a1", "甲一", "1", 8), revision: 2 } });
  check(stale.code === 20006 && stale.status === 409, "带过期 revision 保存被拒（20006 / 409）", `${stale.code}/${stale.status}`);

  const afterStale = await api("GET", "roles/role_a1", { token: tokenA });
  check(afterStale.data.level === 7, "被拒的保存没有写库（还是上一次的值 7）", `${afterStale.data.level}`);
  check(afterStale.data.revision === 3, "详情里的 revision 与服务端一致", `${afterStale.data.revision}`);

  const crossAccount = await api("GET", "roles/role_a1", { token: tokenB });
  check(crossAccount.code === 40300 && crossAccount.status === 403, "别的账号读不到该角色（越权 403）", `${crossAccount.code}/${crossAccount.status}`);

  //#endregion

  //#region 一之二、新手引导进度（#402）：服务端只校验结构 + 体量

  console.log("— 一之二、新手引导进度：结构 + 体量校验，不认客户端的步骤含义 —");

  const guidedData = { ...roleData("role_a1", "甲一", "1", 7), guide: { step: 2, done: false, skipped: false } };
  const guideSaved = await api("PUT", "roles/role_a1", { token: tokenA, body: { data: guidedData, revision: 3 } });
  check(guideSaved.code === 0 && guideSaved.data.data.guide.step === 2, "指南进度原样落库（step 2）", JSON.stringify(guideSaved.data.data && guideSaved.data.data.guide));
  const guideRead = await api("GET", "roles/role_a1", { token: tokenA });
  check(guideRead.data.data.guide.done === false && guideRead.data.data.guide.skipped === false, "三个标记原样读回（done / skipped）", JSON.stringify(guideRead.data.data && guideRead.data.data.guide));

  const guideOverflow = await api("PUT", "roles/role_a1", { token: tokenA, body: { data: { ...guidedData, guide: { step: 65, done: false, skipped: false } }, revision: 4 } });
  check(guideOverflow.code === 20003, "步数越界被拒（20003，不是静默夹取）", `${guideOverflow.code}`);

  const guideFraction = await api("PUT", "roles/role_a1", { token: tokenA, body: { data: { ...guidedData, guide: { step: 1.5, done: false, skipped: false } }, revision: 4 } });
  check(guideFraction.code === 20003, "步数不是整数被拒（20003）", `${guideFraction.code}`);

  const guideBadFlag = await api("PUT", "roles/role_a1", { token: tokenA, body: { data: { ...guidedData, guide: { step: 1, done: "yes", skipped: false } }, revision: 4 } });
  check(guideBadFlag.code === 20003, "done 不是布尔被拒（20003）", `${guideBadFlag.code}`);

  const guideExtra = await api("PUT", "roles/role_a1", { token: tokenA, body: { data: { ...guidedData, guide: { step: 3, done: false, skipped: true, evil: "x" } }, revision: 4 } });
  check(guideExtra.code === 0 && guideExtra.data.data.guide.evil === undefined && guideExtra.data.data.guide.skipped === true, "多余字段被丢弃、三个已知字段保留", JSON.stringify(guideExtra.data.data && guideExtra.data.data.guide));

  // 老档（没有 guide 字段）照样能存，且**服务端不会凭空补一个** ——
  // 客户端正是靠「文档里有没有这个字段」区分老号与新号（无字段 = 引导上线前就在的角色）
  const legacySaved = await api("PUT", "roles/role_a1", { token: tokenA, body: { data: roleData("role_a1", "甲一", "1", 7) } });
  check(legacySaved.code === 0 && legacySaved.data.data.guide === undefined, "没有 guide 字段的老档照常保存，服务端不补默认值", JSON.stringify(legacySaved.data.data && legacySaved.data.data.guide));

  //#endregion

  //#region 二、管理端：检索与筛选

  console.log("— 二、管理端：检索与筛选 —");

  await api("POST", "roles", { token: tokenB, body: { data: roleData("role_b1", "乙一", "2", 30) } });

  const all = await api("GET", "admin/roles", { token: adminToken });
  check(all.code === 0 && all.data.total === 4, "角色列表返回全量（4 个）", JSON.stringify(all.data && all.data.total));

  const onlineOnly = await api("GET", "admin/roles?online=true", { token: adminToken });
  check(onlineOnly.data.total === 2, "online=true 只返回各账号当前选中的角色（2 个）", JSON.stringify(onlineOnly.data.total));
  check(
    onlineOnly.data.list.every((item) => item.online === true),
    "筛选结果的 online 字段全为 true",
  );

  const offlineOnly = await api("GET", "admin/roles?online=false", { token: adminToken });
  check(offlineOnly.data.total === 2, "online=false 只返回离线角色（2 个）", JSON.stringify(offlineOnly.data.total));
  check(
    offlineOnly.data.list.every((item) => item.online === false),
    "筛选结果的 online 字段全为 false",
  );

  const byOccupation = await api("GET", "admin/roles?occupation=2", { token: adminToken });
  check(byOccupation.data.total === 2, "按职业筛选（职业 2 有 2 个）", JSON.stringify(byOccupation.data.total));

  const byLevel = await api("GET", "admin/roles?minLevel=10&maxLevel=20", { token: adminToken });
  check(byLevel.data.total === 2, "按等级区间筛选（10~20 有 2 个）", JSON.stringify(byLevel.data.total));

  const badRange = await api("GET", "admin/roles?minLevel=20&maxLevel=10", { token: adminToken });
  check(badRange.code === 40000, "等级区间写反直接报参数错误（否则会得到一个莫名空的列表）", `${badRange.code}`);

  const byAccount = await api("GET", `admin/roles?accountId=${accountA}`, { token: adminToken });
  check(byAccount.data.total === 3, "按账号筛选（甲有 3 个角色）", JSON.stringify(byAccount.data.total));

  const byKeyword = await api("GET", "admin/roles?keyword=role_b", { token: adminToken });
  check(byKeyword.data.total === 1 && byKeyword.data.list[0].id === "role_b1", "关键字匹配角色 id", JSON.stringify(byKeyword.data.total));

  const withAccountName = all.data.list.every((item) => typeof item.accountName === "string");
  check(withAccountName, "列表带所属账号名（一次 join 拿全，不做 N+1）");

  //#endregion

  //#region 三、管理端：修改角色（基础信息 + 运行时数据）

  console.log("— 三、管理端：修改角色（基础信息 + 运行时数据） —");

  // 时装：`fashionCloth` 在 #377 从数字改成**时装 id**（fashions 表主键），管理端也只能填字符串
  const patched = await api("PATCH", "admin/roles/role_a2", {
    token: adminToken,
    body: { name: "甲二改", level: 11, fashionCloth: "cloth_2", avatar: 7, onMap: "12", gold: 8888 },
  });
  check(patched.code === 0, "改基础信息成功", patched.message);
  check(patched.data.name === "甲二改" && patched.data.level === 11, "索引字段同步更新（列表里看到的就是新名字）");
  check(patched.data.data.fashionCloth === "cloth_2" && patched.data.data.avatar === 7 && patched.data.data.onMap === "12", "时装 / 头像 / 所在地图写进角色数据");
  check(patched.data.data.gold === 8888, "数值字段写进角色数据");
  check(patched.data.revision === 2, "管理端改一次，修订号 +1", JSON.stringify(patched.data.revision));

  const numericFashion = await api("PATCH", "admin/roles/role_a2", { token: adminToken, body: { fashionCloth: 3 } });
  check(numericFashion.code === 40000 && numericFashion.status === 400, "时装填旧形状的数字被拒（只收时装 id）", `${numericFashion.code}/${numericFashion.status}`);
  const unknownFashion = await api("PATCH", "admin/roles/role_a2", { token: adminToken, body: { fashionCloth: "no_such_fashion" } });
  check(unknownFashion.code === 0 && unknownFashion.data.revision === 3, "任意字符串都收（清单外 id 由客户端按 null 兜底）", JSON.stringify(unknownFashion.data?.revision));
  const clearedFashion = await api("PATCH", "admin/roles/role_a2", { token: adminToken, body: { fashionCloth: null } });
  check(clearedFashion.code === 0 && clearedFashion.data.data.fashionCloth === null, "传 null = 脱下（清空穿戴）");

  const duplicateName = await api("PATCH", "admin/roles/role_a2", { token: adminToken, body: { name: "甲三" } });
  check(duplicateName.code === 20005 && duplicateName.status === 409, "同账号下改名撞车被拒（20005）", `${duplicateName.code}/${duplicateName.status}`);

  const runtime = await api("PATCH", "admin/roles/role_a2", {
    token: adminToken,
    body: {
      equipments: { WEAPON: "1001", HELMET: "" },
      skills: { "1001": 3, "1002": 0 },
      bag: [
        { row: 0, col: 1, id: "2001", count: 5 },
        { row: 3, col: 4, id: "3001", count: 1 },
      ],
    },
  });
  check(runtime.code === 0, "改装备 / 技能 / 背包成功", runtime.message);
  check(runtime.data.data.equipments.WEAPON === "1001" && runtime.data.data.equipments.HELMET === null, "装备表：空串规整成 null（卸下）");
  check(runtime.data.data.skills["1001"] === 3 && runtime.data.data.skills["1002"] === 0, "技能表按 id 写等级");
  check(runtime.data.data.bag.length === 4 && runtime.data.data.bag[0].length === 5, "背包网格按最远的格子自动扩到刚好放下", `${runtime.data.data.bag.length}×${runtime.data.data.bag[0].length}`);
  check(runtime.data.data.bag[0][1].id === "2001" && runtime.data.data.bag[0][1].count === 5, "背包物品落在正确的格子上");
  check(runtime.data.data.bag[1][0] === null, "未提交的格子是空的");

  const clearBag = await api("PATCH", "admin/roles/role_a2", { token: adminToken, body: { bag: [] } });
  check(
    clearBag.data.data.bag.every((row) => row.every((cell) => cell === null)) && clearBag.data.data.bag.length === 4,
    "背包传空数组 = 清空（网格尺寸保留）",
  );

  const dupCell = await api("PATCH", "admin/roles/role_a2", {
    token: adminToken,
    body: { bag: [{ row: 0, col: 0, id: "1", count: 1 }, { row: 0, col: 0, id: "2", count: 1 }] },
  });
  check(dupCell.code === 20003 && dupCell.status === 400, "背包格子坐标重复被拒（20003）", `${dupCell.code}/${dupCell.status}`);

  const badAxis = await api("PATCH", "admin/roles/role_a2", { token: adminToken, body: { bag: [{ row: 999, col: 0, id: "1", count: 1 }] } });
  check(badAxis.code === 40000, "背包行号越界被拦下（DTO 40000）", `${badAxis.code}`);

  const badCount = await api("PATCH", "admin/roles/role_a2", { token: adminToken, body: { bag: [{ row: 0, col: 0, id: "1", count: 0 }] } });
  check(badCount.code === 40000, "背包数量为 0 被拦下（DTO 40000）", `${badCount.code}`);

  const lostProps = await api("PATCH", "admin/roles/role_a2", { token: adminToken, body: { bag: [{ row: 0, col: 0, id: "9001", count: 2 }] } });
  check(
    lostProps.data.data.bag[0][0] && lostProps.data.data.bag[0][0].id === "9001",
    "背包格子的属性没有被管道的白名单剥掉（嵌套裸对象会静默变成空数组）",
    JSON.stringify(lostProps.data.data.bag[0][0]),
  );

  const badSkills = await api("PATCH", "admin/roles/role_a2", { token: adminToken, body: { skills: { "1001": -1 } } });
  check(badSkills.code === 20003, "技能等级为负被拒", `${badSkills.code}`);

  const badEquipments = await api("PATCH", "admin/roles/role_a2", { token: adminToken, body: { equipments: ["not-an-object"] } });
  check(badEquipments.code === 40000, "装备表传数组被 DTO 拦下（40000）", `${badEquipments.code}`);

  const badOnMap = await api("PATCH", "admin/roles/role_a2", { token: adminToken, body: { onMap: "" } });
  check(badOnMap.code === 40000, "所在地图传空串被拦下（40000）", `${badOnMap.code}`);

  // 「只有账号当前在线的角色才允许推存档」——不在线的角色推回来一律 20007（踢下线语义）。
  // role_a2 不是账号当前在线角色（先建的是 role_a1），所以这里先验这条判据。
  const offlineSave = await api("PUT", "roles/role_a2", { token: tokenA, body: { data: { notRole: true } } });
  check(offlineSave.code === 20007, "非在线角色推存档被拒（20007 ROLE_KICKED）", `${offlineSave.code}`);

  // 切到 role_a2 再验「坏数据照样被拒」（校验顺序：在线 → 乐观锁 → 数据解析）
  await api("POST", "roles/role_a2/select", { token: tokenA });
  const brokenDoc = await api("PUT", "roles/role_a2", { token: tokenA, body: { data: { notRole: true } } });
  check(brokenDoc.code === 20003, "坏角色数据被拒（不会把背包清空）", `${brokenDoc.code}`);
  // 切回 role_a1（后面的乐观锁联动用例都围绕它）
  await api("POST", "roles/role_a1/select", { token: tokenA });

  //#endregion

  //#region 四、后台改动不被玩家旧存档覆盖（乐观锁联动）

  console.log("— 四、后台改动不被玩家旧存档覆盖 —");

  const beforePatch = await api("GET", "roles/role_a1", { token: tokenA });
  const baseline = beforePatch.data.revision;
  await api("PATCH", "admin/roles/role_a1", { token: adminToken, body: { gold: 777 } });
  const staleAfterAdmin = await api("PUT", "roles/role_a1", {
    token: tokenA,
    body: { data: { ...roleData("role_a1", "甲一", "1", 7), gold: 123 }, revision: baseline },
  });
  check(staleAfterAdmin.code === 20006, "玩家拿后台改之前的数据推进会撞上乐观锁（20006）", `${staleAfterAdmin.code}`);

  const afterAdmin = await api("GET", "roles/role_a1", { token: tokenA });
  check(afterAdmin.data.data.gold === 777, "后台改的金币还在（没有被玩家那份旧存档覆盖）", JSON.stringify(afterAdmin.data.data.gold));

  const resume = await api("PUT", "roles/role_a1", {
    token: tokenA,
    body: { data: { ...roleData("role_a1", "甲一", "1", 7), gold: 777 }, revision: afterAdmin.data.revision },
  });
  check(resume.code === 0, "玩家同步到最新 revision 后可以继续保存", resume.message);

  //#endregion

  //#region 五、批量删除

  console.log("— 五、批量删除 —");

  const batch = await api("POST", "admin/roles/batch-delete", { token: adminToken, body: { ids: ["role_a2", "role_a3"] } });
  check(batch.code === 0 && batch.data.deleted === 2, "批量删除两条", JSON.stringify(batch.data && batch.data.deleted));
  check(batch.data.requested === 2 && batch.data.ids.length === 2, "返回请求条数与实际删掉的 id");
  check(batch.data.clearedOnlineAccountIds.length === 0, "删的不是在线角色 → 没有账号被清标记", JSON.stringify(batch.data.clearedOnlineAccountIds));

  const again = await api("POST", "admin/roles/batch-delete", { token: adminToken, body: { ids: ["role_a2"] } });
  check(again.code === 0 && again.data.deleted === 0, "重复删除同一个 id 幂等（不报错、删除数为 0）", JSON.stringify(again.data && again.data.deleted));

  const emptyIds = await api("POST", "admin/roles/batch-delete", { token: adminToken, body: { ids: [] } });
  check(emptyIds.code === 40000, "空 id 列表被 DTO 拦下（40000）", `${emptyIds.code}`);

  const tooMany = await api("POST", "admin/roles/batch-delete", {
    token: adminToken,
    body: { ids: Array.from({ length: 101 }, (_, index) => `role_x${index}`) },
  });
  check(tooMany.code === 40000, "超过 100 条被拦下（40000）", `${tooMany.code}`);

  const purge = await api("DELETE", `admin/accounts/${accountA}/roles`, { token: adminToken });
  check(purge.code === 0 && purge.data.deleted === 1, "清空账号 A 的全部角色（剩 1 个在线角色）", JSON.stringify(purge.data && purge.data.deleted));
  check(purge.data.clearedOnlineAccountIds.indexOf(accountA) !== -1, "在线角色被删时顺带清掉账号的在线标记", JSON.stringify(purge.data.clearedOnlineAccountIds));

  const detailA = await api("GET", `admin/accounts/${accountA}`, { token: adminToken });
  check(detailA.data.roles.length === 0, "账号下已无角色");
  check(detailA.data.account.onlineRoleId === null, "账号的在线角色已被清空");
  check(detailA.data.account.username === "role_player_a", "账号本身保留（与「删除账号」区分）");

  const purgeMissing = await api("DELETE", "admin/accounts/not-exist-id/roles", { token: adminToken });
  check(purgeMissing.code === 10002, "给不存在的账号清角色 → 10002", `${purgeMissing.code}`);

  //#endregion

  //#region 六、权限

  console.log("— 六、权限：只读观察员不能写 —");

  const viewerList = await api("GET", "admin/roles", { token: viewerToken });
  check(viewerList.code === 0, "只读观察员能看角色列表");

  const viewerBatch = await api("POST", "admin/roles/batch-delete", { token: viewerToken, body: { ids: ["role_b1"] } });
  check(viewerBatch.code === 30006 && viewerBatch.status === 403, "只读观察员批量删除 → 403 / 30006", `${viewerBatch.code}/${viewerBatch.status}`);

  const viewerPatch = await api("PATCH", "admin/roles/role_b1", { token: viewerToken, body: { level: 99 } });
  check(viewerPatch.code === 30006, "只读观察员改角色 → 30006", `${viewerPatch.code}`);

  const viewerPurge = await api("DELETE", `admin/accounts/${accountB}/roles`, { token: viewerToken });
  check(viewerPurge.code === 30006, "只读观察员清空账号角色 → 30006", `${viewerPurge.code}`);

  const playerTokenOnAdmin = await api("POST", "admin/roles/batch-delete", { token: tokenB, body: { ids: ["role_b1"] } });
  check(playerTokenOnAdmin.status === 401, "玩家令牌调管理端接口 → 401（受众隔离）", `${playerTokenOnAdmin.status}`);

  const stillThere = await api("GET", "admin/roles?keyword=role_b", { token: adminToken });
  check(stillThere.data.total === 1, "越权请求全部被拦，角色还在");

  //#endregion

  //#endregion

  //#region 七、文档

  console.log("— 七、文档：新接口落在管理端分组且带权限点 —");

  const docResponse = await fetch(`${baseUrl.replace(/\/api$/, "")}/api-docs-json`);
  const doc = await docResponse.json();
  const rolePaths = ["/api/admin/roles/batch-delete", "/api/admin/accounts/{id}/roles"];
  for (const path of rolePaths) {
    const operations = doc.paths[path] || {};
    const operation = Object.values(operations)[0];
    check(!!operation, `文档里有 ${path}`);
    if (!operation) continue;
    check(operation.tags && operation.tags.length === 1 && operation.tags[0] === "管理端", `${path} 恰好一个分组且是「管理端」`, JSON.stringify(operation.tags));
    check(
      Array.isArray(operation["x-olua-permissions"]) && operation["x-olua-permissions"].indexOf("role:delete") !== -1,
      `${path} 标注了 role:delete 权限点`,
      JSON.stringify(operation["x-olua-permissions"]),
    );
  }
  const listOperation = doc.paths["/api/admin/roles"].get;
  check(
    (listOperation.parameters || []).some((item) => item.name === "online") &&
      (listOperation.parameters || []).some((item) => item.name === "minLevel"),
    "角色列表文档里能看到 online / minLevel 等新筛选参数",
  );
  const patchBody = doc.paths["/api/admin/roles/{id}"].patch.requestBody.content["application/json"].schema;
  check(!!patchBody, "角色修改接口的请求体已画进文档");
  const schemas = Object.keys(doc.components.schemas);
  check(schemas.indexOf("BatchDeleteRolesDto") !== -1 && schemas.indexOf("BatchDeleteResultDto") !== -1, "批量删除的两个模型都已登记进文档");
  check(
    ["AdminRoleDetailDto", "RoleDerivedDto", "RoleDerivedAttributesDto", "RoleReportedAttributesDto"].every((name) => schemas.indexOf(name) !== -1),
    "派生字段的四个模型都已登记进文档（漏登记 = Swagger 上缺 schema）",
    JSON.stringify(schemas.filter((name) => name.indexOf("Derived") !== -1)),
  );
  const detailResponse = doc.paths["/api/admin/roles/{id}"].get.responses["200"].content["application/json"].schema;
  const detailRef = JSON.stringify(detailResponse);
  check(
    detailRef.indexOf("AdminRoleDetailDto") !== -1,
    "角色详情的响应模型是 AdminRoleDetailDto（而不是列表那个不含 derived 的）",
    detailRef,
  );

  //#region 八、服务端重算的战斗属性（derived 出口）

  console.log("— 八、服务端重算的战斗属性（derived 出口） —");

  // 抓 warn：`mismatch` 是给「看接口的人」的，日志是给「查问题的人」的 —— 两者都要在（issue #93 的验收）
  // 打补丁而不是开日志等级：`logger: false` 下 isLevelEnabled 是 false，只有绕过它才抓得到
  const { Logger } = require("@nestjs/common");
  const warnLines = [];
  const originalWarn = Logger.prototype.warn;
  Logger.prototype.warn = function (...args) {
    warnLines.push(args.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join(" "));
    return originalWarn.apply(this, args);
  };

  const playerC = await api("POST", "auth/register", { body: { username: "role_player_c", password: "pass1234" } });
  const tokenC = playerC.data.token;
  check(!!tokenC, "准备：第三个玩家账号（本组的角色都挂在它名下）", playerC.message);

  // 详情接口现在回的是 AdminRoleDetail（比列表多一组派生字段）
  const seeded = await api("POST", "roles", { token: tokenC, body: { data: roleData("role_d1", "算一", "1", 10) } });
  check(seeded.code === 0, "准备：建一个 10 级角色", seeded.message);

  const derived1 = await api("GET", "admin/roles/role_d1", { token: adminToken });
  const d1 = derived1.data.derived;
  check(!!d1 && !!d1.attributes, "详情带一组服务端重算的战斗属性");
  check(
    d1.attributes && typeof d1.attributes.combat === "number" && typeof d1.attributes.maxHp === "number" && Array.isArray(d1.attributes.physicalAttack),
    "重算结果里有八项属性与战斗力",
    JSON.stringify(d1.attributes),
  );
  check(d1.reported.combat === null && d1.reported.maxHp === null, "存档里没上报这两个值 → reported 为 null", JSON.stringify(d1.reported));
  check(
    d1.comparable === true && d1.mismatch === false,
    "算得出来但没上报值 → comparable=true 且 mismatch=false（没比成与不一致是两回事）",
    `comparable=${d1.comparable} mismatch=${d1.mismatch}`,
  );
  check(d1.unknownEquipmentIds.length === 0, "没穿装备 → 没有查不到的装备 id", JSON.stringify(d1.unknownEquipmentIds));

  // 与服务端口径一致的上报值：拿服务端刚算出来的那份原样上报，就不该判成不一致
  // （这条是整组的锚：它说明「服务端算的」与「客户端本该上报的」是同一个数）
  const steadyCombat = d1.attributes.combat;
  const steadyMaxHp = d1.attributes.maxHp;

  const consistent = await api("POST", "roles", {
    token: tokenC,
    body: { data: { ...roleData("role_d2", "算二", "1", 10), combat: steadyCombat, maxHp: steadyMaxHp } },
  });
  check(consistent.code === 0, "准备：建一个上报值正确的角色", consistent.message);
  const derived2 = await api("GET", "admin/roles/role_d2", { token: adminToken });
  check(derived2.data.derived.mismatch === false, "上报服务端刚算出的那份 → 一致", JSON.stringify(derived2.data.derived.reported));
  check(derived2.data.derived.reported.combat === steadyCombat, "上报值原样带出来（对照用）", String(derived2.data.derived.reported.combat));

  // 明显不对的上报值
  const bogus = await api("POST", "roles", {
    token: tokenC,
    body: { data: { ...roleData("role_d3", "算三", "1", 10), combat: 999999999, maxHp: 1 } },
  });
  check(bogus.code === 0, "准备：建一个上报值离谱的角色", bogus.message);
  const derived3 = await api("GET", "admin/roles/role_d3", { token: adminToken });
  check(derived3.data.derived.mismatch === true, "上报值与服务端重算对不上 → mismatch=true", JSON.stringify(derived3.data.derived.reported));
  check(derived3.data.derived.comparable === true, "对不上时依然是「比过了」的（comparable=true）");
  check(
    warnLines.some((line) => line.indexOf("role_d3") !== -1 && line.indexOf("不一致") !== -1),
    "不一致同时落到服务端日志（可观测，不静默）",
    JSON.stringify(warnLines.slice(-3)),
  );

  // 管理端改等级 → derived 立刻跟着变（不等客户端同步），且客户端那份旧上报值当场变成「不一致」
  const bumped = await api("PATCH", "admin/roles/role_d3", { token: adminToken, body: { level: 30 } });
  check(
    bumped.data.derived.attributes.combat !== steadyCombat,
    "管理端改等级后，服务端重算的战斗力立刻变（不等客户端同步）",
    `${steadyCombat} → ${bumped.data.derived.attributes.combat}`,
  );
  check(bumped.data.derived.mismatch === true, "等级一变，客户端那份旧上报值立刻成了不一致（正是 mismatch 要表达的）");
  const reread = await api("GET", "admin/roles/role_d3", { token: adminToken });
  check(
    reread.data.derived.attributes.combat === bumped.data.derived.attributes.combat,
    "改完返回的 derived 与重新读一遍一致",
    `${bumped.data.derived.attributes.combat} vs ${reread.data.derived.attributes.combat}`,
  );

  // 查不到的装备 id：属性会悄悄少一截，所以要作为可读的证据交出来
  const unknownEquip = await api("PATCH", "admin/roles/role_d1", {
    token: adminToken,
    body: { equipments: { WEAPON: "no_such_equipment", HELMET: null } },
  });
  check(
    unknownEquip.data.derived.unknownEquipmentIds.indexOf("no_such_equipment") !== -1,
    "查不到属性的装备 id 被交出来（而不是静默当作没穿）",
    JSON.stringify(unknownEquip.data.derived.unknownEquipmentIds),
  );
  check(
    warnLines.some((line) => line.indexOf("role_d1") !== -1 && line.indexOf("查不到属性") !== -1),
    "未知装备同样落到服务端日志",
    JSON.stringify(warnLines.slice(-3)),
  );

  // 等级不在成长曲线里 → 服务端无处可取旧值，如实给 null，而不是静默算成 0
  const outOfCurve = await api("PATCH", "admin/roles/role_d1", { token: adminToken, body: { level: 999 } });
  check(outOfCurve.data.derived.attributes === null, "等级不在成长曲线里 → attributes 为 null（不静默给 0）", JSON.stringify(outOfCurve.data.derived.attributes));
  check(
    outOfCurve.data.derived.comparable === false && outOfCurve.data.derived.mismatch === false,
    "算不出来时 comparable=false 且 mismatch=false（没比成 ≠ 不一致）",
    `comparable=${outOfCurve.data.derived.comparable} mismatch=${outOfCurve.data.derived.mismatch}`,
  );

  // 列表不带派生字段：列表页不展示战斗力，给它算就是白算，还会让响应无谓变胖
  const listForDerived = await api("GET", "admin/roles?accountId=" + playerC.data.account.id, { token: adminToken });
  check(listForDerived.data.list.length === 3, "列表按账号筛出本组的三个角色", String(listForDerived.data.list.length));
  check(
    listForDerived.data.list.every((role) => role.derived === undefined),
    "列表**不带** derived（只有详情带）",
    JSON.stringify(listForDerived.data.list.map((role) => Object.keys(role).indexOf("derived") !== -1)),
  );

  //#endregion

  //#region 九、玩家上报存档时的比对（写入路径）

  console.log("— 九、玩家上报存档时的比对（写入路径） —");

  // 补丁仍沿用第八段打好的那个（还原挪到本段末尾，两段共用一次打补丁）

  const playerD = await api("POST", "auth/register", { body: { username: "role_player_d", password: "pass1234" } });
  const tokenD = playerD.data.token;
  check(!!tokenD, "准备：第四个玩家账号（它的角色要走保存路径）", playerD.message);

  const seededE = await api("POST", "roles", { token: tokenD, body: { data: roleData("role_e1", "报一", "1", 10) } });
  check(seededE.code === 0, "准备：建一个 10 级角色（自动成为在线角色）", seededE.message);

  // 拿服务端刚算出来的那份当「正确的上报值」——不在测试里重实现一遍算法
  const reference = await api("GET", "admin/roles/role_e1", { token: adminToken });
  const rightCombat = reference.data.derived.attributes.combat;
  const rightMaxHp = reference.data.derived.attributes.maxHp;
  check(typeof rightCombat === "number", "取到服务端重算的基准值", String(rightCombat));

  // 不一致：照常存进去 + 记一条 warn
  const beforeBad = warnLines.length;
  const badSave = await api("PUT", "roles/role_e1", {
    token: tokenD,
    body: { data: { ...roleData("role_e1", "报一", "1", 10), combat: rightCombat + 123456, maxHp: rightMaxHp } },
  });
  check(badSave.code === 0, "上报值对不上的存档照样存进去（只记不拦，不打断正常玩法）", `${badSave.code}`);
  check(
    warnLines.slice(beforeBad).some((line) => line.indexOf("role_e1") !== -1 && line.indexOf("不一致") !== -1),
    "…并落到一条 warn（写入路径才是全量观测点：每次推进度都会经过）",
    JSON.stringify(warnLines.slice(beforeBad)),
  );

  // 一致：不记（每次推进度都刷一条等于没有日志）
  const beforeGood = warnLines.length;
  const goodSave = await api("PUT", "roles/role_e1", {
    token: tokenD,
    body: { data: { ...roleData("role_e1", "报一", "1", 10), combat: rightCombat, maxHp: rightMaxHp } },
  });
  check(goodSave.code === 0, "上报值一致的存档照常保存", `${goodSave.code}`);
  check(warnLines.length === beforeGood, "一致时一条日志都不打", JSON.stringify(warnLines.slice(beforeGood)));

  // 没有改动存档：存进去什么，取回来就是什么
  const readBack = await api("GET", "roles/role_e1", { token: tokenD });
  check(readBack.data.data.combat === rightCombat, "服务端不改写玩家上报的值（存进去什么取回来什么）", String(readBack.data.data.combat));

  Logger.prototype.warn = originalWarn;

  //#endregion

  await app.close();
  finish("PASS：角色管理（修订号 / 筛选 / 结构化字段 / 批量删除 / 权限 / 派生属性 / 上报比对 / 文档）全部通过。");
})().catch((error) => {
  console.log(error && error.stack ? error.stack : String(error));
  finish("FAIL：角色管理端到端验证异常终止。");
});
