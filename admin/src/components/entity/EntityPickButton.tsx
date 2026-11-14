import { useMemo, useState } from "react";
import { EntityImage } from "./EntityImage";
import { EntityPicker } from "./EntityPicker";
import { entityImage, entityLabel, entityNote } from "./catalog";
import type { EntityKind, EntityOption } from "./catalog";

/**
 * 物品 / 装备 / 技能字段：一张「图标 + 名字 + 一行说明」的按钮，点一下开可视化选择器
 *
 * 为什么要有它：掉落条目从前是一个纯文本输入框，要人记 `drug_hp_1` / `weapon_1_p0s1` 这种 id ——
 * 拼错一个字符得等保存时被服务端 400 打回才知道。可选项本来就在客户端配置里（与服务端校验
 * 同一份 `ITEM_LABELS`），没理由让运营去背。这里把「选中值 + 预览 + 打开选择器 + Esc 放行」
 * 收成一行，调用方只管 `value` / `onChange`。
 *
 * 与 `IconField` 的分工：
 * - `IconField` 挑的是**素材文件**（resources 路径本身就是要存的值）；
 * - 这个挑的是**游戏数据行**（存的是 id，名字与图标都从 `catalog` 查出来）。
 * 两者都是「字段自带选择器」，页面不写弹窗、不写按钮 —— 少一处手写就少一处「选完把
 * 编辑弹窗一起关了」的坑（Esc 放行见 `pickerStack`）。
 *
 * 值不在候选清单里（旧数据 / 手改过的行）时**不装作没有值**：照实显示那个 id，并标一句
 * 「清单里没有」，让运营知道该重挑一个，而不是以为字段是空的。
 */
export function EntityPickButton({
  value,
  options,
  onChange,
  pickerTitle = "选择物品",
  placeholder = "点这里挑物品",
  hint,
  emptyHint,
  kind = "item",
  disabled = false,
}: {
  value: string;
  /** 候选清单（调用方给，如 `entityOptions("item")`；也可先按业务过滤） */
  options: EntityOption[];
  onChange: (id: string) => void;
  /** 选择器弹窗标题 */
  pickerTitle?: string;
  /** 空值时的提示文案 */
  placeholder?: string;
  /** 选择器里的说明（如「只列出可进背包的物品」） */
  hint?: string;
  /** 清单为空时的说明 */
  emptyHint?: string;
  /** 值不在清单里时按这一类查名字 / 图标（掉落是物品，邮件附件可能是时装） */
  kind?: EntityKind;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);

  const option = useMemo(() => options.find((row) => row.id === value), [options, value]);
  // 查不到也把名字 / 图标尽力查出来：至少让人看到「这是哪个 id」，而不是一片空白
  const label = option?.label ?? (value ? entityLabel(kind, value) || value : "");
  const note = option?.note ?? (value ? entityNote(kind, value) : "");
  const image = option?.image ?? (value ? entityImage(kind, value) : {});
  const unknown = !!value && !option;

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        title={value ? `${label}（${value}）` : placeholder}
        onClick={() => setOpen(true)}
        className={`flex min-w-0 items-center gap-2 rounded-lg border p-1.5 text-left transition disabled:opacity-50 ${
          unknown
            ? "border-warn/30 bg-warn/5 hover:border-warn/50"
            : "border-line bg-surface-2/60 hover:border-line-strong hover:bg-surface-4/60"
        } w-full`}
      >
        <EntityImage image={image} alt={label} size={28} />
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-xs ${value ? "text-ink-1" : "text-ink-5"}`}>{value ? label : placeholder}</span>
          <span className={`block truncate text-[10px] ${unknown ? "text-warn-hi/90" : "text-ink-5"}`}>
            {unknown ? `清单里没有这个 id：${value}` : note || (value ? value : "点一下可视化挑")}
          </span>
        </span>
      </button>
      {open ? (
        <EntityPicker
          open
          title={pickerTitle}
          hint={hint}
          options={options}
          current={value}
          emptyHint={emptyHint}
          onSelect={onChange}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
