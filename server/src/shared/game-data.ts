/**
 * 游戏数据（服务端侧的门面）：**派生常量 + 拼文案**，数据本身仍在 `game-data.generated.ts`
 *
 * ===========================================================================
 * 为什么要有这个文件
 * ===========================================================================
 * 生成物只是「一张张表」，它不知道消费方要怎么用。服务端有两处需要**派生**出来的东西，
 * 都不适合让每个调用点各写一遍：
 *
 *   1. **允许值清单**：`role-data.util.ts` 的 `ROLE_OCCUPATIONS` / `ROLE_SEXES` 是校验用的
 *      「码的清单」。它必须等于职业表 / 性别表的键 —— 以前是手写的 `["1","2","3","4"]`，
 *      注释里写着「与客户端一致」，而这句话只能靠人记得（客户端加一个职业码，服务端
 *      编译过、e2e 过，直到玩家用新职业建号被拒）。
 *   2. **DTO 描述文案**：`1 战士 / 2 魔法师 / …` 这一行，以前在 DTO 里手写，再经 `gen-api`
 *      生成进两端 `ApiModels` —— 别名的第三份文字版。
 *
 * 这里把两件事都收成「从同一张表算出来」，于是客户端改配置 → 重生成 → 清单与文案一起跟着变。
 *
 * 与 `admin/src/api/gameData.ts` 对称：那边也是「转发 + 查表函数」，数据都在同一个文件里。
 * 守卫：`tools/audit-shared-data.cjs`（除了逐字节比对，还会扫两端源码，抓手写的清单与文案）。
 */

import { OCCUPATION_LABELS, SEX_LABELS } from "./game-data.generated";

export * from "./game-data.generated";

/**
 * 职业码清单（= 职业表的键，顺序即配置顺序）
 *
 * 类型是 `string[]` 而不是字面量联合 `["1","2","3","4"]`：**要的就是这个** —— 字面量联合
 * 必须手写一遍才存在，而手写的那一份正是上面说的「只能靠人记得」的副本。
 */
export const ROLE_OCCUPATION_CODES: string[] = Object.keys(OCCUPATION_LABELS);

/** 性别码清单（= 性别表的键） */
export const ROLE_SEX_CODES: string[] = Object.keys(SEX_LABELS);

/**
 * 把 `码 → 名` 表渲染成一行一览（`1 战士 / 2 魔法师 / 3 道士 / 4 全职业`）
 *
 * 给 DTO 的 `description` 用：接口文档里那一行从此是**算出来的**，不是抄的。
 */
export function enumHint(labels: Record<string, string>): string {
  return Object.entries(labels)
    .map(([code, name]) => `${code} ${name}`)
    .join(" / ");
}

/** 职业一览（DTO 描述用） */
export const OCCUPATION_HINT = enumHint(OCCUPATION_LABELS);

/** 性别一览（DTO 描述用） */
export const SEX_HINT = enumHint(SEX_LABELS);
