#!/usr/bin/env node
/**
 * 守卫：装备对齐清单（`admin/src/data/equip-align.catalog.json`）是否与客户端配置一致
 *
 * ===========================================================================
 * 为什么必须有这个
 * ===========================================================================
 * 那份 JSON 是 `client/assets/configs/{equipments,role,animation}.ts` 的**派生快照**，
 * 页面据它列出 12 件衣服 / 19 把武器 / 2 套裸模，并显示每件当前的几何值。
 *
 * 派生物不钉住就会腐化，而且腐化得很安静（与 `audit-shared-data` 同一类问题）：
 *
 *   - 有人用工作台把 `cloth_3` 的 `outPositions` 导回配置 —— 配置变了，清单没变；
 *   - 于是**下一次**进工作台，页面显示的仍是旧位置，人眼在旧值上再拖一次，
 *     导出、写回，把刚调好的值覆盖掉。**两次都「成功」，第二次悄悄毁掉第一次的成果。**
 *   - 反过来也成立：清单比配置新（改了清单没写回配置），导出后写回会覆盖别人刚改的配置。
 *
 * 所以照 `audit-shared-data.cjs` / `audit-api-generated.cjs` 的做法：**重生成一遍，
 * 逐字节比对**。过期了不需要判断「要不要更新」，答案永远是「跑
 * `node tools/gen-equip-align-catalog.cjs`」—— 来源在客户端 configs，这边没有第二个
 * 正确答案。
 *
 * ===========================================================================
 * 逐字节比不出来、但同样是「静默生产垃圾」的几件事
 * ===========================================================================
 * 下面这些偏差，生成器自己产的、自己比的，必然一致，却全都让页面画错：
 *
 *   1. **清单里出现展开变体**（`cloth_1_p3s2`）：`buildEquipmentMap` 把每件展开成
 *      5×3 = 15 个前后缀组合，混进来后左栏列 180 件同 12 件的重复。判据是 id 后缀；
 *   2. **`outPositions` 长度既不是 0 也不是 8**：8 个朝向必须齐，缺一个就意味着那个
 *      方向静默落回原点（页面拖动看起来"没反应"）；
 *   3. **`atlas` 空**：`toAtlas()` 的正则没认出来的目录形状 → 页面加载一个
 *      `/game-resources//stand/stand.plist`，8 格全空且报错指向资源根，误导排查方向；
 *   4. **`outScale` 为 0 / 非正**：多一半是把 `undefined` 当默认值写进去的，
 *      页面上那件装备会缩成一个点；
 *   5. **`hasAsset` 之类"本机有什么"的字段回流**：`client/assets/resources/` 是
 *      gitignore 的（素材走 Release 分发），这类字段在 CI 上必然全 false、
 *      在开发机上必然全 true —— 一旦回流，这条逐字节比对就会天天假红。
 *
 * 用法：node tools/audit-equip-align-catalog.cjs
 * 退出码：一致 = 0；不一致 / 结构异常 = 1（`make audit` 据此判定 FAIL）
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const GEN = path.join(ROOT, "tools", "gen-equip-align-catalog.cjs");
const TARGET = path.join(ROOT, "admin", "src", "data", "equip-align.catalog.json");

/** 8 个站立朝向：`outPositions` 要么空（走运行时算法），要么整整齐齐 8 个 */
const DIRECTIONS = 8;

/** 环境变量名写在这里，只为了在报错里点名 */
const ENV_OUT = "EQUIP_ALIGN_OUT";

const problems = [];
const fail = (message) => problems.push(message);

