import { BizCode } from "../../common/constants/biz-code";
import { BizException } from "../../common/errors/biz.exception";

/**
 * 存档结构版本与迁移链（#818 / B60）
 *
 * 存档（`roles.data` 那份 JSON）此前**没有版本号**：任何字段改名 / 改结构，只能靠读口
 * `??` 兜底 —— 兜错了是静默错数（把错数当对数用），而且没有回滚余地。
 * 这个文件是「版本号 + 迁移链」的唯一来源：
 *
 * | 版本 | 含义 |
 * |---|---|
 * | 1 | 无版本号的存量老档（本字段上线前的全部存档，缺字段即按 1 处理） |
 * | 2 | 存档里带 `schemaVersion`（1→2 只盖章，不动任何字段） |
 * | 3 | **预留**给 C1「删元宝 / 银子、金币不可流通」（设计见 33 篇 3.4） |
 *
 * ## 加一环的纪律
 *
 * 1. 每环只做「从 N 到 N+1」的形状变换，并且**幂等**（链条重跑无害）；
 * 2. 版本号由链条统一盖（`apply` 不要自己写 `schemaVersion`），这样漏写也坏不了链；
 * 3. 上线前必须有 fixture 测试（33 篇 3.2）—— 「迁移把金币清零」是唯一上线前发现不了的事故；
 * 4. **只有形状变了才加版本**：纯粹新增可选字段不用升版本（缺字段本来就能读）。
 */
export const ROLE_DATA_VERSION = 2;
/** 缺版本号的老档按 1 算（`schemaVersionOf` 的唯一兜底） */
export const ROLE_DATA_LEGACY_VERSION = 1;

/** 一环迁移：`from` → `from + 1`，只改形状、不盖版本号 */
interface RoleDataMigration {
  readonly from: number;
  readonly to: number;
  readonly apply: (data: Record<string, unknown>) => Record<string, unknown>;
}

const ROLE_DATA_MIGRATIONS: readonly RoleDataMigration[] = [
  {
    from: 1,
    to: 2,
    // v1 → v2 没有形状变化：v2 的唯一新增就是版本号本身（由链条统一盖）。
    // 「空链也要建」（33 篇 8①）—— 框架先立起来，C1 的 2→3 才有地方挂
    apply: (data) => data,
  },
];

/**
 * 读存档里的版本号
 *
 * 缺字段 / 字符串 / `NaN` / 0 / 负数一律当 1（33 篇边界 6）：老档没有这个字段，
 * 而能写出这种脏值的只有手工改库 —— 当成最老的一版去迁，比抛错更能救回来。
 */
export function schemaVersionOf(data: Record<string, unknown>): number {
  const raw = Number(data.schemaVersion);
  return Number.isInteger(raw) && raw >= ROLE_DATA_LEGACY_VERSION ? raw : ROLE_DATA_LEGACY_VERSION;
}

export interface RoleMigrationOutcome {
  data: Record<string, unknown>;
  /** 迁移前的版本 */
  from: number;
  /** 迁移后的版本（成功时恒等于 `ROLE_DATA_VERSION`） */
  to: number;
  /** 是否真的走了一步 —— 写库只在这个为 true 时发生 */
  migrated: boolean;
}

/**
 * 把一份存档迁到当前版本（纯内存，不碰库）
 *
 * 三种结局：
 * - 已经是当前版本 → 原样返回（`migrated: false`），这是绝大多数调用；
 * - 落后 → 顺序跑链，返回迁移后的**新对象**；
 * - 迁移不动（版本比代码新 / 链缺环）→ 抛 20028。
 *
 * **版本比代码新也要拒**：那意味着回滚发布（库里的档是更新版本的代码写的），
 * 按老形状去读会把新字段当未知键静默丢掉，下一次存档就把它写没了。
 */
export function migrateRoleData(input: Record<string, unknown>): RoleMigrationOutcome {
  const from = schemaVersionOf(input);
  if (from === ROLE_DATA_VERSION) return { data: input, from, to: from, migrated: false };
  if (from > ROLE_DATA_VERSION) {
    throw BizException.conflict(
      BizCode.ROLE_DATA_VERSION_MISMATCH,
      `存档版本（${from}）高于服务器当前版本（${ROLE_DATA_VERSION}），请联系客服`,
    );
  }
  let data = input;
  let version = from;
  // 上限 = 链长：链条缺环时靠它跳出，绝不让一个坏链条把登录卡成死循环
  for (let step = 0; step < ROLE_DATA_MIGRATIONS.length; step++) {
    const migration = ROLE_DATA_MIGRATIONS.find((item) => item.from === version);
    if (!migration) break;
    data = { ...migration.apply(data), schemaVersion: migration.to };
    version = migration.to;
  }
  if (version !== ROLE_DATA_VERSION) {
    throw BizException.conflict(
      BizCode.ROLE_DATA_VERSION_MISMATCH,
      `存档版本（${from}）无法迁移到当前版本（${ROLE_DATA_VERSION}），请联系客服`,
    );
  }
  return { data, from, to: version, migrated: true };
}

/**
 * 链条自检：必须是 1 → 2 → … → `ROLE_DATA_VERSION` 的连续链
 *
 * 在模块加载时跑一次（**启动即失败**，比运行到某个玩家的档才炸好）：
 * 「有 1→2 没 2→3，而 `ROLE_DATA_VERSION` 写的是 3」这种错，编译期看不出来。
 */
export function assertRoleMigrationChain(): void {
  let version = ROLE_DATA_LEGACY_VERSION;
  for (const migration of ROLE_DATA_MIGRATIONS) {
    if (migration.from !== version || migration.to !== version + 1) {
      throw new Error(`存档迁移链断了：期望 ${version} → ${version + 1}，实际 ${migration.from} → ${migration.to}`);
    }
    version = migration.to;
  }
  if (version !== ROLE_DATA_VERSION) {
    throw new Error(`存档迁移链只到 ${version}，而 ROLE_DATA_VERSION 是 ${ROLE_DATA_VERSION}`);
  }
}

assertRoleMigrationChain();
