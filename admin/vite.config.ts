import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import type { Plugin } from "vite";

/** 客户端素材目录（装备对齐工作台要读图集） */
const RESOURCES = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../client/assets/resources");

/** 图片清单接口里出现的扩展名（选择器只认这几种；`.meta` 不会命中） */
const IMAGE_EXTS = [".png", ".jpg", ".jpeg"];

/**
 * 递归收集图片（path 相对 RESOURCES，posix 分隔，不带扩展名）
 *
 * 返回形状与生产用的 `image-manifest.json` **完全一致** —— 选择器组件对两个来源
 * 用同一段解析代码，不会出现「dev 能用、prod 少字段」。
 */
function collectImages(dir: string): string[] {
  const images: string[] = [];
  const walk = (current: string) => {
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

/**
 * 开发期把客户端素材挂到 `/game-resources` 下
 *
 * 对齐工作台要读 `clothes/out/005/stand/stand.{png,plist}` 这类文件（#542 起图集与散帧同路径）。
 * 生产由管理端 nginx 反代到 game 容器（**同源**：canvas 才不会被污染、`getImageData` 才可用）；
 * 开发期没有 nginx，就在这里直读本地素材 —— 两边是同一个 URL 前缀，
 * 页面代码不需要为环境分支，也就不会出现「本地调好了、部署上去 404」。
 *
 * 另外提供一个 `GET /game-resources/__list[?dir=item]`：图片选择器（`components/ImagePicker`）
 * 要「有哪些图可选」，而生产是 nginx 静态反代、没有目录列表能力 —— 那边读生成物
 * `resources/image-manifest.json`（`make image-manifest`），这里直接扫盘，**素材一放进来就能选**，
 * 不需要先重新生成清单。两个来源的 JSON 形状相同（见 `collectImages`）。
 */
function gameResources(): Plugin {
  return {
    name: "olua-game-resources",
    configureServer(server) {
      server.middlewares.use("/game-resources", (req, res) => {
        const rawUrl = req.url ?? "";
        const relative = decodeURIComponent(rawUrl.split("?")[0]);

        // 目录列表（仅 dev）：`/__list` 或 `/__list?dir=<resources 相对目录>`
        if (relative === "/__list" || relative.startsWith("/__list/")) {
          const dir = (new URL(rawUrl, "http://local").searchParams.get("dir") ?? "").replace(/^\/+|\/+$/g, "");
          const base = path.resolve(RESOURCES, `.${dir ? `/${dir}` : ""}`);
          // 目录穿越防护：同下面的文件分支
          if (base !== RESOURCES && !base.startsWith(RESOURCES + path.sep)) {
            res.statusCode = 403;
            res.end("forbidden");
            return;
          }
          if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
            res.statusCode = 404;
            res.end("not found");
            return;
          }
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ dir, images: collectImages(base) }));
          return;
        }

        const file = path.resolve(RESOURCES, `.${relative}`);
        // 目录穿越防护：拼出来的路径必须还在 resources 下面
        if (!file.startsWith(RESOURCES)) {
          res.statusCode = 403;
          res.end("forbidden");
          return;
        }
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
          res.statusCode = 404;
          res.end("not found");
          return;
        }
        const type = file.endsWith(".png")
          ? "image/png"
          : file.endsWith(".json")
            ? "application/json"
            : file.endsWith(".plist")
              ? "application/xml"
              : "application/octet-stream";
        res.setHeader("Content-Type", type);
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}

/**
 * 管理端构建配置
 *
 * 后端地址**不在这里**：它在 .env 的 VITE_API_BASE_URL 里（见 src/api/config.ts）。
 * 这里只管前端自己的构建与预览。
 */
export default defineConfig({
  plugins: [react(), tailwindcss(), gameResources()],
  // 开发服务器要允许读**项目外**的文件：游戏数据引用的是 `../server/src/shared/game-data.generated.ts`
  // （三端共用的那一份，见 src/api/gameData.ts），不放行的话 dev 模式会 403。
  // 构建（rollup）不受这条限制，它只影响 `npm run dev`。
  server: {
    fs: { allow: [".."] },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
