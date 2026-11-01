import { useMemo, useState } from "react";
import { equipmentSlot, equipmentSlotKeys, slotLabel } from "../../api";
import { EntityCard } from "./EntityCard";
import { EntityPicker } from "./EntityPicker";
import { entityImage, entityLabel, entityNote, entityOptions } from "./catalog";

/**
 * 装备槽面板（可视化穿戴）
 *
 * ===========================================================================
 * 为什么按「生成物的部位表」排，而不是按角色数据里已有的键排
 * ===========================================================================
 * 角色数据里的 `equipments` 是个对象，**空槽位也在**（值是 null），所以它本来就齐全；
 * 但键的顺序是客户端写档时的对象序，不一定是玩家看到的部位序。部位顺序的权威在
 * 客户端配置（生成物 `EQUIPMENT_SLOT_ORDER`，背包一键整理也用这个序），所以：
 *
 *   槽位 = 生成物的全部部位（按它的序） + 数据里有但部位表没有的键（脏数据，追加在后面）
 *
 * 追加那一档不能省：客户端配置更新到一半、或旧存档带了已经删掉的部位时，
 * 只按部位表渲染 = 把玩家身上那件装备**从界面上抹掉了**（存一次就真没了）。
 *
 * 选择器默认只列本部位的装备（服务端会按部位校验，列别的等于给一个必被拒的操作），
 * 但允许「全部部位」—— 运营确实要处理脏数据时不必换页面。
 */
export function EquipSlots({
  value,
  onChange,
  disabled = false,
}: {
  value: Record<string, string | null>;
  onChange: (next: Record<string, string | null>) => void;
  disabled?: boolean;
}) {
  const [picking, setPicking] = useState<string | null>(null);
  const [anySlot, setAnySlot] = useState(false);

  const slots = useMemo(() => {
    const known = equipmentSlotKeys();
    const extra = Object.keys(value).filter((slot) => !known.includes(slot));
    return [...known, ...extra];
  }, [value]);

  const knownSlots = useMemo(() => equipmentSlotKeys(), []);
  const all = useMemo(() => entityOptions("equipment"), []);
  // 有装备的槽用大卡（要看得出穿的是哪件），空槽压成一行小按钮 ——
  // 13 个部位里有 11 个通常是空的，全用大卡会平白吃掉四行高度
  const wornSlots = slots.filter((slot) => !!value[slot]);
  const emptySlots = slots.filter((slot) => !value[slot]);
  const worn = wornSlots.length;

  const pickerOptions = useMemo(() => {
    if (!picking) return [];
    if (anySlot) return all;
    const options = all.filter((option) => equipmentSlot(option.id) === picking);
    if (options.length > 0) return options;
    // 只有「部位表里根本没这个槽」（脏数据）才放开全量；
    // 合法但客户端没配装备的部位（other1 / other2）就让它空着 —— 列别人的部位只会给一个必被拒的操作
    return knownSlots.includes(picking) ? [] : all;
  }, [all, picking, anySlot, knownSlots]);

  const write = (slot: string, id: string | null) => {
    onChange({ ...value, [slot]: id });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-400">
          已穿 <span className="text-slate-100">{worn}</span> / {slots.length} 个部位；点格子挑装备，× 卸下
        </p>
        <label className="flex items-center gap-1.5 text-[11px] text-slate-500">
          <input
            type="checkbox"
            checked={anySlot}
            onChange={(event) => setAnySlot(event.target.checked)}
            className="h-3.5 w-3.5 accent-indigo-500"
          />
          选择器显示全部部位
        </label>
      </div>

      <div className="flex flex-col gap-2">
        {wornSlots.length === 0 ? (
          <p className="text-xs text-slate-500">还没穿任何装备 —— 从下面点一个部位开始挑。</p>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {wornSlots.map((slot) => {
              const id = value[slot] ?? "";
              const known = knownSlots.includes(slot);
              return (
                <EntityCard
                  key={slot}
                  badge={known ? slotLabel(slot) : `${slot}（部位表里没有）`}
                  label={entityLabel("equipment", id)}
                  note={entityNote("equipment", id)}
                  image={entityImage("equipment", id)}
                  placeholder="空"
                  size={36}
                  disabled={disabled}
                  onClick={() => setPicking(slot)}
                  onClear={() => write(slot, null)}
                  clearTitle={`卸下${known ? slotLabel(slot) : slot}`}
                />
              );
            })}
          </div>
        )}

        {emptySlots.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {emptySlots.map((slot) => {
              const known = knownSlots.includes(slot);
              return (
                <button
                  key={slot}
                  type="button"
                  disabled={disabled}
                  title={`${known ? slotLabel(slot) : slot}：空（点击挑装备）`}
                  aria-label={`${known ? slotLabel(slot) : slot}空槽位`}
                  onClick={() => setPicking(slot)}
                  className="flex items-center gap-1 rounded-lg border border-dashed border-slate-800 px-1.5 py-0.5 text-[11px] text-slate-500 transition hover:border-indigo-500/60 hover:text-slate-200 disabled:cursor-not-allowed"
                >
                  <span aria-hidden="true" className="h-3 w-3 rounded-sm border border-slate-800 bg-slate-950/40" />
                  {known ? slotLabel(slot) : `${slot}（未知）`}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      <EntityPicker
        open={!!picking}
        title={`选择${picking ? (knownSlots.includes(picking) ? slotLabel(picking) : picking) : ""}装备`}
        hint={
          anySlot
            ? "已放开部位限制：服务端仍会校验部位与等级，选错会被拒。"
            : "只列出该部位的装备；装备 id 带前后缀变体，名字已含「精良的 · 天级」这类前缀与后缀。"
        }
        options={pickerOptions}
        current={picking ? (value[picking] ?? "") : ""}
        emptyHint={
          anySlot
            ? "客户端配置里没有这一类数据。"
            : "该部位在客户端配置里没有可穿的装备（other1 / other2 是保留槽位）；要看全部部位请勾上右上角那个开关。"
        }
        onSelect={(id) => {
          if (!picking) return;
          write(picking, id);
        }}
        onClose={() => setPicking(null)}
      />
    </div>
  );
}
