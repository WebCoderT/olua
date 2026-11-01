import { useMemo, useState } from "react";
import { Button, Input } from "../ui";
import { EntityCard } from "./EntityCard";
import { EntityPicker } from "./EntityPicker";
import { entityImage, entityLabel, entityNote, entityOptions } from "./catalog";

/** 技能行：id + 等级（等级用字符串，便于受控输入时空着不跳） */
export interface SkillRow {
  id: string;
  level: string;
}

/**
 * 技能列表（可视化）
 *
 * 原来是「技能 id → 等级」两列输入框。现在每行是「图标 + 技能名 + 描述 + 等级」，
 * 添加走选择器（已学会的不再出现在候选里）。等级仍然是自由输入 ——
 * 客户端技能等级上限不是一张表，管理端不编一个上限出来。
 */
export function SkillList({
  rows,
  onChange,
  disabled = false,
}: {
  rows: SkillRow[];
  onChange: (rows: SkillRow[]) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const options = useMemo(() => entityOptions("skill"), []);
  const learned = new Set(rows.map((row) => row.id));
  const candidates = useMemo(() => options.filter((option) => !learned.has(option.id)), [options, learned]);

  return (
    <div className="flex flex-col gap-2">
      {rows.length === 0 ? <p className="text-xs text-slate-500">该角色还没有技能。</p> : null}

      {/* 双列 + 紧凑行：12 个技能原来是 12 行 × 64px（要滚），现在是 6 行 × 40px。
          列数按**可用宽度** auto-fit（弹窗 4xl 下两列，窄一点自动变一列） */}
      <div className="grid gap-1.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
        {rows.map((row, index) => {
          const known = !!row.id;
          return (
            <div key={`${row.id}-${index}`} className="flex items-center gap-1">
              <div className="min-w-0 flex-1">
                <EntityCard
                  compact
                  size={24}
                  label={known ? entityLabel("skill", row.id) : ""}
                  note={known ? entityNote("skill", row.id) : undefined}
                  image={known ? entityImage("skill", row.id) : {}}
                  placeholder="点此挑技能"
                  badge={`${index + 1}.`}
                  disabled={disabled}
                  onClick={() => {
                    // 已有技能点一下 = 换成别的：先移除这一行，再从候选里挑
                    onChange(rows.filter((_, position) => position !== index));
                    setOpen(true);
                  }}
                  onClear={() => onChange(rows.filter((_, position) => position !== index))}
                  clearTitle="移除技能"
                />
              </div>
              {/* 宽度只能给外层容器：`Input` 的基础类里带 `w-full`，再写 `w-11` 是同一属性的冲突，
                  谁生效取决于 CSS 生成顺序 —— 直接把 `flex-1` 的卡片挤成了 0 宽（实测 10px） */}
              <div className="w-12 shrink-0">
                <Input
                  inputMode="numeric"
                  value={row.level}
                  placeholder="Lv"
                  title="等级"
                  aria-label={`第 ${index + 1} 个技能等级`}
                  disabled={disabled || !known}
                  onChange={(event) =>
                    onChange(
                      rows.map((item, position) =>
                        position === index ? { ...item, level: event.target.value.replace(/[^\d]/g, "") } : item,
                      ),
                    )
                  }
                />
              </div>
            </div>
          );
        })}
      </div>

      <div>
        <Button variant="outline" className="px-2.5 py-1 text-xs" disabled={disabled} onClick={() => setOpen(true)}>
          添加技能
        </Button>
      </div>

      <EntityPicker
        open={open}
        title="选择技能"
        hint="已学会的技能不在候选里（同一技能不会占两行）；技能 id 与名字来自客户端配置。"
        options={candidates}
        onSelect={(id) => onChange([...rows, { id, level: "1" }])}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}
