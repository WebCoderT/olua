import { STORAGE_KEYS } from "../api/config";
import type { AdminInfo } from "../api";

/**
 * 管理端会话（令牌 + 管理员信息）
 *
 * 只做「本地存读」，不发请求、不认识路由 —— 这样 http 层可以放心依赖它而不会成环。
 * localStorage 在隐私模式下可能不可用，故所有读写都包一层 try/catch（失败即当作未登录）。
 */
function safeGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* 存不进去就算了：本次会话仍能用内存里的值 */
  }
}

function safeRemove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function readToken(): string | null {
  return safeGet(STORAGE_KEYS.token);
}

/**
 * 会话变化订阅（登录态 / 管理员信息变了就通知一次）
 *
 * 场景：在「我的账号」里改完自己的密码，服务端会返回**新令牌**（旧令牌当场失效），
 * 换令牌的同时角色与权限点可能也变了 —— 顶部身份栏要跟着刷新，而不是留到下次刷新页面。
 * 返回取消订阅函数（组件卸载时调）。
 */
type SessionListener = (admin: AdminInfo | null) => void;
const listeners = new Set<SessionListener>();

export function subscribeSession(listener: SessionListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emitSession(admin: AdminInfo | null): void {
  for (const listener of listeners) listener(admin);
}

export function saveSession(token: string, admin: AdminInfo): void {
  safeSet(STORAGE_KEYS.token, token);
  safeSet(STORAGE_KEYS.profile, JSON.stringify(admin));
  emitSession(admin);
}

export function readAdmin(): AdminInfo | null {
  const raw = safeGet(STORAGE_KEYS.profile);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AdminInfo;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  safeRemove(STORAGE_KEYS.token);
  safeRemove(STORAGE_KEYS.profile);
  emitSession(null);
}

export function isLoggedIn(): boolean {
  return Boolean(readToken());
}

/**
 * 当前会话的权限点
 *
 * 老版本存的会话可能没有 permissions 字段 → 兜底成空数组（**最小权限**：
 * 界面上不显示任何写操作，但请求仍会照发，由服务端给出权威判定）。
 */
export function readPermissions(): string[] {
  const admin = readAdmin();
  return Array.isArray(admin?.permissions) ? admin.permissions : [];
}

/** 是否拥有某个权限点（用于界面显隐；服务端仍会独立校验） */
export function hasPermission(permission: string): boolean {
  return readPermissions().includes(permission);
}

/** 是否拥有全部列出的权限点 */
export function hasAllPermissions(...permissions: string[]): boolean {
  const owned = readPermissions();
  return permissions.every((item) => owned.includes(item));
}
