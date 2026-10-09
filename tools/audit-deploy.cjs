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

const upstream = /set\s+\$olua_api\s+http:\/\/([a-z0-9-]+):(\d+);/.exec(nginx);
if (!upstream) {
  fail("admin/nginx.conf 里没找到上游锚点 `set $olua_api http://<服务名>:<端口>;`（反代配置形状变了？）");
} else {
  const [, host, port] = upstream;
  if (serviceNames.includes(host)) ok("nginx 上游服务名", `${host} 在 compose 里存在`);
  else fail(`nginx 反代到 \`${host}\`，但 compose 里的服务是 ${serviceNames.join(" / ")} —— 改名时漏改了一处`);

  // 服务端容器里监听的端口：以 Dockerfile 的 EXPOSE 为准
  const exposed = /^EXPOSE\s+(\d+)/m.exec(serverDockerfile);
  if (!exposed) fail("server/Dockerfile 里没找到 EXPOSE");
  else if (exposed[1] === port) ok("nginx 上游端口", `${port} 与 server/Dockerfile 的 EXPOSE 一致`);
  else fail(`nginx 反代到 ${port}，但 server/Dockerfile 暴露的是 ${exposed[1]}`);
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
// 取**带 proxy_pass 的那个** location（nginx.conf 里还有 /assets/ 与 / 两个静态块，
// 直接取第一个 location 会认到 /assets/ 上）
const proxyLocation = [...nginx.matchAll(/location\s+(=)?\s*(\S+)\s*\{([\s\S]*?)\n {2}\}/g)]
  .map((match) => ({ path: match[2], body: match[3] }))
  .find((block) => block.body.includes("proxy_pass"));
const buildArg = /VITE_API_BASE_URL:\s*(\S+)/.exec(compose);

if (!prefix) fail("server/.env.example 里没找到 API_PREFIX");
if (!proxyLocation) fail("admin/nginx.conf 里没找到带 proxy_pass 的 location（反代块）");
if (!buildArg) fail("compose 里没给 admin 传 VITE_API_BASE_URL 构建参数");

if (prefix && proxyLocation) {
  const expected = `/${prefix[1]}/`;
  if (proxyLocation.path === expected) ok("反代前缀与 API_PREFIX 一致", expected);
  else fail(`nginx 反代的是 ${proxyLocation.path}，而服务端 API_PREFIX 是 ${prefix[1]}（应反代 ${expected}）`);
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

console.log("部署接线审计 / deploy wiring audit");
console.log(`文件：${Object.values(FILES).length} 个（compose / 两个 Dockerfile / 两个 .dockerignore / nginx.conf / .env.example）`);
console.log("（只做静态接线检查：本机与 CI 不一定有 Docker，镜像构建本身不在这里验）");
console.log("");
for (const line of notes) console.log(`  ✓ ${line}`);
if (failures.length) {
  console.log("");
  for (const line of failures) console.log(`  ✗ ${line}`);
  console.log(`\nFAIL：${failures.length} 处部署接线有问题`);
  process.exit(1);
}
console.log("\nPASS：服务名 / 端口 / 卷挂载 / 反代前缀 / COPY 源 / 密钥隔离 / 变量默认值都接得上");
