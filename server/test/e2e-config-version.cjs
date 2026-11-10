#!/usr/bin/env node
/**
 * 服务端 e2e：配置版本链（#881 / #882 / #883）
 *
 * 三件事必须钉死，否则「配置改了客户端不知道」会以最安静的方式复发：
 *
 * 1. **版本自增**：任何带 `gameConfig:write` 的写接口成功后 +1（判据是权限点，不是路径），
 *    非配置写接口（公告）**不** +1；
 * 2. **ETag / 304**：快照带 `W/"cfg-<version>"`，版本没变时 `If-None-Match` 直接 304 空体
 *    （省掉几 MB 传输），变了才回全量；同一版本下快照**内容**必须逐字节一致（缓存没串味）；
 * 3. **回滚**：每层是全量配置，`restore` 单事务写回、版本 +1、历史不删；
 *    同一人连点合并成一层（节流），回滚自己**不参与**节流（否则回滚点被自己吃掉）；
 *    保留 20 层、超出删最老的；只读观察员调回滚 403。
 *
 * 用法：先 `npm run build`，再 `node test/e2e-config-version.cjs`
 */
process.env.DB_PATH = ":memory:";
process.env.ADMIN_REGISTER_CODE = "test-admin-code";
process.env.JWT_SECRET = "test-secret";
process.env.LOG_REQUESTS = "false";
process.env.CORS_ORIGINS = "*";
// 节流窗压到 800ms：窗口内连点合并、跨窗口各成一层，都能在秒级验证完
// （生产默认 10 秒；这里不压的话测一次要等 10 秒）
process.env.CONFIG_REVISION_THROTTLE_MS = "800";
process.env.CONFIG_REVISION_RETAIN = "20";

const { createHash } = require("node:crypto");
const { NestFactory } = require("@nestjs/core");
const { ValidationPipe } = require("@nestjs/common");
const { AppModule } = require("../dist/app.module");
const { AllExceptionsFilter } = require("../dist/common/filters/all-exceptions.filter");
const { TransformInterceptor } = require("../dist/common/interceptors/transform.interceptor");
const { setupSwagger } = require("../dist/swagger/setup");
const { DatabaseService } = require("../dist/database/database.service");
const { ConfigRevisionService } = require("../dist/modules/game-config/config-revision.service");
const { ConfigVersionService } = require("../dist/modules/game-config/config-version.service");

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

