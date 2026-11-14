import type { RoleDerived, RoleDerivedAttributes } from "../api";
import { Card, Notice } from "./ui";

/** 服务端重算里的一项：键 + 中文名 + 它是不是 [下限, 上限] 区间 */
interface AttributeRow {
  key: keyof RoleDerivedAttributes;
  label: string;
  hint?: string;
  range?: boolean;
}

/**
 * 属性面板的展示顺序（不是服务端字段的声明顺序）
 *
 * 与 `role-attributes.ts` 的 `RoleAttributeSummary` 一一对应，但按「看一个人有多强」的
 * 习惯排：存活 → 三条攻击 → 三条防御 → 战斗力。**服务端出口里有什么就显示什么**
 * （含只跟等级走的 `maxMp`），不在前端替服务端决定哪几项才算数 —— 那样一来
 * 「后台少了一项」会变成没有人能发现的默认行为。
 */
const ATTRIBUTE_ROWS: AttributeRow[] = [
  { key: "maxHp", label: "最大生命值" },
  { key: "hpRecover", label: "生命回复", hint: "点/秒" },
  { key: "maxMp", label: "最大魔法值" },
  { key: "physicalAttack", label: "物理攻击", range: true },
  { key: "magicAttack", label: "魔法攻击", range: true },
  { key: "taoistAttack", label: "道术攻击", range: true },
  { key: "physicalDefense", label: "物理防御", range: true },
  { key: "magicDefense", label: "魔法防御", range: true },
  { key: "taoistDefense", label: "道术防御", range: true },
  { key: "combat", label: "战斗力" },
];

/**
 * 存档里那份派生值（`data.combat` / `data.maxHp`）
 *
 * **客户端已经不算属性了**（#541 起服务端收权）：每次写档都由 `applyAuthoritativeAttributes`
 * 按存档输入现算覆盖 `combat` / `maxHp` / 六项攻防，客户端只是把下发值抄回来再随整份存档推上来。
 * 所以这一列的含义只剩「**存档里上一次写下的那份**」—— 它与「按当前输入重算」不同，
 * 就说明存档那份过期了（客户端配置漂移、或某次改动没触发重算），不是「客户端说了算」。
 *
 * 旧名字叫「客户端上报」，在 #556 之后已经名不副实（会让人以为客户端还有算法、还有作弊空间），
 * 所以改成「存档旧值」；判据没变 —— 两份数值并列摆着，让人自己看。
 *
 * 只有 `combat` / `maxHp` 有值：存档里也有六项攻防，但服务端从来没拿它们对照过，
 * 摆出来会让人误以为那几项也校验过。
 */
function storedValueOf(derived: RoleDerived, key: keyof RoleDerivedAttributes): number | null {
  if (key === "combat") return derived.reported.combat;
  if (key === "maxHp") return derived.reported.maxHp;
  return null;
}

/** 服务端重算那一栏的文本（区间属性写成 `14 ~ 20`） */
function serverTextOf(attributes: RoleDerivedAttributes, row: AttributeRow): string {
  const value = attributes[row.key];
  if (row.range) return Array.isArray(value) ? `${value[0]} ~ ${value[1]}` : "—";
  return typeof value === "number" ? String(value) : "—";
}

/**
 * 提示条
 *
 * 两条提示都用琥珀色：它们的意思都是**值得看一眼**，不是「出错了」——
 * `mismatch` 明确可能是正常存档时机造成的，查不到的装备 id 也只是属性少算一截。
 * 红色在这个后台里专属于危险操作（封禁 / 删除），不拿来当普通提醒用。
 */
/**
 * 一张属性表（紧凑模式会把 10 行拆成两张并排，所以抽出来）
 *
 * 逐行标记差异的口径：**看得见的两个数不一样**（严格相等）。服务端的 `mismatch` 才是
 * 带容差的权威判定（由上面的横幅承载），这里不复制那份容差 —— 它的用途是指给人看
 * 「哪一行有差别」，而严格相等永远不会说错「显示出来的这两个数不同」。
 */
