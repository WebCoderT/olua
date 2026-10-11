#!/usr/bin/env node
/**
 * 把 Cocos Creator 编辑器产物 + 引擎内置声明，整理成 CI 可用的「相对路径」版本。
 *
 * 为什么需要它（见根 FAQ「为什么 CI 不覆盖客户端」）：
 *   `make client-check` 通过 client/tools/tsconfig.check.json 的 `types` 引用
 *   client/temp/declarations/{cc,cc.custom-macro,jsb,cc.env}.d.ts。其中 cc.d.ts /
 *   jsb.d.ts 里的 `/// <reference path="..."/>` 指向**本机 Cocos 安装的绝对路径**，
 *   而 client/temp/ 在 .gitignore 里、CI 上也没有 Cocos。所以这些声明无法进版本库。
 *
 *   本脚本在「本机用 Cocos Creator 打开过 client/ 之后」运行，把声明复制进
 *   client/types/engine/（已入库、不在 .gitignore），并把绝对路径改写成相对路径，
 *   于是 CI 用同样的类型面做 tsc，无需编辑器。
 *
 * 升级 Cocos 后重新生成：打开新版本编辑器 → 跑 `make client-gen-declarations`。
 *
 * 环境变量：
 *   COCOS_CREATOR_PATH  CocosCreator.app 路径（默认 macOS 装法）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const clientDir = path.resolve(__dirname, '..');
const tempDecl = path.join(clientDir, 'temp', 'declarations');
const outDir = path.join(clientDir, 'types', 'engine');

const REF_RE = /\/\/\/\s*<reference\s+path="([^"]+)"\s*\/>/;

function copyWithRewrittenRef(srcName, outName, relTarget) {
  const src = path.join(tempDecl, srcName);
  if (!fs.existsSync(src)) {
    throw new Error(`找不到 ${src} —— 请先用 Cocos Creator 打开 client/ 工程，让它生成 client/temp/declarations/`);
  }
  let text = fs.readFileSync(src, 'utf8');
  const m = text.match(REF_RE);
  if (m) {
    const absEngineFile = m[1];
    if (!fs.existsSync(absEngineFile)) {
      throw new Error(`shim ${srcName} 引用的引擎声明不存在：${absEngineFile}`);
    }
    fs.mkdirSync(outDir, { recursive: true });
    fs.copyFileSync(absEngineFile, path.join(outDir, relTarget));
    // 把绝对路径改写成相对路径，让 CI 能找到
    text = text.replace(REF_RE, `/// <reference path="./${relTarget}"/>`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, outName), text);
  console.log(`  ✓ ${outName}`);
}

function copyAsIs(srcName, outName) {
  const src = path.join(tempDecl, srcName);
  if (!fs.existsSync(src)) {
    throw new Error(`找不到 ${src} —— 请先用 Cocos Creator 打开 client/ 工程`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(src, path.join(outDir, outName));
  console.log(`  ✓ ${outName}`);
}

console.log('==> 生成 client/types/engine/（CI 用的 Cocos 类型声明）');
copyWithRewrittenRef('cc.d.ts', 'cc.d.ts', 'cc-engine.d.ts');
copyWithRewrittenRef('jsb.d.ts', 'jsb.d.ts', 'jsb-engine.d.ts');
copyAsIs('cc.custom-macro.d.ts', 'cc.custom-macro.d.ts');
copyAsIs('cc.env.d.ts', 'cc.env.d.ts');
console.log('  完成。已把绝对路径改为相对路径，CI 无需 Cocos 编辑器。');
