#!/usr/bin/env node
/**
 * 运行时参数 · 推荐配置与一键还原 e2e（server/test/e2e-runtime-params-reset.cjs，issue #1185）
 *
 * 盯的不变量（改推荐常量 / reset 路由 / config-sync.sql 的 runtime_params 行后必须全绿）：
 * 一、seed：空库首启灌进来的 runtime_params 六列 == `GET admin/runtime-params/recommended`
 *     —— 推荐常量与出厂行锁死（谁漂了直接红，不会出现「还原完和出厂不一样」）
 * 二、还原：六个模块各自 POST reset 后，该组生效值 == 推荐值；**只动自己那一列**
 *     （reset drop 不该顺手改掉怪物 AI / 帮会规则 —— 整行 UPDATE 的纪律）
 * 三、鉴权：观察员可读推荐值不可还原（403）/ 玩家令牌 401
 * 四、审计：reset 落 adminRuntimeParams.reset*（targetType runtimeParams）
 * 五、文档：recommended + 6 条 reset 路由都在 api-docs-json，权限点标注正确
 *
 * 用法：先 `npm run build`，再 `node test/e2e-runtime-params-reset.cjs`
 */
process.env.DB_PATH = ":memory:";
process.env.ADMIN_REGISTER_CODE = "test-admin-code";
process.env.JWT_SECRET = "test-secret";
process.env.LOG_REQUESTS = "false";
process.env.CORS_ORIGINS = "*";

const { NestFactory } = require("@nestjs/core");
const { AppModule } = require("../dist/app.module");
const { AllExceptionsFilter } = require("../dist/common/filters/all-exceptions.filter");
const { httpValidationPipe } = require("../dist/common/validation/validation-pipe.factory");
const { TransformInterceptor } = require("../dist/common/interceptors/transform.interceptor");
const { setupSwagger } = require("../dist/swagger/setup");
const { rows } = require("./lib/config-snapshot.cjs");

//#region 断言小工具（与 e2e-roles 同款口径）

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

