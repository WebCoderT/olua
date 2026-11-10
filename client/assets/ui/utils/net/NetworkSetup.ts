import GameUiHelper from "../../helpers/GameUiHelper";
import SceneManager from "../../core/SceneManager";
import { AuthApi } from "./Api";
import { describeError } from "./ApiError";
import HttpClient from "./HttpClient";
import Session from "./Session";

let installed = false;

/** 主动退出期间不再响应「需要重登」兜底（见 `logoutToLogin`） */
let leaving = false;

/**
 * 回到登录场景：清本地会话 + 跳登录。
 * 两条路共用这一个出口：选角界面底部栏的「返回登录」按钮（主动退出，走 `logoutToLogin`）、
 * 请求层判定需要重新登录（令牌过期 / 非法 / 账号被封禁，见下方 unauthorizedHandler）。
 */
export function returnToLogin() {
  Session.clear();
  SceneManager.loadScene("Login");
}

/**
 * 主动退出登录（#880）：**先**发一次吊销请求，**再**清本地会话 + 回登录
 *
 * 顺序不能反 —— `returnToLogin()` 里 `Session.clear()` 一执行就没有令牌可发了。
 * 发出去之后不等结果：网络不通也要让人退得出去（本地清了，这个令牌在本机不再被使用；
 * 服务端那份最坏留到过期，比「点退出没反应」好）。
 *
 * `silent` 只关掉飘字，不关「需要重登」的兜底 —— 但这条请求本来就由主动退出触发，
 * 所以用 `leaving` 挡一下，避免「401 又调一次 returnToLogin」把登录场景重载一遍。
 */
export function logoutToLogin() {
  leaving = true;
  // 不等结果，但**两个分支都要把开关放回去** —— 否则这个账号之后每次 401 都不再回登录场景
  AuthApi.logout({ silent: true }).then(clearLeaving, clearLeaving);
  returnToLogin();
}

/** 吊销请求收尾（成功或失败）：把「主动退出中」的开关放回去 */
function clearLeaving() {
  leaving = false;
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
    // 主动退出时这条兜底不用再跑一遍：人已经在回登录的路上了（见 `logoutToLogin`）
    if (leaving) return;
    returnToLogin();
  });

  HttpClient.setFailureHandler((error) => {
    console.warn(`[net] 请求失败：${error.kind} code=${error.code} status=${error.status}`);
    GameUiHelper.createErrorTipText(describeError(error));
  });
}
