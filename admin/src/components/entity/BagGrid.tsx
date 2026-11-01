import { useEffect, useMemo, useState } from "react";
import { maxStackOf } from "../../api";
import { Modal } from "../Modal";
import { Button, Input } from "../ui";
import { EntityImage } from "./EntityImage";
import { EntityPickerList } from "./EntityPickerList";
import { entityImage, entityLabel, entityOptions } from "./catalog";

/** 背包里的一格（与 `RoleBagCell` 同形；组件不依赖 api 类型，便于复用到别处） */
export interface BagCellValue {
  row: number;
  col: number;
  id: string;
  count: number;
}

/**
 * 背包格子编辑器（可视化）
 *
 * 原来的做法是「一行一个格子：行号 / 列号 / 物品 id / 数量」四输入框 —— 运营要在脑子里
 * 把 `row=2,col=5` 翻译成位置。这里直接按 `rows × cols` 铺成网格：
 * 空格显示虚线「+」，有东西显示图标 + 数量角标，点一下就是「这个格子放什么」。
 *
 * 尺寸（rows / cols）由调用方给 —— 服务端不认识网格形状（它只校验总格数），
 * 尺寸的权威在客户端配置，所以组件不自己假设 7×11。
 *
 * 越界格子（外部把尺寸改小、库里还留着大网格的物品）**照实报出来**，不静默丢：
 * 丢一件装备比多一行提示严重得多。
 */
export function BagGrid({
  cells,
  rows,
  cols,
  disabled = false,
  onChange,
}: {
  cells: BagCellValue[];
  rows: number;
  cols: number;
  disabled?: boolean;
  onChange: (cells: BagCellValue[]) => void;
}) {
  const [editing, setEditing] = useState<{ row: number; col: number } | null>(null);

  const cellMap = useMemo(() => {
    const map = new Map<string, BagCellValue>();
    for (const cell of cells) map.set(`${cell.row},${cell.col}`, cell);
    return map;
  }, [cells]);

  const outOfRange = useMemo(
    () => cells.filter((cell) => cell.row < 0 || cell.col < 0 || cell.row >= rows || cell.col >= cols),
    [cells, rows, cols],
  );

  const slots: { row: number; col: number }[] = [];
  for (let row = 0; row < rows; row += 1) for (let col = 0; col < cols; col += 1) slots.push({ row, col });

  const write = (row: number, col: number, id: string, count: number) => {
    const rest = cells.filter((cell) => !(cell.row === row && cell.col === col));
    onChange(id ? [...rest, { row, col, id, count }] : rest);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-400">
          已用 <span className="text-slate-100">{cells.length}</span> / {rows * cols} 格（{rows} 行 × {cols} 列）
        </p>
        {outOfRange.length > 0 ? (
          <p className="text-[11px] text-amber-300">
            有 {outOfRange.length} 件物品落在当前网格之外（配置改小了？）—— 保存时不会被丢掉，但界面上看不见位置
          </p>
        ) : null}
      </div>

      {rows === 0 || cols === 0 ? (
        <p className="text-xs text-slate-500">该角色数据里没有背包（`bag` 为空或不合法），无法按格编辑。</p>
      ) : (
        <div className="overflow-x-auto">
          <div
            className="grid gap-1"
            // 格子封顶 46px（原来按 1fr 撑满 720，7 行就是 455px 高）；7×11 一屏内能看全
            style={{ gridTemplateColumns: `repeat(${cols}, minmax(28px, 46px))`, justifyContent: "start" }}
          >
            {slots.map(({ row, col }) => {
              const cell = cellMap.get(`${row},${col}`);
              return (
                <BagCellButton
                  key={`${row}-${col}`}
                  cell={cell}
                  row={row}
                  col={col}
                  disabled={disabled}
                  onClick={() => setEditing({ row, col })}
                />
              );
            })}
          </div>
        </div>
      )}

      <CellEditor
        target={editing}
        cell={editing ? cellMap.get(`${editing.row},${editing.col}`) : undefined}
        disabled={disabled}
        onClose={() => setEditing(null)}
        onSubmit={(id, count) => {
          if (!editing) return;
          write(editing.row, editing.col, id, count);
          setEditing(null);
        }}
      />
    </div>
  );
}

