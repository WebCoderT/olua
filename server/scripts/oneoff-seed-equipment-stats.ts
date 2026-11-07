/**
 * 一次性脚本：给 #777 批量生成的装备补上「按等级曲线增长」的八项属性（#781 遗留）
 *
 * ## 曲线从哪来
 * 不发明公式，**沿用已经上线的那条曲线**：衣服（`cloth`）是唯一有完整 1~60 曲线的部位
 * （12 个点：L1 60 血 / L10 157 / … / L60 59232），武器（`weapon`）的攻防形状与它同源
 * （各级都是衣服的 5.25 倍左右），所以统一拿衣服当参照系。
 *
 * 每件新装备的属性 = **衣服同等级的值 × 该部位的 L1 锚点系数**：
 *
 * ```
 * 系数 = 本部位 1 级件的那一项 ÷ 衣服 1 级件的同一项（血 60 / 攻 4 / 防 4）
 * 属性(L) = round(衣服曲线(L) × 系数)
 * ```
 *
 * 这条式子在 1 级上**正好还原出厂件**（项链 24 血 5 攻 1 防 → 60×0.4 / 4×1.25 / 4×0.25），
 * 所以不是拍脑袋的比例，而是既有部位关系沿等级外推。
 *
 * 护腕（`wristband`）没有 1 级件（#777 才新增的部位，79 件全零）→ 锚点取其余五个部位锚点的
 * 中位数（血 26 / 攻 2 / 防 2），与鞋子、头盔同一量级偏轻。之后运营在管理端「N 个变体」弹窗里
 * 逐件微调即可，这里只负责把「全 0」变成「有曲线」。
 *
 * ## 变体怎么跟上
 * 变体行是**最终值**（#655），不是现算的。所以改完基础件要重算它的 15 行。这里直接调
 * `rebuildEquipmentVariants()` —— 全表重建，唯一一份展开实现。**前提是全库变体都没有漂移**
 * （没有任何一行被单独调过），脚本会先算漂移量，`--apply` 时只要漂移 > 0 就中止，
 * 免得把运营逐行调过的数值一起盖掉。
 *
 * ## 只碰「全 0」的件
 * 判据是八项属性全 0（#777 生成的占位件）；已经有数值的件（衣服 / 武器 / 各部位新手件）一律不动。
 *
 * 用法（在 server/ 下）：
 *   node --disable-warning=ExperimentalWarning -r ts-node/register scripts/oneoff-seed-equipment-stats.ts
 *   同上 + ` --apply`                        # 真写库
 */

import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { GameConfigModule } from "../src/modules/game-config/game-config.module";
import { GameConfigService } from "../src/modules/game-config/game-config.service";
import { RuntimeConfigService } from "../src/modules/game-config/runtime-config.service";
import type { EquipmentListItemDto } from "../src/modules/game-config/dto/equipment.dto";
import type { ConfigAttributesDto } from "../src/modules/game-config/dto/title.dto";

const apply = process.argv.includes("--apply");

/** 参照部位：唯一有完整 1~60 曲线的部位 */
const CURVE_SLOT = "cloth";

/** 需要补数值的部位（#777 批量生成的那六个） */
const DERIVED_SLOTS = ["belt", "helmet", "necklace", "ring", "shoes", "wristband"];

/** 一条曲线点（三元素同值：客户端装备就是这么配的，攻防不分元素） */
interface CurvePoint {
  level: number;
  maxHp: number;
  hpRecover: number;
  attack: number;
  defense: number;
}

/** 部位锚点（该部位 1 级件的数值） */
interface Anchor {
  maxHp: number;
  hpRecover: number;
  attack: number;
  defense: number;
}

/** 八项属性是否全 0（= #777 的占位件） */
function isBlank(attributes: ConfigAttributesDto): boolean {
  const ranges = [
    attributes.physicalAttack,
    attributes.physicalDefense,
    attributes.magicAttack,
    attributes.magicDefense,
    attributes.taoistAttack,
    attributes.taoistDefense,
  ];
  return attributes.maxHp === 0 && attributes.hpRecover === 0 && ranges.every((range) => range.min === 0 && range.max === 0);
}

