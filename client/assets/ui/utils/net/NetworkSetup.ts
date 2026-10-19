import GameUiHelper from "../../helpers/GameUiHelper";
import SceneManager from "../../core/SceneManager";
import { describeError } from "./ApiError";
import HttpClient from "./HttpClient";
import Session from "./Session";

let installed = false;

/**
 * 当前页面的来源（诊断用）
 *
 * 失败日志里带上它，才能区分「编辑器内预览（`packages://scene`）」「浏览器预览（`7456`）」「线上部署」——
 * 这三种环境下 baseUrl 的解析结果完全不同，只看 kind/status 定位不了问题。
 * `file://` 页面的 origin 是字符串 "null"（不透明来源），这本身就是有用信息。
 */
function describeOrigin(): string {
  const scope = globalThis as unknown as { location?: { origin?: string; href?: string } };
  return scope.location?.origin ?? scope.location?.href ?? "no-location";
}

/**
 * 网络层全局接线（**幂等**：多个场景都调也只生效一次）
 *
 * 请求层刻意不认识「场景」和「飘字」——它们是界面的事，所以在这一个地方接上：
 * - 需要重新登录（令牌过期 / 非法 / 账号被封禁）→ 清会话 + 回登录场景
 * - 请求失败 → 统一飘字提示（各业务只负责恢复自己的按钮/状态，不再各自提示，避免重复刷屏）
 *
 * 调用时机：登录场景与游戏场景启动时各调一次（见 ui/Login.start、ui/Game.start）。
 */
export function installNetwork() {
  if (installed) return;
  installed = true;

  HttpClient.setUnauthorizedHandler(() => {
    Session.clear();
    SceneManager.loadScene("Login");
  });

  HttpClient.setFailureHandler((error) => {
    // 地址与来源都要打：只报 kind/status 的话，「请求打到哪了」只能靠猜（见 ApiError.url 注释）。
    // 注意保持 console.warn 与文案同一行：配置外泄审计把「含 console. 的行」当作开发期日志放行，
    // 拆行会让模板串单独成行而被判成「中文文案硬编码」（tools/audit-config-leak.cjs 的 cn 规则）。
    console.warn(`[net] 请求失败：kind=${error.kind} url=${error.url ?? "?"} code=${error.code} status=${error.status} origin=${describeOrigin()}`);
    GameUiHelper.createErrorTipText(describeError(error));
  });
}
