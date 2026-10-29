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
 *
 * 两种图集（#523 起）：
 * - **外观**（`clothes/atlas/out/005`）：按方向排的站立帧，固定拼 `/stand/stand`；
 * - **内观**（`clothes/in/005`）：循环动画帧（`00000.PNG`…），路径本身就是文件基名，**没有子目录**。
 */

import type { Atlas, SolidBox } from "./atlas";
import { parseAtlasPlist } from "./atlas";

/** 服务端明确答复「没有这个文件」的三种状态（其它失败一律当环境问题，不标缺素材） */
const MISSING_STATUS = new Set([403, 404, 410]);

function joinBase(resRoot: string, subPath: string): string {
  return `${resRoot.replace(/\/+$/, "")}/${subPath.replace(/^\/+/, "")}`;
}

/** 把资源根与图集目录拼成站立的 plist / png 地址 */
export function atlasUrls(resRoot: string, atlasPath: string): { plist: string; png: string } {
  const base = `${joinBase(resRoot, atlasPath)}/stand/stand`;
  return { plist: `${base}.plist`, png: `${base}.png` };
}

/**
 * 内观图集的地址（#523）
 *
 * 内观素材是**一个路径对应一对文件**（`clothes/in/005` + `.plist` / `.png`），没有
 * `stand/stand` 这层目录 —— 它是循环动画的一串帧（`00000.PNG`、`00001.PNG`…），
 * 不是按方向排的站立帧。拼法必须和客户端 `AnimationHelper.playLoopAtlasWithDuration` 一致。
 */
export function inAtlasUrls(resRoot: string, inPath: string): { plist: string; png: string } {
  const base = joinBase(resRoot, inPath);
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
  return probeUrl(atlasUrls(resRoot, atlasPath).plist);
}

/** 探一张内观图集在不在（规则同 `probeAtlas`，只是路径拼法不同） */
export async function probeInAtlas(resRoot: string, inPath: string): Promise<boolean> {
  if (!inPath) return false;
  return probeUrl(inAtlasUrls(resRoot, inPath).plist);
}

async function probeUrl(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: "HEAD", cache: "no-store" });
    return !MISSING_STATUS.has(response.status);
  } catch {
    return true;
  }
}

/** 加载一张站立图集（plist 与 png 并行取） */
export async function loadAtlas(resRoot: string, atlasPath: string): Promise<Atlas> {
  return loadAtlasFrom(atlasUrls(resRoot, atlasPath));
}

/** 加载一张内观图集（单个 plist + png，帧名是 `00000.PNG` 这种循环动画帧） */
export async function loadInAtlas(resRoot: string, inPath: string): Promise<Atlas> {
  return loadAtlasFrom(inAtlasUrls(resRoot, inPath));
}

async function loadAtlasFrom({ plist, png }: { plist: string; png: string }): Promise<Atlas> {
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
