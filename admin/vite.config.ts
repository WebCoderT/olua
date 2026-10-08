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
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
