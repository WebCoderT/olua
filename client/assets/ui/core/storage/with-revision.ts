import { Role } from "../../../entities/Role";

/**
 * 乐观锁请求壳（#1115 批次 6）：「带上修订号发请求 → 失败返回 null（提示已由请求层弹过）→
 * 成功对齐本地基线 revision」三步收成一处 —— 各调用点只报「调哪个接口、传什么业务参数」。
 */
export async function withRevision<T extends { revision: number }>(
  role: Role,
  op: (revision: number) => Promise<T>,
): Promise<T | null> {
  try {
    // 修订号带上做乐观锁：后台改过这个角色时（20006）服务端拒绝这次操作
    const result = await op(role.revision);
    role.revision = result.revision;
    return result;
  } catch {
    return null; // 失败提示已由请求层弹过（非 silent 请求）
  }
}


