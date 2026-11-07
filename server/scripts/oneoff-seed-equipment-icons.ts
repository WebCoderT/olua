/**
 * 一次性脚本：按素材目录批量生成装备基础件（#777）
 *
 * ## 为什么不直接写 SQL
 * 一件装备在客户端"存在"的前提是 `equipment_variants` 里那 15 行（基础件 × 5 前缀 × 3 后缀）。
 * 展开规则住在 `GameConfigService.variantsOfBase()`，脚本里再抄一份就等于养了第二套真相 ——
 * 以后运营调倍率，脚本生成的存量数据会和「重新生成变体」对不上。所以这里**起一个 Nest
 * application context，直接调 `createEquipment()`**，与手工新建走同一条路径。
 *
 * ## 一条一批的做法
 * `createEquipment()` 每次都 `touchRuntime()` 重装全量配置（约 1 万条变体），648 次会把
 * 本来 3 秒的活拖成几分钟，所以批量期间把 touchRuntime 换成 no-op，收尾再真刷一次。
 *
 * ## 编号与命名
 * - `id` = `<部位>_<图标编号>`（`belt_1300`）—— id 与磁盘文件名一一对应，运营看 id 就知道是哪张图
 * - `label` = `<部位名>·<编号>`（「腰带·1300」）—— 占位名，等运营按设定改名
 * - 等级：部位内按编号升序线性映射到 1–60（这批素材没有等级信息，只有先后顺序）
 * - 八项属性留 0、内外观图集留空（这批素材只给了图标）
 *
 * 已存在同 `id` 或同 `icon` 的跳过 ——— 五件「新手 X」已经顶着归位后的图标，
 * 再建一件就是同图两件装备。
 *
 * 用法：
 *   cd server && node --disable-warning=ExperimentalWarning -r ts-node/register \
 *     scripts/oneoff-seed-equipment-icons.ts            # 干跑
 *     同上 + ` --apply`                                  # 真写库
 */

import "reflect-metadata";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { GameConfigModule } from "../src/modules/game-config/game-config.module";
import { GameConfigService } from "../src/modules/game-config/game-config.service";
import { RuntimeConfigService } from "../src/modules/game-config/runtime-config.service";

const RES = resolve(__dirname, "../../client/assets/resources/equipment");
const apply = process.argv.includes("--apply");

/** 素材目录（复数）→ 装备部位 key（单数，与 equipment_slots.key 对齐） */
const SLOT_DIRS: Array<{ dir: string; slot: string }> = [
  { dir: "belts", slot: "belt" },
  { dir: "helmets", slot: "helmet" },
  { dir: "necklaces", slot: "necklace" },
  { dir: "rings", slot: "ring" },
  { dir: "shoes", slot: "shoes" },
  { dir: "wristbands", slot: "wristband" },
];

/** 等级线性映射的上限（客户端 role_levels 的最高级） */
const MAX_LEVEL = 60;

interface PlanRow {
  id: string;
  slot: string;
  label: string;
  level: number;
  icon: string;
}

