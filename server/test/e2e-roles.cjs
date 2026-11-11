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
 * · 派生属性：详情带服务端重算的战斗属性；与客户端上报值比对；
 *   **#541 起服务端权威重算落库**：建号与存档都会把属性/战斗力覆盖成服务端算的（离谱上报不落库）；
 *   管理端改等级后立即重算；列表**不带**（只有详情带）；等级 0（脏数据）时如实给 null
 *   （#786 起等级走参数化曲线，末段外推 —— 没有「等级不在表里」这种情形了）
 * · 文档：新接口落在「管理端」分组且带权限点标注
 * · 角色数上限（#878）：一账号 6 个、第 7 个 400 / 20018、`UNIQUE(account_id, name)` 真的在库里
 * · 身份字段独占（#879）：存档改不了 name / occupation / sex（非法职业也不拦存档）
 * · 登出（#880）：吊销该账号全部令牌（另一台设备的也一起失效），重新登录照常
 *
 * 用法：先 `npm run build`，再 `node test/e2e-roles.cjs`
 */
process.env.DB_PATH = ":memory:";
process.env.ADMIN_REGISTER_CODE = "test-admin-code";
process.env.JWT_SECRET = "test-secret";
process.env.LOG_REQUESTS = "false";
// 角色数上限钉成出厂默认（#878）：**本机 `server/.env` 里配的值不该影响断言的数字** ——
// 否则同一条用例在「本地改过 .env」和 CI 上会给出两种结论
process.env.ROLE_MAX_PER_ACCOUNT = "6";

process.env.CORS_ORIGINS = "*";

const { NestFactory } = require("@nestjs/core");
const { ValidationPipe } = require("@nestjs/common");
const { AppModule } = require("../dist/app.module");
const { AllExceptionsFilter } = require("../dist/common/filters/all-exceptions.filter");
const { TransformInterceptor } = require("../dist/common/interceptors/transform.interceptor");
const { setupSwagger } = require("../dist/swagger/setup");
// 存档 PUT 的公共帮手（#820 起 revision 必填：先 GET 拿修订号再 PUT）
const { saveRole, revOfWith } = require("./lib/role-save.cjs");
/** 直连库：验「表上的唯一索引真的建了」（#878）—— 接口层验不出索引在不在 */
const { DatabaseService } = require("../dist/database/database.service");
/** 脏数据路径（等级 0）在接口层进不去（PatchRoleDto 有 @Min(1)），直接喂给同一个 DTO 入口 */
const { RoleDerivedDto } = require("../dist/modules/roles/dto/role.dto");

//#region 断言小工具

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

/** 取角色当前修订号（#820 / B62：写接口必须带基线，缺了就是 400 / 40000） */
const revOf = (roleId, token) => revOfWith(api, roleId, token);

/**
 * 造一份合法的**存档文档**（PUT 全量覆盖用）
 *
 * #597 起建号不再收完整文档（入参只有名称 / 职业 / 性别），这份只在存档路径里出现 ——
 * `data.id` 会被路径参数覆盖，填什么都行，这里沿用旧 id 形态保持可读。
 */
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

/**
 * 把角色提到指定等级（管理端 PATCH —— #554 起这是**唯一**的正规提级路径）
 *
 * 建号请求里的 `level` 会被钉成出厂值（改包也拿不到满级号，见 role-authority.ts 的
 * `pinInitialLevel`），所以「造一个 N 级角色」必须两步：建号（1 级）→ 管理端改等级。
 * 顺带也把这条运营路径本身钉在测试里 —— 后台补级只走它。
 */
