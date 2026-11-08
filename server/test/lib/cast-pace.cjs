/**
 * 出手节奏（#813 的服务端冷却闸）
 *
 * e2e 里两次 `cast` 之间必须隔这么久，否则第二次起会被 `rejected: "cooldown"` 拒掉 ——
 * 服务端现在按**真客户端同一口径**判冷却：
 *
 *   有效冷却 = `skills.cooldown`（秒）× 1000 ÷ `data.speedRate[skills.action]`
 *
 * 基础剑术（1000）：cooldown 1.0s ÷ attack_near 4 = **250ms**。
 * 冷却值从配置快照现算（运营改 `skills.cooldown` 时这里跟着走，不写死 250）。
 *
 * 为什么要测试让步而不是放宽服务端：这些循环原本在模拟一个**改过包的客户端**（连发到死），
 * 而冷却闸存在的全部意义就是让那种客户端打不出伤害。让测试按真实攻速出手，
 * 顺带把「每一条击杀路径都真的走过判定链」变成常态覆盖。
 */
const configSnapshot = require("./config-snapshot.cjs");

/** 新角色的 `speedRate.attack_near`（= `initial-role.ts` 的 DEFAULT_SPEED_RATE.attack_near） */
const ROLE_ATTACK_NEAR_RATE = 4;

const baseSkill = (configSnapshot.rows("skills") || []).find((row) => String(row.id) === "1000");
const cooldownMs = Math.max(0, Math.round(((Number(baseSkill && baseSkill.cooldown) || 0) * 1000) / ROLE_ATTACK_NEAR_RATE));

/** 余量：setTimeout 只会晚不会早，40ms 足够吸收事件循环抖动 */
const CAST_GAP_MS = cooldownMs + 40;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 等一个出手间隔（在两次 cast 之间调用；第一次调用白等一次也没关系） */
async function paceCast() {
  if (CAST_GAP_MS > 0) await sleep(CAST_GAP_MS);
}

module.exports = { CAST_GAP_MS, sleep, paceCast };