/** 键序无关的深度相等（比较用 stringify 前先把键排好序） */
function deepEqual(a, b) {
  const stable = (value) =>
    value === null || typeof value !== "object"
      ? JSON.stringify(value)
      : Array.isArray(value)
        ? `[${value.map(stable).join(",")}]`
        : `{${Object.keys(value).sort().map((key) => `${key}:${stable(value[key])}`).join(",")}}`;
  return stable(a) === stable(b);
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

/** 管理端请求所在的区（#960）：一个 e2e 进程只在一个区里干活，管理端请求统一带它 */
const ADMIN_ZONE = 1;

async function api(method, path, options = {}) {
  const headers = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.zoneId !== undefined) headers["X-Zone-Id"] = String(options.zoneId);
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

(async () => {
  const app = await NestFactory.create(AppModule.register({ realtime: true }), { logger: false });
  app.setGlobalPrefix("api");
  app.useGlobalPipes(httpValidationPipe());
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new TransformInterceptor());
  setupSwagger(app);
  await app.listen(0);
  baseUrl = `${await app.getUrl()}/api`;

  try {
    //#region 准备

    console.log("— 准备：超管 + 观察员 + 一个玩家 —");

    const superAdmin = await api("POST", "admin/auth/register", {
      body: { username: "gm_params", password: "pass1234", registerCode: "test-admin-code" },
    });
    const adminToken = superAdmin.data.token;
    check(superAdmin.code === 0 && !!adminToken, "准备：注册超管拿到令牌", superAdmin.message);

    const viewer = await api("POST", "admin/auth/register", { body: { username: "gm_params_view", password: "pass1234", registerCode: "test-admin-code" } });
    const viewerToken = viewer.data.token;
    await api("PATCH", `admin/admins/${viewer.data.admin.id}`, { token: adminToken, zoneId: ADMIN_ZONE, body: { role: "viewer" } });

    const player = await api("POST", "auth/register", { body: { username: "params_player", password: "pass1234" } });
    const playerToken = player.data.token;

    //#endregion

    //#region 一、seed == recommended

    console.log("— 一、空库首启的出厂行 == 推荐配置（推荐常量与 seed 锁死） —");

    const seedRow = rows("runtime_params")[0];
    check(!!seedRow, "快照里有 runtime_params 行", JSON.stringify(seedRow || null));
    const recommended = await api("GET", "admin/runtime-params/recommended", { token: adminToken, zoneId: ADMIN_ZONE });
    check(recommended.code === 0 && !!recommended.data, "GET recommended 返回六组", recommended.message);
    const pairs = [
      ["drop", "dropParams"],
      ["autoBattle", "autoBattle"],
      ["guild", "guildRules"],
      ["monsterAi", "monsterAi"],
      ["movement", "movement"],
      ["castRange", "castRange"],
    ];
    for (const [apiGroup, seedColumn] of pairs) {
      check(
        deepEqual(recommended.data[apiGroup], seedRow[seedColumn]),
        `推荐值.${apiGroup} == 出厂行.${seedColumn}（推荐常量与 config-sync.sql 是同一份）`,
        `接口 ${JSON.stringify(recommended.data[apiGroup])} vs seed ${JSON.stringify(seedRow[seedColumn])}`,
      );
    }

    // 空库首启 = 库里就是出厂行：三组快照接口（drop / autoBattle / guild）此刻也应等于推荐值
    const fresh = await api("GET", "admin/runtime-params", { token: adminToken, zoneId: ADMIN_ZONE });
    check(
      fresh.code === 0 && deepEqual(fresh.data.drop, recommended.data.drop) && deepEqual(fresh.data.autoBattle, recommended.data.autoBattle) && deepEqual(fresh.data.guild, recommended.data.guild),
      "空库首启的三组生效值 == 推荐值（seed 键齐全，启动自检不报错）",
      JSON.stringify(fresh.data || null),
    );
    const freshAi = await api("GET", "admin/runtime-params/monster-ai", { token: adminToken, zoneId: ADMIN_ZONE });
    check(deepEqual(freshAi.data, recommended.data.monsterAi), "空库首启的怪物 AI 生效值 == 推荐值", JSON.stringify(freshAi.data || null));
    const freshMovement = await api("GET", "admin/runtime-params/movement", { token: adminToken, zoneId: ADMIN_ZONE });
    check(deepEqual(freshMovement.data, recommended.data.movement), "空库首启的位移校验生效值 == 推荐值（档位 log）", JSON.stringify(freshMovement.data || null));
    const freshCastRange = await api("GET", "admin/runtime-params/cast-range", { token: adminToken, zoneId: ADMIN_ZONE });
    check(deepEqual(freshCastRange.data, recommended.data.castRange), "空库首启的出手距离闸生效值 == 推荐值（档位 log）", JSON.stringify(freshCastRange.data || null));

    //#endregion

    //#region 二、逐组还原

    console.log("— 二、六个模块各自还原：脏值 → reset → 回到推荐值，且只动自己那一列 —");

    // 先把六组全部弄脏（各挑一个字段改成合法但离推荐值很远的值），还原后逐组核对
    const dirtied = await api("PATCH", "admin/runtime-params", {
      token: adminToken,
      zoneId: ADMIN_ZONE,
      body: { drop: { ttlMs: 300000 }, autoBattle: { cellSize: 8 }, guild: { nameMax: 30 } },
    });
    check(dirtied.code === 0, "三组快照参数已弄脏（ttlMs 300000 / cellSize 8 / nameMax 30）", dirtied.message);
    const dirtyAi = await api("PATCH", "admin/runtime-params/monster-ai", { token: adminToken, zoneId: ADMIN_ZONE, body: { leashRange: 100 } });
    check(dirtyAi.code === 0, "怪物 AI 已弄脏（leashRange 100）", dirtyAi.message);
    const dirtyMovement = await api("PATCH", "admin/runtime-params/movement", { token: adminToken, zoneId: ADMIN_ZONE, body: { mode: "off", maxSpeed: 9999 } });
    check(dirtyMovement.code === 0, "位移校验已弄脏（mode off / maxSpeed 9999）", dirtyMovement.message);
    const dirtyCastRange = await api("PATCH", "admin/runtime-params/cast-range", { token: adminToken, zoneId: ADMIN_ZONE, body: { mode: "enforce" } });
    check(dirtyCastRange.code === 0, "出手距离闸已弄脏（mode enforce）", dirtyCastRange.message);

    // 六个 reset 逐个打：每一步断言「自己回到推荐值」+「还没轮到的组仍是脏值」（reset 不得越权洗掉别人）
    const resetCases = [
      { path: "drop/reset", group: "drop" },
      { path: "auto-battle/reset", group: "autoBattle" },
      { path: "guild/reset", group: "guild" },
      { path: "monster-ai/reset", group: "monsterAi" },
      { path: "movement/reset", group: "movement" },
      { path: "cast-range/reset", group: "castRange" },
    ];
    const dirtyProbe = {
      drop: (value) => value.ttlMs === 300000,
      autoBattle: (value) => value.cellSize === 8,
      guild: (value) => value.nameMax === 30,
      monsterAi: (value) => value.leashRange === 100,
      movement: (value) => value.mode === "off",
      castRange: (value) => value.mode === "enforce",
    };
    for (const [index, item] of resetCases.entries()) {
      const result = await api("POST", `admin/runtime-params/${item.path}`, { token: adminToken, zoneId: ADMIN_ZONE });
      check(result.code === 0, `POST ${item.path} 成功`, result.message);
      check(deepEqual(result.data, recommended.data[item.group]), `${item.group} 还原后 == 推荐值`, JSON.stringify(result.data || null));
      for (const rest of resetCases.slice(index + 1)) {
        const current = await readGroup(rest.group, adminToken);
        check(
          dirtyProbe[rest.group](current),
          `还原 ${item.group} 没有动到 ${rest.group}（还是脏值）`,
          JSON.stringify(current || null),
        );
      }
    }

    // 全部还原完：六组生效值都 == 推荐值
    const finalThree = await api("GET", "admin/runtime-params", { token: adminToken, zoneId: ADMIN_ZONE });
    check(
      deepEqual(finalThree.data.drop, recommended.data.drop) && deepEqual(finalThree.data.autoBattle, recommended.data.autoBattle) && deepEqual(finalThree.data.guild, recommended.data.guild),
      "全还原后：三组快照参数生效值 == 推荐值",
      JSON.stringify(finalThree.data || null),
    );

    //#endregion

    //#region 三、鉴权

    console.log("— 三、鉴权：观察员可读不可还原、玩家令牌 401 —");

    const viewerRead = await api("GET", "admin/runtime-params/recommended", { token: viewerToken, zoneId: ADMIN_ZONE });
    check(viewerRead.code === 0 && !!viewerRead.data.drop, "观察员能读推荐值（gameConfig:read 观察员有）", `${viewerRead.status}`);
    const viewerReset = await api("POST", "admin/runtime-params/drop/reset", { token: viewerToken, zoneId: ADMIN_ZONE });
    check(viewerReset.status === 403 && viewerReset.code === 30006, "观察员还原被拒（403 / 30006：没有 gameConfig:write）", `${viewerReset.status}/${viewerReset.code}`);
    const playerDenied = await api("POST", "admin/runtime-params/drop/reset", { token: playerToken });
    check(playerDenied.status === 401, "玩家令牌调还原接口被拒（401：audience 不符）", `${playerDenied.status}`);

    //#endregion

    //#region 四、审计

    console.log("— 四、审计：还原动作逐条留痕 —");

    const audit = await api("GET", "admin/audit-logs?action=adminRuntimeParams.resetDrop&page=1&size=10", { token: adminToken, zoneId: ADMIN_ZONE });
    // POST 成功的 statusCode 是 201（Created），别按 200 找
    const entry = (audit.data.list || []).find((e) => e.statusCode === 201 || e.statusCode === 200);
    check(!!entry && entry.targetType === "runtimeParams" && entry.actorName === "gm_params", "reset 落审计（action adminRuntimeParams.resetDrop / targetType runtimeParams / 操作人一致）", JSON.stringify((audit.data.list || [])[0] || null));

    //#endregion

    //#region 五、文档

    console.log("— 五、文档：recommended + 六条 reset 都在契约里 —");

    const docResponse = await fetch(`${baseUrl.replace(/\/api$/, "")}/api-docs-json`);
    const docs = await docResponse.json();
    const recommendedOp = (docs.paths["/api/admin/runtime-params/recommended"] || {}).get;
    check(!!recommendedOp && JSON.stringify(recommendedOp).includes("gameConfig:read"), "GET recommended 在契约里且标 gameConfig:read", JSON.stringify(!!recommendedOp));
    const resetPaths = ["drop/reset", "auto-battle/reset", "guild/reset", "monster-ai/reset", "movement/reset", "cast-range/reset"];
    for (const tail of resetPaths) {
      const op = (docs.paths[`/api/admin/runtime-params/${tail}`] || {}).post;
      check(!!op && JSON.stringify(op).includes("gameConfig:write"), `POST ${tail} 在契约里且标 gameConfig:write`, JSON.stringify(!!op));
    }

    //#endregion
  } catch (error) {
    console.error("e2e 异常：", error);
    process.exit(1);
  } finally {
    await app.close();
  }

  finish("运行时参数推荐配置与一键还原（seed 锁死 / 逐组还原 / 越权防护 / 审计 / 文档）全部通过");
})();

/** 组名 → 该组生效值对象（drop / autoBattle / guild 共用一个合体接口，其余各走各的） */
async function readGroup(group, token) {
  const path = group === "monsterAi" ? "admin/runtime-params/monster-ai" : group === "movement" ? "admin/runtime-params/movement" : group === "castRange" ? "admin/runtime-params/cast-range" : "admin/runtime-params";
  const result = await api("GET", path, { token, zoneId: ADMIN_ZONE });
  if (group === "monsterAi" || group === "movement" || group === "castRange") return result.data;
  return result.data ? result.data[group] : null;
}