/** 一个格子：空 = 虚线 + 十字；有物 = 图标 + 数量角标（超过 1 才显示，跟游戏里一致） */
function BagCellButton({
  cell,
  row,
  col,
  disabled,
  onClick,
}: {
  cell?: BagCellValue;
  row: number;
  col: number;
  disabled: boolean;
  onClick: () => void;
}) {
  const title = cell
    ? `第 ${row + 1} 行第 ${col + 1} 列：${entityLabel("item", cell.id)} ×${cell.count}`
    : `第 ${row + 1} 行第 ${col + 1} 列：空（点击放东西）`;
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={`relative flex aspect-square items-center justify-center rounded-md border transition disabled:cursor-not-allowed ${
        cell
          ? "border-slate-700 bg-slate-900/70 hover:border-indigo-500/70"
          : "border-dashed border-slate-800 bg-slate-950/40 hover:border-slate-600 hover:bg-slate-900/60"
      }`}
    >
      {cell ? (
        <>
          <EntityImage image={entityImage("item", cell.id)} alt={entityLabel("item", cell.id)} size={24} />
          {cell.count > 1 ? (
            <span className="absolute bottom-0 right-0.5 text-[10px] font-medium text-amber-200">{cell.count}</span>
          ) : null}
        </>
      ) : (
        <span className="text-xs text-slate-700">+</span>
      )}
    </button>
  );
}

/**
 * 单格编辑弹窗：先挑物品（复用 `EntityPickerList`），再填数量
 *
 * 选中物品不立即关闭 —— 数量还没填。所以这里是「自己的弹窗外壳 + 公共列表」，
 * 而不是 `EntityPicker`（那个是「选中即完成」的一步式选择）。
 */
function CellEditor({
  target,
  cell,
  disabled,
  onClose,
  onSubmit,
}: {
  target: { row: number; col: number } | null;
  cell?: BagCellValue;
  disabled: boolean;
  onClose: () => void;
  onSubmit: (id: string, count: number) => void;
}) {
  const options = useMemo(() => entityOptions("item"), []);
  const [id, setId] = useState("");
  const [count, setCount] = useState("1");

  // 每次打开都从该格的现状开始（编辑另一格时不残留上一格的选择）
  useEffect(() => {
    if (!target) return;
    setId(cell?.id ?? "");
    setCount(String(cell?.count ?? 1));
  }, [target, cell]);

  if (!target) return null;

  const max = id ? maxStackOf(id) : 1;
  const parsed = Number(count);
  const countOk = Number.isFinite(parsed) && parsed >= 1 && parsed <= max;

  return (
    <Modal
      open
      title={`第 ${target.row + 1} 行 · 第 ${target.col + 1} 列`}
      hint="挑一件物品放进这一格；同一格只放一种物品，数量不超堆叠上限。"
      size="lg"
      onClose={onClose}
      footer={
        <>
          <div className="mr-auto flex min-w-[160px] flex-1 items-center gap-2">
            {id ? <EntityImage image={entityImage("item", id)} alt={entityLabel("item", id)} size={32} /> : null}
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs text-slate-200">{id ? entityLabel("item", id) : "还没选物品"}</p>
              <p className="truncate text-[10px] text-slate-500">{id ? `堆叠上限 ${max}` : "在上面的列表里点一项"}</p>
            </div>
          </div>
          {!countOk && id ? (
            <span className="text-[11px] text-amber-300">数量要在 1 ~ {max} 之间（超过堆叠上限请分格放）</span>
          ) : null}
          <label className="flex items-center gap-2 text-xs text-slate-400">
            数量
            <Input
              className="w-24"
              inputMode="numeric"
              value={count}
              aria-label="数量"
              disabled={!id}
              onChange={(event) => setCount(event.target.value.replace(/[^\d]/g, ""))}
            />
          </label>
          <Button variant="outline" disabled={disabled || !cell} onClick={() => onSubmit("", 0)} title="把这一格清空">
            清空格子
          </Button>
          <Button disabled={disabled || !id || !countOk} onClick={() => onSubmit(id, parsed)}>
            放入
          </Button>
        </>
      }
    >
      <EntityPickerList options={options} current={id} resetKey={target} onPick={(picked) => setId(picked)} />
    </Modal>
  );
}
