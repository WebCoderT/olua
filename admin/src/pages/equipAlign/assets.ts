/**
 * 素材加载（图集 plist + png）
 *
 * ===========================================================================
 * 为什么单独一个文件
 * ===========================================================================
 * 这里要 `fetch` 一个静态文件（`.plist`），而管理端的「请求只能从 api/http.ts 发出」这条
 * 审计规则（`tools/audit-api-hardcode.cjs`）不区分「静态素材」与「接口」。
 * 与其给整个页面开豁免（那以后有人在页面里写接口请求就查不出来了），不如把素材读取收在这一个文件里，
 * **只放行它**：本文件不碰任何 `/api` 路径、不带令牌、不解析业务错误码。
 *
 * 另外它承担「资源根」的拼接：生产走 admin nginx 的 `/game-resources/`（同源反代到 game 容器），
 * 开发走 vite 中间件（`admin/vite.config.ts`），两边是同一个 URL 前缀。
 */

import type { Atlas, SolidBox } from "./atlas";
import { parseAtlasPlist } from "./atlas";

/** 服务端明确答复「没有这个文件」的三种状态（其它失败一律当环境问题，不标缺素材） */
const MISSING_STATUS = new Set([403, 404, 410]);

/** 把资源根与图集目录拼成站立的 plist / png 地址 */
export function atlasUrls(resRoot: string, atlasPath: string): { plist: string; png: string } {
  const base = `${resRoot.replace(/\/+$/, "")}/${atlasPath.replace(/^\/+/, "")}/stand/stand`;
  return { plist: `${base}.plist`, png: `${base}.png` };
}

/**
 * 探一张站立图集在不在（列表上的「缺素材」标记）
 *
 * 这件事**不能写进生成的清单**：`client/assets/resources/` 是 gitignore 的（素材走
 * GitHub Release 分发），同一份配置在装了素材的机器上和在 CI 上答案不同 —— 那会让
 * 「重生成 + 逐字节比对」的守点变成必然假红。所以放到运行时，永远反映当前资源根。
 *
 * `HEAD` 就够：只问「有没有」，不要正文。`cache: "no-store"` 是为了切资源根后不读到旧结论。
 *
 * **只有「确实没有」才算缺**：404 / 403 / 410 是服务端明确答复没有这个文件；
 * 连不上、超时、5xx 之类的失败一律当「有」—— 那是环境问题，标成「缺素材」只会
 * 让人去查素材，方向就错了。
 */
export async function probeAtlas(resRoot: string, atlasPath: string): Promise<boolean> {
  if (!atlasPath) return false;
  try {
    const response = await fetch(atlasUrls(resRoot, atlasPath).plist, { method: "HEAD", cache: "no-store" });
    return !MISSING_STATUS.has(response.status);
  } catch {
    return true;
  }
}

/** 加载一张站立图集（plist 与 png 并行取） */
export async function loadAtlas(resRoot: string, atlasPath: string): Promise<Atlas> {
  const { plist, png } = atlasUrls(resRoot, atlasPath);
  const [plistText, image] = await Promise.all([
    fetch(plist).then((response) => {
      if (!response.ok) throw new Error(`读取 ${plist} 失败（HTTP ${response.status}）`);
      return response.text();
    }),
    new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`读取 ${png} 失败（检查「资源根」是否指到游戏站的 resources）`));
      img.src = png;
    }),
  ]);
  return { image, frames: parseAtlasPlist(plistText), solid: new Map<string, SolidBox | null>() };
}
