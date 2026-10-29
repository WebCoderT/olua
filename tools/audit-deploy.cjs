#!/usr/bin/env node
/**
 * 部署接线审计（deploy wiring audit）
 *
 * 这套文件里有两处**跨文件耦合**，改一边忘了另一边不会报任何错，只会在运行时才炸：
 *   1. nginx 反代的上游主机名 = `docker-compose.yml` 里的服务名（改名后 502 才知道）
 *   2. `docker-compose.yml` 里 server 的 `DB_PATH` 必须落在它挂的卷里 ——
 *      不然容器一重建就「数据没了」（库写在容器可写层里）
 *
 * 另外几条属于「配置漂移」与「别把密钥打进镜像」：
 *   - nginx 反代的路径前缀 = 服务端 API_PREFIX = 管理端构建参数 VITE_API_BASE_URL
 *   - Dockerfile 里 `COPY` 的源路径真的存在（改目录名后 build 才失败太晚了）
 *   - `.dockerignore` 必须排除 `.env` 与 `node_modules`（密钥会被打进镜像层，翻得出来）
 *   - compose 里 `${VAR}` 一律要有默认值（没设就起不来，属于「一键起」的反面）
 *   - 静态站 `location /` 的 try_files 必须带 `$uri/`（不带的话请求 / 会直接 404）
 *   - 服务端运行镜像必须带着 `scripts/`（自动备份在进程里拉起那个备份脚本）
 *   - 实时通道接线（#175 拆进程）：compose 必须有 server-realtime 服务（走 main.realtime
 *     入口、DB_PATH 落在同一个卷里）；game nginx 必须把 /api/realtime* 反代到它并带
 *     WS upgrade 头 —— 少任何一边，玩家都是「能登录、连不上实时通道」
 *
 * **只做静态接线检查**：本机与 CI 里不一定有 Docker，镜像构建本身不在这里验。
 * 实现上是**锚点匹配**而不是完整 YAML 解析 —— 认的正是我们自己这几个文件的固定形态；
 * 锚点找不到就报 FAIL，所以「把文件改成别的形状」也会被看见，而不会悄悄放过。
 *
 * 用法：
 *   node tools/audit-deploy.cjs          # 报告 + 退出码（有 FAIL 即 1）
 *   node tools/audit-deploy.cjs --list   # 只列文件
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const ARGS = process.argv.slice(2);
const LIST_ONLY = ARGS.includes("--list");

const FILES = {
  compose: "docker-compose.yml",
  serverDockerfile: "server/Dockerfile",
  serverIgnore: "server/.dockerignore",
  serverEnvExample: "server/.env.example",
  adminDockerfile: "admin/Dockerfile",
  adminIgnore: "admin/.dockerignore",
  adminNginx: "admin/nginx.conf",
  gameNginx: "deploy/nginx-game.conf",
};

const failures = [];
const notes = [];

function fail(message) {
  failures.push(message);
}
function ok(label, detail = "") {
  notes.push(`${label}${detail ? `  —— ${detail}` : ""}`);
}
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** 锚点：必须在文本里找到（找不到就报 FAIL，并说明期望什么） */
function anchor(text, pattern, label, hint) {
  if (pattern.test(text)) {
    ok(label);
    return true;
  }
  fail(`${label}：${hint}`);
  return false;
}

//#region 1. 文件齐不齐

for (const rel of Object.values(FILES)) {
  if (!exists(rel)) fail(`缺少文件：${rel}`);
}
if (LIST_ONLY) {
  for (const rel of Object.values(FILES)) console.log(`  ${exists(rel) ? "✓" : "✗"} ${rel}`);
  process.exit(failures.length ? 1 : 0);
}
if (failures.length) {
  console.log("部署接线审计 / deploy wiring audit");
  for (const item of failures) console.log(`  ✗ ${item}`);
  process.exit(1);
}

const compose = read(FILES.compose);
const serverDockerfile = read(FILES.serverDockerfile);
const adminDockerfile = read(FILES.adminDockerfile);
const nginx = read(FILES.adminNginx);
const gameNginx = read(FILES.gameNginx);

