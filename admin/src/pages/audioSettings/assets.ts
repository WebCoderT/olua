/**
 * 音效配置页的**静态素材读取**（#680）
 *
 * 为什么单独一个文件：管理端有一条硬性纪律 —— 请求只能从 `api/http.ts` 发出
 * （`tools/audit-api-hardcode.cjs` 盯着）。音频清单与目录列表是**静态素材**读取，
 * 不碰 `/api`、不带令牌，与 `pages/equipAlign/assets.ts`、`components/ImagePicker.tsx`
 * 同一类，所以在这里集中放行（审计的 `adminAssets` 白名单登记了本文件）。
 *
 * 放进白名单的代价是「这里可以随便发请求」，所以本文件**只允许读 `/game-resources/` 下的东西**：
 * 任何接口调用都该走 `api/`，不要图省事加到这里。
 */

/** 资源根（开发期由 vite 中间件挂，生产由管理端 nginx 反代 game 容器）；末尾不带斜杠 */
export const DEFAULT_RES_ROOT = "/game-resources";

/** 音效文件所在目录（resources 相对；用户定：音效都放 audio/） */
export const AUDIO_ROOT = "audio";

/**
 * 拼一个可试听的地址
 *
 * 只做字符串拼接：`resRoot` 末尾的斜杠去掉，路径原样接上。换资源根（本地直连游戏站）时
 * 页面只改这一个入参，别处不再拼地址。
 */
export function audioUrlOf(resRoot: string, filePath: string): string {
  return `${resRoot.trim().replace(/\/+$/, "")}/${filePath.replace(/^\/+/, "")}`;
}

/**
 * 可选的音频文件清单（带扩展名，如 `audio/login-bg.wav`）
 *
 * 两个来源同形状（与图片选择器一个道理）：
 * 1. **生产**：`audio-manifest.json`（`make image-manifest` 一并生成，随资源包走）；
 * 2. **开发**：vite 中间件的 `/__list?dir=sounds&audio=1`（直接扫盘，素材一放进来就能选）。
 *
 * 都拿不到就返回空数组 —— 选择器降级成「手填路径 + 试听确认」，不阻塞配置。
 */
export async function loadAudioFiles(): Promise<string[]> {
  try {
    const manifest = await fetch(`${DEFAULT_RES_ROOT}/audio-manifest.json`);
    if (manifest.ok) {
      const payload = (await manifest.json()) as { files?: unknown };
      if (Array.isArray(payload.files)) return payload.files.filter((item): item is string => typeof item === "string");
    }
  } catch {
    /* 生产清单不在（或不是 dev 服务器）—— 继续试扫盘接口 */
  }
  try {
    const listing = await fetch(`${DEFAULT_RES_ROOT}/__list?dir=${AUDIO_ROOT}&audio=1`);
    if (listing.ok) {
      const payload = (await listing.json()) as { files?: unknown };
      if (Array.isArray(payload.files)) return payload.files.filter((item): item is string => typeof item === "string");
    }
  } catch {
    /* 生产环境没有目录列表能力 —— 降级为手填 */
  }
  return [];
}
