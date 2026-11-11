#!/usr/bin/env node
/**
 * 装备槽位清洗专项 e2e（#825 / docs/37 B8）
 *
 * 这一套盯的是**属性汇总侧**的自防，不是写入侧：
 *
 * 一、同一件装备占多个槽位 → 属性只算一次
 *     属性是「遍历 `equipments` 的所有值」累加的，不看键。于是同一件写进 5 个槽位就能把
 *     它的属性算 5 遍 —— 改包、运营 PATCH 存档、服务端接管前的老存档都能造出这种档。
 * 二、部位不符的槽位 → 那件不计属性（宁可少算，也不多算）
 * 三、正常路径不受影响：单件仍然算一次（修完不能把正常穿戴也弄丢）
 * 四、管理端 PATCH 与查询同一个口径（它读的就是这份汇总）
 *
 * 为什么必须直接写库：管理端 PATCH 之后的属性也算得对，是因为**汇总侧**去重了；
 * 要验「读库直接拿到脏档」这一条，只能绕过写入侧把脏档种进 `roles.data`。
 * 写入侧的 `sanitizeEquipments`（读档写档时修档）在 e2e-roles 里已有回归。
 *
 * 走的是 `dist/`，所以前置是 `npm run build`。
 * 用法：npm run test:e2e:equip-sanitize
 */
process.env.DB_PATH = ":memory:";
process.env.ADMIN_REGISTER_CODE = "test-admin-code";
process.env.JWT_SECRET = "e2e-equip-sanitize-secret";
process.env.LOG_REQUESTS = "false";
process.env.CORS_ORIGINS = "*";

const { NestFactory } = require("@nestjs/core");
const { ValidationPipe } = require("@nestjs/common");
const { AppModule } = require("../dist/app.module");
const { AllExceptionsFilter } = require("../dist/common/filters/all-exceptions.filter");
const { TransformInterceptor } = require("../dist/common/interceptors/transform.interceptor");
const { DatabaseService } = require("../dist/database/database.service");
const { EQUIPMENT_SLOT_KEYS } = require("../dist/common/constants/game-enums");
// 玩家存档的公共帮手（#820 起 revision 必填）
const { saveRole } = require("./lib/role-save.cjs");

//#region 断言小工具

let passed = 0;
const failures = [];

function check(ok, label, extra) {
  if (ok) {
    passed += 1;
    console.log(`  [OK] ${label}`);
    return true;
  }
  failures.push(extra === undefined ? label : `${label}（实际：${extra}）`);
  console.log(`  [!!] ${label}${extra === undefined ? "" : ` —— ${extra}`}`);
  return false;
}

