import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import type { Plugin } from "vite";

/** 客户端素材目录（装备对齐工作台要读图集） */
const RESOURCES = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../client/assets/resources");

/**
 * 开发期把客户端素材挂到 `/game-resources` 下
 *
 * 对齐工作台要读 `clothes/atlas/out/005/stand/stand.{png,plist}` 这类文件。
 * 生产由管理端 nginx 反代到 game 容器（**同源**：canvas 才不会被污染、`getImageData` 才可用）；
 * 开发期没有 nginx，就在这里直读本地素材 —— 两边是同一个 URL 前缀，
 * 页面代码不需要为环境分支，也就不会出现「本地调好了、部署上去 404」。
 */
function gameResources(): Plugin {
  return {
    name: "olua-game-resources",
    configureServer(server) {
      server.middlewares.use("/game-resources", (req, res) => {
        const relative = decodeURIComponent((req.url ?? "").split("?")[0]);
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
        const type = file.endsWith(".png") ? "image/png" : file.endsWith(".plist") ? "application/xml" : "application/octet-stream";
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
