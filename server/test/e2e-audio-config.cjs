#!/usr/bin/env node
/**
 * 音效配置专项 e2e（server/test/e2e-audio-config.cjs，#680）
 *
 * 盯的不变量（改音效接口 / seed / AUDIO_DEFAULTS 后必须全绿）：
 *
 * 一、鉴权：观察员可读不可写（403 / 30006）、玩家令牌 401 —— 改音效是运营动作
 * 二、seed：**12 项**按 `AUDIO_KEYS` 登记顺序（分类成组）补出、四个分类各有项、
 *     每行形状对（展示名 / 分类 / 分类名 / 音量范围 / 路径合法 / 两个布尔 / 无追账）；
 *     **没有新建 / 删除接口**（POST / DELETE 404：key 由客户端播放代码决定）
 * 三、路径判据：只认 `audio/` 下、扩展名白名单、不许 `..` / 绝对路径 / 中文与空格；
 *     空串合法（= 未配置，这一项不响）；反斜杠会被规范成正斜杠
 * 四、音量边界：0 / 100 收，-1 / 101 / 小数被拒
 * 五、保存：整份覆盖 + 追账字段（updatedBy / updatedAt > 0）+ 再读一次还在
 * 六、客户端（#683）：快照有 `audio` 段（12 行、只有播放要用的五个字段）、
 *     公开接口 `GET /game-config/audio` 不带令牌也能读且与快照同形状同顺序
 * 七、审计：action = adminAudioSetting.save、targetType = audioSetting
 * 八、文档：两个管理 operation + 一个玩家 operation、模型字段齐全、写模型没有 key
 *
 * 用法：先 `npm run build`，再 `node test/e2e-audio-config.cjs`
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

//#region 断言小工具（与 e2e-ui-effect 同款口径）

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

/** 发一次请求，返回归一后的结果 */
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

/** 保存一次的快捷封装（字段缺省 = 出厂值形状，便于只改一处断言一处） */
function saveAudio(key, token, body) {
  return api("PATCH", `admin/audio-settings/${key}`, {
    token,
    body: { filePath: "audio/login-bgm.wav", volume: 60, loop: true, enabled: true, ...body },
  });
}

