#!/usr/bin/env node
/**
 * 守卫：战斗规则生成物是否与客户端来源一致
 *
 * ===========================================================================
 * 为什么必须有这个
 * ===========================================================================
 * `battle-rules.generated.ts` 是客户端配置的**快照**。快照这种东西，生成完没人管就会腐化：
 * 有人改了 `client/assets/configs/growth.ts` 的成长曲线，服务端那份还停在旧数值上 ——
 * 服务端算出来的伤害与客户端显示的不一致，而双方都不会报错，只是「怪忽然变难打了」。
 *
 * 这类漂移是最难查的一类 bug：**没有任何一处失败，只是一端慢慢偏离另一端。**
 * 所以照 `audit-api-generated.cjs` 的做法，用「重新生成一遍 + 逐字节比对」把它钉死。
 *
 * 过期时不需要人去判断「要不要更新」—— 答案永远是「重新生成」，
 * 因为来源在客户端，服务端没有别的正确答案可选。
 *
 * 用法：node tools/audit-battle-rules.cjs
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const GENERATED = path.join(ROOT, "server", "src", "modules", "combat", "battle-rules.generated.ts");

function main() {
  if (!fs.existsSync(GENERATED)) {
    fail(`生成物不存在：${path.relative(ROOT, GENERATED)}\n  先跑 node tools/gen-battle-rules.cjs`);
  }

  const before = fs.readFileSync(GENERATED, "utf8");

  // 就地重生成：gen 脚本的输出路径是固定的，跑完把结果读回来比对即可
  execFileSync(process.execPath, [path.join(ROOT, "tools", "gen-battle-rules.cjs")], {
    cwd: ROOT,
    stdio: "ignore",
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  const after = fs.readFileSync(GENERATED, "utf8");

  if (before !== after) {
    fail(
      "战斗规则生成物已过期（客户端 configs 改了，但服务端快照没跟上）\n" +
        "  修法只有一种：重新生成\n" +
        "    node tools/gen-battle-rules.cjs",
    );
  }

  const lines = after.split("\n").length;
  console.log(`✔ 战斗规则一致（重新生成后逐字节相同，${lines} 行）`);
}

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

main();
