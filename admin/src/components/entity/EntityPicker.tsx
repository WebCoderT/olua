import { useEffect, useState } from "react";
import { Button } from "../ui";
import { Modal } from "../Modal";
import { usePickerStackEntry } from "../pickerStack";
import { EntityPickerList } from "./EntityPickerList";
import type { EntityOption } from "./catalog";

/**
 * 实体选择弹窗：受控开合，选中即回调并关闭
 *
 * 全管理端的「挑一个装备 / 技能 / 物品 / 时装 / 称号档」都走它 —— 调用方只要把
 * `catalog.entityOptions(kind)`（必要时先过滤）传进来，不需要写搜索框、分组、网格、分页。
 *
 * 外壳复用 `Modal`（Esc、遮罩关闭、内容区滚动都由它统一提供）：这里**不再自己写一层
 * `fixed inset-0`** —— 那正是「同一类东西两份实现」的来源，两份的关闭行为迟早不一致。
 *
 * 每次打开都重置搜索与分组（`resetKey` = open）：否则上一次挑装备的「武器」分组会
 * 带到下一次选技能里，界面上看起来像「没有可选的东西」。
 *
 * ## 多选（`multiple`）
 * 传 `multiple` + `onSelectMany` 时，点一项是「勾 / 取消」，底部出现「加入 N 项」——
 * 给「一次往条目池里塞十几样东西」用的（掉落条目以前只能一条一条加，每加一条要开一次弹窗）。
 * 单选路径完全不变：点一项 `onSelect(id)` 后立即关闭。
 *
 * 与 `ImagePicker` 一样登记到 `pickerStack`：选择器叠在编辑弹窗上时，编辑弹窗的
 * `onClose` 要靠 `anyPickerOpen()` 放行，否则「关选择器」会顺手把编辑弹窗一起关掉。
 */
export function EntityPicker({
  open,
  title,
  hint,
  options,
  current,
  emptyHint,
  multiple = false,
  onSelect,
  onSelectMany,
  onClose,
}: {
  open: boolean;
  title: string;
  hint?: string;
  options: EntityOption[];
  current?: string;
  /** 列表为空时的说明（不同调用方的「为什么没有」不一样） */
  emptyHint?: string;
  /** 多选：勾若干项后一次性交回 */
  multiple?: boolean;
  /** 单选回调（多选时不需要，走 `onSelectMany`） */
  onSelect?: (id: string) => void;
  /** 多选时的提交回调（与 `onSelect` 二选一，`multiple` 时用它） */
  onSelectMany?: (ids: string[]) => void;
  onClose: () => void;
}) {
  usePickerStackEntry(open);
  const [picked, setPicked] = useState<string[]>([]);

  // 每次打开都从空开始：上一次的勾选不该跟着带进来（尤其「批量添加」重复打开时）
  useEffect(() => {
    if (open) setPicked([]);
  }, [open]);

  const toggle = (id: string) => {
    setPicked((previous) => (previous.includes(id) ? previous.filter((item) => item !== id) : [...previous, id]));
  };

  return (
    <Modal
      open={open}
      title={title}
      hint={hint ?? (multiple ? "点若干项勾选，底部「加入」一次带回。" : "点一项即选中；列表为空说明客户端配置里没有这一类数据。")}
      size="lg"
      onClose={onClose}
      footer={
        multiple ? (
          <>
            <span className="mr-auto text-[11px] text-slate-500">已选 {picked.length} 项</span>
            <Button variant="outline" disabled={picked.length === 0} onClick={() => setPicked([])}>
              清空
            </Button>
            <Button variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button
              disabled={picked.length === 0}
              onClick={() => {
                onSelectMany?.(picked);
                onClose();
              }}
            >
              加入 {picked.length} 项
            </Button>
          </>
        ) : undefined
      }
    >
      <EntityPickerList
        options={options}
        current={current}
        selected={multiple ? picked : undefined}
        emptyHint={emptyHint}
        resetKey={open}
        onPick={(id) => {
          if (multiple) {
            toggle(id);
            return;
          }
          onSelect?.(id);
          onClose();
        }}
      />
    </Modal>
  );
}
