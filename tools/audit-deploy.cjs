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
 *   - TLS 边缘（#742）：edge 必须 listen 443 ssl、证书路径与 certbot 的 --cert-name 一致、
 *     :80 还要能走 ACME 校验（Let's Encrypt 不跟 301）、两个服务都挂在 tls 组里、
 *     证书与校验目录在两容器间共享同一对具名卷；admin 的发布地址必须能退让（TLS 下
 *     宿主机 :80 归 edge，两个容器抢同一端口只会在部署那一刻报错）
 *   - 官网的绝对地址（canonical / og:url / og:image）不许再出现我们自己的 http 域名 ——
 *     分享卡片要求 https，漏一处就是「分享出去没缩略图」
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
  // 管理端的构建上下文是**仓库根**（要跨目录 import 服务端枚举），所以它的 .dockerignore 也在根上
  adminIgnore: ".dockerignore",
  adminNginx: "admin/nginx.conf.template",
  gameNginx: "deploy/nginx-game.conf",
  edgeNginx: "deploy/nginx-edge.conf",
  edgeEntrypoint: "deploy/edge-entrypoint.sh",
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

/** 所有 nginx 配置（管理端入口与游戏站），接线检查对每一份都要跑一遍 */
const NGINX_FILES = [
  ["admin/nginx.conf.template", nginx],
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

/**
 * 取 compose 里某个服务的配置块（从 `  <name>:` 到下一个两空格缩进的键，或文件尾）
 *
 * 服务的**块内**属性（profiles / volumes / ports）只能这样看：全文搜 `profiles:` 会把
 * 别的服务的 profile 也算进来，而这种「张冠李戴」恰好不会报错，只会让守点变成摆设。
 */
function serviceBlock(name) {
  if (!servicesBlock) return "";
  const start = new RegExp(`^ {2}${name}:\\s*$`, "m").exec(servicesBlock[1]);
  if (!start) return "";
  const rest = servicesBlock[1].slice(start.index + start[0].length);
  const end = /^ {2}[a-z][a-z0-9-]*:\s*$/m.exec(rest);
  return end ? rest.slice(0, end.index) : rest;
}

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
  // 管理端 context = 仓库根（admin/Dockerfile 里 COPY 的是 admin/... 与 server/src/...）
  ["admin/Dockerfile", adminDockerfile, "."],
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
  ["admin（仓库根）", FILES.adminIgnore, read(FILES.adminIgnore)],
]) {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(".env")) ok(`${label} 的 .dockerignore 排除了 .env（密钥不进镜像层）`);
  else fail(`${label} 的 .dockerignore 没有排除 .env —— 密钥会被打进镜像，层里翻得出来`);

  if (lines.includes("node_modules")) ok(`${label} 的 .dockerignore 排除了 node_modules`);
  else fail(`${label} 的 .dockerignore 没有排除 node_modules（宿主机的依赖会被拷进镜像）`);
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
  // 入口配置里可能有多个 `location /`（比如管理端模板里的官网站整站反代段）——
  // 只要有**一个**静态段的 try_files 带 `$uri/` 就算过，但一段都没有就是残缺。
  const rootBlocks = [...text.matchAll(/location\s+\/\s*\{([\s\S]*?)\n {2}\}/g)].map((m) => m[1]);
  if (!rootBlocks.length) {
    fail(`${label} 里找不到 \`location / {\` 锚点（静态入口的形状变了？）`);
    continue;
  }
  const good = rootBlocks.find((body) => {
    const tries = /try_files\s+([^;]+);/.exec(body);
    return tries && tries[1].trim().split(/\s+/).includes("$uri/");
  });
  if (good) {
    const args = /try_files\s+([^;]+);/.exec(good)[1].trim();
    ok(`${label} 根目录请求交给 index`, args);
  } else {
    fail(`${label} 里没有任何 \`location /\` 的 try_files 带 \`$uri/\`：请求 / 会直接 404（index 指令够不着）`);
  }
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

