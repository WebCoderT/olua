#!/usr/bin/env node
/** 测试源码读取兼容层：configs/layout/dialogs.ts 已按域拆到 configs/layout/dialogs/（#1115 批次 2）。
 *  断言需要「原 dialogs.ts 全部源码」时用它：传入指向旧 dialogs.ts 的路径或新 dialogs 目录，
 *  返回 index + 全部域文件拼接后的源码字符串（排序稳定）。 */
const fs = require("fs");
const path = require("path");

function dialogsSourceFor(dialogsPath) {
  const dir = fs.existsSync(dialogsPath) && fs.statSync(dialogsPath).isDirectory()
    ? dialogsPath
    : path.join(path.dirname(dialogsPath), "dialogs");
  return fs
    .readdirSync(dir)
    .filter((x) => x.endsWith(".ts"))
    .sort()
    .map((x) => fs.readFileSync(path.join(dir, x), "utf8"))
    .join("\n");
}

module.exports = { dialogsSourceFor };