/** 所有 nginx 配置（管理端与游戏站），接线检查对每一份都要跑一遍 */
const NGINX_FILES = [
  ["admin/nginx.conf", nginx],
  ["deploy/nginx-game.conf", gameNginx],
];

/** 取出「带 proxy_pass 的那个 location」（配置里还混着 /assets/、/ 这类静态块） */
/**
 * 取「反代到服务端」的那个 location
 *
 * 一个 nginx.conf 里可能有多段 proxy_pass：除了 `/api/`，管理端还有 `/game-resources/`
 * （装备对齐工作台读素材，见 #509）。所以不能简单取第一个，要按想要的前缀找，
 * 找不到再退回第一个（配置文件里只写了一段反代的旧情况）。
 */
function proxyLocationOf(text, wanted) {
  const blocks = [...text.matchAll(/location\s+(=)?\s*(\S+)\s*\{([\s\S]*?)\n {2}\}/g)]
    .map((match) => ({ path: match[2], body: match[3] }))
    .filter((block) => block.body.includes("proxy_pass"));
  if (wanted) {
    const wantedBlock = blocks.find((block) => block.path === wanted);
    if (wantedBlock) return wantedBlock;
  }
  return blocks[0];
}
const serverEnvExample = read(FILES.serverEnvExample);

//#endregion

//#region 2. 服务名 ↔ nginx 上游

// compose 的 services 段里，服务名是两空格缩进、以冒号结尾的键
const servicesBlock = /^services:\s*$([\s\S]*?)^\S/m.exec(compose);
const serviceNames = servicesBlock
  ? [...servicesBlock[1].matchAll(/^ {2}([a-z][a-z0-9-]*):\s*$/gm)].map((m) => m[1])
  : [];
if (serviceNames.length < 2) fail("compose 里没解析到 services（锚点变了？至少要 server 与 admin 两个服务）");
ok("compose 服务", serviceNames.join(" / "));

const exposed = /^EXPOSE\s+(\d+)/m.exec(serverDockerfile);
if (!exposed) fail("server/Dockerfile 里没找到 EXPOSE");

// 管理端与游戏站各自把 /api 反代到服务端，两处都要对得上 compose
for (const [label, text] of NGINX_FILES) {
  const upstream = /set\s+\$olua_api\s+http:\/\/([a-z0-9-]+):(\d+);/.exec(text);
  if (!upstream) {
    fail(`${label} 里没找到上游锚点 \`set $olua_api http://<服务名>:<端口>;\`（反代配置形状变了？）`);
    continue;
  }
  const [, host, port] = upstream;
  if (serviceNames.includes(host)) ok(`${label} 上游服务名`, `${host} 在 compose 里存在`);
  else fail(`${label} 反代到 \`${host}\`，但 compose 里的服务是 ${serviceNames.join(" / ")} —— 改名时漏改了一处`);

  // 服务端容器里监听的端口：以 Dockerfile 的 EXPOSE 为准
  if (!exposed) continue;
  if (exposed[1] === port) ok(`${label} 上游端口`, `${port} 与 server/Dockerfile 的 EXPOSE 一致`);
  else fail(`${label} 反代到 ${port}，但 server/Dockerfile 暴露的是 ${exposed[1]}`);
}

//#endregion

//#region 3. 数据文件必须在卷里

const dbPath = /^\s+DB_PATH:\s*(\S+)\s*$/m.exec(compose);
const mount = /^\s+-\s+([a-z0-9_-]+):(\/[\w./-]+)\s*$/m.exec(compose);
if (!dbPath) {
  fail("compose 里没找到 `DB_PATH:`（容器内的数据文件路径必须显式写出来）");
} else if (!mount) {
  fail("compose 里没找到卷挂载 `- <卷名>:<容器内路径>`");
} else {
  const [, volumeName, mountTarget] = mount;
  if (dbPath[1].startsWith(`${mountTarget}/`)) ok("数据文件在卷里", `${dbPath[1]} ⊂ ${mountTarget}`);
  else fail(`DB_PATH=${dbPath[1]} 不在挂载点 ${mountTarget} 里 —— 容器重建会丢库`);

  const declaredVolume = new RegExp(`^\\s+${volumeName}:\\s*$`, "m").test(compose);
  if (declaredVolume) ok("具名卷已声明", volumeName);
  else fail(`compose 用了卷 ${volumeName}，但顶层 volumes: 里没声明它`);
}

