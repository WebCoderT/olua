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

      {rows.map((row, index) => {
        const known = !!row.id;
        return (
          <div key={`${row.id}-${index}`} className="flex items-stretch gap-2">
            <div className="min-w-0 flex-1">
              <EntityCard
                label={known ? entityLabel("skill", row.id) : ""}
                note={known ? entityNote("skill", row.id) : undefined}
                image={known ? entityImage("skill", row.id) : {}}
                placeholder="点此挑技能"
                badge={`第 ${index + 1} 个`}
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
            <label className="flex w-24 flex-col justify-center gap-1">
              <span className="text-[10px] text-slate-500">等级</span>
              <Input
                inputMode="numeric"
                value={row.level}
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
            </label>
          </div>
        );
      })}

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
