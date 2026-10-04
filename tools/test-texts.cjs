const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const TSC = "/Applications/Cocos/Creator/3.8.7/CocosCreator.app/Contents/Resources/resources/3d/engine/node_modules/typescript/bin/tsc";
const out = fs.mkdtempSync(path.join(os.tmpdir(), "texts-"));
const cfg = path.join(out, "tsconfig.json");
fs.writeFileSync(
  cfg,
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2015",
        module: "CommonJS",
        moduleResolution: "node",
        outDir: path.join(out, "js"),
        strict: false,
        skipLibCheck: true,
        types: [],
      },
      include: ["/Users/tz/workspace/olua/assets/configs/texts.ts", "/Users/tz/workspace/olua/assets/types/common.ts"],
      exclude: [],
    },
    null,
    2,
  ),
);
cp.execSync("node " + JSON.stringify(TSC) + " -p " + JSON.stringify(cfg), { stdio: "inherit" });
const mod = require(path.join(out, "js", "configs", "texts.js"));

const checks = [
  ["soul_bind_gold_tip", { need: 1200 }, "绑定元宝不足，升级需要 1200"],
  ["soul_upgrade_tip", { level: 5, label: "初生魂翼" }, "战魂升级成功：5 阶 · 初生魂翼"],
  ["label_good_detail_info", { level: 30, slot: "武器" }, "等级 30 · 武器"],
  ["label_good_detail_recycle", { price: 890 }, "回收价 890 绑定元宝"],
  ["reject_map_level", { map: "比奇省", level: 12 }, "比奇省 需要等级达到 12 级"],
  ["hover_row_seconds", { prefix: "冷却剩余", seconds: "3.2" }, "冷却剩余：3.2 秒"],
  ["hover_row_ready", { prefix: "冷却剩余" }, "冷却剩余：就绪"],
  ["label_damage", { value: 78 }, "-78"],
  ["label_damage_miss", undefined, "MISS"],
  ["label_exp_gain", { exp: 45 }, "+45 经验"],
  ["label_skill_release", { skill: "烈火剑法" }, "释放烈火剑法"],
  ["label_skill_level", { level: 3 }, "lv.3"],
  ["pickup_tip", { names: "金创药(小) x3、铁矿 x1" }, "拾取 金创药(小) x3、铁矿 x1"],
  ["label_good_count", { name: "金创药(小)", count: 3 }, "金创药(小) x3"],
  ["progress_loading", { percent: 42 }, "加载中 42%"],
  ["progress_loading_tip", { percent: 42, tip: "帧动画 3/7" }, "加载中 42% · 帧动画 3/7"],
  ["progress_frames", { done: 3, total: 7 }, "帧动画 3/7"],
  ["feature_locked_tip", { feature: "背包", level: 10 }, "背包功能需要在10级后开放"],
  ["label_soul_current", { level: 7, label: "幽魂之翼" }, "当前战魂：7 阶 · 幽魂之翼"],
  ["label_bind_gold", { value: 25000 }, "绑定元宝：25000"],
  ["label_good_detail_info", { level: 1 }, "等级 1 · {slot}"],
];

let bad = 0;
for (const [key, params, want] of checks) {
  const got = mod.getText(key, params);
  const ok = got === want;
  if (!ok) bad++;
  console.log((ok ? "OK   " : "FAIL ") + key + " -> " + got + (ok ? "" : "   (期望 " + want + ")"));
}

const unknown = mod.getText("no_such_key");
const unknownOk = unknown === "no_such_key";
if (!unknownOk) bad++;
console.log((unknownOk ? "OK   " : "FAIL ") + "未登记 key 原样返回 -> " + unknown);

console.log(bad ? "FAIL: " + bad + " 项不通过" : "PASS: 文案模板全部通过（含漏参/未登记 key 的兜底）");
process.exit(bad ? 1 : 0);