//#endregion

//#region 4. 反代前缀 ↔ API_PREFIX ↔ 管理端构建参数

const prefix = /^\s*#?\s*API_PREFIX\s*=\s*(\S+)\s*$/m.exec(serverEnvExample);
const buildArg = /VITE_API_BASE_URL:\s*(\S+)/.exec(compose);

if (!prefix) fail("server/.env.example 里没找到 API_PREFIX");
if (!buildArg) fail("compose 里没给 admin 传 VITE_API_BASE_URL 构建参数");

for (const [label, text] of NGINX_FILES) {
  const proxyLocation = proxyLocationOf(text, prefix ? `/${prefix[1]}/` : null);
  if (!proxyLocation) {
    fail(`${label} 里没找到带 proxy_pass 的 location（反代块）`);
    continue;
  }
  if (!prefix) continue;
  const expected = `/${prefix[1]}/`;
  if (proxyLocation.path === expected) ok(`${label} 反代前缀与 API_PREFIX 一致`, expected);
  else fail(`${label} 反代的是 ${proxyLocation.path}，而服务端 API_PREFIX 是 ${prefix[1]}（应反代 ${expected}）`);
}
if (prefix && buildArg) {
  const expected = `/${prefix[1]}`;
  if (buildArg[1] === expected) ok("管理端构建地址与 API_PREFIX 一致", expected);
  else fail(`管理端 VITE_API_BASE_URL=${buildArg[1]}，而服务端 API_PREFIX 是 ${prefix[1]}（应为 ${expected}）`);
}

//#endregion

//#region 5. Dockerfile 的 COPY 源路径真的存在

function copySources(dockerfile, contextDir) {
  const sources = [];
  for (const line of dockerfile.split(/\r?\n/)) {
    const match = /^\s*COPY\s+(.+)$/i.exec(line);
    if (!match) continue;
    const tokens = match[1].trim().split(/\s+/);
    if (tokens[0].startsWith("--from=")) continue; // 阶段之间拷贝，源不在构建上下文里
    const rest = tokens[0].startsWith("--") ? tokens.slice(1) : tokens;
    sources.push(...rest.slice(0, -1)); // 最后一个是目标路径
  }
  return sources.map((src) => ({ src, abs: path.join(ROOT, contextDir, src) }));
}

for (const [label, dockerfile, contextDir] of [
  ["server/Dockerfile", serverDockerfile, "server"],
  ["admin/Dockerfile", adminDockerfile, "admin"],
]) {
  for (const { src, abs } of copySources(dockerfile, contextDir)) {
    if (fs.existsSync(abs)) continue;
    fail(`${label} 的 COPY 源不存在：${contextDir}/${src}`);
  }
  ok(`${label} 的 COPY 源都存在`, `${copySources(dockerfile, contextDir).length} 个`);
}

//#endregion

//#region 6. 密钥不许进镜像上下文

for (const [label, rel, text] of [
  ["server", FILES.serverIgnore, read(FILES.serverIgnore)],
  ["admin", FILES.adminIgnore, read(FILES.adminIgnore)],
]) {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(".env")) ok(`${label}/.dockerignore 排除了 .env（密钥不进镜像层）`);
  else fail(`${label}/.dockerignore 没有排除 .env —— 密钥会被打进镜像，层里翻得出来`);

  if (lines.includes("node_modules")) ok(`${label}/.dockerignore 排除了 node_modules`);
  else fail(`${label}/.dockerignore 没有排除 node_modules（宿主机的依赖会被拷进镜像）`);
}

// compose 的 env_file 指的文件本身就是 gitignore 的，所以只要求「有模板可抄」
anchor(compose, /^\s+-\s+\.\/server\/\.env\s*$/m, "compose 用 env_file 注入服务端配置", "应写 `- ./server/.env`（缺配置时宁可起不来，也不要用内置默认密钥悄悄跑）");

