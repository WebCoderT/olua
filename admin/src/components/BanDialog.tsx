import { useEffect, useState } from "react";
import { BAN_DURATION_MAX_HOURS, BAN_DURATION_PRESETS, BAN_REASON_MAX_LENGTH } from "../api";
import { Button, Field, Input, Select } from "./ui";
import { toastError } from "../store/toast";

/** 快选里代表「永久」的值（`Select` 的 value 只能是字符串，用这个常量对映 null） */
const FOREVER = "forever";
/** 快选里代表「自定义」的值 */
const CUSTOM = "custom";

/**
 * 封禁弹窗
 *
 * 只干一件事：收集「原因 + 时长」再交给调用方提交。
 *
 * 两个刻意的默认：
 * - 时长默认 **1 天**（运营里最常用的档），想永久封要显式选到「永久」—— 手滑不会把号封死；
 * - 原因**必填**：没有原因的封禁，玩家来问时谁也答不上来，事后也看不出这次封禁是否合理。
 */
export function BanDialog({
  open,
  targetName,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  /** 被封的账号名（文案用） */
  targetName: string;
  onCancel: () => void;
  /** 提交一次封禁；返回是否成功（失败时请求层已弹过提示，这里只决定要不要关闭） */
  onSubmit: (payload: { reason: string; durationHours: number | null }) => Promise<boolean>;
}) {
  const [reason, setReason] = useState("");
  const [preset, setPreset] = useState("24");
  const [customHours, setCustomHours] = useState("24");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setReason("");
    setPreset("24");
    setCustomHours("24");
    setSubmitting(false);
  }, [open]);

  if (!open) return null;

  /** 把「快选 / 自定义 / 永久」三种选择收敛成服务端的 durationHours（自定义非法时返回 undefined） */
  const resolveDuration = (): number | null | undefined => {
    if (preset === FOREVER) return null;
    if (preset !== CUSTOM) return Number(preset);
    const hours = Math.floor(Number(customHours));
    if (!Number.isFinite(hours) || hours < 1 || hours > BAN_DURATION_MAX_HOURS) return undefined;
    return hours;
  };

  const submit = async () => {
    const trimmed = reason.trim();
    if (!trimmed) {
      toastError("请填写封禁原因 —— 玩家来申诉时这是唯一的依据");
      return;
    }
    const duration = resolveDuration();
    if (duration === undefined) {
      toastError(`自定义时长请填 1~${BAN_DURATION_MAX_HOURS} 之间的整数小时`);
      return;
    }
    setSubmitting(true);
    const ok = await onSubmit({ reason: trimmed, durationHours: duration });
    setSubmitting(false);
    if (ok) onCancel();
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
        <h3 className="text-base font-semibold text-slate-100">封禁账号</h3>
        <p className="mt-2 text-sm text-slate-400">
          将对账号「{targetName}」执行封禁：
        </p>

        <div className="mt-4 flex flex-col gap-4">
          <Field label="封禁原因" hint={`最多 ${BAN_REASON_MAX_LENGTH} 字；玩家登录时会看到`}>
            <Input
              value={reason}
              maxLength={BAN_REASON_MAX_LENGTH}
              placeholder="例如：使用外挂脚本"
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>

          <Field label="封禁时长" hint="临时封禁到期会自动解封，不需要再来点一次">
            <Select value={preset} onChange={(event) => setPreset(event.target.value)}>
              {BAN_DURATION_PRESETS.map((item) => (
                <option key={item.label} value={item.hours === null ? FOREVER : String(item.hours)}>
                  {item.label}
                </option>
              ))}
              <option value={CUSTOM}>自定义…</option>
            </Select>
          </Field>

          {preset === CUSTOM ? (
            <Field label="自定义时长（小时）" hint={`1 ~ ${BAN_DURATION_MAX_HOURS}`}>
              <Input
                type="number"
                min={1}
                max={BAN_DURATION_MAX_HOURS}
                value={customHours}
                onChange={(event) => setCustomHours(event.target.value)}
              />
            </Field>
          ) : null}
        </div>

        <p className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          封禁<strong>立即生效</strong>：在线的玩家下一次请求就会被拒（客户端会收到「账号已被封禁并带上原因」），
          在线标记也会一并清除。永久封禁没有自动恢复，只能手动解封。
        </p>

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" disabled={submitting} onClick={onCancel}>
            取消
          </Button>
          <Button variant="danger" loading={submitting} onClick={() => void submit()}>
            确认封禁
          </Button>
        </div>
      </div>
    </div>
  );
}
