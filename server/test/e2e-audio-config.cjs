#!/usr/bin/env node
/**
 * 音效配置专项 e2e（server/test/e2e-audio-config.cjs，#680）
 *
 * 盯的不变量（改音效接口 / seed / AUDIO_DEFAULTS 后必须全绿）：
 *
 * 一、鉴权：观察员可读不可写（403 / 30006）、玩家令牌 401 —— 改音效是运营动作
 * 二、seed：两项（登录背景音 + 登录按钮音）按登记顺序补出、`updatedAt = 0`（= 从没改过）、
 *     **没有新建 / 删除接口**（POST / DELETE 404：key 由客户端播放代码决定）
 * 三、路径判据：只认 `sounds/` 下、扩展名白名单、不许 `..` / 绝对路径 / 中文与空格；
 *     空串合法（= 未配置，这一项不响）；反斜杠会被规范成正斜杠
 * 四、音量边界：0 / 100 收，-1 / 101 / 小数被拒
 * 五、保存：整份覆盖 + 追账字段（updatedBy / updatedAt > 0）+ 再读一次还在
 * 六、**本轮不接客户端**：`GET /game-config` 里没有 audio 段（对接时这条要一起改）
 * 七、审计：action = adminAudioSetting.save、targetType = audioSetting
 * 八、文档：两个 operation 在 OpenAPI 里、模型字段齐全、写模型没有 key（路径里已经有了）
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
    body: { filePath: "sounds/login_bg.wav", volume: 60, loop: true, enabled: true, ...body },
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
    check(viewerList.code === 0 && viewerList.data.total === 2, "观察员能读音效列表（gameConfig:read）", `${viewerList.status}`);
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

    console.log("— 二、seed：两项按登记顺序补出、没有新建 / 删除接口 —");

    const list = await api("GET", "admin/audio-settings", { token: adminToken });
    check(list.code === 0, "超管能读音效列表", list.message);
    const rows = list.data?.list ?? [];
    check(rows.length === 2 && list.data.total === 2, "出厂两项（登录背景音 / 登录按钮音）", `${rows.length}`);

    const [bgm, click] = rows;
    check(bgm?.key === "login_bgm", "第一项是登录背景音（按 AUDIO_KEYS 登记顺序，不是字典序）", bgm?.key);
    check(bgm?.label === "登录场景背景音", "展示名随接口下发（页面不写死文案）", bgm?.label);
    check(bgm?.filePath === "sounds/login_bg.wav", "背景音出厂指向资源包里已有的文件", bgm?.filePath);
    check(bgm?.volume === 60 && bgm?.loop === true && bgm?.enabled === true, "背景音出厂：音量 60 / 循环 / 启用", JSON.stringify(bgm));
    check(bgm?.updatedAt === 0 && bgm?.updatedBy === "", "出厂行没有追账（0 = 从没改过）", `${bgm?.updatedAt}/${bgm?.updatedBy}`);

    check(click?.key === "login_click", "第二项是登录按钮音", click?.key);
    check(click?.label === "登录场景点击登录按钮音", "按钮音展示名正确", click?.label);
    check(click?.filePath === "sounds/click_button.wav", "按钮音出厂指向资源包里已有的点击音", JSON.stringify(click?.filePath));
    check(click?.loop === false, "点击音不循环（循环播点击音会一直响）", String(click?.loop));

    const createTry = await api("POST", "admin/audio-settings", { token: adminToken, body: {} });
    check(createTry.status === 404, "没有新建接口（POST 404：key 由客户端播放代码决定）", `${createTry.status}`);
    const deleteTry = await api("DELETE", "admin/audio-settings/login_bgm", { token: adminToken });
    check(deleteTry.status === 404, "没有删除接口（DELETE 404）", `${deleteTry.status}`);

    //#endregion

    //#region 三、路径判据

    console.log("— 三、路径判据：只认 sounds/ 下、扩展名白名单、不许 .. / 绝对路径 —");

    const badPaths = [
      { filePath: "images/login_bg.wav", why: "不在 sounds/ 下" },
      { filePath: "/sounds/login_bg.wav", why: "绝对路径（相对 resources 才是对的）" },
      { filePath: "sounds/../secrets.wav", why: "出现 .." },
      { filePath: "sounds/login_bg.txt", why: "扩展名不在白名单" },
      { filePath: "sounds/login bg.wav", why: "文件名带空格" },
      { filePath: "sounds/木剑砍击音效.wav", why: "文件名带中文（用户定：只允许英文名）" },
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
    const cleared = await saveAudio("login_click", adminToken, { filePath: "", volume: 80, loop: false });
    check(cleared.code === 0 && cleared.data.filePath === "", "空串合法（= 未配置，不是错误）", `${cleared.status}/${cleared.code}`);

    // 反斜杠（Windows 上复制来的路径）会被规范成正斜杠，而不是被拒
    const backslash = await saveAudio("login_bgm", adminToken, { filePath: "sounds\\login_bg.wav" });
    check(backslash.code === 0 && backslash.data.filePath === "sounds/login_bg.wav", "反斜杠规范成正斜杠", JSON.stringify(backslash.data?.filePath));

    // 多级目录合法（以后分场景建子目录不用改判据）
    const nested = await saveAudio("login_bgm", adminToken, { filePath: "sounds/login/bgm_main.wav" });
    check(nested.code === 0, "sounds/ 下多级目录合法", `${nested.status}/${nested.message}`);

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
      filePath: "sounds/login_bg.wav",
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
    const clickAfter = (reloaded.data?.list ?? []).find((row) => row.key === "login_click");
    check(clickAfter?.volume === 80 && clickAfter?.loop === false, "另一个音效项没被连带改动", JSON.stringify(clickAfter));

    //#endregion

    //#region 六、本轮不接客户端

    console.log("— 六、本轮不接客户端：快照里还没有 audio 段 —");

    const snapshot = await api("GET", "game-config", { token: playerToken });
    check(snapshot.code === 0, "玩家能拉配置快照", snapshot.message);
    // 对接客户端时这一条要一起改：届时 audio 段会出现在快照里（并且带 enabled / filePath / volume / loop）
    check(snapshot.data?.audio === undefined, "快照里没有 audio 段（本轮约定：先配置、后对接）", typeof snapshot.data?.audio);

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

    console.log("— 八、文档：两个 operation + 模型字段 —");

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
    for (const field of ["key", "label", "filePath", "volume", "loop", "enabled", "updatedBy", "updatedAt"]) {
      check(props.includes(field), `AudioSettingDto 有 ${field}`, props.join(","));
    }
    const saveProps = Object.keys(swaggerDoc.components?.schemas?.SaveAudioSettingDto?.properties ?? {});
    check(!saveProps.includes("key"), "写模型没有 key（路径里已经有了）", saveProps.join(","));

    //#endregion
  } finally {
    await app.close();
  }

  finish("音效配置 e2e 全部通过");
})().catch((error) => {
  console.error("e2e 执行失败：", error);
  process.exit(1);
});