// game nginx 必须把 /api/realtime* 反代到实时进程（上游名 + 端口 + WS upgrade 头）
//
// #770 按区分片之后，这里不再是「一个上游」：`N` 片就有 N 段 location
// （`/api/realtime` = 第 0 片 + 取票，`/api/realtime/s1` = 第 1 片 …）。
// 所以逐段校验：**每个上游服务名都必须在 compose 里存在，且端口与它自己的 REALTIME_PORT 一致**。
const rtBlocks = [...gameNginx.matchAll(/location\s+\/api\/realtime([^\s{]*)\s*\{([\s\S]*?)\n {2}\}/g)];
if (rtBlocks.length === 0) {
  fail("deploy/nginx-game.conf 里没有 `location /api/realtime` 块 —— 取票与 WS 都会落到存档进程");
} else {
  const baseBlock = rtBlocks.find(([, suffix]) => suffix.trim() === "");
  if (!baseBlock) fail("deploy/nginx-game.conf 里没有**不带分片段**的 `location /api/realtime` —— 取票请求没有落点");

  for (const [, suffix, body] of rtBlocks) {
    const where = suffix.trim() === "" ? "/api/realtime（第 0 片 + 取票）" : `/api/realtime${suffix}`;
    const upstream = /set\s+\$olua_realtime\s+http:\/\/([a-z0-9-]+):(\d+);/.exec(body);
    if (!upstream) {
      fail(`${where} 里没有上游锚点 \`set $olua_realtime http://<服务名>:<端口>;\``);
      continue;
    }
    const [, host, port] = upstream;
    if (!serviceNames.includes(host)) {
      fail(`${where} 反代到 \`${host}\`，但 compose 里没有这个服务（现有：${serviceNames.join(" / ")}）`);
    } else {
      const servicePort = new RegExp(`${host}:[\\s\\S]*?REALTIME_PORT:\\s*"?([0-9]+)"?`).exec(compose);
      if (!servicePort) fail(`${where} 对应的 compose 服务 ${host} 没有 REALTIME_PORT`);
      else if (servicePort[1] !== port) fail(`${where} 的上游端口是 ${port}，而 compose 里 ${host} 的 REALTIME_PORT 是 ${servicePort[1]}`);
      else ok(`game nginx 实时上游（${where}）`, `${host}:${port}`);
    }

    if (/proxy_set_header\s+Upgrade\s+\$http_upgrade;/.test(body) && /proxy_set_header\s+Connection\s+"upgrade";/.test(body)) {
      ok(`实时反代带 WS upgrade 头（${where}）`, "Upgrade + Connection");
    } else {
      fail(`${where} 缺 \`Upgrade\` / \`Connection "upgrade"\` 头 —— WS 握手会退化成普通 HTTP 请求被拒`);
    }
    if (/proxy_read_timeout\s+\d+s;/.test(body)) ok(`实时反代放宽了读超时（${where}）`, "WS 是长连接，默认 60s 会掐断");
    else fail(`${where} 没有调大 proxy_read_timeout —— WS 会被 nginx 默认 60s 掐断（心跳救不回所有代理）`);
  }
}

// server/Dockerfile 必须把 3101 也 EXPOSE 出来（文档口径：实时进程端口）
if (/^EXPOSE\s+3101\s*$/m.test(serverDockerfile)) ok("server/Dockerfile EXPOSE 3101", "实时进程端口已声明");
else fail("server/Dockerfile 没有 `EXPOSE 3101` —— 实时进程端口的文档口径缺失（镜像不 Mapping，纯文档也要接得上）");

//#endregion

//#region 10. 三站域名接线（envsubst 模板 ↔ Dockerfile ↔ compose ↔ 官网服务）

// 域名一律走环境变量（admin/nginx.conf.template 是 envsubst 模板），配置里**不许写死域名**
// —— 写死一处，换域名时必然漏改；模板变量 + compose 默认值 + .env 覆盖，三层各司其职。
for (const [variable, label] of [
  ["OLUA_SITE_DOMAINS", "官网站"],
  ["OLUA_ADMIN_DOMAIN", "管理端"],
  ["OLUA_GAME_DOMAIN", "游戏站"],
]) {
  anchor(nginx, new RegExp(`\\$\\{${variable}\\}`), `${label}域名走模板变量`, `admin/nginx.conf.template 里应有 \${${variable}}（不许写死域名）`);
  anchor(
    compose,
    new RegExp(`^\\s{6}${variable}:\\s*`, "m"),
    `compose 给 admin 传 ${variable}`,
    "admin 服务 environment 里要有这个变量（模板 envsubst 的数据源，换域名不用重建镜像）"
  );
}
// 只查生效行（剥掉 # 注释）—— 注释里允许出现示例域名做说明
const nginxActive = nginx
  .split(/\r?\n/)
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");
if (/\bgame\.yimw\.cn|admin\.yimw\.cn|\byimw\.cn\b/.test(nginxActive)) {
  fail("admin/nginx.conf.template 里写死了域名 —— 一律用 ${OLUA_*} 模板变量，域名只在 deploy.env/.env 里出现");
} else {
  ok("nginx 模板没写死域名");
}

anchor(
  adminDockerfile,
  /COPY admin\/nginx\.conf\.template\s+\/etc\/nginx\/templates\//,
  "nginx 模板进镜像 templates 目录",
  "nginx 镜像启动时对 /etc/nginx/templates/*.template 做 envsubst 写到 conf.d/，直接 COPY 到 conf.d 会跳过替换"
);

anchor(compose, /^ {2}website:\s*$/m, "compose 有 website 服务", "官网静态站（挂 ./website，走 admin :80 的 server_name 分流，不占宿主机端口）");
anchor(compose, /- \.\/website:\/usr\/share\/nginx\/html:ro/, "website 挂载 ./website 只读", "官网产物随仓库走，容器不需要写");

//#endregion

//#region 11. TLS 边缘（#742）：edge 终止 TLS、certbot 签续、admin 让出宿主机 :80

// 这一层最容易「只改一半」，而**两半都只在部署那一刻才报错**：
//   - 端口归属：admin 还占着宿主机 :80 → 两个容器抢同一个端口，compose 直接起不来；
//   - 证书路径：边缘指的文件与 certbot 写的目录不是同一个 → nginx 起不来。
// 本机跑什么都是绿的（这两样都要 Docker 才验得到），所以在这里静态拦住。

const edgeNginx = read(FILES.edgeNginx);

anchor(
  edgeNginx,
  /^\s*listen\s+443\s+ssl\b/m,
  "edge 监听 443 并终止 TLS",
  "deploy/nginx-edge.conf 里应有 `listen 443 ssl;` —— 没有它就没有任何地方持有证书"
);

// edge 的 443 不得开 HTTP/2（#1320）：edge 在 ALPN 里广播 h2 时，Apple CFNetwork（macOS/iOS
// 原生包的网络栈）会选 h2 并尝试 RFC 8441 扩展 CONNECT 升级 WebSocket —— nginx 不支持、
// 客户端不回退，升级请求在 h2 层就被拒（access log 都没有），原生包的实时通道全断。
if (!/^\s*http2\s+on\s*;/m.test(edgeNginx)) {
  ok("edge 443 不开 HTTP/2（逼 CFNetwork 走 HTTP/1.1 标准 WS 升级，#1320）");
} else {
  fail("deploy/nginx-edge.conf 里有 `http2 on;` —— 原生客户端（CFNetwork）在 h2 上发不出 WebSocket 升级，实时通道全断（#1320）");
}

// 证书目录固定叫 olua（certbot 的 `--cert-name olua`）：换域名时证书内容变、目录不变，
// 这里就不用跟着改。两边只要有一边改了名字，nginx 与 certbot 就各写各的。
anchor(
  edgeNginx,
  /ssl_certificate\s+\/etc\/letsencrypt\/live\/olua\/fullchain\.pem;/,
  "edge 的证书路径与 certbot 的 --cert-name 对应",
  "应是 /etc/letsencrypt/live/olua/fullchain.pem（compose 里 certbot 用 --cert-name olua）"
);
anchor(
  edgeNginx,
  /ssl_certificate_key\s+\/etc\/letsencrypt\/live\/olua\/privkey\.pem;/,
  "edge 的私钥路径与证书同目录",
  "应是 /etc/letsencrypt/live/olua/privkey.pem"
);

// Let's Encrypt 的 http-01 校验**不会跟随 301**：把 :80 简化成一句 return 301 的结果
// 是「签证书那一步永远失败」，而报错只是「校验文件 404」——看不出是这里少了段配置。
anchor(
  edgeNginx,
  /location\s+\/\.well-known\/acme-challenge\/\s*\{[\s\S]{0,120}?root\s+\/var\/www\/certbot;/,
  ":80 放行 ACME 校验目录",
  ":80 的 server 块里要有 `location /.well-known/acme-challenge/ { root /var/www/certbot; }`"
);
anchor(
  edgeNginx,
  /return\s+301\s+https:\/\/\$host\$request_uri;/,
  ":80 的其余请求 301 到 https",
  "`return 301 https://$host$request_uri;`（带 $request_uri 才不会丢掉路径与查询串）"
);

// 上游必须是 compose 里的 admin，端口是**容器内**的 80（与宿主机 OLUA_ADMIN_PORT 无关）
const edgeUpstream = /set\s+\$olua_admin\s+http:\/\/([a-z0-9-]+):(\d+);/.exec(edgeNginx);
if (!edgeUpstream) {
  fail("deploy/nginx-edge.conf 里没有上游锚点 `set $olua_admin http://<服务名>:<端口>;`（反代配置形状变了？）");
} else {
  const [, host, port] = edgeUpstream;
  if (!serviceNames.includes(host)) {
    fail(`edge 反代到 \`${host}\`，但 compose 里没有这个服务（现有：${serviceNames.join(" / ")}）`);
  } else if (port !== "80") {
    fail(`edge 反代到 ${host}:${port}，而 admin 容器里监听的是 80（容器内端口，与 OLUA_ADMIN_PORT 无关）`);
  } else {
    ok("edge 上游", `${host}:80（容器内端口，不受宿主机 OLUA_ADMIN_PORT 影响）`);
  }
}

// 实时通道要多穿一跳：WS 的 Upgrade 头与长超时缺一个，玩家就是「能登录、连不上」
if (
  /proxy_set_header\s+Upgrade\s+\$http_upgrade;/.test(edgeNginx) &&
  /proxy_set_header\s+Connection\s+\$olua_conn_upgrade;/.test(edgeNginx)
) {
  ok("edge 透传 WS upgrade 头", "Upgrade + Connection（边缘这一跳不能少）");
} else {
  fail("deploy/nginx-edge.conf 缺 `Upgrade` / `Connection` 头 —— 实时通道穿过边缘时握手会退化成普通 HTTP 请求被拒");
}
anchor(
  edgeNginx,
  /proxy_read_timeout\s+3600s;/,
  "edge 放宽了读超时",
  "WS 长连接与素材整段下载都走这里，nginx 默认 60s 会中途掐断"
);

// 两个服务都必须在 tls 组里：不加 --profile 就不该被拉起来 ——
// 它们要占宿主机 :80 / :443，本地开发一 `up` 就抢端口，或者干脆因为没证书卡住
for (const svc of ["edge", "certbot"]) {
  const block = serviceBlock(svc);
  if (!block) {
    fail(`compose 里没有 ${svc} 服务 —— TLS 那一层不完整（见 #742）`);
  } else if (/^\s+profiles:\s*\[\s*"tls"\s*\]/m.test(block)) {
    ok(`compose 的 ${svc} 挂在 tls 组`, "--profile tls 才会起（deploy.sh 用 COMPOSE_PROFILES=tls 打开）");
  } else {
    fail(`compose 的 ${svc} 没挂 \`profiles: ["tls"]\` —— 本地普通 up 也会起它，而它要占宿主机 :80 / :443`);
  }
}

// game 必须挂在 game 组（#1314）：客户端不是常驻服务，没在发客户端的时期
// 普通 `up -d` 不该把它拉回来（占 :8080、game.yimw.cn 一直有人撞）。发客户端走
// deploy.sh --game / --resources 的显式 `--profile game up -d game`。
{
  const block = serviceBlock("game");
  if (!block) {
    fail("compose 里没有 game 服务 —— 发客户端的容器没了（deploy.sh --game 会拉不起来）");
  } else if (/^\s+profiles:\s*\[\s*"game"\s*\]/m.test(block)) {
    ok("compose 的 game 挂在 game 组", "默认 up -d 不启动；deploy.sh --game 显式 --profile game 拉起");
  } else {
    fail(`compose 的 game 没挂 \`profiles: ["game"]\` —— 普通 up -d 也会起它，不部署客户端时它一直空转占着 :8080`);
  }
}

// deploy.sh --game 的 rsync 目标是 `game/` 整目录（带 --delete），而管理端素材
// `game/resources/` 也挂在里面（--resources 模式的 rsync 目标）。不带 exclude 时
// --delete 会把素材整目录清掉（#1318 线上事故：地图切片 / /game-resources/ 全 404）。
// 判定只看 rsync 命令本身（剥掉 `#` 注释行），防止「注释里写了旗标但代码没写」的假绿。
{
  const script = read(".workbuddy/skills/olua-deploy/scripts/deploy.sh");
  const gameTargetAt = script.indexOf('"$TARGET:$DEPLOY_DIR/game/"');
  const cmdStart = script.lastIndexOf("rsync -a --delete", gameTargetAt);
  if (gameTargetAt < 0 || cmdStart < 0) {
    fail("deploy.sh 里找不到 --game 的 rsync（game/ 目标）—— 发客户端链路断了");
  } else {
    const cmd = script
      .slice(cmdStart, gameTargetAt)
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    if (cmd.includes("--exclude=/resources")) {
      ok("deploy.sh --game 的 rsync 排除了 resources/", "game/resources/ 是 --resources 的地盘，--delete 不能扫到它");
    } else {
      fail(`deploy.sh --game 的 rsync 没带 \`--exclude=/resources\` —— --delete 会把管理端素材 game/resources/ 整目录删掉（#1318 事故）`);
    }
  }
}

// 证书与校验目录必须是**同一对具名卷**：certbot 写、edge 只读读，
// 挂成不同的目录（或一边 bind mount 一边具名卷）时，续期会「成功但没人看得见」
const edgeBlock = serviceBlock("edge");
const certbotBlock = serviceBlock("certbot");
for (const [volume, target, who] of [
  ["olua-letsencrypt", "/etc/letsencrypt", "证书链"],
  ["olua-webroot", "/var/www/certbot", "ACME 校验文件"],
]) {
  const mounted = `${volume}:${target}`;
  const inEdge = edgeBlock.includes(mounted);
  const inCertbot = certbotBlock.includes(mounted);
  if (inEdge && inCertbot) ok(`${who}在 edge / certbot 之间共享`, mounted);
  else fail(`${who}没有共享同一份卷：edge ${inEdge ? "有" : "缺"} ${mounted}，certbot ${inCertbot ? "有" : "缺"} ${mounted}`);
  if (new RegExp(`^\\s+${volume}:\\s*$`, "m").test(compose)) ok("具名卷已声明", volume);
  else fail(`compose 用了卷 ${volume}，但顶层 volumes: 里没声明它`);
}
anchor(edgeBlock, /olua-letsencrypt:\/etc\/letsencrypt:ro/, "edge 只读挂载证书", "写证书的是 certbot；边缘只读，避免两边同时写同一份文件");

// 端口归属：TLS 模式下宿主机 :80 必须能**让**给 edge，否则两个容器抢同一个端口
// （compose 报 `port is already allocated`，且只在部署时才发现）
anchor(
  compose,
  /- "\$\{OLUA_ADMIN_BIND:-[^}]+\}:\$\{OLUA_ADMIN_PORT:-[^}]+\}:80"/,
  "admin 的发布地址可退让",
  "admin 的 ports 应写成 `${OLUA_ADMIN_BIND:-0.0.0.0}:${OLUA_ADMIN_PORT:-80}:80` —— TLS 部署要把它改成 127.0.0.1:8081 把 :80 让给 edge"
);

// 边缘脚本要能等到证书、也要会定期 reload（certbot 在别的容器里，喊不动 nginx）
anchor(
  read(FILES.edgeEntrypoint),
  /nginx -s reload/,
  "edge 入口会定期 reload 证书",
  "deploy/edge-entrypoint.sh 里要有 `nginx -s reload`：certbot 续期后没人喊 nginx 重读证书"
);

// 官网的绝对地址必须已经是 https：canonical / og:url / og:image 写 http 的话
// 分享卡片取不到图（微信等要求 https），而且每次访问还要多一次 301。
const WEBSITE_HTTP_DOMAIN = /http:\/\/(?:www\.|admin\.|game\.)?yimw\.cn/g;
const websiteHtmls = fs
  .readdirSync(path.join(ROOT, "website"))
  .filter((name) => name.endsWith(".html"));
const httpLeft = websiteHtmls
  .map((name) => ({ name, hits: (read(`website/${name}`).match(WEBSITE_HTTP_DOMAIN) || []).length }))
  .filter((item) => item.hits > 0);
if (httpLeft.length) {
  fail(
    `官网还有明文 http 绝对地址：${httpLeft.map((i) => `website/${i.name}（${i.hits} 处）`).join("、")} —— ` +
      "canonical / og:url / og:image 必须是 https，否则分享卡片取不到图"
  );
} else {
  ok("官网绝对地址全是 https", `${websiteHtmls.length} 个 html`);
}

//#endregion

console.log("部署接线审计 / deploy wiring audit");
console.log(`文件：${Object.values(FILES).length} 个（compose / 两个 Dockerfile / 两个 .dockerignore / nginx 模板与游戏 nginx / TLS 边缘与 certbot / .env.example）`);
console.log("（只做静态接线检查：本机与 CI 不一定有 Docker，镜像构建本身不在这里验）");
console.log("");
for (const line of notes) console.log(`  ✓ ${line}`);
if (failures.length) {
  console.log("");
  for (const line of failures) console.log(`  ✗ ${line}`);
  console.log(`\nFAIL：${failures.length} 处部署接线有问题`);
  process.exit(1);
}
console.log("\nPASS：服务名 / 端口 / 卷挂载 / 反代前缀 / COPY 源 / 密钥隔离 / 变量默认值 / 根路径 index / 备份脚本随镜像 / 实时进程双服务 / 三站域名模板接线 / TLS 边缘与证书共享 / 官网链接全 https 都接得上");
