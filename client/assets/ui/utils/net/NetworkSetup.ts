import GameUiHelper from "../../helpers/GameUiHelper";
import SceneManager from "../../core/SceneManager";
import { describeError } from "./ApiError";
import HttpClient from "./HttpClient";
import Session from "./Session";

let installed = false;

/**
 * 回到登录场景：清本地会话 + 跳登录。
 * 两条路共用这一个出口：选角界面底部栏的「返回登录」按钮（主动退出）、
 * 请求层判定需要重新登录（令牌过期 / 非法 / 账号被封禁，见下方 unauthorizedHandler）。
 */
export function returnToLogin() {
  Session.clear();
  SceneManager.loadScene("Login");
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

  HttpClient.setUnauthorizedHandler(() => returnToLogin());

  HttpClient.setFailureHandler((error) => {
    console.warn(`[net] 请求失败：${error.kind} code=${error.code} status=${error.status}`);
    GameUiHelper.createErrorTipText(describeError(error));
  });
}
