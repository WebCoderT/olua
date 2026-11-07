import { useEffect, useMemo, useState } from "react";
import { Button, Input } from "../ui";
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
 * 渲染上限 `max`：技能有 1011 条、装备变体上万条、怪物 220 只，一次性铺完会卡住主线程。
 * 超过就先画 `max` 条，底部给一个「再显示 N 项」——**能翻到底**，不是只提示「缩小搜索范围」
 * （分组也算「缩小范围」，可「普通怪」一组就有两百只，光靠分组翻不到最后一只）。
 */
export function EntityPickerList({
  options,
  current,
  selected,
  onPick,
  hint,
  max = 120,
  emptyHint = "没有匹配的项",
  imageSize = 32,
  resetKey,
}: {
  options: EntityOption[];
  /** 当前已选（单选高亮用） */
  current?: string;
  /** 多选模式下已勾选的 id（传了它就按多选渲染：点一项是「勾 / 取消」） */
  selected?: string[];
  onPick: (id: string) => void;
  /** 列表上方的说明（如「只列出衣服部位的装备」） */
  hint?: string;
  max?: number;
  emptyHint?: string;
  /**
   * 图标边长（默认 32）
   *
   * 装备 / 技能这类「图 + 名字」认得出就够，32 一屏能多摆几项；而**装备边框 / 详情背景**
   * 挑的就是那张图本身（#749），32px 看不出边框粗细与光效，调用方给 48~56。
   */
  imageSize?: number;
  /** 变化时清空搜索与分组（弹窗每次打开传一个新值，避免残留上一次的筛选） */
  resetKey?: unknown;
}) {
  const multiple = selected !== undefined;
  const [keyword, setKeyword] = useState("");
  const [group, setGroup] = useState<string | null>(null);
  /** 已画多少条（「再显示 N 项」往上加；搜索 / 分组变化要回到首页，否则会记得上一次的深度） */
  const [limit, setLimit] = useState(max);

  useEffect(() => {
    setKeyword("");
    setGroup(null);
  }, [resetKey]);

  useEffect(() => {
    setLimit(max);
  }, [max, keyword, group, resetKey]);

  const groups = useMemo(() => groupNames(options), [options]);
  const filtered = useMemo(() => filterOptions(options, keyword, group), [options, keyword, group]);
  const shown = filtered.slice(0, limit);

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
              const active = multiple ? (selected?.includes(option.id) ?? false) : current === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  title={`${option.label}（${option.id}）\n${option.note}`}
                  aria-pressed={multiple ? active : undefined}
                  onClick={() => onPick(option.id)}
                  className={`flex items-center gap-2 rounded-lg border p-2 text-left transition ${
                    active
                      ? "border-indigo-500 bg-indigo-500/10"
                      : "border-slate-800 bg-slate-900/60 hover:border-slate-600 hover:bg-slate-800/60"
                  }`}
                >
                  <EntityImage image={option.image} alt={option.label} size={imageSize} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-slate-100">{option.label}</span>
                    <span className="block truncate text-[10px] text-slate-500">{option.note}</span>
                  </span>
                  {/* 多选才画勾：单选点一下就走，多选框型对齐与否一眼看不出 */}
                  {multiple ? (
                    <span
                      aria-hidden="true"
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] ${
                        active ? "border-indigo-400 bg-indigo-500 text-white" : "border-slate-600 text-transparent"
                      }`}
                    >
                      ✓
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-slate-600">
          共 {filtered.length} 项
          {filtered.length > shown.length ? `，已画 ${shown.length} 项` : ""}
        </p>
        {filtered.length > shown.length ? (
          <Button
            variant="outline"
            className="px-2 py-0.5 text-[11px]"
            onClick={() => setLimit(limit + max)}
          >
            再显示 {Math.min(max, filtered.length - shown.length)} 项
          </Button>
        ) : null}
      </div>
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
