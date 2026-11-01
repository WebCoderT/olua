import type { RoleDerived, RoleDerivedAttributes } from "../api";
import { Card } from "./ui";

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
 * 客户端上报值（存档 `data` 里那一项）
 *
 * 只有 `combat` / `maxHp` 有值：服务端的比对口径就这两项（#93 定的 —— 客户端每次
 * `combatCalc` 都会写它们，而 `combat` 是加权总和、最能代表「两端口径是否还一致」；
 * 六项区间属性拿来判「是否一致」噪音太大，玩家在升级与重算之间存档就会命中）。
 *
 * 所以这一列只摆**被比对过**的项。存档里其实也有六项攻防，但既然服务端没校验过，
 * 摆出来只会让人误以为那几项也过了对照。
 */
function reportedOf(derived: RoleDerived, key: keyof RoleDerivedAttributes): number | null {
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
function Notice({ children }: { children: string }) {
  return <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-200">{children}</p>;
}

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
        <tr className="border-b border-slate-800 text-left text-xs text-slate-500">
          <th className={`${cell} font-medium`}>属性</th>
          <th className={`${cell} font-medium`}>服务端重算</th>
          <th className={`${dense ? "py-1" : "py-2"} font-medium`}>客户端上报</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const reported = reportedOf(derived, row.key);
          const serverValue = attributes ? attributes[row.key] : undefined;
          const differs = reported !== null && typeof serverValue === "number" && serverValue !== reported;
          return (
            <tr key={row.key} className={`border-b border-slate-800/60 last:border-0 ${differs ? "bg-amber-500/10" : ""}`}>
              <td className={`${cell} text-slate-400`}>
                {row.label}
                {row.hint ? <span className="ml-1 text-xs text-slate-600">（{row.hint}）</span> : null}
              </td>
              <td className={`${cell} font-medium text-slate-100`}>{attributes ? serverTextOf(attributes, row) : "—"}</td>
              <td className={`${dense ? "py-1" : "py-2"} ${differs ? "font-medium text-amber-300" : "text-slate-400"}`}>
                {reported === null ? <span className="text-slate-600">—</span> : reported}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * 战斗属性卡片：**服务端重算的那份** vs **客户端上报的那份**
 *
 * 这个卡片存在的唯一理由是「让它可见」：服务端重算的值到了接口里（#93），
 * 但如果没人显示，运营在后台看到的战斗力就仍然只是玩家客户端说了多少。
 *
 * 前端**不下结论**。服务端算的那份不一定对（玩家在升级与重算之间存档 → 客户端那份
 * 才是旧的；服务端快照落后于客户端配置 → 反过来），所以这里只把两份摆在一起，
 * 判定权交给看的人。
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
   * 并进「角色」卡的那一档：**只读**、竖排紧凑列表（一行一个属性，右侧「上报」只在该项有上报时出现）
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
      {!attributes ? <Notice>服务端算不出这个等级（等级不在成长曲线里），本次没有可对照的基准；客户端上报值照常显示。</Notice> : null}
      {derived.mismatch ? (
        <Notice>
          {bare
            ? "两份数值对不上（下面标出的那几行）。升级与重算之间存档、配置漂移、旧装备 id 都会命中 —— 这里只让它可见，不判定哪一份对。"
            : "服务端重算与客户端上报对不上（数值不同的那一行已标出）。这不等于作弊：玩家在升级与重算之间存档、客户端配置漂移、存档留着旧装备 id 都会命中。这里只负责让它可见，不判定哪一份是对的。"}
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
        <p className="text-[10px] uppercase tracking-wide text-slate-500">战斗属性（服务端重算 · 只读）</p>
        {notices}
        <dl className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
          {ATTRIBUTE_ROWS.map((row) => {
            const reported = reportedOf(derived, row.key);
            const serverValue = attributes ? attributes[row.key] : undefined;
            const differs = reported !== null && typeof serverValue === "number" && serverValue !== reported;
            return (
              <div
                key={row.key}
                className={`flex items-baseline justify-between gap-2 rounded px-1 py-0.5 ${differs ? "bg-amber-500/10" : ""}`}
              >
                <dt className="truncate text-[11px] text-slate-400">
                  {row.label}
                  {row.hint ? <span className="text-[10px] text-slate-600">（{row.hint}）</span> : null}
                </dt>
                <dd className="flex shrink-0 items-baseline gap-1.5">
                  <span className={`text-xs font-medium tabular-nums ${differs ? "text-amber-200" : "text-slate-100"}`}>
                    {attributes ? serverTextOf(attributes, row) : "—"}
                  </span>
                  {reported === null ? null : (
                    <span className={`text-[10px] tabular-nums ${differs ? "text-amber-300" : "text-slate-500"}`}>
                      上报 {reported}
                    </span>
                  )}
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
        <p className="mt-3 text-xs leading-relaxed text-slate-600">
          「客户端上报」一列只有战斗力与最大生命值：服务端的比对口径就这两项（客户端每次重算都会写它们，而战斗力是加权总和、最能代表两端口径是否还一致）。存档里其实也有六项攻防，但服务端没有校验过它们，摆出来只会让人以为那几项也过了对照 —— 服务端重算的结果全在左列，要排查时对着看。
        </p>
      )}
    </Card>
  );
}