/** 某个部位目录下的图标：按编号数值升序（`01408` 与 `2030410` 混在同一目录时也能排对） */
function iconsOf(dir: string): string[] {
  const abs = join(RES, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((name) => name.endsWith(".png"))
    .map((name) => name.slice(0, -4))
    .filter((serial) => /^\d+$/.test(serial))
    .sort((a, b) => Number(a) - Number(b));
}

async function main(): Promise<void> {
  // AppModule 是工厂形态（#37 拆进程）：直接传类进去会得到一个没有 imports 的空壳，
  // 拿不到任何 provider。这里按「存档进程」形态起 context —— 不需要 WS，也不该拉起来。
  const app = await NestFactory.createApplicationContext(AppModule.register({ realtime: false }), {
    logger: ["error", "warn"],
  });
  try {
    // GameConfigService 不在 GameConfigModule 的 exports 里（那是给 HTTP 层用的），
    // 根 context 找不到 —— `select(模块)` 拿到的 context 以该模块为根，未导出的 provider 也在。
    const gameConfig = app.select(GameConfigModule);
    const svc = gameConfig.get(GameConfigService);
    const runtime = app.get(RuntimeConfigService);

    // 现有装备的 icon / id —— 用来跳过"图标已经被某件装备顶着"的情况
    const existing = svc.listEquipments({ page: 1, size: 100_000 });
    const usedIcons = new Set(existing.list.map((row) => row.icon).filter(Boolean));
    const usedIds = new Set(existing.list.map((row) => row.id));
    const slotLabel = new Map(svc.listEquipmentSlots().map((row) => [row.key, row.label]));

    const plan: PlanRow[] = [];
    const skipped: string[] = [];
    for (const { dir, slot } of SLOT_DIRS) {
      const icons = iconsOf(dir);
      if (icons.length === 0) {
        console.warn(`跳过 ${dir}：目录不存在或没有数字命名的 png`);
        continue;
      }
      // 等级按**整批图标**线性摊开（已被占用的那几张也算在内），换个体位不影响别件
      const step = icons.length > 1 ? (MAX_LEVEL - 1) / (icons.length - 1) : 0;
      icons.forEach((serial, index) => {
        const icon = `equipment/${dir}/${serial}`;
        // id 去前导零（`belt_1300` 而不是 `belt_01300`）—— 与库里既有的 `weapon_1` / `cloth_14`
        // 一个形态；前导零留着会让 `nextEquipmentId()` 的数字比较看不出是同一套编号
        const id = `${slot}_${Number(serial)}`;
        if (usedIds.has(id)) {
          skipped.push(`${id}（id 已存在）`);
          return;
        }
        if (usedIcons.has(icon)) {
          skipped.push(`${icon}（图标已被现有装备占用）`);
          return;
        }
        plan.push({
          id,
          slot,
          label: `${slotLabel.get(slot) ?? slot}·${Number(serial)}`,
          level: 1 + Math.round(index * step),
          icon,
        });
      });
    }

    const bySlot = new Map<string, number>();
    for (const row of plan) bySlot.set(row.slot, (bySlot.get(row.slot) ?? 0) + 1);

    console.log(`计划新建 ${plan.length} 件基础件（× 15 前缀后缀 = ${plan.length * 15} 条变体）`);
    for (const { slot } of SLOT_DIRS) console.log(`  ${slot}: ${bySlot.get(slot) ?? 0} 件`);
    if (skipped.length > 0) console.log(`跳过 ${skipped.length} 件：${skipped.slice(0, 5).join("、")}${skipped.length > 5 ? " …" : ""}`);
    console.log("样例：", plan.slice(0, 3).map((row) => `${row.id} / ${row.label} / Lv${row.level}`).join(" · "));

    if (!apply) {
      console.log("\n干跑结束。加 --apply 真写库。");
      return;
    }

    // 批量期间不重装配置：648 次 × 全量 1 万条变体 = 几分钟的纯浪费
    const patched = svc as unknown as { touchRuntime: () => void };
    const original = patched.touchRuntime.bind(svc);
    patched.touchRuntime = () => {};

    const started = Date.now();
    let created = 0;
    const failures: string[] = [];
    try {
      for (const row of plan) {
        try {
          svc.createEquipment({
            id: row.id,
            slot: row.slot,
            label: row.label,
            level: row.level,
            sellPrice: 10 * row.level,
            icon: row.icon,
          });
          created += 1;
        } catch (error) {
          failures.push(`${row.id}: ${(error as Error).message}`);
        }
      }
    } finally {
      patched.touchRuntime = original;
    }

    runtime.refreshAll();
    console.log(`\n完成：新建 ${created} 件，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
    if (failures.length > 0) {
      console.error(`失败 ${failures.length} 件：`);
      for (const line of failures.slice(0, 20)) console.error(`  ${line}`);
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

void main();