function group(label) {
  console.log(`\n▶ ${label}`);
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

async function api(method, route, options = {}) {
  const headers = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(`${baseUrl}/${route}`, {
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

(async () => {
  const app = await NestFactory.create(AppModule.register({ realtime: true }), { logger: false });
  app.setGlobalPrefix("api");
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, transformOptions: { enableImplicitConversion: true } }));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new TransformInterceptor());
  await app.listen(0);
  baseUrl = `${await app.getUrl()}/api`;

  const db = app.get(DatabaseService);

  /**
   * 直接把一份（可能脏的）`equipments` 种进存档
   *
   * 走 SQL 而不是接口：管理端 PATCH 之后属性算得对也可能是「写入时被清洗了」，
   * 那验不出汇总侧的自防。这里模拟的是「脏档已经在库里」。
   */
  const writeEquipments = (roleId, equipments) => {
    const row = db.get("SELECT data FROM roles WHERE id = ?", [roleId]);
    if (!row) throw new Error(`角色 ${roleId} 不存在`);
    const data = JSON.parse(row.data);
    data.equipments = equipments;
    db.run("UPDATE roles SET data = ? WHERE id = ?", [JSON.stringify(data), roleId]);
  };

  const derivedOf = async (roleId, token) => {
    const detail = await api("GET", `admin/roles/${roleId}`, { token });
    if (detail.code !== 0) throw new Error(`读角色详情失败：${detail.message}`);
    return detail.data.derived;
  };

  try {
    //#region 准备
    group("准备：管理员 / 玩家 / 一个 1 级空号");
    const superAdmin = await api("POST", "admin/auth/register", {
      body: { username: "gm_equip_sanitize", password: "pass1234", registerCode: "test-admin-code" },
    });
    const adminToken = superAdmin.data && superAdmin.data.token;
    check(superAdmin.code === 0 && !!adminToken, "准备：注册管理员拿到令牌", superAdmin.message);

    const registered = await api("POST", "auth/register", { body: { username: "equip_sanitize", password: "pass1234" } });
    const token = registered.data && registered.data.token;
    check(registered.code === 0 && !!token, "准备：注册玩家", registered.message);
    const created = await api("POST", "roles", { token, body: { name: "洗槽壹", occupation: "1", sex: "1" } });
    const roleId = created.data && created.data.id;
    check(created.code === 0 && !!roleId, "准备：建一个角色", created.message);

    // 拿一件「属性明显」的装备（攻击 + 防御 + 血量之和最大那件），槽位从库里读，不写死
    const piece = db.get(
      `SELECT id, slot FROM equipments
        ORDER BY (physical_attack_max + physical_defense_max + magic_defense_max + max_hp) DESC
        LIMIT 1`,
    );
    check(!!(piece && piece.id && piece.slot), "准备：库里取到一件高属性装备", JSON.stringify(piece));

    const eqId = piece.id;
    const slot = piece.slot;
    // 另外两个「不是它的部位」的槽位（用于造「同一件穿多槽」）
    const otherSlots = EQUIPMENT_SLOT_KEYS.filter((key) => key !== slot).slice(0, 2);
    check(otherSlots.length === 2, "准备：取到两个不同的槽位名", JSON.stringify(otherSlots));
    //#endregion

    //#region 基线
    group("基线：空装备");
    const baseDerived = await derivedOf(roleId, adminToken);
    const baseCombat = baseDerived.attributes.combat;
    check(typeof baseCombat === "number" && baseCombat > 0, "空装备也能算出战斗力（等级那一档）", String(baseCombat));

    const single = {};
    single[slot] = { id: eqId };
    writeEquipments(roleId, single);
    const singleDerived = await derivedOf(roleId, adminToken);
    const singleCombat = singleDerived.attributes.combat;
    check(singleCombat > baseCombat, "穿一件属性就涨（正常路径没被修坏）", `${baseCombat} → ${singleCombat}`);
    //#endregion

    //#region 同一件穿多槽
    group("同一件穿多槽：只算一次（#825 的核心）");
    const triple = {};
    triple[slot] = { id: eqId };
    triple[otherSlots[0]] = { id: eqId };
    triple[otherSlots[1]] = { id: eqId };
    writeEquipments(roleId, triple);
    const tripleDerived = await derivedOf(roleId, adminToken);
    check(
      tripleDerived.attributes.combat === singleCombat,
      "同一件写进 3 个槽位 → 战斗力与穿一件完全一样（不是 3 倍）",
      `穿一件 ${singleCombat}，穿三槽 ${tripleDerived.attributes.combat}`,
    );
    check(
      JSON.stringify(tripleDerived.attributes) === JSON.stringify(singleDerived.attributes),
      "八项属性与战斗力与「只穿一件」逐项相同（不是只把战斗力压回去）",
      JSON.stringify(tripleDerived.attributes),
    );
    //#endregion

    //#region 部位不符
    group("部位不符：那件不计");
    const misfit = {};
    misfit[otherSlots[0]] = { id: eqId };
    writeEquipments(roleId, misfit);
    const misfitDerived = await derivedOf(roleId, adminToken);
    check(
      misfitDerived.attributes.combat === baseCombat,
      "武器写进别的槽位 → 属性不计（宁可少算，也不按错部位算进去）",
      `空装备 ${baseCombat}，错槽 ${misfitDerived.attributes.combat}`,
    );
    check(
      JSON.stringify(misfitDerived.attributes) === JSON.stringify(baseDerived.attributes),
      "八项属性与空装备逐项相同（不是只把战斗力压回去）",
      JSON.stringify(misfitDerived.attributes),
    );

    // 更隐蔽的一条：**两件不同装备**各占一个槽位（一件对、一件错）—— 去重按 id 管不住它，
    // 靠部位校验才拦得住。否则「五个槽位各穿一件武器」就是五倍攻击。
    const secondPiece = db.get("SELECT id FROM equipments WHERE slot = ? AND id <> ? ORDER BY id LIMIT 1", [slot, eqId]);
    check(!!secondPiece, "准备：同部位再取一件别的装备", JSON.stringify(secondPiece));
    const mixed = {};
    mixed[slot] = { id: eqId };
    mixed[otherSlots[0]] = { id: secondPiece.id };
    writeEquipments(roleId, mixed);
    const mixedDerived = await derivedOf(roleId, adminToken);
    check(
      JSON.stringify(mixedDerived.attributes) === JSON.stringify(singleDerived.attributes),
      "同部位的第二件塞进错槽 → 不计（「五个槽位各穿一把武器」刷不出五倍攻击）",
      JSON.stringify(mixedDerived.attributes),
    );
    //#endregion

    //#region 管理端 PATCH 同一口径
    group("管理端 PATCH：简表契约不变，部位与存在性收口（#836）");
    // #836 起管理端 PATCH 也走「槽位 ↔ id」裁决：之前「同一件塞两个槽位」「不存在的 id」
    // 都静默落库（等下次清洗），现在创建侧直接拒绝 —— 脏档只能由直写库 / 史前老档造出。
    const patched = await api("PATCH", `admin/roles/${roleId}`, { token: adminToken, body: { equipments: { [slot]: eqId } } });
    check(patched.code === 0, "管理端 PATCH 合法简表成功（契约没变）", patched.message);
    check(
      patched.data && patched.data.derived && patched.data.derived.attributes.combat === singleCombat,
      "PATCH 合法穿戴 → 派生属性与直接种档完全一致（属性当场重算）",
      patched.data && patched.data.derived ? String(patched.data.derived.attributes.combat) : "无 derived",
    );

    const misfitPatched = await api("PATCH", `admin/roles/${roleId}`, {
      token: adminToken,
      body: { equipments: { [otherSlots[0]]: eqId } },
    });
    check(misfitPatched.code === 20003, "PATCH 部位不符 → 20003（不再静默落库等清洗）", misfitPatched.message);

    const unknownPatched = await api("PATCH", `admin/roles/${roleId}`, {
      token: adminToken,
      body: { equipments: { [otherSlots[0]]: "no_such_equipment" } },
    });
    check(unknownPatched.code === 20003, "PATCH 不存在的装备 id → 20003", unknownPatched.message);

    // 「查不到属性的 id 作为证据交出来」改由直写库验证：写入侧已拦，历史脏档仍要可观测
    writeEquipments(roleId, { [otherSlots[0]]: { id: "no_such_equipment" } });
    const evidence = await derivedOf(roleId, adminToken);
    check(
      evidence.unknownEquipmentIds.indexOf("no_such_equipment") !== -1,
      "查不到属性的 id 仍然作为证据交出来（没被去重逻辑吞掉）",
      JSON.stringify(evidence.unknownEquipmentIds),
    );
    //#endregion

    //#region 读档写档仍然修档
    group("回归：写入侧清洗仍在（汇总侧只是自防，不是替代）");
    // 同一件穿多槽现在造不出来只能直写库：种进去，玩家存档路径要把它清成一处
    const duplicated = {};
    duplicated[slot] = { id: eqId };
    duplicated[otherSlots[0]] = { id: eqId };
    writeEquipments(roleId, duplicated);
    // 玩家侧存档会走 sanitizeEquipments：把同一件的重复槽位清掉
    const currentData = JSON.parse(db.get("SELECT data FROM roles WHERE id = ?", [roleId]).data);
    const saved = await saveRole(api, token, roleId, currentData);
    check(saved.code === 0, "玩家存档成功（带基线修订号）", saved.message);
    const afterSave = JSON.parse(db.get("SELECT data FROM roles WHERE id = ?", [roleId]).data);
    const wornCount = Object.values(afterSave.equipments || {}).filter((entry) => entry && entry.id === eqId).length;
    check(wornCount === 1, "存档路径把重复槽位清成一处（脏档在下次存盘时被纠正）", `仍穿着 ${wornCount} 处`);
    //#endregion
  } finally {
    await app.close();
  }

  finish("PASS：装备槽位清洗（同件多槽只算一次 / 部位不符不计 / 管理端同口径 / 写入侧仍修档）全部通过。");
})().catch((error) => {
  console.log(error && error.stack ? error.stack : String(error));
  finish("FAIL：装备槽位清洗专项异常终止。");
});