function main() {
  if (!fs.existsSync(TARGET)) {
    console.error(`✗ 清单不存在：${path.relative(ROOT, TARGET)}`);
    console.error("  生成：node tools/gen-equip-align-catalog.cjs");
    process.exit(1);
  }

  const expected = fs.readFileSync(TARGET, "utf8");
  const actual = regenerate();
  if (actual !== expected) reportDrift(expected, actual);

  const catalog = parse(actual);
  checkStructure(catalog);

  if (problems.length) {
    console.error("✗ 装备对齐清单有问题：");
    for (const problem of problems) console.error(`  · ${problem}`);
    process.exit(1);
  }
  const total = catalog.clothes.length + catalog.weapons.length + catalog.role.length;
  console.log(
    `  清单一致 ✓（裸模 ${catalog.role.length} / 衣服 ${catalog.clothes.length} / 武器 ${catalog.weapons.length}，共 ${total} 条 × ${catalog.directions.length} 方向）`,
  );
}

/** 重跑生成器，产物写到临时文件（不碰工作区里的那一份） */
function regenerate() {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "olua-equip-audit-")), "catalog.json");
  try {
    execFileSync(process.execPath, [GEN], {
      cwd: ROOT,
      env: { ...process.env, [ENV_OUT]: tmp },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    return fs.readFileSync(tmp, "utf8");
  } catch (error) {
    console.error("✗ 重新生成清单失败（生成器本身出错，不是漂移）：");
    const detail = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
    if (detail) console.error(detail.split("\n").slice(0, 20).join("\n"));
    process.exit(1);
  } finally {
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  }
}

/**
 * 逐字节不一致时指出**第一条不同的行**，而不是甩两个几万字的 diff
 *
 * 清单是 `JSON.stringify(_, null, 2)` 出来的，一行一个字段，所以「第一条不同的行」
 * 基本就落在出问题的那一件上。
 */
function reportDrift(expected, actual) {
  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  let index = 0;
  while (index < expectedLines.length && index < actualLines.length && expectedLines[index] === actualLines[index]) index += 1;

  fail(`与客户端配置**不一致**（第 ${index + 1} 行起）：提交的清单已过期`);
  fail(`  提交的：${(expectedLines[index] ?? "<文件结束>").trim().slice(0, 160)}`);
  fail(`  现算的：${(actualLines[index] ?? "<文件结束>").trim().slice(0, 160)}`);
  fail("  修法：node tools/gen-equip-align-catalog.cjs（这是派生快照，不要手改）");
}

function parse(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    console.error(`✗ 清单不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

function checkStructure(catalog) {
  if (!Array.isArray(catalog.directions) || catalog.directions.length !== DIRECTIONS) {
    fail(`directions 必须是 ${DIRECTIONS} 个方向（实际 ${Array.isArray(catalog.directions) ? catalog.directions.length : "缺失"}）`);
  }
  for (const group of ["role", "clothes", "weapons"]) {
    if (!Array.isArray(catalog[group]) || !catalog[group].length) fail(`${group} 是空表（生成器抽错来源数组了？）`);
  }

  const isVariant = (id) => /_p\d+s\d+$/.test(id);
  for (const group of ["role", "clothes", "weapons"]) {
    for (const item of catalog[group] ?? []) {
      const id = group === "role" ? `role:${item.id}` : `${group === "clothes" ? "cloth" : "weapon"}:${item.key}`;
      if (isVariant(String(item.key ?? item.id ?? ""))) fail(`${id} 是展开变体，清单只该有基础件`);
      if (!item.atlas) fail(`${id} 的 atlas 为空（toAtlas 没认出 out：${item.out ?? item.src}）`);
      if (!(Number(item.outScale) > 0)) fail(`${id} 的 outScale 不是正数（${item.outScale}），页面上会缩成一个点`);
      const positions = item.outPositions;
      if (!Array.isArray(positions) || ![0, DIRECTIONS].includes(positions.length)) {
        fail(`${id} 的 outPositions 长度必须是 0 或 ${DIRECTIONS}（实际 ${Array.isArray(positions) ? positions.length : "缺失"}）`);
      }
      if (Object.prototype.hasOwnProperty.call(item, "hasAsset")) {
        fail(`${id} 带着 hasAsset —— 素材有无必须运行时探测，写进清单会让本守点在 CI 上假红`);
      }
    }
  }
}

main();
