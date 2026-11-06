#!/usr/bin/env node
/**
 * 生成客户端素材的**图片清单**（`client/assets/resources/image-manifest.json`）
 *
 * 为什么需要它：管理端的图片选择器（`admin/src/components/ImagePicker.tsx`）要「有哪些图可选」。
 * 开发期由 vite 中间件的 `/game-resources/__list` 直接扫盘（素材一放进来就能选，无需本工具）；
 * **生产是 nginx 静态反代，没有任何目录列表能力** —— 只能读一份预先落盘的清单。
 *
 * 清单放在 `client/assets/resources/` 里面（而不是仓库根）是刻意的：
 * 它跟着 `/game-resources/` 同一个根走，dev 由中间件读、prod 由 nginx 反代 game 容器，
 * 页面代码只有一条 URL。resources 目录本身不入库（`make resources-*` 分发），
 * 所以这份清单也随资源包一起走 —— 换机器 / 更新素材后重跑本脚本即可。
 *
 * 形状与 dev 的 `__list` 响应逐字段一致：`{ dir, images }`（外加 generatedAt 便于排查陈旧清单）。
 * `images` 里的路径相对 resources 根、posix 分隔、**不带扩展名** —— 与数据库 `icon` 字段
 * 的写法一致（客户端取图统一补 `.png`，见 admin `gameResUrl`）。
 *
 * 用法：node tools/gen-image-manifest.cjs   （或 make image-manifest）
 *
 * #680 起它同时产出**音效清单** `audio-manifest.json`（`{ dir: "audio", files }`，带扩展名）：
 * 音效配置页的「选文件」在生产环境也要有数据源，道理与图片选择器一样。两个文件一起生成，
 * 免得出现「图片清单刷新了、音效清单还是旧的」。
 */

const fs = require("node:fs");
const path = require("node:path");

const RESOURCES = path.resolve(__dirname, "../client/assets/resources");
const OUTPUT = path.join(RESOURCES, "image-manifest.json");
const IMAGE_EXTS = [".png", ".jpg", ".jpeg"];

/**
 * 音效清单（#680，`audio-manifest.json`）
 *
 * 音效配置页要「有哪些音频可选」，生产同样没有目录列表能力 —— 与图片清单一个道理。
 * 形状是 `{ generatedAt, dir: "audio", files }`，`files` **带扩展名**：数据库 `file_path`
 * 存的就是 `audio/login-bg.wav` 这种带扩展名的相对路径，选择器拿到就能直接存。
 * 开发期不依赖这份清单（vite 中间件扫盘 `?audio=1`），它只为生产准备。
 */
const AUDIO_OUTPUT = path.join(RESOURCES, "audio-manifest.json");
const AUDIO_EXTS = [".wav", ".mp3", ".ogg", ".m4a"];
const AUDIO_DIR = "audio";

function collect(dir) {
  const images = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!IMAGE_EXTS.includes(ext)) continue;
      const relative = path.relative(RESOURCES, full).split(path.sep).join("/");
      images.push(relative.slice(0, -ext.length));
    }
  };
  walk(dir);
  images.sort();
  return images;
}

function main() {
  if (!fs.existsSync(RESOURCES)) {
    console.error(`素材目录不存在：${RESOURCES}`);
    console.error("先按 README「资源同步」拉资源（make resources-download VERSION=<v>）");
    process.exit(1);
  }
  const images = collect(RESOURCES);
  const payload = {
    generatedAt: new Date().toISOString(),
    dir: "",
    images,
  };
  fs.writeFileSync(OUTPUT, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  // 按顶层目录报一下数量：素材更新后「清单是不是旧的」一眼能看出来
  const counts = new Map();
  for (const image of images) {
    const top = image.includes("/") ? image.split("/")[0] : "(根)";
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  const summary = [...counts.entries()].map(([dir, count]) => `${dir} ${count}`).join(" · ");
  console.log(`图片清单已生成：${path.relative(process.cwd(), OUTPUT)}（共 ${images.length} 张）`);
  console.log(`  ${summary}`);

  // 音效清单：只扫 audio/（音效就该放这儿），带扩展名
  const audioDir = path.join(RESOURCES, AUDIO_DIR);
  const files = fs.existsSync(audioDir)
    ? fs
        .readdirSync(audioDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && AUDIO_EXTS.includes(path.extname(entry.name).toLowerCase()))
        .map((entry) => `${AUDIO_DIR}/${entry.name}`)
        .sort()
    : [];
  fs.writeFileSync(
    AUDIO_OUTPUT,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), dir: AUDIO_DIR, files }, null, 2)}\n`,
    "utf8",
  );
  console.log(`音效清单已生成：${path.relative(process.cwd(), AUDIO_OUTPUT)}（共 ${files.length} 个）`);
  for (const file of files) console.log(`  ${file}`);
}

main();