function checkEqual(actual, expected, label) {
  return check(actual === expected, label, JSON.stringify(actual));
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

/** 等一会儿（只在验证节流窗口时用；这两个数字是测试自己的时间常量） */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

//#endregion

let baseUrl = "";

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

/** 快照请求：要拿到**响应头里的 ETag** 与 304 的空体，所以不能用 api() */
async function snapshotCall(token, etag) {
  const headers = { Authorization: `Bearer ${token}` };
  if (etag) headers["If-None-Match"] = etag;
  const response = await fetch(`${baseUrl}/game-config`, { headers });
  const text = await response.text();
  return {
    status: response.status,
    etag: response.headers.get("etag"),
    body: text ? JSON.parse(text) : null,
  };
}

/** 一份数据的内容摘要（sha1；只用于断言失败时把差异压成一行） */
function digest(value) {
  return createHash("sha1").update(JSON.stringify(value ?? null)).digest("hex");
}

/** 快照里某个技能的某个数值（用来验「快照内容真的变了」） */
function skillValue(snapshot, id, field) {
  const row = (snapshot?.body?.data?.skills ?? []).find((item) => item.id === id);
  return row ? row[field] : undefined;
}

async function main() {
  const app = await NestFactory.create(AppModule.register({ realtime: false }), { logger: false });
  app.setGlobalPrefix("api");
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, transformOptions: { enableImplicitConversion: true } }));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new TransformInterceptor());
  setupSwagger(app);
  await app.listen(0);
  baseUrl = `${await app.getUrl()}/api`;

  const db = app.get(DatabaseService);
  const versions = app.get(ConfigVersionService);
  const revisions = app.get(ConfigRevisionService);

  try {
    //#region 一 · 准备
    const admin = await api("POST", "admin/auth/register", {
      body: { username: "gm_config", password: "pass1234", registerCode: "test-admin-code" },
    });
    const adminToken = admin.data.token;
    check(admin.code === 0 && !!adminToken, "准备：注册管理员拿到令牌", admin.message);

    const viewer = await api("POST", "admin/auth/register", {
      body: { username: "gm_config_view", password: "pass1234", registerCode: "test-admin-code" },
    });
    await api("PATCH", `admin/admins/${viewer.data.admin.id}`, { token: adminToken, body: { role: "viewer" } });
    const viewerToken = viewer.data.token;

    const player = await api("POST", "auth/register", { body: { username: "cfg_player", password: "pass1234" } });
    const playerToken = player.data.token;
    check(player.code === 0 && !!playerToken, "准备：注册玩家拿到令牌", player.message);
    //#endregion

    //#region 二 · 版本与 ETag（#881）
    const v0 = await api("GET", "game-config/version", { token: playerToken });
    checkEqual(v0.code, 0, "玩家侧 GET /game-config/version 可用");
    checkEqual(v0.data?.version, 0, "空库首启：版本从 0 开始（出厂快照文件写的是第 0 版）");

    const adminV0 = await api("GET", "admin/config/version", { token: adminToken });
    checkEqual(adminV0.code, 0, "管理端版本接口可用", adminV0.message);
    checkEqual(adminV0.data?.version, 0, "管理端看到同一个数字");

    const first = await snapshotCall(playerToken);
    checkEqual(first.status, 200, "首次拉快照 200");
    checkEqual(first.etag, 'W/"cfg-0"', "快照带 ETag（W/ + 版本号，不哈希内容）");
    checkEqual(skillValue(first, "1001", "castLockMs") !== undefined, true, "快照里能取到技能 1001 的 castLockMs");

    const cached = await snapshotCall(playerToken, first.etag);
    checkEqual(cached.status, 304, "同一版本带 If-None-Match → 304");
    // 别用 checkEqual(…, null)：失败时它会把整份几 MB 的快照 JSON 打进日志
    check(
      cached.body === null,
      "304 没有响应体（省掉几 MB）",
      cached.body === null ? undefined : `收到了 ${JSON.stringify(cached.body).length} 字节`,
    );

    const wildcard = await snapshotCall(playerToken, "*");
    checkEqual(wildcard.status, 304, "If-None-Match: * 也算命中（RFC 允许）");

    const staleEtag = await snapshotCall(playerToken, 'W/"cfg-999"');
    checkEqual(staleEtag.status, 200, "ETag 不匹配 → 照常回全量");

    const contentA = await snapshotCall(playerToken);
    const contentB = await snapshotCall(playerToken);
    // 比摘要而不是比整份 JSON：断言失败时日志里只会出现两个 sha1，不会灌进几 MB
    checkEqual(digest(contentA.body?.data), digest(contentB.body?.data), "同一版本两次拉快照内容一致（缓存没串味）");
    //#endregion

    //#region 三 · 写配置 +1（判据是权限点）
    const patch1 = await api("PATCH", "admin/skills/1001", { token: adminToken, body: { castLockMs: 1111 } });
    checkEqual(patch1.code, 0, "改技能 castLockMs 成功", patch1.message);

    const v1 = await api("GET", "game-config/version", { token: playerToken });
    checkEqual(v1.data?.version, 1, "写配置成功后版本 +1");

    const afterPatch = await snapshotCall(playerToken, first.etag);
    checkEqual(afterPatch.status, 200, "版本变了 → 旧 ETag 不再命中 304");
    checkEqual(skillValue(afterPatch, "1001", "castLockMs"), 1111, "快照内容跟着变（技能 castLockMs）");
    checkEqual(afterPatch.etag, 'W/"cfg-1"', "ETag 跟着版本走");

    // 非配置写接口不该 +1：公告走 announcement:write，不进配置版本
    const announcement = await api("POST", "admin/announcements", { token: adminToken, body: { title: "版本链测试", content: "不该影响配置版本" } });
    checkEqual(announcement.code, 0, "准备：发一条公告", announcement.message);
    const afterAnnouncement = await api("GET", "admin/config/version", { token: adminToken });
    checkEqual(afterAnnouncement.data?.version, 1, "公告这类非配置写不动版本号（判据是 gameConfig:write 权限点）");
    //#endregion

    //#region 四 · 回滚历史与节流（#882）
    const list1 = await api("GET", "admin/config/revisions", { token: adminToken });
    checkEqual(list1.data?.total, 1, "第一次改配置落了一层历史");
    const layer1 = list1.data?.list?.[0] ?? { version: -1, rowCount: -1 };
    checkEqual(layer1.version, 1, "层的版本号 = 改动后的版本号");
    checkEqual(layer1.label, "adminSkill.update", "层上记的是触发改动的接口标识");
    checkEqual(layer1.createdBy, "gm_config", "层上记的是操作人");
    check(layer1.tableCount >= 30, "payload 是全量配置（38 张表上下）", String(layer1.tableCount));
    check(layer1.rowCount > 10000, "payload 行数与库里一致（约 1.3 万行）", String(layer1.rowCount));
    check(layer1.byteSize > 0, "payload 字节数有记录");

    // 窗口内连点：合并成一层（版本照旧 +1）
    await api("PATCH", "admin/skills/1001", { token: adminToken, body: { castLockMs: 2222 } });
    await api("PATCH", "admin/skills/1001", { token: adminToken, body: { castLockMs: 3333 } });
    const listBurst = await api("GET", "admin/config/revisions", { token: adminToken });
    checkEqual(listBurst.data?.total, 1, "同一人在节流窗内连点 3 次 → 只有一层");
    checkEqual(listBurst.data?.list?.[0]?.version, 3, "那一层记的是最新版本号（内容也是最新的）");
    const v3 = await api("GET", "game-config/version", { token: playerToken });
    checkEqual(v3.data?.version, 3, "版本号本身每次都 +1（合并的只是历史层）");

    // 跨窗口：新的一层
    await sleep(900);
    await api("PATCH", "admin/skills/1001", { token: adminToken, body: { castLockMs: 4444 } });
    const list2 = await api("GET", "admin/config/revisions", { token: adminToken });
    checkEqual(list2.data?.total, 2, "过了节流窗再改 → 新的一层");
    checkEqual(list2.data?.list?.[0]?.version, 4, "最新一层是第 4 版");
    checkEqual(list2.data?.list?.[1]?.version, 3, "上一层的版本号没被改写");

    const diff = await api("GET", "admin/config/revisions/3/diff/4", { token: adminToken });
    checkEqual(diff.code, 0, "diff 接口可用", diff.message);
    check((diff.data?.tables ?? []).some((row) => row.table === "skills"), "diff 指出 skills 表有变化", JSON.stringify(diff.data?.tables ?? null));
    checkEqual(diff.data?.changed, (diff.data?.tables ?? []).length, "changed 与逐表条目数一致");
    //#endregion

    //#region 五 · 回滚（#882）
    const restore = await api("POST", "admin/config/revisions/3/restore", { token: adminToken });
    checkEqual(restore.code, 0, "回滚到第 3 版成功", restore.message);
    checkEqual(restore.data?.restoredFrom, 3, "结果里写了取自哪一版");
    check((restore.data?.version ?? 0) > 4, "回滚本身也是一层新版本（版本继续往前）", String(restore.data?.version ?? null));
    checkEqual(restore.data?.rows, layer1.rowCount, "恢复的行数 = payload 里的行数");

    const restored = await snapshotCall(playerToken);
    checkEqual(skillValue(restored, "1001", "castLockMs"), 3333, "库里的值回到第 3 版（3333）");
    checkEqual(restored.etag, `W/"cfg-${restore.data?.version}"`, "快照 ETag 跟上回滚后的版本");

    const history = await api("GET", "admin/config/revisions", { token: adminToken });
    checkEqual(history.data?.list?.[0]?.label, "restore:v3", "回滚落的那一层 label 是 restore:vN");
    checkEqual(history.data?.total, 3, "历史不删：v3 / v4 / 回滚层都在");
    check(
      (history.data?.list ?? []).some((row) => row.version === 4),
      "回滚没有把回滚前的第 4 版吃掉（回滚自身不参与节流）",
      JSON.stringify((history.data?.list ?? []).map((row) => row.version)),
    );

    const missing = await api("POST", "admin/config/revisions/99999/restore", { token: adminToken });
    checkEqual(missing.code, 50146, "回滚一个不存在的版本 → 404 / 50146", missing.message);

    const forbiddenList = await api("GET", "admin/config/revisions", { token: viewerToken });
    checkEqual(forbiddenList.code, 30006, "只读观察员看不了配置版本历史", forbiddenList.message);
    const forbiddenRestore = await api("POST", "admin/config/revisions/3/restore", { token: viewerToken });
    checkEqual(forbiddenRestore.code, 30006, "只读观察员不能回滚", forbiddenRestore.message);
    //#endregion

    //#region 六 · 保留层数（20）
    const total0 = db.count("SELECT COUNT(1) AS total FROM config_revisions");
    const maxVersion = db.count("SELECT MAX(version) AS total FROM config_revisions");
    const now = Date.now();
    // 直接塞到 25 行（绕过 record，省掉 25 次全量 dump）：保留策略在 record 里，塞完再记一层就能看到它生效
    for (let index = 0; index < 25 - total0; index += 1) {
      db.run(
        "INSERT INTO config_revisions (version, label, payload, byte_size, table_count, row_count, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [maxVersion + 1000 + index, "filler", '{"version":0,"tables":{}}', 26, 0, 0, "filler", now],
      );
    }
    checkEqual(db.count("SELECT COUNT(1) AS total FROM config_revisions"), 25, "准备：历史里塞到 25 层");

    revisions.record(maxVersion + 2000, { username: "gm_config" }, "retain-test", { throttle: false });
    const remaining = db.all("SELECT version FROM config_revisions ORDER BY version ASC");
    checkEqual(db.count("SELECT COUNT(1) AS total FROM config_revisions"), 20, "超过 20 层后删到 20 层");
    checkEqual(db.count("SELECT COUNT(1) AS total FROM config_revisions WHERE version = ?", [maxVersion + 2000]), 1, "刚记的那层在");
    // 25 层 → 「先删最老 6 层再加 1」= 20 层：留下来的最早一层是 filler 的第 4 个
    checkEqual(remaining[0].version, maxVersion + 1003, "删掉的正好是最老的 6 层（先删后加，不会因满而写失败）");
    checkEqual(remaining[remaining.length - 1].version, maxVersion + 2000, "最新一层是刚记的那层");
    checkEqual(versions.current() >= maxVersion, true, "版本计数器不受保留策略影响（只删历史行）");
    //#endregion

    //#region 七 · 文档
    const doc = await fetch(`${await app.getUrl()}/api-docs-json`).then((response) => (response.ok ? response.json() : null));
    if (doc) {
      const paths = ["/api/admin/config/version", "/api/admin/config/revisions", "/api/admin/config/revisions/{from}/diff/{to}", "/api/admin/config/revisions/{version}/restore", "/api/game-config/version"];
      const missingPaths = paths.filter((path) => !doc.paths?.[path]);
      checkEqual(missingPaths.join(","), "", "五个新接口都进了 OpenAPI 文档");
      const restoreOp = doc.paths?.["/api/admin/config/revisions/{version}/restore"]?.post;
      checkEqual(restoreOp?.["x-olua-audience"], "admin", "回滚接口归在管理端分组");
    }
    //#endregion
  } finally {
    await app.close();
  }

  finish("配置版本链 e2e");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