/** 装备行 → 曲线点（三元素取物理那一份；客户端三个元素本来就同值） */
function curvePointOf(row: EquipmentListItemDto): CurvePoint {
  return {
    level: row.level,
    maxHp: row.attributes.maxHp,
    hpRecover: row.attributes.hpRecover,
    attack: row.attributes.physicalAttack.max,
    defense: row.attributes.physicalDefense.max,
  };
}

/**
 * 曲线取值：**分段线性插值**
 *
 * 12 个点在 L1~L60 上并不均匀（L1 / L10 / L16 / …），直接用相邻两点线性插值 ——
 * 这就是「沿用已上线曲线」最忠实的读法，不额外拟合指数（拟合出来的曲线会在两点之间偏离
 * 运营已经调过的值）。
 */
function valueAt(curve: CurvePoint[], level: number, pick: (point: CurvePoint) => number): number {
  if (curve.length === 0) return 0;
  if (level <= curve[0].level) return pick(curve[0]);
  const last = curve[curve.length - 1];
  if (level >= last.level) return pick(last);
  for (let index = 1; index < curve.length; index++) {
    const prev = curve[index - 1];
    const next = curve[index];
    if (level > next.level) continue;
    const ratio = (level - prev.level) / (next.level - prev.level);
    return pick(prev) + (pick(next) - pick(prev)) * ratio;
  }
  return pick(last);
}

/** 按锚点系数把参照曲线放大到本部位（1 级时正好还原锚点自身） */
function scaleTo(anchor: Anchor, reference: Anchor, computed: Anchor): ConfigAttributesDto {
  const ratio = (value: number, base: number, target: number) => (base === 0 ? 0 : Math.round((value * target) / base));
  const hp = ratio(computed.maxHp, reference.maxHp, anchor.maxHp);
  const recover = ratio(computed.hpRecover, reference.hpRecover, anchor.hpRecover);
  const attack = ratio(computed.attack, reference.attack, anchor.attack);
  const defense = ratio(computed.defense, reference.defense, anchor.defense);
  const fixed = { min: attack, max: attack };
  const armor = { min: defense, max: defense };
  return {
    maxHp: hp,
    hpRecover: recover,
    physicalAttack: fixed,
    magicAttack: { ...fixed },
    taoistAttack: { ...fixed },
    physicalDefense: armor,
    magicDefense: { ...armor },
    taoistDefense: { ...armor },
  };
}

/**
 * 变体行偏离「基础件 × 前后缀倍率」的行数
 *
 * 整表重建（`rebuildEquipmentVariants`）会把每一行都按公式重算 —— 这是唯一一份展开实现，
 * 也是脚本想复用的东西。但只要有一行被运营单独调过，复用就等于覆盖。所以先数一遍：
 * 不为 0 就中止，交给人决定（把那些行记下来手工恢复，或改用定向更新）。
 */
function variantDrift(
  svc: GameConfigService,
  bases: EquipmentListItemDto[],
): { count: number; samples: string[] } {
  const meta = svc.getEquipmentMeta();
  const baseById = new Map(bases.map((row) => [row.id, row]));
  const rateOf = (prefix: number, suffix: number) => (meta.prefixRates[prefix] ?? 1) * (meta.suffixRates[suffix] ?? 1);
  let count = 0;
  const samples: string[] = [];
  for (let page = 1; page <= 500; page++) {
    const result = svc.listVariantPage({ page, size: 100 });
    for (const row of result.list) {
      const base = baseById.get(row.baseId);
      if (!base) continue;
      const rate = rateOf(row.prefix, row.suffix);
      const expected: Array<[number, number]> = [
        [base.attributes.maxHp, row.attributes.maxHp],
        [base.attributes.hpRecover, row.attributes.hpRecover],
        [base.attributes.physicalAttack.max, row.attributes.physicalAttack.max],
        [base.attributes.physicalDefense.max, row.attributes.physicalDefense.max],
      ];
      const drifted = expected.some(([baseValue, rowValue]) => Math.abs(Math.round(baseValue * rate) - rowValue) > 1);
      if (!drifted) continue;
      count += 1;
      if (samples.length < 5) samples.push(`${row.id}（基础件 ${base.attributes.maxHp} × ${rate} ≠ ${row.attributes.maxHp}）`);
    }
    if (page * 100 >= result.total) break;
  }
  return { count, samples };
}

