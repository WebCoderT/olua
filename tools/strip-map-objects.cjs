#!/usr/bin/env node
/**
 * 把 TMX 里的**对象组整组删掉**：地图文件只留瓦片与图层（#676）
 *
 *   node tools/strip-map-objects.cjs              # 处理 client/assets/resources/map/*\/*.tmx
 *   node tools/strip-map-objects.cjs --dry        # 只报告会删掉什么
 *   node tools/strip-map-objects.cjs --dir <路径> # 处理别的资源目录（分卷解出来的那份）
 *
 * ## 为什么要删
 *
 * 「地图文件只做显示，所有数据在管理端」这条边界，光靠客户端不再读 TMX 是守不住的：
 * 文件里还留着 npc / revive / monster / collision 四组对象，下一个人（或下一次 AI 会话）
 * 看到它们就会以为那是数据源 —— #672 / #676 之前的事实也确实如此。删掉才是真的边界。
 *
 * 现在这四组数据的去处：
 *
 * | 原对象组 | 现在 |
 * |---|---|
 * | `npc`（class=npc / revive） | `map_npcs` / `maps.revive_cx,cy`（#672） |
 * | `monster` | `map_spawn_areas`（#667） |
 * | `collision` | `map_collisions`（#676） |
 *
 * ## 顺序（重要）
 *
 *   1. `node server/scripts/migrate-map-points.cjs`      —— 先把点位搬进库
 *   2. `node server/scripts/migrate-map-collisions.cjs`  —— 再把碰撞盒搬进库
 *   3. **本工具**                                        —— 删 TMX 里的对象组
 *   4. `node tools/import-map-resources.cjs`             —— 让 `maps.content` 只剩图层
 *   5. `make config-export`                              —— 出厂值进 `config-sync.sql`
 *
 * 反过来（先删 TMX）也能跑，但迁移脚本读的就是 `maps.content` —— 那时它已经被刷成空的，
 * 迁移会「搬出 0 行」，而库里也没有数据。结果就是围墙消失、玩家走出地图。
 *
 * ## 为什么不是 git 里的删除
 *
 * `client/assets/resources/` 是 **gitignore** 的（资源按分卷分发，见 `make resources-*`），
 * 所以这个动作没法靠 commit 传播。要有工具，才知道「换台机器该做什么」。
 *
 * 重新打包资源后记得刷新清单（`python3 client/tools/resources_sync.py manifest`，
 * 不带 `--version` 就沿用原版本号）—— 否则 `make resources-verify` 会报不一致。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..");
const MAP_DIR = path.join(REPO, "client", "assets", "resources", "map");

/** 读一个 `<objectgroup ...> ... </objectgroup>` 块（含标签本身）；自闭合的空组也认 */
function objectGroupsOf(xml) {
  const groups = [];
  const pattern = /<objectgroup\b[^>]*?(\/?)>/g;
  let match;
  while ((match = pattern.exec(xml))) {
    const start = match.index;
    if (match[1] === "/") {
      groups.push({ start, end: start + match[0].length, name: nameOf(match[0]), count: 0 });
      continue;
    }
    const closeAt = xml.indexOf("</objectgroup>", pattern.lastIndex);
    if (closeAt < 0) break;
    const end = closeAt + "</objectgroup>".length;
    const body = xml.slice(pattern.lastIndex, closeAt);
    groups.push({
      start,
      end,
      name: nameOf(match[0]),
      count: (body.match(/<object\b/g) ?? []).length,
    });
    pattern.lastIndex = end;
  }
  return groups;
}

function nameOf(openTag) {
  const match = /(?:^|\s)name\s*=\s*"([^"]*)"/.exec(openTag);
  return match ? match[1] : "（未命名）";
}

function main() {
  const dryRun = process.argv.includes("--dry");
  const dirArg = process.argv.indexOf("--dir");
  const mapDir = dirArg >= 0 ? path.resolve(process.cwd(), process.argv[dirArg + 1] ?? "") : MAP_DIR;

  if (!fs.existsSync(mapDir)) {
    console.error(`地图目录不存在：${mapDir}（本工具要在带有客户端素材的机器上跑）`);
    process.exit(1);
  }

  const mapIds = fs
    .readdirSync(mapDir, { withFileTypes: true })
    .filter((item) => item.isDirectory())
    .map((item) => item.name)
    // 只认纯数字目录（map/ 下还有 prefab、icon 之类的资源子目录）
    .filter((name) => /^\d+$/.test(name))
    .sort((a, b) => Number(a) - Number(b));

  let totalGroups = 0;
  let totalObjects = 0;
  let touched = 0;
  if (dryRun) console.log("dry run（不写文件）");

  for (const mapId of mapIds) {
    const tmxPath = path.join(mapDir, mapId, `${mapId}.tmx`);
    if (!fs.existsSync(tmxPath)) {
      console.warn(`地图 ${mapId} 没有 ${mapId}.tmx，跳过`);
      continue;
    }
    const xml = fs.readFileSync(tmxPath, "utf8");
    const groups = objectGroupsOf(xml);
    if (groups.length === 0) continue;

    const summary = groups.map((group) => `${group.name}(${group.count})`).join(" · ");
    console.log(`地图 ${mapId}：删 ${groups.length} 组 —— ${summary}`);
    totalGroups += groups.length;
    totalObjects += groups.reduce((sum, group) => sum + group.count, 0);
    if (dryRun) continue;

    // 从后往前切，前面的偏移量才不会被改动影响
    let next = xml;
    for (const group of [...groups].reverse()) {
      next = next.slice(0, group.start) + next.slice(group.end);
    }
    // 删完会留下空行（Tiled 的缩进习惯），顺手收一下：只收「整行只有空白」的行
    next = next
      .split("\n")
      .filter((line) => line.trim() !== "")
      .join("\n")
      .concat("\n");
    fs.writeFileSync(tmxPath, next, "utf8");
    touched += 1;
  }

  console.log("");
  if (touched === 0 && totalGroups === 0) {
    console.log("没有可删的对象组（TMX 里已经只有瓦片与图层）");
    return;
  }
  console.log(
    dryRun
      ? `待删：${totalGroups} 个对象组 / ${totalObjects} 个对象（未写文件）`
      : `已删：${touched} 张图的 ${totalGroups} 个对象组 / ${totalObjects} 个对象`,
  );
  console.log("下一步：node tools/import-map-resources.cjs → make config-export");
  console.log("       重新分卷后：python3 client/tools/resources_sync.py manifest（沿用原版本号）");
}

main();
