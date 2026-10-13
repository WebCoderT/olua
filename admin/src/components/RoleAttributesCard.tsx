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
 * 战斗属性卡片：**服务端重算的那份** vs **客户端上报的那份**
 *
 * 这个卡片存在的唯一理由是「让它可见」：服务端重算的值到了接口里（#93），
 * 但如果没人显示，运营在后台看到的战斗力就仍然只是玩家客户端说了多少。
 *
 * 前端**不下结论**。服务端算的那份不一定对（玩家在升级与重算之间存档 → 客户端那份
 * 才是旧的；服务端快照落后于客户端配置 → 反过来），所以这里只把两份摆在一起，
 * 判定权交给看的人。
 */
export function RoleAttributesCard({ derived }: { derived: RoleDerived }) {
  const attributes = derived.attributes;
  const { unknownEquipmentIds } = derived;

  return (
    <Card
      title="战斗属性（服务端重算）"
      description="按已保存的存档现算（等级 / 装备 / 战魂 / 称号 / 军衔）。上面的字段改完点「保存改动」这里就立刻更新，不用等客户端同步。"
    >
      <div className="flex flex-col gap-2">
        {!attributes ? <Notice>服务端算不出这个等级（等级不在成长曲线里），本次没有可对照的基准；客户端上报值照常显示。</Notice> : null}
        {derived.mismatch ? (
          <Notice>
            服务端重算与客户端上报对不上（数值不同的那一行已标出）。这不等于作弊：玩家在升级与重算之间存档、客户端配置漂移、存档留着旧装备 id
            都会命中。这里只负责让它可见，不判定哪一份是对的。
          </Notice>
        ) : null}
        {unknownEquipmentIds.length > 0 ? (
          <Notice>
            {`有 ${unknownEquipmentIds.length} 件装备的 id 在服务端配置里查不到，这几件不参与计算（属性会少算一截）：${unknownEquipmentIds.join("、")}`}
          </Notice>
        ) : null}
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[26rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-800 text-left text-xs text-slate-500">
              <th className="py-2 pr-4 font-medium">属性</th>
              <th className="py-2 pr-4 font-medium">服务端重算</th>
              <th className="py-2 font-medium">客户端上报</th>
            </tr>
          </thead>
          <tbody>
            {ATTRIBUTE_ROWS.map((row) => {
              const reported = reportedOf(derived, row.key);
              const serverValue = attributes ? attributes[row.key] : undefined;
              // 逐行标记的口径：**看得见的两个数不一样**（严格相等）。
              // 服务端的 `mismatch` 才是带容差的权威判定，由上面的横幅承载；这里不复制那份容差 ——
              // 它的用途是指给人看「哪一行有差别」，而严格相等永远不会说错「显示出来的这两个数不同」。
              const differs = reported !== null && typeof serverValue === "number" && serverValue !== reported;
              return (
                <tr key={row.key} className={`border-b border-slate-800/60 last:border-0 ${differs ? "bg-amber-500/10" : ""}`}>
                  <td className="py-2 pr-4 text-slate-400">
                    {row.label}
                    {row.hint ? <span className="ml-1 text-xs text-slate-600">（{row.hint}）</span> : null}
                  </td>
                  <td className="py-2 pr-4 font-medium text-slate-100">{attributes ? serverTextOf(attributes, row) : "—"}</td>
                  <td className={`py-2 ${differs ? "font-medium text-amber-300" : "text-slate-400"}`}>
                    {reported === null ? <span className="text-slate-600">—</span> : reported}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs leading-relaxed text-slate-600">
        「客户端上报」一列只有战斗力与最大生命值：服务端的比对口径就这两项（客户端每次重算都会写它们，而战斗力是加权总和、最能代表两端口径是否还一致）。存档里其实也有六项攻防，但服务端没有校验过它们，摆出来只会让人以为那几项也过了对照 —— 服务端重算的结果全在左列，要排查时对着看。
      </p>
    </Card>
  );
}
