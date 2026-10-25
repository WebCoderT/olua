import { useEffect, useMemo, useState } from "react";
import { ACQUIRE_CHANNEL, ACQUIRE_CHANNEL_LABELS } from "../api";
import type { ConfigAttributes, Rank, Soul, Title } from "../api";
import { Button, Field, Input, Select } from "./ui";

/** 区间型属性的六项（与 ConfigAttributes 的区间字段一一对应；展示名在这里。装备配置页共用） */
export const RANGE_FIELDS = [
  { key: "physicalAttack", label: "物攻" },
  { key: "magicAttack", label: "魔攻" },
  { key: "taoistAttack", label: "道攻" },
  { key: "physicalDefense", label: "物防" },
  { key: "magicDefense", label: "魔防" },
  { key: "taoistDefense", label: "道防" },
] as const;

/** 弹窗表单值（channel 仅称号、tier 仅军衔有；不相关的 kind 传过来时忽略）。价格不在这里 —— 唯一修改口在成长列表（#232/#234/#250） */
export interface GameConfigFormValue {
  label: string;
  tier: string;
  description: string;
  animation: string;
  animationFrameRate: number;
  acquireChannel: string;
  attributes: ConfigAttributes;
}

/**
 * 养成配置（称号 / 战魂 / 军衔）编辑弹窗
 *
 * 三份配置的字段几乎同构（称号多获得渠道、战魂/军衔无渠道、军衔无动画只有大段名），
 * 共用一个弹窗，`kind` 只影响：标题文案 + 渠道下拉 / 动画输入是否出现 + 大段名输入是否出现。
 * 属性**整份提交、整份替换**（服务端口径），所以表单里八项全部展示、全部回填 ——
 * 没有只改一行的快捷路径，避免「以为只改了攻击结果把防御清零」这类事故。
 *
 * **价格（升级价格 / 升级消耗 / 晋升消耗）不在这个弹窗里**：唯一显示与修改口是各自的
 * 成长列表（#232/#234/#250），提交时原样带回当前值，绝不因弹窗保存而改动价格。
 *
 * 校验分工：必填与 min ≤ max 在这里做**即时提示**（省一次来回），权威在服务端
 * （DTO 校验 + 50010/50011/50015/40000）。
 */