//#endregion

//#region 7. compose 的变量替换都要有默认值

const substitutions = [...compose.matchAll(/\$\{([A-Z0-9_]+)(:?-[^}]*)?\}/g)];
const noDefault = substitutions.filter((match) => !match[2]);
if (noDefault.length) {
  fail(`compose 里这些变量没有默认值：${noDefault.map((m) => `\${${m[1]}}`).join(", ")} —— 没设就起不来，与「一键起」矛盾`);
} else {
  ok("compose 变量替换都带默认值", `${substitutions.length} 处`);
}

//#endregion

//#region 8. 静态站的根路径必须能落到 index 上

// 静态站请求 `/` 时，nginx 的 `$uri` 是**目录**而不是文件。try_files 里少了 `$uri/`
// 这一项，目录请求就不会回到 index 指令：玩家直接开根端口拿到 404，手打 /index.html
// 却又是好的 —— 这种残缺只有「记得补全路径」的人才绕得过，所以在这里拦一道。
for (const [label, text] of NGINX_FILES) {
  if (!/^\s*index\s+\S+;/m.test(text)) continue; // 纯反代站没有静态入口，跳过
  const rootBlock = /location\s+\/\s*\{([\s\S]*?)\n {2}\}/.exec(text);
  if (!rootBlock) {
    fail(`${label} 里找不到 \`location / {\` 锚点（静态入口的形状变了？）`);
    continue;
  }
  const tries = /try_files\s+([^;]+);/.exec(rootBlock[1]);
  if (!tries) {
    fail(`${label} 的 location / 里没有 try_files（不知道命中规则是按什么算的）`);
    continue;
  }
  const args = tries[1].trim().split(/\s+/);
  if (args.includes("$uri/")) ok(`${label} 根目录请求交给 index`, args.join(" "));
  else fail(`${label} 的 try_files 是 \`${args.join(" ")}\`：缺 \`$uri/\`，请求 / 会直接 404（index 指令够不着）`);
}

//#endregion

//#region 9. 运行镜像里必须带着备份脚本

// 自动备份是在**服务进程里**拉起 scripts/backup.cjs 完成的（与其再写一份 VACUUM INTO，
// 不如复用 make db-backup 走的那份，避免两套保留 / 校验口径各自漂移）。
// 少了这一行，本机怎么跑都正常，进了容器却是「每次备份都失败，而且没人发现」。
const BACKUP_SCRIPT = "server/scripts/backup.cjs";
const runtimeStage = /^FROM\s+\S+\s+AS\s+runtime\s*$([\s\S]*)$/m.exec(serverDockerfile);
if (!exists(BACKUP_SCRIPT)) {
  fail(`缺少文件：${BACKUP_SCRIPT}（自动备份与 make db-backup 共用它）`);
} else if (!runtimeStage) {
  fail("server/Dockerfile 里找不到 runtime 阶段锚点（多阶段构建的形状变了？）");
} else if (/^\s*COPY\s+scripts\s/m.test(runtimeStage[1])) {
  ok("运行镜像带着备份脚本", "自动备份依赖 scripts/backup.cjs");
} else {
  fail("server/Dockerfile 的 runtime 阶段没有 `COPY scripts` —— 容器里自动备份每次都会失败（本机验不出来）");
}

//#endregion

//#region 10. 实时进程接线（#175 拆进程：compose 双服务 + nginx 按路径反代 WS）

// compose 必须有 server-realtime 服务，且入口是 main.realtime
if (serviceNames.includes("server-realtime")) ok("compose 有实时进程服务", "server-realtime");
else fail("compose 里没有 server-realtime 服务 —— 独立进程形态（#175）部署后实时通道整个不存在");

const realtimeCommand = /server-realtime:[\s\S]*?command:[\s\S]*?main\.realtime\.js/.exec(compose);
if (realtimeCommand) ok("实时进程入口", "command 走 dist/main.realtime.js");
else fail("compose 的 server-realtime 没有 `command: … dist/main.realtime.js` —— 会跟存档进程起成两个一样的实例");