(async () => {
  const app = await NestFactory.create(AppModule.register({ realtime: true }), { logger: false });
  app.setGlobalPrefix("api");
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, transformOptions: { enableImplicitConversion: true } }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new TransformInterceptor());
  setupSwagger(app);
  await app.listen(0);
  baseUrl = `${await app.getUrl()}/api`;

  try {
    //#region 准备

    console.log("— 准备：超管 + 观察员 + 一个玩家 —");

    const superAdmin = await api("POST", "admin/auth/register", {
      body: { username: "gm_audio", password: "pass1234", registerCode: "test-admin-code" },
    });
    const adminToken = superAdmin.data.token;
    check(superAdmin.code === 0 && !!adminToken, "准备：注册超管拿到令牌", superAdmin.message);

    const viewer = await api("POST", "admin/auth/register", {
      body: { username: "gm_audio_view", password: "pass1234", registerCode: "test-admin-code" },
    });
    const viewerToken = viewer.data.token;
    await api("PATCH", `admin/admins/${viewer.data.admin.id}`, { token: adminToken, body: { role: "viewer" } });

    const player = await api("POST", "auth/register", { body: { username: "audio_player", password: "pass1234" } });
    const playerToken = player.data.token;
    // #597 起建号只交三样客户端数据，角色 id 由服务端生成
    const role = await api("POST", "roles", { token: playerToken, body: { name: "音效体验官", occupation: "1", sex: "1" } });
    check(role.code === 0 && role.data.online === true, "准备：玩家在线角色已就位", role.message);

    //#endregion

    //#region 一、鉴权

    console.log("— 一、鉴权：观察员可读不可写、玩家令牌 401 —");

    const viewerList = await api("GET", "admin/audio-settings", { token: viewerToken });
    check(viewerList.code === 0 && viewerList.data.total === 12, "观察员能读音效列表（gameConfig:read）", `${viewerList.status}`);
    const viewerSave = await saveAudio("login_bgm", viewerToken, { volume: 30 });
    check(
      viewerSave.status === 403 && viewerSave.code === 30006,
      "观察员保存被拒（403 / 30006：没有 gameConfig:write）",
      `${viewerSave.status}/${viewerSave.code}`,
    );
    const playerDenied = await api("GET", "admin/audio-settings", { token: playerToken });
    check(playerDenied.status === 401, "玩家令牌调管理端接口被拒（401：audience 不符）", `${playerDenied.status}`);

    //#endregion

    //#region 二、seed 与「没有新建 / 删除」

    console.log("— 二、seed：12 项按登记顺序（分类成组）补出、没有新建 / 删除接口 —");

    const list = await api("GET", "admin/audio-settings", { token: adminToken });
    check(list.code === 0, "超管能读音效列表", list.message);
    const rows = list.data?.list ?? [];
    check(rows.length === 12 && list.data.total === 12, "出厂 12 个音效项", `${rows.length}`);

    // 顺序 = `AUDIO_KEYS` 登记顺序（按分类成组）—— 管理端 tab 的分组与顺序就按它排，
    // 换成字典序会让「界面与交互」不再排在最前面
    const EXPECTED_KEYS = [
      "login_bgm",
      "ui_click",
      "warrior_attack",
      "role_die_man",
      "role_die_woman",
      "move",
      "item_drop",
      "equip_wear",
      "money_change",
      "bag_resort",
      "level_up",
      "map_teleport",
    ];
    check(
      JSON.stringify(rows.map((row) => row.key)) === JSON.stringify(EXPECTED_KEYS),
      "按 AUDIO_KEYS 登记顺序返回（分类成组，不是字典序）",
      rows.map((row) => row.key).join(","),
    );

    // 改名（#685：`login_click` → `ui_click`）的两条契约：
    // 展示名要跟着用途走（它现在挂在所有按钮上，不再只是登录按钮），
    // 旧 key 不能留着 —— 老库里的那行由 seed 的 deleteOrphans 清掉，管理端不该出现「点了没声音」的孤儿项
    const clickRow = rows.filter((row) => row.key === "ui_click")[0];
    check(clickRow?.label === "按钮点击音", "点击音展示名是「按钮点击音」（全站按钮共用）", clickRow?.label);
    check(rows.every((row) => row.key !== "login_click"), "旧 key login_click 没有残留（改名后 seed 会清孤儿）", rows.map((r) => r.key).join(","));

    // 逐行的**形状**断言：不锁具体数值（出厂音量 / 路径随时会被运营改），只锁「该有的都在、类型对」
    for (const row of rows) {
      check(!!row.label && row.label !== row.key, `${row.key}：有展示名`, row.label);
      check(
        ["login", "combat", "item", "growth"].includes(row.category),
        `${row.key}：分类在四个已知分类里`,
        row.category,
      );
      check(!!row.categoryLabel && row.categoryLabel !== row.category, `${row.key}：有分类展示名`, row.categoryLabel);
      check(
        Number.isInteger(row.volume) && row.volume >= 0 && row.volume <= 100,
        `${row.key}：音量是 0~100 的整数`,
        row.volume,
      );
      check(
        row.filePath === "" || /^audio\/[A-Za-z0-9_\-/]+\.[A-Za-z0-9]+$/.test(row.filePath),
        `${row.key}：路径合法（audio/ 下英文名）或未配置`,
        JSON.stringify(row.filePath),
      );
      check(typeof row.loop === "boolean" && typeof row.enabled === "boolean", `${row.key}：两个布尔开关`, `${row.loop}/${row.enabled}`);
      // 追账只锁形状，不锁「必须是 0」：快照（config-sync.sql）跟着库走，运营保存过的行
      // 带着操作人/时间戳进来是 #655 定的口径（库里是权威），不能再假设测试库全是出厂行
      check(
        typeof row.updatedAt === "number" && row.updatedAt >= 0 && typeof row.updatedBy === "string",
        `${row.key}：追账字段形状对（数字时间戳 + 字符串操作人）`,
        `${row.updatedAt}/${row.updatedBy}`,
      );
    }

    // 分类是**清单本身**的一部分（不是运营数据）：每类各几项，改了清单就要改这条
    const byCategory = rows.reduce((acc, row) => ({ ...acc, [row.category]: (acc[row.category] ?? 0) + 1 }), {});
    check(
      byCategory.login === 2 && byCategory.combat === 4 && byCategory.item === 4 && byCategory.growth === 2,
      "四个分类各有项（登录 2 / 战斗 4 / 物品 4 / 成长 2）",
      JSON.stringify(byCategory),
    );
    check(rows.some((row) => row.loop), "至少有一项是循环（登录背景音）", rows.filter((row) => row.loop).map((row) => row.key).join(","));
    check(rows.every((row) => row.enabled), "出厂全部启用（没有任何一项默认哑掉）");

    const createTry = await api("POST", "admin/audio-settings", { token: adminToken, body: {} });
    check(createTry.status === 404, "没有新建接口（POST 404：key 由客户端播放代码决定）", `${createTry.status}`);
    const deleteTry = await api("DELETE", "admin/audio-settings/login_bgm", { token: adminToken });
    check(deleteTry.status === 404, "没有删除接口（DELETE 404）", `${deleteTry.status}`);

    //#endregion

    //#region 三、路径判据

    console.log("— 三、路径判据：只认 audio/ 下、扩展名白名单、不许 .. / 绝对路径 —");

    const badPaths = [
      { filePath: "images/login_bg.wav", why: "不在 audio/ 下" },
      { filePath: "/audio/login-bgm.wav", why: "绝对路径（相对 resources 才是对的）" },
      { filePath: "audio/../secrets.wav", why: "出现 .." },
      { filePath: "audio/login_bg.txt", why: "扩展名不在白名单" },
      { filePath: "audio/login bg.wav", why: "文件名带空格" },
      { filePath: "audio/战士普攻.wav", why: "文件名带中文（用户定：只允许英文名）" },
    ];
    for (const { filePath, why } of badPaths) {
      const rejected = await saveAudio("login_bgm", adminToken, { filePath });
      check(
        rejected.status === 400 && rejected.code === 40000,
        `路径被拒（${why}）：${filePath}`,
        `${rejected.status}/${rejected.code} ${rejected.message}`,
      );
    }

    // 空串 = 未配置，是合法状态（文件还没进资源包时就这样留着）
    const cleared = await saveAudio("ui_click", adminToken, { filePath: "", volume: 80, loop: false });
    check(cleared.code === 0 && cleared.data.filePath === "", "空串合法（= 未配置，不是错误）", `${cleared.status}/${cleared.code}`);

    // 反斜杠（Windows 上复制来的路径）会被规范成正斜杠，而不是被拒
    const backslash = await saveAudio("login_bgm", adminToken, { filePath: "audio\\login-bgm.wav" });
    check(backslash.code === 0 && backslash.data.filePath === "audio/login-bgm.wav", "反斜杠规范成正斜杠", JSON.stringify(backslash.data?.filePath));

    // 多级目录合法（以后分场景建子目录不用改判据）
    const nested = await saveAudio("login_bgm", adminToken, { filePath: "audio/login/bgm_main.wav" });
    check(nested.code === 0, "audio/ 下多级目录合法", `${nested.status}/${nested.message}`);

    //#endregion

    //#region 四、音量边界

    console.log("— 四、音量边界：0 / 100 收，越界与小数被拒 —");

    const minVolume = await saveAudio("login_bgm", adminToken, { volume: 0 });
    check(minVolume.code === 0 && minVolume.data.volume === 0, "音量 0 合法（等于静音，排查时有用）", `${minVolume.status}`);
    const maxVolume = await saveAudio("login_bgm", adminToken, { volume: 100 });
    check(maxVolume.code === 0 && maxVolume.data.volume === 100, "音量 100 合法", `${maxVolume.status}`);

    for (const volume of [-1, 101, 1.5]) {
      const rejected = await saveAudio("login_bgm", adminToken, { volume });
      check(rejected.status === 400, `音量 ${volume} 被拒`, `${rejected.status}/${rejected.code}`);
    }

    //#endregion

    //#region 五、保存成功

    console.log("— 五、保存：整份覆盖 + 追账 + 再读一次还在 —");

    const saved = await saveAudio("login_bgm", adminToken, {
      filePath: "audio/login-bgm.wav",
      volume: 35,
      loop: false,
      enabled: false,
    });
    check(saved.code === 0, "保存成功", saved.message);
    check(saved.data.key === "login_bgm" && saved.data.label === "登录场景背景音", "返回体带 key 与展示名", JSON.stringify(saved.data?.key));
    check(saved.data.volume === 35 && saved.data.loop === false && saved.data.enabled === false, "四项都按提交值覆盖（整份覆盖，不是部分更新）", JSON.stringify(saved.data));
    check(saved.data.updatedAt > 0, "追账：updatedAt > 0（改过了）", String(saved.data?.updatedAt));
    check(saved.data.updatedBy === "gm_audio", "追账：updatedBy = 操作人账号名", saved.data?.updatedBy);

    const reloaded = await api("GET", "admin/audio-settings", { token: adminToken });
    const bgmAfter = (reloaded.data?.list ?? []).find((row) => row.key === "login_bgm");
    check(bgmAfter?.volume === 35 && bgmAfter?.enabled === false, "再读一次仍是保存后的值（落了库，不是内存）", JSON.stringify(bgmAfter));

    // 另一半没动：保存一项不该顺手改另一项
    const clickAfter = (reloaded.data?.list ?? []).find((row) => row.key === "ui_click");
    check(clickAfter?.volume === 80 && clickAfter?.loop === false, "另一个音效项没被连带改动", JSON.stringify(clickAfter));

    //#endregion

    //#region 六、客户端对接（#683）

    console.log("— 六、客户端：快照有 audio 段 + 公开接口无需令牌、同形状同顺序 —");

    const snapshot = await api("GET", "game-config", { token: playerToken });
    check(snapshot.code === 0, "玩家能拉配置快照", snapshot.message);
    const audio = snapshot.data?.audio;
    check(Array.isArray(audio) && audio.length === 12, "快照 audio 段 12 行（客户端按 key 取用）", `${Array.isArray(audio) ? audio.length : typeof audio}`);
    check(
      Array.isArray(audio) && audio.every((row) => ["key", "filePath", "volume", "loop", "enabled"].every((field) => field in row)),
      "客户端形状只有播放要用的五个字段",
      JSON.stringify(audio?.[0]),
    );
    check(
      Array.isArray(audio) && audio.every((row) => !("label" in row) && !("category" in row) && !("updatedBy" in row) && !("updatedAt" in row)),
      "不下发展示名 / 分类 / 追账（客户端不消费，多一个字段就多一个误读）",
      JSON.stringify(audio?.[0]),
    );
    check(
      JSON.stringify((audio ?? []).map((row) => row.key)) === JSON.stringify(EXPECTED_KEYS),
      "快照顺序与 AUDIO_KEYS 登记顺序一致",
      (audio ?? []).map((row) => row.key).join(","),
    );

    // 公开接口：登录场景没有令牌，而登录背景音正是那时要播的（与公告同一口径）
    const anonymous = await api("GET", "game-config/audio");
    check(anonymous.code === 0 && anonymous.data?.total === 12, "公开接口不带令牌也能读（登录页要用）", `${anonymous.status}/${anonymous.code}`);
    check(
      JSON.stringify((anonymous.data?.list ?? []).map((row) => row.key)) === JSON.stringify(EXPECTED_KEYS),
      "公开接口与快照同形状同顺序（客户端只留一套读法）",
      (anonymous.data?.list ?? []).map((row) => row.key).join(","),
    );

    //#endregion

    //#region 七、审计

    console.log("— 七、审计：动作与目标类型 —");

    const audit = await api("GET", "admin/audit-logs?size=50&targetType=audioSetting", { token: adminToken });
    check(audit.code === 0, "能查审计日志", audit.message);
    const audioLogs = audit.data?.list ?? [];
    check(audioLogs.length > 0, "写音效会进审计（targetType = audioSetting）", `${audioLogs.length}`);
    check(audioLogs.every((log) => log.targetType === "audioSetting"), "每条的目标类型都是 audioSetting", JSON.stringify(audioLogs[0]));
    check(
      audioLogs.some((log) => log.action === "adminAudioSetting.save" && log.success === true),
      "动作 = adminAudioSetting.save（由 operationId 写入，不是手抄）",
      JSON.stringify(audioLogs[0]),
    );

    //#endregion

    //#region 八、文档契约

    console.log("— 八、文档：三个 operation + 模型字段 —");

    // OpenAPI 文档直接从 `server/openapi.json` 取（与 gen-api 同源；swagger:emit 时产出）
    const swaggerDoc = require("../openapi.json");
    const audioOps = Object.entries(swaggerDoc.paths)
      .filter(([path]) => path.includes("/admin/audio-settings"))
      .map(([, item]) => Object.values(item).map((op) => op.operationId))
      .flat();
    check(audioOps.includes("adminAudioSetting.list"), "文档里有 adminAudioSetting.list", JSON.stringify(audioOps));
    check(audioOps.includes("adminAudioSetting.save"), "文档里有 adminAudioSetting.save", JSON.stringify(audioOps));
    check(audioOps.length === 2, "只有读 / 写两个 operation（没有新建 / 删除）", `${audioOps.length}`);

    const schema = swaggerDoc.components?.schemas?.AudioSettingDto;
    check(Boolean(schema), "模型 AudioSettingDto 已登记（SWAGGER_MODELS）");
    const props = Object.keys(schema?.properties ?? {});
    for (const field of ["key", "label", "category", "categoryLabel", "filePath", "volume", "loop", "enabled", "updatedBy", "updatedAt"]) {
      check(props.includes(field), `AudioSettingDto 有 ${field}`, props.join(","));
    }
    const saveProps = Object.keys(swaggerDoc.components?.schemas?.SaveAudioSettingDto?.properties ?? {});
    check(!saveProps.includes("key"), "写模型没有 key（路径里已经有了）", saveProps.join(","));

    // 客户端形状（#683）：五个字段，没有展示名 / 分类 / 追账
    const configProps = Object.keys(swaggerDoc.components?.schemas?.AudioConfigDto?.properties ?? {});
    check(
      JSON.stringify(configProps.slice().sort()) === JSON.stringify(["enabled", "filePath", "key", "loop", "volume"]),
      "AudioConfigDto 只有播放要用的五个字段",
      configProps.join(","),
    );
    const gameConfigOps = Object.entries(swaggerDoc.paths)
      .filter(([path]) => path.includes("/game-config"))
      .map(([, item]) => Object.values(item).map((op) => op.operationId))
      .flat();
    check(gameConfigOps.includes("gameConfig.audio"), "文档里有 gameConfig.audio（公开接口）", JSON.stringify(gameConfigOps));

    //#endregion
  } finally {
    await app.close();
  }

  finish("音效配置 e2e 全部通过");
})().catch((error) => {
  console.error("e2e 执行失败：", error);
  process.exit(1);
});
