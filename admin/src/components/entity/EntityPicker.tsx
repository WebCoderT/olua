import { Modal } from "../Modal";
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
 */
export function EntityPicker({
  open,
  title,
  hint,
  options,
  current,
  emptyHint,
  onSelect,
  onClose,
}: {
  open: boolean;
  title: string;
  hint?: string;
  options: EntityOption[];
  current?: string;
  /** 列表为空时的说明（不同调用方的「为什么没有」不一样） */
  emptyHint?: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      title={title}
      hint={hint ?? "点一项即选中；列表为空说明客户端配置里没有这一类数据。"}
      size="lg"
      onClose={onClose}
    >
      <EntityPickerList
        options={options}
        current={current}
        emptyHint={emptyHint}
        resetKey={open}
        onPick={(id) => {
          onSelect(id);
          onClose();
        }}
      />
    </Modal>
  );
}