function AttributeTable({
  rows,
  derived,
  cell,
  dense,
}: {
  rows: AttributeRow[];
  derived: RoleDerived;
  cell: string;
  dense: boolean;
}) {
  const attributes = derived.attributes;
  return (
    <table className={`w-full border-collapse ${dense ? "text-xs" : "min-w-[26rem] text-sm"}`}>
      <thead>
        <tr className="border-b border-line text-left text-xs text-ink-5">
          <th className={`${cell} font-medium`}>属性</th>
          <th className={`${cell} font-medium`}>服务端重算</th>
          <th className={`${dense ? "py-1" : "py-2"} font-medium`}>存档旧值</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const reported = storedValueOf(derived, row.key);
          const serverValue = attributes ? attributes[row.key] : undefined;
          const differs = reported !== null && typeof serverValue === "number" && serverValue !== reported;
          return (
            <tr key={row.key} className={`border-b border-line/60 last:border-0 ${differs ? "bg-warn/10" : ""}`}>
              <td className={`${cell} text-ink-4`}>
                {row.label}
                {row.hint ? <span className="ml-1 text-xs text-ink-6">（{row.hint}）</span> : null}
              </td>
              <td className={`${cell} font-medium text-ink-1`}>{attributes ? serverTextOf(attributes, row) : "—"}</td>
              <td className={`${dense ? "py-1" : "py-2"} ${differs ? "font-medium text-warn-hi" : "text-ink-4"}`}>
                {reported === null ? <span className="text-ink-6">—</span> : reported}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * 战斗属性卡片：**按当前输入重算的那份** vs **存档里上一次写下的那份**
 *
 * 这个卡片存在的理由：服务端从 #541 起按存档输入自己算属性（伤害 / 掉落 / 战力都走它），
 * 存档里那份派生值只是它上一次写下的快照。两张摆在一起，才能一眼看出「存档是不是旧了」——
 * 配置漂移、某次改动没触发重算，都会在这里露出差异。
 *
 * 前端**不下结论**：差异不代表谁作弊（客户端已经不参与计算了），只表示两份不一致。
 *
 * `dense`：角色详情要「一屏看完」，所以行高压到最紧、10 行拆成两张并排、
 * 底部那段长说明收起来 —— **判据（两份数值并列 + 差异高亮）一条不少**。
 */
export function RoleAttributesCard({
  derived,
  dense = false,
  bare = false,
}: {
  derived: RoleDerived;
  dense?: boolean;
  /**
   * 并进「角色」卡的那一档：**只读**、竖排紧凑列表（一行一个属性，右侧「存档 x」只在**和重算值不同**时才出现）
   *
   * 为什么不用表格：窄栏里三列表头会折成「服务端重 / 算」，数值 `406 ~ 550` 也会折行，
   * 一折行每行就变两三行高，10 行吃掉 300px。列表这个形状在同样宽度下只要一半高度，
   * 判据（两份数值并列 + 差异高亮）一条不少。
   */
  bare?: boolean;
}) {
  const attributes = derived.attributes;
  const { unknownEquipmentIds } = derived;
  const cell = dense ? "py-1 pr-3" : "py-2 pr-4";
  // 紧凑模式拆两半：前 5 行左、后 5 行右（存活 / 三条攻击 在左，防御 / 战斗力 在右）
  const half = Math.ceil(ATTRIBUTE_ROWS.length / 2);
  const columns = dense ? [ATTRIBUTE_ROWS.slice(0, half), ATTRIBUTE_ROWS.slice(half)] : [ATTRIBUTE_ROWS];

  const notices = (
    <div className="flex flex-col gap-2">
      {!attributes ? <Notice>服务端算不出这个等级（等级不在成长曲线里），本次没有可对照的基准；存档里那份旧值照常显示。</Notice> : null}
      {derived.mismatch ? (
        <Notice>
          {bare
            ? "存档里那份派生值与按当前输入重算的不一致（下面标出的那几行）。客户端已经不参与计算，这多半是存档旧了（配置漂移、或某次改动没触发重算），出现差异时保存一次就会被重算覆盖。"
            : "存档里那份派生值（上次写档时的快照）与按当前输入重算的结果不一致，数值不同的那一行已标出。客户端 #541 起不再计算属性，所以这不是「客户端说了算」：多半是存档旧了 —— 客户端配置漂移、或某次改动没触发重算；保存一次就会按当前输入重算覆盖。"}
        </Notice>
      ) : null}
      {unknownEquipmentIds.length > 0 ? (
        <Notice>
          {`有 ${unknownEquipmentIds.length} 件装备的 id 在服务端配置里查不到，这几件不参与计算（属性会少算一截）：${unknownEquipmentIds.join("、")}`}
        </Notice>
      ) : null}
    </div>
  );

  if (bare) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-[10px] uppercase tracking-wide text-ink-5">战斗属性（服务端重算 · 只读）</p>
        {notices}
        <dl className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
          {ATTRIBUTE_ROWS.map((row) => {
            const reported = storedValueOf(derived, row.key);
            const serverValue = attributes ? attributes[row.key] : undefined;
            const differs = reported !== null && typeof serverValue === "number" && serverValue !== reported;
            return (
              <div
                key={row.key}
                className={`flex items-baseline justify-between gap-2 rounded px-1 py-0.5 ${differs ? "bg-warn/10" : ""}`}
              >
                <dt className="truncate text-[11px] text-ink-4">
                  {row.label}
                  {row.hint ? <span className="text-[10px] text-ink-6">（{row.hint}）</span> : null}
                </dt>
                <dd className="flex shrink-0 items-baseline gap-1.5">
                  <span className={`text-xs font-medium tabular-nums ${differs ? "text-warn-hi" : "text-ink-1"}`}>
                    {attributes ? serverTextOf(attributes, row) : "—"}
                  </span>
                  {/* 只在「和重算值不同」时才把旧值摆出来：一样的时候它没有信息量，
                      而窄栏里每行多一个数字就挤一分 */}
                  {differs && reported !== null ? (
                    <span className="text-[10px] tabular-nums text-warn-hi">存档 {reported}</span>
                  ) : null}
                </dd>
              </div>
            );
          })}
        </dl>
      </div>
    );
  }

  return (
    <Card
      dense={dense}
      title="战斗属性（服务端重算）"
      description={
        dense
          ? "按已保存的存档现算；改完点「保存改动」这里立刻更新。"
          : "按已保存的存档现算（等级 / 装备 / 战魂 / 称号 / 军衔）。上面的字段改完点「保存改动」这里就立刻更新，不用等客户端同步。"
      }
    >
      {notices}
      <div
        className={`${dense ? "mt-2" : "mt-3"} grid grid-cols-1 gap-x-4`}
        // auto-fit 而不是断点：卡片可能被放进窄栏（那里只能单列）、也可能占满右侧一大块（两列更省高度）。
        // 按**可用宽度**决定，不按视口宽度
        style={dense ? { gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" } : undefined}
      >
        {columns.map((rows, index) => (
          <div key={index} className="overflow-x-auto">
            <AttributeTable rows={rows} derived={derived} cell={cell} dense={dense} />
          </div>
        ))}
      </div>

      {dense ? null : (
        <p className="mt-3 text-xs leading-relaxed text-ink-6">
          「存档旧值」一列只有战斗力与最大生命值：存档里其实也有六项攻防，但服务端从来没拿它们对照过，摆出来会让人误以为那几项也校验过。客户端从 #541 起不再计算属性 —— 每次写档都由服务端按存档输入（等级 / 装备 / 战魂 / 称号 / 军衔）重算覆盖，所以这一列只是「上一次写下的快照」；它与重算值不同，说明存档旧了，保存一次即可纠正。
        </p>
      )}
    </Card>
  );
}