export function GameConfigDialog({
  kind,
  open,
  initial,
  onCancel,
  onSubmit,
}: {
  kind: "title" | "soul" | "rank";
  open: boolean;
  initial: Title | Soul | Rank | null;
  onCancel: () => void;
  /** 提交；返回是否成功（失败时请求层已统一弹过提示，弹窗保持打开） */
  onSubmit: (value: GameConfigFormValue) => Promise<boolean>;
}) {
  const [label, setLabel] = useState("");
  const [tier, setTier] = useState("");
  const [description, setDescription] = useState("");
  const [animation, setAnimation] = useState("");
  const [frameRate, setFrameRate] = useState("8");
  const [channel, setChannel] = useState<string>(ACQUIRE_CHANNEL.UNAVAILABLE);
  const [attributes, setAttributes] = useState<ConfigAttributes | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // 每次打开都按当前记录重置（编辑另一条时不残留上一条的内容）
  useEffect(() => {
    if (!open) return;
    setLabel(initial?.label ?? "");
    setTier("tier" in (initial ?? {}) ? String((initial as Rank).tier) : "");
    setDescription(initial?.description ?? "");
    const source = initial as Partial<Title> | null;
    setAnimation(typeof source?.animation === "string" ? source.animation : "");
    setFrameRate(typeof source?.animationFrameRate === "number" ? String(source.animationFrameRate) : "8");
    setChannel("acquireChannel" in (initial ?? {}) ? String((initial as Title).acquireChannel) : ACQUIRE_CHANNEL.UNAVAILABLE);
    setAttributes(initial?.attributes ? { ...initial.attributes } : null);
    setSubmitting(false);
  }, [open, initial]);

  const level = initial?.level ?? 0;
  const unit = kind === "title" ? "级" : "阶";
  const kindName = kind === "title" ? "称号" : kind === "soul" ? "战魂" : "军衔";
  /** 军衔没有动画资源（外观是头顶一行红字），弹窗不出现动画两栏 */
  const hasAnimation = kind !== "rank";

  /** 区间交叉（min > max）的键集合；空 = 合法 */
  const crossedKeys = useMemo(() => {
    if (!attributes) return [];
    return RANGE_FIELDS.filter(({ key }) => attributes[key].min > attributes[key].max).map(({ key }) => key);
  }, [attributes]);

  if (!open || !attributes) return null;

  const numbersValid = !hasAnimation || (Number.isInteger(Number(frameRate)) && Number(frameRate) >= 1);
  const animationValid = !hasAnimation || animation.trim().length > 0;
  const canSubmit = label.trim().length > 0 && animationValid && numbersValid && crossedKeys.length === 0 && !submitting;

  const setRange = (key: (typeof RANGE_FIELDS)[number]["key"], side: "min" | "max", value: string) => {
    const parsed = Math.max(0, Math.floor(Number(value) || 0));
    setAttributes({ ...attributes, [key]: { ...attributes[key], [side]: parsed } });
  };

  const submit = async () => {
    setSubmitting(true);
    const ok = await onSubmit({
      label: label.trim(),
      tier: tier.trim(),
      description: description.trim(),
      animation: animation.trim(),
      animationFrameRate: Number(frameRate),
      acquireChannel: channel,
      attributes,
    });
    setSubmitting(false);
    if (!ok) return;
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
        <h3 className="text-base font-semibold text-slate-100">
          编辑{kindName} · {level} {unit}
        </h3>
        <p className="mt-1 text-xs text-slate-500">
          等级序列固定（不可新增 / 删除）。属性整份替换：下方八项会一起提交，改错请整行对照。
        </p>

        <div className="mt-5 flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="名称">
              <Input value={label} onChange={(event) => setLabel(event.target.value)} />
            </Field>
            {kind === "title" ? (
              <Field label="获得渠道" hint="「系统赠送」的发放逻辑暂未实现，仅先记录渠道">
                <Select value={channel} onChange={(event) => setChannel(event.target.value)}>
                  {Object.entries(ACQUIRE_CHANNEL_LABELS).map(([value, text]) => (
                    <option key={value} value={value}>
                      {text}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            {kind === "rank" ? (
              <Field label="大段名" hint="军衔 10 大段的段名（如「校尉」），弹窗列表与徽记展示用">
                <Input value={tier} onChange={(event) => setTier(event.target.value)} />
              </Field>
            ) : null}
          </div>

          <Field label="描述">
            <Input value={description} onChange={(event) => setDescription(event.target.value)} />
          </Field>

          {hasAnimation ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="动画资源目录" hint="resources 相对路径">
                <Input value={animation} onChange={(event) => setAnimation(event.target.value)} />
              </Field>
              <Field label="动画帧率">
                <Input
                  type="number"
                  min={1}
                  value={frameRate}
                  onChange={(event) => setFrameRate(event.target.value)}
                />
              </Field>
            </div>
          ) : null}

          <div>
            <span className="mb-2 block text-xs font-medium text-slate-400">属性加成（整份替换）</span>
            <div className="grid grid-cols-1 gap-3 rounded-xl border border-slate-800 bg-slate-950/40 p-4 sm:grid-cols-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-slate-400">生命上限</span>
                <Input
                  type="number"
                  min={0}
                  className="w-28"
                  value={attributes.maxHp}
                  onChange={(event) =>
                    setAttributes({ ...attributes, maxHp: Math.max(0, Math.floor(Number(event.target.value) || 0)) })
                  }
                />
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-slate-400">每 5 秒回血</span>
                <Input
                  type="number"
                  min={0}
                  className="w-28"
                  value={attributes.hpRecover}
                  onChange={(event) =>
                    setAttributes({ ...attributes, hpRecover: Math.max(0, Math.floor(Number(event.target.value) || 0)) })
                  }
                />
              </div>
              {RANGE_FIELDS.map(({ key, label: fieldLabel }) => (
                <div key={key} className="flex items-center justify-between gap-2">
                  <span className="text-xs text-slate-400">{fieldLabel}</span>
                  <div className="flex items-center gap-1">
                    <Input
                      type="number"
                      min={0}
                      className="w-20"
                      aria-label={`${fieldLabel}下限`}
                      value={attributes[key].min}
                      onChange={(event) => setRange(key, "min", event.target.value)}
                    />
                    <span className="text-xs text-slate-600">~</span>
                    <Input
                      type="number"
                      min={0}
                      className="w-20"
                      aria-label={`${fieldLabel}上限`}
                      value={attributes[key].max}
                      onChange={(event) => setRange(key, "max", event.target.value)}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {crossedKeys.length > 0 ? (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
              以下属性的下限不能大于上限：{crossedKeys.join("、")}。
            </p>
          ) : null}
          {!numbersValid ? (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
              帧率需为 ≥1 的整数。
            </p>
          ) : null}

        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" disabled={submitting} onClick={onCancel}>
            取消
          </Button>
          <Button disabled={!canSubmit} loading={submitting} onClick={() => void submit()}>
            保存修改
          </Button>
        </div>
      </div>
    </div>
  );
}
