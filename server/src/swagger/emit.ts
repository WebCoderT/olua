import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AppModule } from "../app.module";
import { buildSwaggerDocument } from "./setup";

/**
 * 把 OpenAPI 文档落成 `server/openapi.json`（**接口文件的唯一来源**）
 *
 * 跑法：`npm run swagger:emit`（或 `npm run gen:api` 一并生成三端代码）。
 * 脚本会先 `tsc` 再用 `dist/swagger/emit.js` 跑 —— 与 e2e 一样走编译产物，
 * 免得「文档是从源码跑的、接口是从 dist 跑的」这种两套口径。
 *
 * 为什么要落成文件而不是让生成器去连服务端拉 `/api-docs-json`：
 * 生成必须**离线、可重复、可 diff** —— 拉线上文档会因为「本地跑的是哪个版本」而漂，
 * 落成文件进版本库后，接口改没改在 `git diff` 里一目了然，也能被守卫脚本比对。
 *
 * 这里刻意用内存库（DB_PATH=:memory:）：只为拿到路由与 DTO 元数据，不需要真数据，
 * 更不能因为生成文档而在仓库里建出一个 .db 文件。
 */
async function main() {
  process.env.DB_PATH = process.env.DB_PATH ?? ":memory:";
  process.env.LOG_REQUESTS = "false";

  const app = await NestFactory.create(AppModule, { logger: false });
  await app.init();
  const document = buildSwaggerDocument(app);
  await app.close();

  const target = join(__dirname, "..", "..", "openapi.json");
  writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, "utf8");

  const paths = Object.keys(document.paths ?? {}).length;
  const schemas = Object.keys((document.components ?? {}).schemas ?? {}).length;
  console.log(`已生成 OpenAPI 文档：${target}`);
  console.log(`  路径 ${paths} 条 / 模型 ${schemas} 个`);
}

void main();
