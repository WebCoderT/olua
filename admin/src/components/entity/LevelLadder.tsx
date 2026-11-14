import { useMemo, useState } from "react";
import { Badge } from "../ui";
import { EntityImage } from "./EntityImage";
import { EntityPicker } from "./EntityPicker";
import { LEVEL_KIND_LABELS, levelDescription, levelImage, levelLabel, levelNote, levelOptions } from "./catalog";
import type { LevelKind } from "./catalog";

/**
 * 养成等级阶梯（称号 / 战魂 / 军衔的可视化档位）
 *
 * 原来这里是一个数字输入框 + 一行名字 —— 运营得自己记住「31 级是什么称号」。
 * 现在换成：当前档的大图（称号 / 战魂是图集首帧动画）+ 名字 + 说明文案 + 升到该档的消耗，
 * 点开弹窗按档挑（每档都带自己的动画首帧，一眼能认）。
 *
 * 0 = 未激活（客户端就是这么存的），所以「清空」写回 0 而不是 undefined ——
 * 服务端把缺字段当 0，但显式给 0 更不容易被误读成「没改」。
 */
export function LevelLadder({
  kind,
  value,
  onChange,
  disabled = false,
  compact = false,
}: {
  kind: LevelKind;
  /** 当前档位（0 = 未激活） */
  value: number;
  onChange: (level: number) => void;
  disabled?: boolean;
  /** 紧凑版：藏掉说明文案那一行（角色详情左栏一屏要塞三个） */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const options = useMemo(() => levelOptions(kind), [kind]);
  const label = LEVEL_KIND_LABELS[kind];
  const active = value >= 1;

  return (
    <>
      <div
        role={disabled ? undefined : "button"}
        tabIndex={disabled ? undefined : 0}
        aria-label={`${label}档位`}
        onClick={disabled ? undefined : () => setOpen(true)}
        onKeyDown={(event) => {
          if (disabled) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          setOpen(true);
        }}
        className={`flex items-center gap-3 rounded-xl border border-line-strong bg-surface-2/70 ${compact ? "p-2" : "p-2.5"} transition ${
          disabled ? "" : "cursor-pointer hover:border-gold/70 hover:bg-surface-4/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
        }`}
      >
        <EntityImage image={active ? levelImage(kind, value) : {}} alt={active ? levelLabel(kind, value) : undefined} size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-[10px] leading-tight text-ink-5">{label}</p>
            <Badge tone={active ? "gold" : "muted"}>
              <span className="whitespace-nowrap">{active ? `${value} 档` : "未激活"}</span>
            </Badge>
          </div>
          <p className={`truncate text-xs font-medium ${active ? "text-ink-1" : "text-ink-6"}`}>
            {active ? levelLabel(kind, value) || `第 ${value} 档` : "点此选择档位"}
          </p>
          {compact ? null : (
            <p className="truncate text-[10px] text-ink-5">{active ? levelDescription(kind, value) : "0 = 未激活"}</p>
          )}
        </div>
        {active && !disabled ? (
          <button
            type="button"
            title={`清除${label}`}
            aria-label={`清除${label}`}
            onClick={(event) => {
              event.stopPropagation();
              onChange(0);
            }}
            className="rounded px-1 text-xs leading-none text-ink-5 transition hover:bg-surface-4 hover:text-ember-hi"
          >
            ×
          </button>
        ) : null}
      </div>

      <EntityPicker
        open={open}
        title={`选择${label}档位`}
        hint={`共 ${options.length} 档，全部来自客户端配置（名字 / 说明 / 消耗 / 动画图集都在那一份数据里）。`}
        options={options}
        current={active ? String(value) : ""}
        onSelect={(id) => onChange(Number(id))}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

/** 当前档的一句话（保留给「常用数值」那种紧凑布局用；与卡片同一口径） */
export function levelSummary(kind: LevelKind, value: number): string {
  if (value < 1) return kind === "rank" ? "0 = 未授衔" : "0 = 未激活";
  const label = levelLabel(kind, value);
  const note = levelNote(kind, value);
  return [label || `第 ${value} 档`, note].filter(Boolean).join(" · ");
}
