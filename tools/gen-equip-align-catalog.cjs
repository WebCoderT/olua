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
const path = require("node:path");
const { ASSETS, ROOT, createWork, compileClientConfig, configLoader, cleanupWork } = require("./lib/client-config-compile.cjs");

const OUT = process.env.EQUIP_ALIGN_OUT || path.join(ROOT, "admin", "src", "data", "equip-align.catalog.json");

const SOURCE_FILES = [
  ...["equipments", "role", "animation"].map((name) => path.join(ASSETS, "configs", `${name}.ts`)),
  // 内观视图的底座（#523）：角色信息弹窗的背景图与尺寸在 layout/dialogs，别在页面里抄第二份
  path.join(ASSETS, "configs", "layout", "dialogs.ts"),
];

function main() {
  const work = createWork("equip-catalog");
  compileClientConfig(work, SOURCE_FILES);
  const { cfg, layoutCfg } = configLoader(work);
  const catalog = buildCatalog({
    equipments: cfg("equipments"),
    role: cfg("role"),
    animation: cfg("animation"),
    dialogs: layoutCfg("dialogs"),
  });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  cleanupWork(work);

  console.log(`✔ 已生成 ${path.relative(ROOT, OUT)}`);
  console.log(`  裸模 ${catalog.role.length} 套 · 衣服 ${catalog.clothes.length} 件 · 武器 ${catalog.weapons.length} 把`);
}

/** 图集路径（#542 起图集与散帧**同路径**，夹层已移除 → 恒等；保留函数是为页面字段语义留名） */
function toAtlas(outSrc) {
  return outSrc;
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

function buildCatalog({ equipments, role, animation, dialogs }) {
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

  const clothes = map(equipments.clothes, "cloth");
  const weapons = map(equipments.weapons, "weapon");
  const dialogBg = dialogs.roleInfoDialogLayout?.background ?? {};

  return {
    generatedBy: "tools/gen-equip-align-catalog.cjs",
    directions,
    /**
     * 角色的体型与碰撞盒（来自 `configs/role.roleBody`）
     *
     * 工作台要在格子里画出**和客户端 `debug.colliderRange` 同一个框** —— 用户就是拿它
     * 判断「身体有没有踩在脚下」的。把那两个数字写死在页面里等于造第二份真值，
     * 所以跟着清单一起下发；改了 roleBody，重生成清单即可。
     */
    body: {
      width: Number(role.roleBody?.size?.width) || 0,
      height: Number(role.roleBody?.size?.height) || 0,
      colliderWidth: Number(role.roleBody?.colliderSize?.width) || 0,
      colliderHeight: Number(role.roleBody?.colliderSize?.height) || 0,
      colliderOffset: vec(role.roleBody?.colliderOffset),
    },
    /**
     * 内观视图的底座（#523）
     *
     * 内观工作台画的是**角色信息弹窗里那块区域**：背景图（含圆盘）+ 内观节点。
     * - `background` 取自 `configs/layout/dialogs.roleInfoDialogLayout.background`（唯一真值，
     *   页面不许自己写坐标）；
     * - `plate` 是**实测值**：背景图 858×908（@2x）上金色圆盘外缘约 x 240~600、y 640~790，
     *   换算到弹窗坐标就是中心 (-82.5, -149.5)、半径 90。它不是配置里的东西 ——
     *   **换背景图就要重测**（这也是它只在这里出现一次的原因）；
     * - `baseClothKey` 是「第一件衣服」：调武器时的参照系（19 把武器共用同一个参照，
     *   而不是跟着当前选中的衣服漂）。取配置里的第一件，避免页面自己猜。
     */
    inShow: {
      background: {
        image: String(dialogBg.image ?? ""),
        position: vec(dialogBg.position),
        size: [Number(dialogBg.size?.width) || 0, Number(dialogBg.size?.height) || 0],
      },
      plate: { center: [-82.5, -149.5], radius: 90 },
      baseClothKey: clothes.length ? clothes[0].key : "",
    },
    role: roleEntries,
    clothes,
    weapons,
  };
}

main();
