#!/usr/bin/env node
/** 测试源码读取兼容层：GameUiHelper.ts 已按域拆到 helpers/parts/（#1115 批次 1）。
 *  断言需要「原类全部源码」时用它：传入原 GameUiHelper.ts 的绝对路径，
 *  返回 barrel + 全部 parts/*.ts 拼接后的源码字符串（排序稳定）。 */
const fs = require("fs");
const path = require("path");

function partsSourceFor(helperTsPath) {
  const base = path.dirname(helperTsPath);
  const dir = path.join(base, "parts");
  return [
    fs.readFileSync(helperTsPath, "utf8"),
    ...fs
      .readdirSync(dir)
      .filter((x) => x.endsWith(".ts"))
      .sort()
      .map((x) => fs.readFileSync(path.join(dir, x), "utf8")),
  ].join("\n");
}

module.exports = { partsSourceFor };
