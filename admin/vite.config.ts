import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * 管理端构建配置
 *
 * 后端地址**不在这里**：它在 .env 的 VITE_API_BASE_URL 里（见 src/api/config.ts）。
 * 这里只管前端自己的构建与预览。
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
