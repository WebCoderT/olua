#!/usr/bin/env node
/**
 * 生成「装备对齐工作台」的只读清单（`admin/src/data/equip-align.catalog.json`）
 *
 * ===========================================================================
 * 这个文件解决什么
 * ===========================================================================
 * 管理端的装备对齐页要列出「所有衣服 / 所有武器 / 两套裸模」以及它们**当前的几何值**
 * （outScale / outPositions / 内观 inPosition / inScale），这些数据的唯一来源是
 * 客户端配置 `client/assets/configs`。管理端是独立的 Vite 前端，不能直接 import 那些
 * .ts（它们 `import { Vec2 } from "cc"`），所以按 `gen-shared-data.cjs` 同一套路把它们
 * 编译成 JS 再读值，快照成一份纯 JSON 给页面用。
 *
 * **这是派生清单，不是第二份数据**：改了客户端配置就重跑本脚本（`audit-shared-data`
 * 的兄弟守点 `audit-equip-align-catalog` 会重生成后逐字节比对）。
 *
 * 清单里**不含**属性 / 价格这些运营字段 —— 那些在管理端自己的接口里；
 * 这里只要「画一张图需要什么」：资源路径、几何、名字。
 *
 * ===========================================================================
 * 为什么清单里没有「有没有素材」这一项
 * ===========================================================================
 * 一开始这里带过一个 `hasAsset`（探测 `resources/` 下 plist 在不在）。它有两个问题：
 *
 *   1. **它不是配置数据，是「这台机器上有什么」** —— 而 `client/assets/resources/` 是
 *      gitignore 的（素材走 GitHub Release 分发，`make resources-download`）。于是同一份
 *      配置在装了素材的机器上生成 33 个 `true`、在 CI 上生成 33 个 `false`；
 *   2. 一旦按「重生成 + 逐字节比对」钉住清单（`tools/audit-equip-align-catalog.cjs`），
 *      这个字段会让 CI **必然**报不一致 —— 那不是漂移，是环境差异，属于假红。
 *
 * 所以素材有无的判断搬到了**页面运行时**（`equipAlign/assets.ts` 的 `probeAtlas`）：
 * 浏览器里探一次 URL 就知道，且永远反映「当前这套资源根」的真实情况。
 *
 * 用法：node tools/gen-equip-align-catalog.cjs
 *      EQUIP_ALIGN_OUT=/tmp/x.json node tools/gen-equip-align-catalog.cjs   # 审计用
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const ASSETS = path.join(ROOT, "client", "assets");
const OUT = process.env.EQUIP_ALIGN_OUT || path.join(ROOT, "admin", "src", "data", "equip-align.catalog.json");

const SOURCE_FILES = ["equipments", "role", "animation"].map((name) => path.join(ASSETS, "configs", `${name}.ts`));

/** cc 垫片：配置层只用到这几个表现层类（与 gen-shared-data 完全一致） */
const CC_SHIM = `
class Color { constructor(value) { this.value = value; } }
class Vec2 { constructor(x = 0, y = 0) { this.x = x; this.y = y; } }
class Size { constructor(width = 0, height = 0) { this.width = width; this.height = height; } }
class Vec3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } }
module.exports = { Color, Vec2, Size, Vec3 };
`;

function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "olua-equip-catalog-"));
  writeShim(work);
  compile(work);
  const cfg = load(work);
  const catalog = buildCatalog(cfg);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  fs.rmSync(work, { recursive: true, force: true });

  console.log(`✔ 已生成 ${path.relative(ROOT, OUT)}`);
  console.log(`  裸模 ${catalog.role.length} 套 · 衣服 ${catalog.clothes.length} 件 · 武器 ${catalog.weapons.length} 把`);
}

/** 把 cc 垫片伪装成一个可被 require 的包 */
function writeShim(work) {
  const shimDir = path.join(work, "out", "node_modules", "cc");
  fs.mkdirSync(shimDir, { recursive: true });
  fs.writeFileSync(path.join(shimDir, "index.js"), CC_SHIM, "utf8");
  fs.writeFileSync(path.join(shimDir, "package.json"), '{"name":"cc","version":"0.0.0","main":"index.js"}', "utf8");
}