async function raiseLevel(roleId, level, token) {
  const res = await api("PATCH", `admin/roles/${roleId}`, { token, body: { level } });
  if (res.code !== 0) throw new Error(`提等级失败 ${roleId} → ${level}：${res.message}`);
  return res;
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

  const roleA1 = await api("POST", "roles", { token: tokenA, body: { name: "甲一", occupation: "1", sex: "1" } });
  const roleA1Id = roleA1.data.id;
  check(roleA1.code === 0 && roleA1.data.revision === 1, "新建角色 revision 从 1 开始", JSON.stringify(roleA1.data && roleA1.data.revision));
  check(roleA1.data.online === true, "第一个角色自动成为在线角色");
  check(roleA1.data.data.revision === undefined, "revision 是索引列，不会留在角色文档里", JSON.stringify(roleA1.data.data.revision));

  const roleA2 = await api("POST", "roles", { token: tokenA, body: { name: "甲二", occupation: "2", sex: "1" } });
  const roleA2Id = roleA2.data.id;
  const roleA3 = await api("POST", "roles", { token: tokenA, body: { name: "甲三", occupation: "3", sex: "1" } });
  const roleA3Id = roleA3.data.id;
  check(roleA2.code === 0 && roleA3.code === 0, "同一账号可连续创建多个角色（上限 6，见第十段 #878）");

  // 这几次存档用 `onMap`（客户端全权字段）当「改点东西」的载体，**不用 level / exp**：
  // #550 起等级与经验也归服务端（存档里的上报值会被回填成库里的值），
  // 拿它们当载体验修订号的话，验的就不是修订号了
  // #820 起 revision 必填：不带就是 400 / 40000 —— 不再有「最后写入者胜」那条后门
  const noRevision = await api("PUT", `roles/${roleA1Id}`, {
    token: tokenA,
    body: { data: { ...roleData(roleA1Id, "甲一", "1", 1), onMap: "0" } },
  });
  check(
    noRevision.code === 40000 && noRevision.status === 400,
    "不带 revision 的保存被拒（400 / 40000，不再静默覆盖）",
    `${noRevision.code}/${noRevision.status}`,
  );

  const saved1 = await saveRole(api, tokenA, roleA1Id, { ...roleData(roleA1Id, "甲一", "1", 1), onMap: "1" });
  check(saved1.code === 0 && saved1.data.revision === 2, "带上服务端 revision 保存成功，revision 递增到 2", JSON.stringify(saved1.data && saved1.data.revision));

  const saved2 = await api("PUT", `roles/${roleA1Id}`, { token: tokenA, body: { data: { ...roleData(roleA1Id, "甲一", "1", 1), onMap: "2" }, revision: 2 } });
  check(saved2.code === 0 && saved2.data.revision === 3, "带正确 revision 保存成功，revision 到 3", JSON.stringify(saved2.data && saved2.data.revision));

  const stale = await api("PUT", `roles/${roleA1Id}`, { token: tokenA, body: { data: { ...roleData(roleA1Id, "甲一", "1", 1), onMap: "3" }, revision: 2 } });
  check(stale.code === 20006 && stale.status === 409, "带过期 revision 保存被拒（20006 / 409）", `${stale.code}/${stale.status}`);

  const afterStale = await api("GET", `roles/${roleA1Id}`, { token: tokenA });
  check(afterStale.data.data.onMap === "2", "被拒的保存没有写库（还是上一次的值 2）", `${afterStale.data.data && afterStale.data.data.onMap}`);
  check(afterStale.data.revision === 3, "详情里的 revision 与服务端一致", `${afterStale.data.revision}`);

  const crossAccount = await api("GET", `roles/${roleA1Id}`, { token: tokenB });
  check(crossAccount.code === 40300 && crossAccount.status === 403, "别的账号读不到该角色（越权 403）", `${crossAccount.code}/${crossAccount.status}`);

  //#endregion

  //#region 一之二、新手引导进度（#402）：服务端只校验结构 + 体量

  console.log("— 一之二、新手引导进度：结构 + 体量校验，不认客户端的步骤含义 —");

  const guidedData = { ...roleData(roleA1Id, "甲一", "1", 1), guide: { step: 2, done: false, skipped: false } };
  const guideSaved = await api("PUT", `roles/${roleA1Id}`, { token: tokenA, body: { data: guidedData, revision: 3 } });
  check(guideSaved.code === 0 && guideSaved.data.data.guide.step === 2, "指南进度原样落库（step 2）", JSON.stringify(guideSaved.data.data && guideSaved.data.data.guide));
  const guideRead = await api("GET", `roles/${roleA1Id}`, { token: tokenA });
  check(guideRead.data.data.guide.done === false && guideRead.data.data.guide.skipped === false, "三个标记原样读回（done / skipped）", JSON.stringify(guideRead.data.data && guideRead.data.data.guide));

  const guideOverflow = await api("PUT", `roles/${roleA1Id}`, { token: tokenA, body: { data: { ...guidedData, guide: { step: 65, done: false, skipped: false } }, revision: 4 } });
  check(guideOverflow.code === 20003, "步数越界被拒（20003，不是静默夹取）", `${guideOverflow.code}`);

  const guideFraction = await api("PUT", `roles/${roleA1Id}`, { token: tokenA, body: { data: { ...guidedData, guide: { step: 1.5, done: false, skipped: false } }, revision: 4 } });
  check(guideFraction.code === 20003, "步数不是整数被拒（20003）", `${guideFraction.code}`);

  const guideBadFlag = await api("PUT", `roles/${roleA1Id}`, { token: tokenA, body: { data: { ...guidedData, guide: { step: 1, done: "yes", skipped: false } }, revision: 4 } });
  check(guideBadFlag.code === 20003, "done 不是布尔被拒（20003）", `${guideBadFlag.code}`);

  const guideExtra = await api("PUT", `roles/${roleA1Id}`, { token: tokenA, body: { data: { ...guidedData, guide: { step: 3, done: false, skipped: true, evil: "x" } }, revision: 4 } });
  check(guideExtra.code === 0 && guideExtra.data.data.guide.evil === undefined && guideExtra.data.data.guide.skipped === true, "多余字段被丢弃、三个已知字段保留", JSON.stringify(guideExtra.data.data && guideExtra.data.data.guide));

  // 老档（没有 guide 字段）照样能存，且**服务端不会凭空补一个** ——
  // 客户端正是靠「文档里有没有这个字段」区分老号与新号（无字段 = 引导上线前就在的角色）
  const legacySaved = await saveRole(api, tokenA, roleA1Id, roleData(roleA1Id, "甲一", "1", 1));
  check(legacySaved.code === 0 && legacySaved.data.data.guide === undefined, "没有 guide 字段的老档照常保存，服务端不补默认值", JSON.stringify(legacySaved.data.data && legacySaved.data.data.guide));

  //#endregion

  //#region 二、管理端：检索与筛选

  console.log("— 二、管理端：检索与筛选 —");

  const roleB1 = await api("POST", "roles", { token: tokenB, body: { name: "乙一", occupation: "2", sex: "1" } });
  const roleB1Id = roleB1.data.id;

  // 筛选要用「不同等级」的样本，但建号等级恒为出厂值（#554），所以这里统一走管理端提级。
  // 只动 a3 / b1：a1 与 a2 是第三、四段的修订号基线，多一次写库就把那些数字顶偏了。
  // 12 与 18 取在区间内侧（不是边界值），这样这条断言验的是筛选本身，不是边界开闭
  await raiseLevel(roleA3Id, 12, adminToken);
  const raisedB1 = await raiseLevel(roleB1Id, 18, adminToken);
  check(
    raisedB1.data.level === 18,
    "准备：两个角色的等级已由管理端提级（#554 后建号等级恒为出厂值）",
    `${raisedB1.data && raisedB1.data.level}`,
  );

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

  const byKeyword = await api("GET", "admin/roles?keyword=" + encodeURIComponent("乙一"), { token: adminToken });
  check(byKeyword.data.total === 1 && byKeyword.data.list[0].id === roleB1Id, "关键字匹配角色 id（服务端生成的 id）", JSON.stringify(byKeyword.data.total));

  const withAccountName = all.data.list.every((item) => typeof item.accountName === "string");
  check(withAccountName, "列表带所属账号名（一次 join 拿全，不做 N+1）");

  //#endregion

  //#region 三、管理端：修改角色（基础信息 + 运行时数据）

  console.log("— 三、管理端：修改角色（基础信息 + 运行时数据） —");

  // 时装：`fashionCloth` 在 #377 从数字改成**时装 id**（fashions 表主键），管理端也只能填字符串
  const patched = await api("PATCH", `admin/roles/${roleA2Id}`, {
    token: adminToken,
    body: { name: "甲二改", level: 11, fashionCloth: "cloth_2", avatar: 7, onMap: "12", gold: 8888 },
  });
  check(patched.code === 0, "改基础信息成功", patched.message);
  check(patched.data.name === "甲二改" && patched.data.level === 11, "索引字段同步更新（列表里看到的就是新名字）");
  check(patched.data.data.fashionCloth === "cloth_2" && patched.data.data.avatar === 7 && patched.data.data.onMap === "12", "时装 / 头像 / 所在地图写进角色数据");
  check(patched.data.data.gold === 8888, "数值字段写进角色数据");
  check(patched.data.revision === 2, "管理端改一次，修订号 +1", JSON.stringify(patched.data.revision));

  const numericFashion = await api("PATCH", `admin/roles/${roleA2Id}`, { token: adminToken, body: { fashionCloth: 3 } });
  check(numericFashion.code === 40000 && numericFashion.status === 400, "时装填旧形状的数字被拒（只收时装 id）", `${numericFashion.code}/${numericFashion.status}`);
  const unknownFashion = await api("PATCH", `admin/roles/${roleA2Id}`, { token: adminToken, body: { fashionCloth: "no_such_fashion" } });
  check(unknownFashion.code === 0 && unknownFashion.data.revision === 3, "任意字符串都收（清单外 id 由客户端按 null 兜底）", JSON.stringify(unknownFashion.data?.revision));
  const clearedFashion = await api("PATCH", `admin/roles/${roleA2Id}`, { token: adminToken, body: { fashionCloth: null } });
  check(clearedFashion.code === 0 && clearedFashion.data.data.fashionCloth === null, "传 null = 脱下（清空穿戴）");

  const duplicateName = await api("PATCH", `admin/roles/${roleA2Id}`, { token: adminToken, body: { name: "甲三" } });
  check(duplicateName.code === 20005 && duplicateName.status === 409, "同账号下改名撞车被拒（20005）", `${duplicateName.code}/${duplicateName.status}`);

  const runtime = await api("PATCH", `admin/roles/${roleA2Id}`, {
    token: adminToken,
    body: {
      // #836 起管理端 PATCH 也校验装备存在性与部位（之前 1001/3001 这种编的 id 都收）——
      // 结构性断言（包对象 / 空串规整 null / 背包扩容）改用真实装备 id 保持
      equipments: { weapon: "weapon_1", helmet: "" },
      skills: { "1001": 3, "1002": 0 },
      bag: [
        { row: 0, col: 1, id: "2001", count: 5 },
        { row: 3, col: 4, id: "3001", count: 1 },
      ],
    },
  });
  check(runtime.code === 0, "改装备 / 技能 / 背包成功", runtime.message);
  // #816：槽位存 `{ id, bound?, from? }`（管理端入参仍是「槽位 → id」，由服务端翻成对象）
  check(
    runtime.data.data.equipments.weapon.id === "weapon_1" && runtime.data.data.equipments.helmet === null,
    "装备表：写入的 id 包成对象、空串规整成 null（卸下）",
    JSON.stringify(runtime.data.data.equipments),
  );
  check(runtime.data.data.skills["1001"] === 3 && runtime.data.data.skills["1002"] === 0, "技能表按 id 写等级");
  check(runtime.data.data.bag.length === 4 && runtime.data.data.bag[0].length === 5, "背包网格按最远的格子自动扩到刚好放下", `${runtime.data.data.bag.length}×${runtime.data.data.bag[0].length}`);
  check(runtime.data.data.bag[0][1].id === "2001" && runtime.data.data.bag[0][1].count === 5, "背包物品落在正确的格子上");
  check(runtime.data.data.bag[1][0] === null, "未提交的格子是空的");

  const clearBag = await api("PATCH", `admin/roles/${roleA2Id}`, { token: adminToken, body: { bag: [] } });
  check(
    clearBag.data.data.bag.every((row) => row.every((cell) => cell === null)) && clearBag.data.data.bag.length === 4,
    "背包传空数组 = 清空（网格尺寸保留）",
  );

  const dupCell = await api("PATCH", `admin/roles/${roleA2Id}`, {
    token: adminToken,
    body: { bag: [{ row: 0, col: 0, id: "1", count: 1 }, { row: 0, col: 0, id: "2", count: 1 }] },
  });
  check(dupCell.code === 20003 && dupCell.status === 400, "背包格子坐标重复被拒（20003）", `${dupCell.code}/${dupCell.status}`);

  const badAxis = await api("PATCH", `admin/roles/${roleA2Id}`, { token: adminToken, body: { bag: [{ row: 999, col: 0, id: "1", count: 1 }] } });
  check(badAxis.code === 40000, "背包行号越界被拦下（DTO 40000）", `${badAxis.code}`);

  const badCount = await api("PATCH", `admin/roles/${roleA2Id}`, { token: adminToken, body: { bag: [{ row: 0, col: 0, id: "1", count: 0 }] } });
  check(badCount.code === 40000, "背包数量为 0 被拦下（DTO 40000）", `${badCount.code}`);

  const lostProps = await api("PATCH", `admin/roles/${roleA2Id}`, { token: adminToken, body: { bag: [{ row: 0, col: 0, id: "9001", count: 2 }] } });
  check(
    lostProps.data.data.bag[0][0] && lostProps.data.data.bag[0][0].id === "9001",
    "背包格子的属性没有被管道的白名单剥掉（嵌套裸对象会静默变成空数组）",
    JSON.stringify(lostProps.data.data.bag[0][0]),
  );

  const badSkills = await api("PATCH", `admin/roles/${roleA2Id}`, { token: adminToken, body: { skills: { "1001": -1 } } });
  check(badSkills.code === 20003, "技能等级为负被拒", `${badSkills.code}`);

  const badEquipments = await api("PATCH", `admin/roles/${roleA2Id}`, { token: adminToken, body: { equipments: ["not-an-object"] } });
  check(badEquipments.code === 40000, "装备表传数组被 DTO 拦下（40000）", `${badEquipments.code}`);

  const badOnMap = await api("PATCH", `admin/roles/${roleA2Id}`, { token: adminToken, body: { onMap: "" } });
  check(badOnMap.code === 40000, "所在地图传空串被拦下（40000）", `${badOnMap.code}`);

  // 「只有账号当前在线的角色才允许推存档」——不在线的角色推回来一律 20007（踢下线语义）。
  // role_a2 不是账号当前在线角色（先建的是 role_a1），所以这里先验这条判据。
  const offlineSave = await saveRole(api, tokenA, roleA2Id, { notRole: true });
  check(offlineSave.code === 20007, "非在线角色推存档被拒（20007 ROLE_KICKED）", `${offlineSave.code}`);

  // 切到 role_a2 再验「坏数据照样被拒」（校验顺序：在线 → 乐观锁 → 数据解析）
  await api("POST", `roles/${roleA2Id}/select`, { token: tokenA });
  // 注意载体：#879 起 name / occupation / sex 由服务端覆盖，**一份「缺字段」的文档不再是坏数据**
  // （收权会用库里的值把背包 / 装备 / 技能一起回填，`{ notRole: true }` 现在是合法的空文档）。
  // 这里改用「数值越界」当坏数据的载体：它仍然走 20003，验的还是「解析失败不落库」
  const brokenDoc = await saveRole(api, tokenA, roleA2Id, { level: 0 });
  check(brokenDoc.code === 20003, "坏角色数据被拒（不会把背包清空）", `${brokenDoc.code}`);
  // 切回 role_a1（后面的乐观锁联动用例都围绕它）
  await api("POST", `roles/${roleA1Id}/select`, { token: tokenA });

  //#endregion

  //#region 四、后台改动不被玩家旧存档覆盖（乐观锁联动）

  console.log("— 四、后台改动不被玩家旧存档覆盖 —");

  const beforePatch = await api("GET", `roles/${roleA1Id}`, { token: tokenA });
  const baseline = beforePatch.data.revision;
  await api("PATCH", `admin/roles/${roleA1Id}`, { token: adminToken, body: { gold: 777 } });
  const staleAfterAdmin = await api("PUT", `roles/${roleA1Id}`, {
    token: tokenA,
    body: { data: { ...roleData(roleA1Id, "甲一", "1", 1), gold: 123 }, revision: baseline },
  });
  check(staleAfterAdmin.code === 20006, "玩家拿后台改之前的数据推进会撞上乐观锁（20006）", `${staleAfterAdmin.code}`);

  const afterAdmin = await api("GET", `roles/${roleA1Id}`, { token: tokenA });
  check(afterAdmin.data.data.gold === 777, "后台改的金币还在（没有被玩家那份旧存档覆盖）", JSON.stringify(afterAdmin.data.data.gold));

  const resume = await api("PUT", `roles/${roleA1Id}`, {
    token: tokenA,
    body: { data: { ...roleData(roleA1Id, "甲一", "1", 1), gold: 777 }, revision: afterAdmin.data.revision },
  });
  check(resume.code === 0, "玩家同步到最新 revision 后可以继续保存", resume.message);

  //#endregion

  //#region 五、批量删除

  console.log("— 五、批量删除 —");

  const batch = await api("POST", "admin/roles/batch-delete", { token: adminToken, body: { ids: [roleA2Id, roleA3Id] } });
  check(batch.code === 0 && batch.data.deleted === 2, "批量删除两条", JSON.stringify(batch.data && batch.data.deleted));
  check(batch.data.requested === 2 && batch.data.ids.length === 2, "返回请求条数与实际删掉的 id");
  check(batch.data.clearedOnlineAccountIds.length === 0, "删的不是在线角色 → 没有账号被清标记", JSON.stringify(batch.data.clearedOnlineAccountIds));

  const again = await api("POST", "admin/roles/batch-delete", { token: adminToken, body: { ids: [roleA2Id] } });
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

  const viewerBatch = await api("POST", "admin/roles/batch-delete", { token: viewerToken, body: { ids: [roleB1Id] } });
  check(viewerBatch.code === 30006 && viewerBatch.status === 403, "只读观察员批量删除 → 403 / 30006", `${viewerBatch.code}/${viewerBatch.status}`);

  const viewerPatch = await api("PATCH", `admin/roles/${roleB1Id}`, { token: viewerToken, body: { level: 99 } });
  check(viewerPatch.code === 30006, "只读观察员改角色 → 30006", `${viewerPatch.code}`);

  const viewerPurge = await api("DELETE", `admin/accounts/${accountB}/roles`, { token: viewerToken });
  check(viewerPurge.code === 30006, "只读观察员清空账号角色 → 30006", `${viewerPurge.code}`);

  const playerTokenOnAdmin = await api("POST", "admin/roles/batch-delete", { token: tokenB, body: { ids: [roleB1Id] } });
  check(playerTokenOnAdmin.status === 401, "玩家令牌调管理端接口 → 401（受众隔离）", `${playerTokenOnAdmin.status}`);

  const stillThere = await api("GET", "admin/roles?keyword=" + encodeURIComponent("乙一"), { token: adminToken });
  check(stillThere.data.total === 1, "越权请求全部被拦，角色还在（按名字检索）");

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
  // 本组只看「服务端算的」与「客户端上报的」是否同一份，与等级取值无关 ——
  // 建号恒为 1 级就够了（要造高等级另有 raiseLevel，见 §二）
  const seeded = await api("POST", "roles", { token: tokenC, body: { name: "算一", occupation: "1", sex: "1" } });
  const roleD1Id = seeded.data.id;
  check(seeded.code === 0, "准备：建一个角色（建号恒 1 级）", seeded.message);

  const derived1 = await api("GET", `admin/roles/${roleD1Id}`, { token: adminToken });
  const d1 = derived1.data.derived;
  check(!!d1 && !!d1.attributes, "详情带一组服务端重算的战斗属性");
  check(
    d1.attributes && typeof d1.attributes.combat === "number" && typeof d1.attributes.maxHp === "number" && Array.isArray(d1.attributes.physicalAttack),
    "重算结果里有八项属性与战斗力",
    JSON.stringify(d1.attributes),
  );
  check(d1.reported.combat === d1.attributes.combat, "建号没上报 combat → 服务端重算落库补齐（reported = 权威值）", JSON.stringify(d1.reported));
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

  const consistent = await api("POST", "roles", { token: tokenC, body: { name: "算二", occupation: "1", sex: "1" } });
  const roleD2Id = consistent.data.id;
  check(consistent.code === 0, "准备：再建一个角色（初始文档即服务端重算值）", consistent.message);
  const derived2 = await api("GET", `admin/roles/${roleD2Id}`, { token: adminToken });
  check(derived2.data.derived.mismatch === false, "服务端构造的初始文档 → reported 与权威值一致", JSON.stringify(derived2.data.derived.reported));
  check(derived2.data.derived.reported.combat === steadyCombat, "服务端算的那份原样带出来（同等级下两号同值，口径一致）", String(derived2.data.derived.reported.combat));

  // #597：建号入参只有名称 / 职业 / 性别 —— 「改包上报离谱属性」这条路连入口都没有了，
  // 初始文档天然就是服务端重算的那份
  const bogus = await api("POST", "roles", { token: tokenC, body: { name: "算三", occupation: "1", sex: "1" } });
  const roleD3Id = bogus.data.id;
  check(bogus.code === 0, "准备：再建一个角色（无属性入参可填）", bogus.message);
  const derived3 = await api("GET", `admin/roles/${roleD3Id}`, { token: adminToken });
  check(derived3.data.derived.mismatch === false, "服务端构造的初始角色：reported = 权威值（mismatch=false）", JSON.stringify(derived3.data.derived.reported));
  check(
    derived3.data.derived.reported.combat === derived3.data.derived.attributes.combat,
    "落库的 combat 就是服务端重算的那份",
    JSON.stringify(derived3.data.derived.reported),
  );

  // 管理端改等级 → derived 立刻跟着变（不等客户端同步），且客户端那份旧上报值当场变成「不一致」
  const bumped = await api("PATCH", `admin/roles/${roleD3Id}`, { token: adminToken, body: { level: 30 } });
  check(
    bumped.data.derived.attributes.combat !== steadyCombat,
    "管理端改等级后，服务端重算的战斗力立刻变（不等客户端同步）",
    `${steadyCombat} → ${bumped.data.derived.attributes.combat}`,
  );
  check(
    bumped.data.derived.mismatch === false && bumped.data.derived.reported.combat === bumped.data.derived.attributes.combat,
    "管理端改等级后存档属性当场重算（#836：落库值就是服务端算的，不再留一份旧的等玩家同步）",
    JSON.stringify(bumped.data.derived.reported),
  );
  const reread = await api("GET", `admin/roles/${roleD3Id}`, { token: adminToken });
  check(
    reread.data.derived.attributes.combat === bumped.data.derived.attributes.combat,
    "改完返回的 derived 与重新读一遍一致",
    `${bumped.data.derived.attributes.combat} vs ${reread.data.derived.attributes.combat}`,
  );

  // 查不到的装备 id：#836 起管理端 PATCH 直接拒绝（不再静默落库）——
  // 「未知装备作为证据交出来」的覆盖挪到 e2e-equip-sanitize（直写库造历史脏档）
  const unknownEquip = await api("PATCH", `admin/roles/${roleD1Id}`, {
    token: adminToken,
    body: { equipments: { weapon: "no_such_equipment", helmet: null } },
  });
  check(
    unknownEquip.code === 20003,
    "PATCH 不存在的装备 id → 20003（#836：写入侧收口）",
    `${unknownEquip.code} ${unknownEquip.message}`,
  );

  // #786：等级改成参数化曲线后**没有硬边界**了 —— 远超旧上限 60 的等级照样算得出来（末段外推）
  const farLevel = await api("PATCH", `admin/roles/${roleD1Id}`, { token: adminToken, body: { level: 999 } });
  check(
    Boolean(farLevel.data.derived.attributes) && farLevel.data.derived.attributes.maxHp > 0,
    "远超旧上限（999 级）→ 曲线外推照样算得出属性（不再有「等级不在表里」）",
    JSON.stringify(farLevel.data.derived.attributes && farLevel.data.derived.attributes.maxHp),
  );
  check(
    farLevel.data.derived.comparable === true,
    "算得出来就参与比对（comparable=true）",
    `comparable=${farLevel.data.derived.comparable}`,
  );

  // 「算不出来」现在只剩脏数据一种（等级 < 1）：DTO 层如实给 null，而不是静默算成 0。
  // 管理端接口本身不允许 level=0（PatchRoleDto 的 @Min(1)），所以这里直接喂脏等级给同一个入口。
  const dirtyDerived = RoleDerivedDto.from(0, {});
  check(dirtyDerived.attributes === null, "等级 0（脏存档）→ attributes 为 null（不静默给 0）", JSON.stringify(dirtyDerived.attributes));
  check(
    dirtyDerived.comparable === false && dirtyDerived.mismatch === false,
    "算不出来时 comparable=false 且 mismatch=false（没比成 ≠ 不一致）",
    `comparable=${dirtyDerived.comparable} mismatch=${dirtyDerived.mismatch}`,
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

  //#region 八点五、运营库改值即时生效（#544）

  console.log("— 八点五、管理端改装备属性 → 服务端结算立刻按新值 —");

  // 这条守的是「两端一致」：管理端改的是库，客户端靠快照覆写跟着变；服务端此前读的是
  // 编译期生成物 —— 于是面板变了、伤害没变，且没有任何报错。现在覆盖层接管，必须立刻生效。
  const equipList = await api("GET", "admin/equipments?size=1", { token: adminToken });
  const sampleEquip = equipList.data.list[0];
  check(!!sampleEquip && sampleEquip.attributes.maxHp > 0, "准备：取一件 maxHp > 0 的基础件", JSON.stringify(sampleEquip && sampleEquip.attributes));

  // 槽位名用这件装备的**真实部位**（大写写法是历史习惯，服务端比较时大小写不敏感）。
  // 以前这里固定写 WEAPON：那时属性汇总不看键，穿在哪个槽位都算；
  // #825 起部位不符的条目**不计属性**（同件穿多槽 / 一槽一件错位装备都能刷战力），
  // 所以「穿一件衣服」必须写 cloth，不能借 WEAPON 的壳。
  const wearIt = await api("PATCH", `admin/roles/${roleD1Id}`, {
    token: adminToken,
    body: { level: 10, equipments: { [sampleEquip.slot.toUpperCase()]: sampleEquip.id } },
  });
  const baseMaxHp = wearIt.data.derived.attributes.maxHp;
  check(typeof baseMaxHp === "number", "穿上后取到含装备加成的 maxHp", String(baseMaxHp));

  // #655：变体是**独立配置行** —— 管理端改哪一行，服务端下一次重算就用那一行
  const variantList = await api("GET", `admin/equipment-variants?baseId=${sampleEquip.id}&size=20`, { token: adminToken });
  const variantRow = (variantList.data.list || []).find((item) => item.id === sampleEquip.id);
  check(!!variantRow, "准备：变体表里能查到这件装备的 p0s0 行", JSON.stringify((variantList.data.list || []).length));

  const boost = await api("PATCH", `admin/equipment-variants/${sampleEquip.id}`, {
    token: adminToken,
    body: { attributes: { ...variantRow.attributes, maxHp: variantRow.attributes.maxHp * 2 } },
  });
  check(boost.code === 0, "管理端把该变体的 maxHp 改成 2 倍", boost.message);

  const afterBoost = await api("GET", `admin/roles/${roleD1Id}`, { token: adminToken });
  const boostedMaxHp = afterBoost.data.derived.attributes.maxHp;
  check(
    boostedMaxHp === baseMaxHp + variantRow.attributes.maxHp,
    "改变体 → 服务端重算立刻按新值（不需要重启、也不需要客户端同步）",
    `${baseMaxHp} → ${boostedMaxHp}（变体原 maxHp ${variantRow.attributes.maxHp}）`,
  );

  // 独立性守点（#655 的语义变化）：改基础件**不再**带动它的 15 个变体
  const baseTriple = await api("PATCH", `admin/equipments/${sampleEquip.id}`, {
    token: adminToken,
    body: { attributes: { ...sampleEquip.attributes, maxHp: sampleEquip.attributes.maxHp * 3 } },
  });
  check(baseTriple.code === 0, "管理端把基础件 maxHp 改成 3 倍", baseTriple.message);
  const afterBase = await api("GET", `admin/roles/${roleD1Id}`, { token: adminToken });
  check(
    afterBase.data.derived.attributes.maxHp === boostedMaxHp,
    "改基础件不再带动变体（每件变体都是独立配置行）",
    `${boostedMaxHp} vs ${afterBase.data.derived.attributes.maxHp}`,
  );

  // 变体各算各的：p4s2 穿在身上，加成就是它自己那一行的值
  const variantId = `${sampleEquip.id}_p4s2`;
  const topVariant = (variantList.data.list || []).find((item) => item.id === variantId);
  check(!!topVariant, "准备：同一件的 p4s2 变体也在表里", JSON.stringify((variantList.data.list || []).map((item) => item.id)));
  const wearVariant = await api("PATCH", `admin/roles/${roleD1Id}`, {
    token: adminToken,
    body: { equipments: { [sampleEquip.slot.toUpperCase()]: variantId } },
  });
  check(wearVariant.code === 0, "准备：把同一件的变体穿上（p4s2）", wearVariant.message);
  // 等级那部分加成没变，减掉它剩下的就是装备加成
  const variantBonus = wearVariant.data.derived.attributes.maxHp - (baseMaxHp - sampleEquip.attributes.maxHp);
  check(
    variantBonus === topVariant.attributes.maxHp,
    "变体按自己那一行算（不再由基础件 × 前后缀倍率现算）",
    `${variantBonus} vs ${topVariant.attributes.maxHp}`,
  );

  // 还原：先把变体和基础件都改回原值，再确认角色属性回到起点
  const restoreVariant = await api("PATCH", `admin/equipment-variants/${sampleEquip.id}`, { token: adminToken, body: { attributes: variantRow.attributes } });
  check(restoreVariant.code === 0, "还原该变体的属性", restoreVariant.message);
  const restoredEquip = await api("PATCH", `admin/equipments/${sampleEquip.id}`, { token: adminToken, body: { attributes: sampleEquip.attributes } });
  check(restoredEquip.code === 0, "还原该基础件的属性", restoredEquip.message);
  const backToNormal = await api("PATCH", `admin/roles/${roleD1Id}`, {
    token: adminToken,
    body: { equipments: { [sampleEquip.slot.toUpperCase()]: sampleEquip.id } },
  });
  check(
    backToNormal.data.derived.attributes.maxHp === baseMaxHp,
    "还原后回到原值（覆盖层跟着回退，不是一次性的）",
    `${backToNormal.data.derived.attributes.maxHp} vs ${baseMaxHp}`,
  );

  //#endregion

  //#region 八点六、管理端改价签 → 服务端成交价跟着变（#545）

  console.log("— 八点六、管理端改价签 / 等级 → 服务端成交价跟着变 —");

  // 出厂价签的对照来源：配置快照（#655 后价签逐条落在库里，快照是它的逐行投影）
  const snap = require("./lib/config-snapshot.cjs");

  // 这条守的是「经济出口两端一致」：客户端背包里的价签来自快照覆写（管理端改完立刻变），
  // 服务端此前读的是编译期生成物 —— 界面上写 77，到账 2。玩家只能描述成「价签不对」。
  const bagWith = (id, count) => ({ bag: [{ row: 0, col: 0, id, count }] });

  const putHide = await api("PATCH", `admin/roles/${roleD1Id}`, { token: adminToken, body: bagWith("material_hide", 5) });
  check(putHide.code === 0, "准备：背包里放 5 块兽皮", putHide.message);

  const hideFactory = snap.index("items")["material_hide"].sellPrice;
  const soldAtFactory = await api("POST", `roles/${roleD1Id}/sell`, {
    token: tokenC,
    body: { entries: [{ goodId: "material_hide", count: 1 }], revision: await revOf(roleD1Id, tokenC) },
  });
  check(soldAtFactory.data.sold[0].unitPrice === hideFactory, "未改价时按出厂价签成交（库里 seed 值与生成物一致）", soldAtFactory.data.sold[0].unitPrice);

  const priceUp = await api("PATCH", "admin/items/material_hide", { token: adminToken, body: { sellPrice: 77 } });
  check(priceUp.code === 0, "管理端把兽皮卖价改成 77", priceUp.message);
  const soldAtNew = await api("POST", `roles/${roleD1Id}/sell`, {
    token: tokenC,
    body: { entries: [{ goodId: "material_hide", count: 1 }], revision: await revOf(roleD1Id, tokenC) },
  });
  check(soldAtNew.data.sold[0].unitPrice === 77, "再卖一块立刻按新价（不重启、不清库）", soldAtNew.data.sold[0].unitPrice);

  await api("PATCH", "admin/items/material_hide", { token: adminToken, body: { sellPrice: hideFactory } });
  const soldBackToFactory = await api("POST", `roles/${roleD1Id}/sell`, {
    token: tokenC,
    body: { entries: [{ goodId: "material_hide", count: 1 }], revision: await revOf(roleD1Id, tokenC) },
  });
  check(soldBackToFactory.data.sold[0].unitPrice === hideFactory, "还原后回到出厂价（覆盖层跟着回退，不是一次性的）", soldBackToFactory.data.sold[0].unitPrice);

  // 装备：#655 起回收价就是**变体行的 sell_price**（以前是「等级基础价 × 前后缀倍率」现算）
  const putEquip = await api("PATCH", `admin/roles/${roleD1Id}`, { token: adminToken, body: bagWith(sampleEquip.id, 1) });
  check(putEquip.code === 0, "准备：背包里放一件该装备（基础件）", putEquip.message);
  const soldEquip = await api("POST", `roles/${roleD1Id}/sell`, {
    token: tokenC,
    body: { entries: [{ goodId: sampleEquip.id, count: 1 }], revision: await revOf(roleD1Id, tokenC) },
  });
  check(
    soldEquip.data.sold[0].unitPrice === variantRow.sellPrice,
    "装备价 = 变体行自己的回收价（库里的最终值，客户端显示的是同一个数）",
    `${soldEquip.data.sold[0].unitPrice} vs ${variantRow.sellPrice}`,
  );

  // 改基础件等级**不再**改价签（变体行有独立 level / sell_price）——
  // 想调价就改那一行的 sellPrice，这是 #655 的语义变化
  const levelUp = await api("PATCH", `admin/equipments/${sampleEquip.id}`, { token: adminToken, body: { level: 50 } });
  check(levelUp.code === 0, "管理端把该装备的等级改成 50", levelUp.message);
  await api("PATCH", `admin/roles/${roleD1Id}`, { token: adminToken, body: bagWith(sampleEquip.id, 1) });
  const soldEquip50 = await api("POST", `roles/${roleD1Id}/sell`, {
    token: tokenC,
    body: { entries: [{ goodId: sampleEquip.id, count: 1 }], revision: await revOf(roleD1Id, tokenC) },
  });
  check(
    soldEquip50.data.sold[0].unitPrice === variantRow.sellPrice,
    "改基础件等级不影响变体价签（价签是变体行自己的列）",
    `${soldEquip50.data.sold[0].unitPrice} vs ${variantRow.sellPrice}`,
  );

  const levelRestore = await api("PATCH", `admin/equipments/${sampleEquip.id}`, { token: adminToken, body: { level: sampleEquip.level } });
  check(levelRestore.code === 0, "还原该装备的等级（后续断言仍按出厂值）", levelRestore.message);

  // 改变体自己的 sellPrice → 成交价立刻跟着走（这才是现在调价的入口）
  const variantPrice = variantRow.sellPrice + 7;
  const priceUpVariant = await api("PATCH", `admin/equipment-variants/${sampleEquip.id}`, { token: adminToken, body: { sellPrice: variantPrice } });
  check(priceUpVariant.code === 0, "管理端把该变体的回收价 +7", priceUpVariant.message);
  await api("PATCH", `admin/roles/${roleD1Id}`, { token: adminToken, body: bagWith(sampleEquip.id, 1) });
  const soldEquipNewPrice = await api("POST", `roles/${roleD1Id}/sell`, {
    token: tokenC,
    body: { entries: [{ goodId: sampleEquip.id, count: 1 }], revision: await revOf(roleD1Id, tokenC) },
  });
  check(
    soldEquipNewPrice.data.sold[0].unitPrice === variantPrice,
    "改变体回收价 → 成交价立刻跟着走（不重启、不用重新生成共享数据）",
    `${soldEquipNewPrice.data.sold[0].unitPrice} vs ${variantPrice}`,
  );
  await api("PATCH", `admin/equipment-variants/${sampleEquip.id}`, { token: adminToken, body: { sellPrice: variantRow.sellPrice } });

  //#endregion

  //#region 九、玩家上报存档时的比对（写入路径）

  console.log("— 九、玩家上报存档时的比对（写入路径） —");

  // 补丁仍沿用第八段打好的那个（还原挪到本段末尾，两段共用一次打补丁）

  const playerD = await api("POST", "auth/register", { body: { username: "role_player_d", password: "pass1234" } });
  const tokenD = playerD.data.token;
  check(!!tokenD, "准备：第四个玩家账号（它的角色要走保存路径）", playerD.message);

  const seededE = await api("POST", "roles", { token: tokenD, body: { name: "报一", occupation: "1", sex: "1" } });
  const roleE1Id = seededE.data.id;
  check(seededE.code === 0, "准备：建一个角色（建号恒 1 级，自动成为在线角色）", seededE.message);

  // 拿服务端刚算出来的那份当「正确的上报值」——不在测试里重实现一遍算法
  const reference = await api("GET", `admin/roles/${roleE1Id}`, { token: adminToken });
  const rightCombat = reference.data.derived.attributes.combat;
  const rightMaxHp = reference.data.derived.attributes.maxHp;
  check(typeof rightCombat === "number", "取到服务端重算的基准值", String(rightCombat));

  // 不一致：照常存进去 + 记一条 warn
  const beforeBad = warnLines.length;
  const badSave = await saveRole(api, tokenD, roleE1Id, {
    ...roleData(roleE1Id, "报一", "1", 1),
    combat: rightCombat + 123456,
    maxHp: rightMaxHp,
  });
  check(badSave.code === 0, "上报值对不上的存档照常收下（日志记录 + 权威覆盖，不打断正常玩法）", `${badSave.code}`);
  check(
    warnLines.slice(beforeBad).some((line) => line.indexOf(String(roleE1Id)) !== -1 && line.indexOf("不一致") !== -1),
    "…并落到一条 warn（写入路径才是全量观测点：每次推进度都会经过）",
    JSON.stringify(warnLines.slice(beforeBad)),
  );
  // #541 权威覆盖：上报的那份只用来记日志，落库的一定是服务端重算的
  const afterBadSave = await api("GET", `admin/roles/${roleE1Id}`, { token: adminToken });
  check(
    afterBadSave.data.derived.reported.combat === afterBadSave.data.derived.attributes.combat,
    "离谱上报不落库：存档里已被服务端重算值覆盖（reported = 权威值）",
    JSON.stringify(afterBadSave.data.derived.reported),
  );

  // 一致：把服务端刚给的那份原样推回去（真客户端就是从 roleUpdate 帧抄的），一条日志都不该有
  const current = await api("GET", `roles/${roleE1Id}`, { token: tokenD });
  const beforeGood = warnLines.length;
  const goodSave = await saveRole(api, tokenD, roleE1Id, current.data.data);
  check(goodSave.code === 0, "上报值一致的存档照常保存", `${goodSave.code}`);
  check(warnLines.length === beforeGood, "一致时一条日志都不打", JSON.stringify(warnLines.slice(beforeGood)));

  // 没有改动存档：一致的上报值经服务端重算后取回还是它（口径一致时覆盖 == 原值）
  const readBack = await api("GET", `roles/${roleE1Id}`, { token: tokenD });
  check(readBack.data.data.combat === rightCombat, "取回来的 combat 是服务端重算的那份（与一致上报值相同）", String(readBack.data.data.combat));

  Logger.prototype.warn = originalWarn;

  //#endregion

  //#region 九点五、权威边界：账本与成长线阶位写不进去

  console.log("— 九点五、权威边界：账本与成长线阶位写不进去 —");

  const playerF = await api("POST", "auth/register", { body: { username: "role_player_f", password: "pass1234" } });
  const tokenF = playerF.data.token;
  const seededF = await api("POST", "roles", { token: tokenF, body: { name: "报二", occupation: "1", sex: "1" } });
  const roleF1Id = seededF.data.id;
  check(seededF.code === 0, "准备：第五个玩家建号（入参只有三样，初始账本为 0）", seededF.message);
  // #597：初始文档由服务端构造，等级天然恒为 1（「建号上报满级」这条路连入参都没有了）
  const createdF = await api("GET", `admin/roles/${roleF1Id}`, { token: adminToken });
  check(
    createdF.data.level === 1 && createdF.data.data.level === 1,
    "服务端构造的初始角色恒为 1 级（索引列与存档两份一致）",
    `level=${createdF.data.level} data.level=${createdF.data.data && createdF.data.data.level}`,
  );

  // 改包视角：把账本与阶位一起改掉再推整份存档。服务端照样收下（拒收会让
  // 「客户端少收了一帧」变成玩不了），但落库的必须是库里的值。
  const tampered = {
    ...roleData(roleF1Id, "报二", "1", 1),
    // 等级也改（#550）：这是索引列，回填不生效的话列表与详情会按 99 级显示一身神装
    level: 99,
    gold: 999999,
    bindGold: 88888,
    silver: 7777,
    title: 9,
    soulOfWar: 9,
    rank: 9,
    exp: 424242,
    hp: 999999,
  };
  const tamperSave = await saveRole(api, tokenF, roleF1Id, tampered);
  check(tamperSave.code === 0, "改包存档照常收下（回填而不是 409：拦的是「写进去」，不是「发过来」）", tamperSave.message);

  const afterTamper = await api("GET", `roles/${roleF1Id}`, { token: tokenF });
  const tamperedDoc = afterTamper.data.data;
  check(tamperedDoc.gold === 0, "金币没被改写（账本以库为准；建号从零起）", `gold=${tamperedDoc.gold}`);
  check(
    tamperedDoc.bindGold === 0 && tamperedDoc.silver === 0,
    "绑定元宝 / 银两同样没被改写",
    `bindGold=${tamperedDoc.bindGold} silver=${tamperedDoc.silver}`,
  );
  check(
    tamperedDoc.title === 0 && tamperedDoc.soulOfWar === 0 && tamperedDoc.rank === 0,
    "称号 / 战魂 / 军衔阶位没被改写（只有 upgradeGrowth 能推进）",
    `title=${tamperedDoc.title} soul=${tamperedDoc.soulOfWar} rank=${tamperedDoc.rank}`,
  );
  // 进度（#550）：经验只由服务端结算，客户端已经没有本地加经验路径；等级还是索引列，
  // 回填之后 `row.level` 必须跟着重取（否则列表按 99 级排序、详情按库里那个值显示）
  check(tamperedDoc.exp === 0, "经验没被改写（经验只由服务端结算）", `exp=${tamperedDoc.exp}`);
  check(tamperedDoc.level === 1, "等级没被改写（改包填 99，索引列也跟着回填成 1）", `level=${tamperedDoc.level}`);
  // 上限由服务端重算得出，血蓝夹在 [0, maxHp]（客户端 applyServerRoleUpdate 同一条不变式）
  const fDerived = await api("GET", `admin/roles/${roleF1Id}`, { token: adminToken });
  const fMaxHp = fDerived.data.derived.attributes.maxHp;
  check(
    tamperedDoc.hp === fMaxHp,
    "血量被夹回上限（改包填 999999 也拿不到超上限的血）",
    `hp=${tamperedDoc.hp} maxHp=${fMaxHp}`,
  );

  // 正常客户端：账本与阶位原样上报（它本来就是从 roleUpdate 帧抄回来的），保存照旧
  const plainSave = await saveRole(api, tokenF, roleF1Id, { ...roleData(roleF1Id, "报二", "1", 1), gold: 0 });
  check(plainSave.code === 0, "账本一致的存档照常保存（回填对正常客户端是空操作）", plainSave.message);

  // #597：建号不再收完整文档，「改包塞九位数金币」这条路连入参都没有了 ——
  // 初始账本 / 背包 / 装备 / 技能 / 引导全部由服务端构造，这里逐项验一遍
  const richCreate = await api("POST", "roles", { token: tokenF, body: { name: "报三", occupation: "1", sex: "1" } });
  const roleF2Id = richCreate.data.id;
  check(richCreate.code === 0, "准备：再建一个角色（入参只有名称 / 职业 / 性别）", richCreate.message);
  const richDetail = await api("GET", `roles/${roleF2Id}`, { token: tokenF });
  const richDoc = richDetail.data.data;
  check(
    richDoc.gold === 0 && richDoc.bindGold === 0 && richDoc.silver === 0,
    "新角色账本全 0（不再有「初始金币」这种出厂馈赠）",
    `gold=${richDoc.gold} bindGold=${richDoc.bindGold} silver=${richDoc.silver}`,
  );
  check(
    Array.isArray(richDoc.bag) && richDoc.bag.length === 0,
    "新角色背包为空（新手装备一并废除；网格尺寸由客户端读档时按自身配置铺）",
    JSON.stringify(richDoc.bag),
  );
  check(
    richDoc.equipments && Object.keys(richDoc.equipments).length === 0,
    "新角色装备表为空对象（槽位由客户端按枚举补齐）",
    JSON.stringify(richDoc.equipments),
  );
  check(
    !!richDoc.skills && richDoc.skills["1000"] === 1 && richDoc.skills["1011"] === 1,
    "玩家技能段（1xxx）全部解锁 1 级（玩法数据不是物品）",
    JSON.stringify(richDoc.skills),
  );
  check(
    !!richDoc.guide && richDoc.guide.step === 0 && richDoc.guide.done === false,
    "引导从第 0 步开始（新号天然弹引导；老号「无字段 = 已完成」判定不受影响）",
    JSON.stringify(richDoc.guide),
  );

  //#endregion

  //#region 十、角色数上限 / 身份字段独占 / 登出（#878 / #879 / #880）

  console.log("— 十、角色数上限 / 身份字段独占 / 登出（#878 / #879 / #880） —");

  const playerG = await api("POST", "auth/register", { body: { username: "role_player_g", password: "pass1234" } });
  const tokenG = playerG.data.token;
  const accountG = playerG.data.account.id;

  // #878：一账号 6 个（`ROLE_MAX_PER_ACCOUNT` 默认 6）
  const created = [];
  for (let index = 1; index <= 6; index += 1) {
    created.push(await api("POST", "roles", { token: tokenG, body: { name: `上限${index}`, occupation: "1", sex: "1" } }));
  }
  check(
    created.every((item) => item.code === 0),
    "同一账号前 6 个角色全部建成功（上限内不拦）",
    created.map((item) => item.code).join(","),
  );
  const seventh = await api("POST", "roles", { token: tokenG, body: { name: "上限7", occupation: "1", sex: "1" } });
  check(
    seventh.status === 400 && seventh.code === 20018,
    "第 7 个建号被拒（400 / 20018，不再是「数量不设上限」）",
    `${seventh.code}/${seventh.status}`,
  );
  check(seventh.message.includes("6"), "拒绝文案里带上限数字（客户端据此提示，不必自己存一份）", seventh.message);
  const listG = await api("GET", "roles", { token: tokenG });
  check(listG.data.length === 6, "库里仍只有 6 个（被拒的那次没有落半行）", `${listG.data && listG.data.length}`);

  // 表上的唯一索引：接口层验不出来（应用层查重会先拦），只能直接看 schema
  const db = app.get(DatabaseService);
  const uniqueIndex = db.all(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_roles_account_name'",
  );
  check(uniqueIndex.length === 1, "UNIQUE(account_id, name) 索引已建立（并发同名由数据库兜底）", JSON.stringify(uniqueIndex));
  let duplicateRejected = false;
  let duplicateMessage = "";
  try {
    db.run(
      `INSERT INTO roles (id, account_id, name, occupation, sex, level, kills, data, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["dup-role-id", accountG, "上限1", "1", "1", 1, 0, "{}", 1, Date.now(), Date.now()],
    );
  } catch (error) {
    duplicateRejected = true;
    duplicateMessage = error instanceof Error ? error.message : String(error);
  }
  check(
    duplicateRejected && /UNIQUE/i.test(duplicateMessage),
    "同账号同名直接插库被数据库拒绝（索引真的在拦，不只是应用层查重）",
    duplicateMessage,
  );
  // 应用层那条闸也在（顺序在「上限」之前：重名先给 20005 这个能自己解决的理由，而不是「去删一个」）
  const sameName = await api("POST", "roles", { token: tokenG, body: { name: "上限1", occupation: "1", sex: "1" } });
  check(sameName.code === 20005, "同账号重名仍是 20005（且先于上限判定）", `${sameName.code}`);

  // #879：身份三字段归服务端 —— 存档里报什么都不看，一律按库里的写回
  const playerH = await api("POST", "auth/register", { body: { username: "role_player_h", password: "pass1234" } });
  const tokenH = playerH.data.token;
  const roleH1 = await api("POST", "roles", { token: tokenH, body: { name: "身一", occupation: "1", sex: "1" } });
  const roleH1Id = roleH1.data.id;
  const renamed = await saveRole(api, tokenH, roleH1Id, { ...roleData(roleH1Id, "改包改名", "3", 1), sex: "2" });
  check(renamed.code === 0, "带假身份字段的存档照常保存（忽略，不是拒收）", `${renamed.code}/${renamed.message}`);
  check(renamed.data?.name === "身一", "存档改不了名字（响应里还是库里的名字）", renamed.data?.name);
  check(renamed.data?.occupation === "1", "存档改不了职业（转职只能走将来的转职接口）", renamed.data?.occupation);
  check(renamed.data?.sex === "1", "存档改不了性别", renamed.data?.sex);
  check(
    renamed.data?.data?.name === "身一" && renamed.data?.data?.occupation === "1" && renamed.data?.data?.sex === "1",
    "文档里那份也被盖成了库值（否则「列表里的名字」与「详情里的名字」会各说一套）",
    JSON.stringify({ name: renamed.data?.data?.name, occupation: renamed.data?.data?.occupation, sex: renamed.data?.data?.sex }),
  );
  // 非法职业不该把整份存档卡死 —— 这正是「先盖后校验」而不是「解析完再覆盖」的理由
  const bogusOccupation = await saveRole(api, tokenH, roleH1Id, { ...roleData(roleH1Id, "身一", "99", 1) });
  check(
    bogusOccupation.code === 0,
    "存档里塞一个不存在的职业码也照常保存（不认的字段不该拦下整次存档）",
    `${bogusOccupation.code}/${bogusOccupation.message}`,
  );
  check(bogusOccupation.data?.occupation === "1", "……而且职业仍是库里的那个", bogusOccupation.data?.occupation);

  // #880：登出吊销该账号**全部**令牌（同一账号另一台设备签的也一起失效）
  // 同一秒内两次登录签出来的令牌**可能逐字相同**（载荷只有 sub / ver / iat，而 iat 只到秒），
  // 所以这里不比较两个令牌是否不同 —— 要比的是「登出后两台设备都失效」
  const secondLogin = await api("POST", "auth/login", { body: { username: "role_player_h", password: "pass1234" } });
  const tokenH2 = secondLogin.data.token;
  check(secondLogin.code === 0 && !!tokenH2, "准备：同一账号再登录一次拿到第二个令牌（模拟第二台设备）", secondLogin.message);
  const meBefore = await api("GET", "auth/me", { token: tokenH2 });
  check(meBefore.code === 0, "准备：第二个令牌登出前是可用的", `${meBefore.code}`);
  const logout = await api("POST", "auth/logout", { token: tokenH });
  check(logout.code === 0 && logout.data === null, "登出成功（data 为 null）", `${logout.code}`);
  const meAfter = await api("GET", "auth/me", { token: tokenH });
  check(meAfter.status === 401 && meAfter.code === 40103, "登出后旧令牌立刻失效（401 / 40103，不必等 7 天到期）", `${meAfter.code}/${meAfter.status}`);
  const meOtherDevice = await api("GET", "auth/me", { token: tokenH2 });
  check(
    meOtherDevice.status === 401 && meOtherDevice.code === 40103,
    "另一台设备的令牌也失效（没有会话表，吊销只能整账号一起）",
    `${meOtherDevice.code}/${meOtherDevice.status}`,
  );
  const relogin = await api("POST", "auth/login", { body: { username: "role_player_h", password: "pass1234" } });
  check(relogin.code === 0, "登出后重新登录照常（只是换了一版令牌，不是把号锁掉）", relogin.message);
  const meNewToken = await api("GET", "auth/me", { token: relogin.data.token });
  check(meNewToken.code === 0, "新令牌可用（版本号已对齐）", `${meNewToken.code}`);
  const anonymousLogout = await api("POST", "auth/logout");
  check(anonymousLogout.status === 401 && anonymousLogout.code === 40100, "不带令牌调登出是 401 / 40100（不是公共接口）", `${anonymousLogout.code}/${anonymousLogout.status}`);

  //#endregion

  await app.close();
  finish("PASS：角色管理（修订号 / 筛选 / 结构化字段 / 批量删除 / 权限 / 派生属性 / 上报比对 / 文档）全部通过。");
})().catch((error) => {
  console.log(error && error.stack ? error.stack : String(error));
  finish("FAIL：角色管理端到端验证异常终止。");
});
