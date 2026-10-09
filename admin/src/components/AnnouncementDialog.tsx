import { useEffect, useState } from "react";
import { ANNOUNCEMENT_LEVEL, ANNOUNCEMENT_LEVEL_LABELS, localInputToMs, msToLocalInput } from "../api";
import type { Announcement } from "../api";
import { Button, Field, Input, Select } from "./ui";

/** 标题 / 正文的长度上限（与服务端 DTO 的校验一致，仅用于即时提示与输入框限制） */
const TITLE_MAX = 60;
const CONTENT_MAX = 2000;

/**
 * 弹窗提交的值
 *
 * 与 `CreateAnnouncement` / `UpdateAnnouncement` 的字段一一对应，
 * 时间字段统一用「毫秒或 null」表示（界面上是 `datetime-local` 的字符串，
 * 转换走 api/types 里的 `msToLocalInput` / `localInputToMs`，不在这里另写一套）。
 */
export interface AnnouncementFormValue {
  title: string;
  content: string;
  level: string;
  enabled: boolean;
  startsAt: number | null;
  endsAt: number | null;
}

/**
 * 公告 新建 / 编辑 弹窗
 *
 * 两件事刻意**不做**：
 * 1. 不在这里判断权限 —— 调用方（页面）按 `announcement:write` 决定要不要打开它；
 * 2. 不把时间窗校验当权威 —— 只做「结束早于开始」的即时提示，真正的判据在服务端
 *    （跨字段校验 + 50002），这里只是省一次来回。
 */
export function AnnouncementDialog({
  open,
  initial,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  /** 传入 = 编辑该条；null = 新建 */
  initial: Announcement | null;
  onCancel: () => void;
  /** 提交；返回是否成功（失败时请求层已统一弹过提示） */
  onSubmit: (value: AnnouncementFormValue) => Promise<boolean>;
}) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [level, setLevel] = useState<string>(ANNOUNCEMENT_LEVEL.NORMAL);
  const [enabled, setEnabled] = useState(true);
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // 每次打开都按当前记录重置表单（关掉再打开另一条时不该残留上一条的内容）
  useEffect(() => {
    if (!open) return;
    setTitle(initial?.title ?? "");
    setContent(initial?.content ?? "");
    setLevel(initial?.level ?? ANNOUNCEMENT_LEVEL.NORMAL);
    setEnabled(initial?.enabled ?? true);
    setStartsAt(msToLocalInput(initial?.startsAt ?? null));
    setEndsAt(msToLocalInput(initial?.endsAt ?? null));
    setSubmitting(false);
  }, [open, initial]);

  if (!open) return null;

  const startMs = startsAt ? localInputToMs(startsAt) ?? null : null;
  const endMs = endsAt ? localInputToMs(endsAt) ?? null : null;
  const rangeInvalid = startMs !== null && endMs !== null && endMs <= startMs;
  const canSubmit = title.trim().length > 0 && content.trim().length > 0 && !rangeInvalid && !submitting;

  const submit = async () => {
    setSubmitting(true);
    const ok = await onSubmit({
      title: title.trim(),
      content: content.trim(),
      level,
      enabled,
      startsAt: startMs,
      endsAt: endMs,
    });
    setSubmitting(false);
    if (!ok) return;
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
        <h3 className="text-base font-semibold text-slate-100">{initial ? "编辑公告" : "发布公告"}</h3>
        <p className="mt-1 text-xs text-slate-500">
          时间窗留空表示「立即生效 / 不设截止」—— 不要为了「长期有效」编一个很远的结束时间，它总会在某天真的到期。
        </p>

        <div className="mt-5 flex flex-col gap-4">
          <Field label="标题">
            <Input value={title} maxLength={TITLE_MAX} placeholder="例如：例行维护公告" onChange={(event) => setTitle(event.target.value)} />
          </Field>

          <Field label="正文" hint={`最多 ${CONTENT_MAX} 字，纯文本`}>
            <textarea
              className="min-h-[140px] w-full resize-y rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-indigo-500/70"
              value={content}
              maxLength={CONTENT_MAX}
              placeholder="正文内容，换行会原样保留"
              onChange={(event) => setContent(event.target.value)}
            />
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="级别">
              <Select value={level} onChange={(event) => setLevel(event.target.value)}>
                {Object.entries(ANNOUNCEMENT_LEVEL_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="生效开始" hint="留空 = 立即生效">
              <Input type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} />
            </Field>
            <Field label="生效结束" hint="留空 = 不设截止">
              <Input type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} />
            </Field>
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input type="checkbox" className="h-4 w-4 accent-indigo-500" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
            启用（停用后玩家立刻看不到，但记录与时间窗都还在）
          </label>

          {rangeInvalid ? (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
              生效结束时间必须晚于开始时间。
            </p>
          ) : null}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" disabled={submitting} onClick={onCancel}>
            取消
          </Button>
          <Button disabled={!canSubmit} loading={submitting} onClick={() => void submit()}>
            {initial ? "保存修改" : "发布"}
          </Button>
        </div>
      </div>
    </div>
  );
}