/**
 * 编译客户端配置到临时目录
 *
 * 报 `Cannot find module 'cc'` 是**预期内的**（引擎类型不在这个工程里），
 * 缺类型不影响 JS 产物；真正的失败（语法错误 / 找不到源文件）不会被吞掉。
 */
function compile(work) {
  const tsconfig = path.join(work, "tsconfig.json");
  fs.writeFileSync(
    tsconfig,
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "CommonJS",
          moduleResolution: "node",
          outDir: path.join(work, "out"),
          rootDir: ASSETS,
          skipLibCheck: true,
          esModuleInterop: true,
          strict: false,
          noEmitOnError: false,
        },
        files: SOURCE_FILES,
      },
      null,
      2,
    ),
    "utf8",
  );

  const tsc = path.join(ROOT, "server", "node_modules", ".bin", "tsc");
  if (!fs.existsSync(tsc)) throw new Error(`找不到 tsc：${tsc}（先在 server/ 下装依赖）`);

  let log = "";
  try {
    log = execFileSync(tsc, ["-p", tsconfig], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    log = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  const fatal = log.split("\n").filter((line) => line.includes("error TS") && !line.includes("Cannot find module 'cc'"));
  if (fatal.length) {
    console.error(fatal.slice(0, 20).join("\n"));
    throw new Error(`客户端配置编译失败（${fatal.length} 条错误，见上）`);
  }
}

function load(work) {
  const dir = path.join(work, "out", "configs");
  const requireCfg = (name) => require(path.join(dir, `${name}.js`));
  return { equipments: requireCfg("equipments"), role: requireCfg("role"), animation: requireCfg("animation") };
}

/** `clothes/out/005` → `clothes/atlas/out/005`（与客户端 `configs/animation.getAtlasSrc` 同一条规则） */
function toAtlas(outSrc) {
  const direct = /^(\w+)\/out\/(.+)$/.exec(outSrc);
  if (direct) return `${direct[1]}/atlas/out/${direct[2]}`;
  const role = /^role\/(\d+)$/.exec(outSrc);
  return role ? `role/atlas/${role[1]}` : "";
}

const vec = (value) => (value ? [Number(value.x) || 0, Number(value.y) || 0] : [0, 0]);

/** 一组几何字段（统一 shape，页面不用为衣服/武器/裸模写三套读取逻辑） */
function geometryOf(item) {
  return {
    outScale: Number(item.outScale) || 0,
    outPositions: (item.outPositions ?? []).map(vec),
    // 武器的 outPositions 目前是「自动算法的微调」，衣服/裸模是「绝对位置」——
    // 页面要把这个差别标出来，所以清单里带上当前语义（客户端同一份口径）
    manual: item.outManual === true,
    inScale: [Number(item.inScaleX) || 1, Number(item.inScaleY) || 1],
    inPosition: vec(item.inPosition),
  };
}

function buildCatalog({ equipments, role, animation }) {
  const directions = animation.directions.map((value) => String(value).toLowerCase());

  const roleEntries = [...role.roleDefaultCloths.entries()].map(([sex, cloth]) => {
    const atlas = toAtlas(cloth.out);
    return {
      id: String(sex),
      // SEX 的枚举值就是 "1" / "2"（见 types/role.ts），这里只做一个显示名
      label: String(sex) === String(role.SEX?.GRIL ?? "2") ? "女裸模" : "男裸模",
      src: cloth.out,
      atlas,
      ...geometryOf(cloth),
    };
  });

  /**
   * 只取**基础件**：`buildEquipmentMap` 会把每件展开成 5×3 = 15 个前后缀变体
   * （`cloth_1_p3s2`），外观完全一样、几何也一样 —— 页面上列 180 件是同 12 件的重复，
   * 没有任何操作价值。
   */
  const isVariant = (id) => /_p\d+s\d+$/.test(id);
  const map = (table, slot) =>
    [...table.entries()]
      .filter(([id, item]) => !isVariant(id) && item.out)
      .map(([id, item]) => {
        const atlas = toAtlas(item.out);
        return {
          key: id,
          label: item.label ?? id,
          slot,
          out: item.out,
          atlas,
          in: item.in ?? "",
          ...geometryOf(item),
        };
      });

  return {
    generatedBy: "tools/gen-equip-align-catalog.cjs",
    directions,
    role: roleEntries,
    clothes: map(equipments.clothes, "cloth"),
    weapons: map(equipments.weapons, "weapon"),
  };
}

main();