// 实时进程与存档进程必须挂**同一个**卷（同一份 SQLite 文件才共享得起来）
const realtimeDbPath = /server-realtime:[\s\S]*?DB_PATH:\s*(\S+)/.exec(compose);
if (realtimeDbPath && dbPath && mount) {
  if (realtimeDbPath[1] === dbPath[1]) ok("实时进程与存档进程同库", realtimeDbPath[1]);
  else fail(`server-realtime 的 DB_PATH=${realtimeDbPath[1]} 与 server 的 ${dbPath[1]} 不同 —— 两进程必须共享同一个 SQLite 文件`);
} else if (!realtimeDbPath) {
  fail("compose 的 server-realtime 没有显式 DB_PATH —— 实时进程的写会落进容器可写层，容器重建即丢");
}

// game nginx 必须把 /api/realtime 反代到 server-realtime（上游名 + 端口 + WS upgrade 头）
const realtimeUpstream = /set\s+\$olua_realtime\s+http:\/\/([a-z0-9-]+):(\d+);/.exec(gameNginx);
if (!realtimeUpstream) {
  fail("deploy/nginx-game.conf 里没找到实时上游锚点 `set $olua_realtime http://server-realtime:<端口>;` —— 玩家能登录但连不上实时通道");
} else {
  const [, rtHost, rtPort] = realtimeUpstream;
  if (rtHost === "server-realtime") ok("game nginx 实时上游服务名", rtHost);
  else fail(`game nginx 实时通道反代到 \`${rtHost}\`，但 compose 里的实时服务叫 server-realtime`);

  if (rtPort === "3101") ok("game nginx 实时上游端口", rtPort);
  else fail(`game nginx 实时上游端口是 ${rtPort}，应为 3101（与 compose 的 REALTIME_PORT 一致）`);

  const rtLocation = /location\s+\/api\/realtime\s*\{([\s\S]*?)\n {2}\}/.exec(gameNginx);
  if (!rtLocation) {
    fail("deploy/nginx-game.conf 里没有 `location /api/realtime` 块 —— 取票与 WS 都会落到存档进程");
  } else {
    if (/proxy_set_header\s+Upgrade\s+\$http_upgrade;/.test(rtLocation[1]) && /proxy_set_header\s+Connection\s+"upgrade";/.test(rtLocation[1])) {
      ok("实时反代带 WS upgrade 头", "Upgrade + Connection");
    } else {
      fail("实时反代缺 `Upgrade` / `Connection \"upgrade\"` 头 —— WS 握手会退化成普通 HTTP 请求被拒");
    }
    if (/proxy_read_timeout\s+\d+s;/.test(rtLocation[1])) ok("实时反代放宽了读超时", "WS 是长连接，默认 60s 会掐断");
    else fail("实时反代没有调大 proxy_read_timeout —— WS 会被 nginx 默认 60s 掐断（心跳救不回所有代理）");
  }
}

// server/Dockerfile 必须把 3101 也 EXPOSE 出来（文档口径：实时进程端口）
if (/^EXPOSE\s+3101\s*$/m.test(serverDockerfile)) ok("server/Dockerfile EXPOSE 3101", "实时进程端口已声明");
else fail("server/Dockerfile 没有 `EXPOSE 3101` —— 实时进程端口的文档口径缺失（镜像不 Mapping，纯文档也要接得上）");

//#endregion

console.log("部署接线审计 / deploy wiring audit");
console.log(`文件：${Object.values(FILES).length} 个（compose / 两个 Dockerfile / 两个 .dockerignore / 两份 nginx.conf / .env.example）`);
console.log("（只做静态接线检查：本机与 CI 不一定有 Docker，镜像构建本身不在这里验）");
console.log("");
for (const line of notes) console.log(`  ✓ ${line}`);
if (failures.length) {
  console.log("");
  for (const line of failures) console.log(`  ✗ ${line}`);
  console.log(`\nFAIL：${failures.length} 处部署接线有问题`);
  process.exit(1);
}
console.log("\nPASS：服务名 / 端口 / 卷挂载 / 反代前缀 / COPY 源 / 密钥隔离 / 变量默认值 / 根路径 index / 备份脚本随镜像 / 实时进程双服务接线都接得上");