/** 中位数（偶数个取中间两个的平均，四舍五入） */
function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[middle - 1] + sorted[middle]) / 2) : sorted[middle];
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule.register({ realtime: false }), {
    logger: ["error", "warn"],
  });
  try {
    const svc = app.select(GameConfigModule).get(GameConfigService);
    const runtime = app.get(RuntimeConfigService);

    const all: EquipmentListItemDto[] = [];
    for (let page = 1; page <= 200; page++) {
      const result = svc.listEquipments({ page, size: 100 });
      all.push(...result.list);
      if (page * 100 >= result.total) break;
    }

    // —— 参照曲线：衣服（有完整 1~60 曲线）——
    const curve = all
      .filter((row) => row.slot === CURVE_SLOT && !isBlank(row.attributes) && row.attributes.maxHp > 0)
      .map(curvePointOf)
      .sort((a, b) => a.level - b.level);
    if (curve.length < 3) throw new Error(`参照部位 ${CURVE_SLOT} 的曲线点太少（${curve.length}），拒绝按它外推`);
    const reference: Anchor = {
      maxHp: curve[0].maxHp,
      hpRecover: curve[0].hpRecover,
      attack: curve[0].attack,
      defense: curve[0].defense,
    };

    // —— 各部位锚点：该部位 1 级件的数值（新手件）——
    const anchors = new Map<string, Anchor>();
    for (const slot of DERIVED_SLOTS) {
      const starter = all.find((row) => row.slot === slot && row.level === 1 && !isBlank(row.attributes));
      if (starter) {
        const point = curvePointOf(starter);
        anchors.set(slot, { maxHp: point.maxHp, hpRecover: point.hpRecover, attack: point.attack, defense: point.defense });
      }
    }
    // 护腕没有 1 级件：取其余部位锚点的中位数（比头盔 / 鞋子略轻，与「护腕」的定位相符）
    if (!anchors.has("wristband")) {
      const known = Array.from(anchors.values());
      anchors.set("wristband", {
        maxHp: median(known.map((row) => row.maxHp)),
        hpRecover: median(known.map((row) => row.hpRecover)),
        attack: median(known.map((row) => row.attack)),
        defense: median(known.map((row) => row.defense)),
      });
    }

    // —— 待补的件：六个部位里八项全 0 的那些 ——
    const plan: Array<{ row: EquipmentListItemDto; attributes: ConfigAttributesDto }> = [];
    const outside: string[] = [];
    for (const row of all) {
      if (!isBlank(row.attributes)) continue;
      const anchor = anchors.get(row.slot);
      if (!anchor || !DERIVED_SLOTS.includes(row.slot)) {
        outside.push(`${row.id}（${row.slot}）`);
        continue;
      }
      const computed: Anchor = {
        maxHp: valueAt(curve, row.level, (point) => point.maxHp),
        hpRecover: valueAt(curve, row.level, (point) => point.hpRecover),
        attack: valueAt(curve, row.level, (point) => point.attack),
        defense: valueAt(curve, row.level, (point) => point.defense),
      };
      plan.push({ row, attributes: scaleTo(anchor, reference, computed) });
    }

    console.log(`参照曲线 ${CURVE_SLOT}：${curve.length} 个点（L${curve[0].level}~L${curve[curve.length - 1].level}）`);
    console.log("部位锚点（1 级件）：");
    for (const slot of DERIVED_SLOTS) {
      const anchor = anchors.get(slot);
      if (!anchor) continue;
      console.log(`  ${slot.padEnd(10)} 血 ${anchor.maxHp} / 回血 ${anchor.hpRecover} / 攻 ${anchor.attack} / 防 ${anchor.defense}`);
    }

    // 每个部位抽 3 档看曲线形状（1 级 / 中间 / 最高）
    console.log("\n曲线抽样（血 / 回血 / 攻 / 防）：");
    for (const slot of DERIVED_SLOTS) {
      const rows = plan.filter((item) => item.row.slot === slot).sort((a, b) => a.row.level - b.row.level);
      if (rows.length === 0) continue;
      const picks = [rows[0], rows[Math.floor(rows.length / 2)], rows[rows.length - 1]];
      const text = picks
        .map(
          (item) =>
            `L${item.row.level} ${item.attributes.maxHp}/${item.attributes.hpRecover}/${item.attributes.physicalAttack.max}/${item.attributes.physicalDefense.max}`,
        )
        .join("  ");
      console.log(`  ${slot.padEnd(10)} ${text}`);
    }
    console.log(`\n待补数值的基础件：${plan.length} 件（× 15 变体 = ${plan.length * 15} 行）`);
    if (outside.length > 0) {
      console.warn(`跳过 ${outside.length} 件「不在六个部位里」的全零件：${outside.slice(0, 5).join("、")}${outside.length > 5 ? " …" : ""}`);
    }

    // —— 漂移检查：变体行是否都还是「基础件 × 前后缀倍率」——
    // 有漂移说明运营逐行调过某些变体，整表重建会把那些值盖掉 → 拒绝写库
    const drift = variantDrift(svc, all);
    console.log(`变体漂移：${drift.count} 行${drift.count > 0 ? `（如 ${drift.samples.slice(0, 3).join("、")}）` : "（全部等于 基础件 × 倍率，可安全整表重建）"}`);

    if (!apply) {
      console.log("\n干跑结束。加 --apply 真写库（先补基础件，再整表重建变体）。");
      return;
    }
    if (drift.count > 0) {
      console.error("\n中止：变体行与「基础件 × 倍率」不一致，整表重建会覆盖运营逐行调过的值。先处理漂移再跑。");
      process.exitCode = 1;
      return;
    }

    // 批量期间不重装配置（每件都会 touchRuntime 一次 = 全量 1 万条变体）
    const patched = svc as unknown as { touchRuntime: () => void };
    const original = patched.touchRuntime.bind(svc);
    patched.touchRuntime = () => {};

    const started = Date.now();
    try {
      for (const item of plan) {
        svc.updateEquipment(item.row.id, { attributes: item.attributes });
      }
    } finally {
      patched.touchRuntime = original;
    }
    const updatedBase = plan.length;

    // 变体是最终值（#655）：基础件变了要重算那 15 行 —— 走唯一一份展开实现
    const rebuilt = svc.rebuildEquipmentVariants();
    runtime.refreshAll();

    console.log(
      `\n完成：补数值 ${updatedBase} 件基础件，重建 ${rebuilt.variants} 行变体（${rebuilt.bases} 件 × ${rebuilt.combos} 组合），用时 ${(
        (Date.now() - started) /
        1000
      ).toFixed(1)}s`,
    );

    // 收尾自检：这六个部位不该再有全 0 的件；变体也不该再有全 0 的行
    const after = svc.listEquipments({ page: 1, size: 100, slot: "belt" });
    const sampleRows = after.list.filter((row) => plan.some((item) => item.row.id === row.id)).slice(0, 2);
    for (const row of sampleRows) {
      console.log(
        `  抽查 ${row.id} L${row.level}：血 ${row.attributes.maxHp} / 回血 ${row.attributes.hpRecover} / 攻 ${row.attributes.physicalAttack.max} / 防 ${row.attributes.physicalDefense.max}`,
      );
    }
  } finally {
    await app.close();
  }
}

void main();
