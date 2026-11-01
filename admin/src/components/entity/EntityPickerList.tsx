import { useEffect, useMemo, useState } from "react";
import { Input } from "../ui";
import { EntityImage } from "./EntityImage";
import { filterOptions, groupNames } from "./catalog";
import type { EntityOption } from "./catalog";

/**
 * 实体候选列表（搜索框 + 分组 + 网格）—— 没有弹窗外壳
 *
 * 拆出来是为了两处复用：
 * - `EntityPicker` = 弹窗外壳 + 本组件（选装备 / 技能 / 物品）；
 * - 背包格子编辑 = 自己的弹窗外壳 + 本组件 + 数量输入。
 *
 * 渲染上限 `max`：技能有 1011 条、装备变体 555 条，一次性铺完会卡住主线程。
 * 超过就只画前 `max` 条并提示「缩小搜索范围」—— 比假装全都在（卡死）诚实。
 */
export function EntityPickerList({
  options,
  current,
  onPick,
  hint,
  max = 120,
  emptyHint = "没有匹配的项",
  resetKey,
}: {
  options: EntityOption[];
  /** 当前已选（高亮用） */
  current?: string;
  onPick: (id: string) => void;
  /** 列表上方的说明（如「只列出衣服部位的装备」） */
  hint?: string;
  max?: number;
  emptyHint?: string;
  /** 变化时清空搜索与分组（弹窗每次打开传一个新值，避免残留上一次的筛选） */
  resetKey?: unknown;
}) {
  const [keyword, setKeyword] = useState("");
  const [group, setGroup] = useState<string | null>(null);

  useEffect(() => {
    setKeyword("");
    setGroup(null);
  }, [resetKey]);

  const groups = useMemo(() => groupNames(options), [options]);
  const filtered = useMemo(() => filterOptions(options, keyword, group), [options, keyword, group]);
  const shown = filtered.slice(0, max);

  return (
    // h-full 不能省：这个组件的滚动区靠 `flex-1 + overflow-y-auto` 限高，
    // 父级给了 flex-1 但自己不撑满时，列表会按内容自然高度长出去、压到底部按钮上
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          autoFocus
          value={keyword}
          placeholder="搜 id 或名字…"
          aria-label="搜索"
          onChange={(event) => setKeyword(event.target.value)}
        />
        {groups.length > 1 ? (
          <div className="flex flex-wrap gap-1">
            <GroupChip active={group === null} onClick={() => setGroup(null)}>
              全部 {options.length}
            </GroupChip>
            {groups.map((name) => (
              <GroupChip key={name} active={group === name} onClick={() => setGroup(name)}>
                {name}
              </GroupChip>
            ))}
          </div>
        ) : null}
      </div>

      {hint ? <p className="text-xs text-slate-500">{hint}</p> : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 ? (
          <p className="py-8 text-center text-xs text-slate-500">{emptyHint}</p>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((option) => {
              const active = current === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  title={`${option.label}（${option.id}）\n${option.note}`}
                  onClick={() => onPick(option.id)}
                  className={`flex items-center gap-2 rounded-lg border p-2 text-left transition ${
                    active
                      ? "border-indigo-500 bg-indigo-500/10"
                      : "border-slate-800 bg-slate-900/60 hover:border-slate-600 hover:bg-slate-800/60"
                  }`}
                >
                  <EntityImage image={option.image} alt={option.label} size={32} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-slate-100">{option.label}</span>
                    <span className="block truncate text-[10px] text-slate-500">{option.note}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <p className="text-[11px] text-slate-600">
        共 {filtered.length} 项
        {filtered.length > shown.length ? `，只画了前 ${shown.length} 项 —— 用搜索或分组缩小范围` : ""}
      </p>
    </div>
  );
}

function GroupChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-2 py-1 text-[11px] transition ${
        active ? "bg-indigo-500 text-white" : "bg-slate-800/70 text-slate-300 hover:bg-slate-700"
      }`}
    >
      {children}
    </button>
  );
}
