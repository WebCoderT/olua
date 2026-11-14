import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { gameMailsApi, PERMISSION } from "../api";
import type { MailView } from "../api";
import { PageHeader } from "../components/PageHeader";
import { EntityPickButton } from "../components/entity/EntityPickButton";
import { entityOptions } from "../components/entity/catalog";
import type { EntityOption } from "../components/entity/catalog";
import { Button, Card, Field, Input, Select } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";

/** 人工补发允许的两个频道（与服务端 ADMIN_SEND_CHANNELS 同口径；social / combat 是系统事实记录） */
const CHANNEL_OPTIONS = [
  { value: "system", label: "系统（system）" },
  { value: "reward", label: "奖励（reward）" },
] as const;

/**
 * 附件候选：物品总表（装备全量变体 + 药品 + 材料）+ 时装
 *
 * 服务端领取时才校验存在性（`gameMail` 发放走背包入包那条路），所以这里给的是**客户端的
 * 全部可入包物**；时装不在物品总表里（它走 `fashions` 表 + 单独穿戴），单独并进来。
 */
function attachOptions(): EntityOption[] {
  return [...entityOptions("item"), ...entityOptions("fashion")];
}

interface ItemLine {
  goodId: string;
  count: string;
}

/**
 * 发消息（#437：管理端消息补发入口，单发）
 *
 * 落库走服务端 `adminGameMail.send` → `GameMailService.send`（与成就兜底 / 好友申请同一个
 * 落库口子），所以这里只管把表单收集成服务端认的形状：
 * - 频道只给 system / reward 两项（social / combat 是系统自动产生的事实记录）；
 * - 附件是「预告」：玩家在消息中心点领取才真的到手；
 * - 收件人不要求在线 —— 邮件本来就是异步的。
 *
 * 权限点 `gameMail:send`：界面按权限显隐只是体验，服务端守卫才是权威。
 * 从角色运营台点「发消息」跳过来时 URL 会带上 `?roleId=…`，直接预填。
 */
export function MailSendPage() {
  const canSend = hasPermission(PERMISSION.GAME_MAIL_SEND);
  const [params] = useSearchParams();
  const options = useMemo(attachOptions, []);

  const [roleId, setRoleId] = useState(params.get("roleId") ?? "");
  const [channel, setChannel] = useState<string>("system");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [bindGold, setBindGold] = useState("");
  const [exp, setExp] = useState("");
  const [items, setItems] = useState<ItemLine[]>([]);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<MailView | null>(null);

  const updateItem = (index: number, patch: Partial<ItemLine>) => {
    setItems((prev) => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  };

  /** 收集成服务端入参：空串一律不传，「没填」与「填了 0」在这里就是一个意思 */
  const buildBody = () => {
    const numeric = (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return undefined;
      const value = Number(trimmed);
      return Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
    };
    return {
      channel: channel as "system" | "reward",
      title: title.trim(),
      body: body.trim() || undefined,
      bindGold: numeric(bindGold),
      exp: numeric(exp),
      items: items
        .filter((line) => line.goodId.trim() && Number(line.count) >= 1)
        .map((line) => ({ goodId: line.goodId.trim(), count: Math.floor(Number(line.count)) })),
    };
  };

  const submit = async () => {
    const target = roleId.trim();
    if (!target || !title.trim()) return;
    setSending(true);
    try {
      const mail = await gameMailsApi.send(target, buildBody());
      setSent(mail);
      toastSuccess(`已发进角色 ${target} 的收件箱`);
      // 发完清空内容但保留收件人：连续给同一个号补发是常态
      setTitle("");
      setBody("");
      setBindGold("");
      setExp("");
      setItems([]);
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setSending(false);
    }
  };

  const canSubmit = canSend && !!roleId.trim() && !!title.trim() && !sending;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <PageHeader
        title="发消息"
        description="给指定角色补发一封游戏内消息（收件箱「系统 / 奖励」两栏）。附件要玩家点领取才真的到手；收件人不需要在线。"
      />

      <Card className="flex flex-col gap-4 p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="收件角色 id" hint="角色运营台 → 详情页 → 「发消息」可自动带上">
            <Input value={roleId} onChange={(event) => setRoleId(event.target.value)} placeholder="role_xxx" disabled={!canSend} />
          </Field>
          <Field label="频道" hint="social / combat 是系统事实记录，不开放人工发送">
            <Select value={channel} onChange={(event) => setChannel(event.target.value)} disabled={!canSend}>
              {CHANNEL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="标题" hint="最长 60 字">
          <Input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={60} placeholder="补偿发放" disabled={!canSend} />
        </Field>

        <Field label="正文（可选）" hint="纯文本，最长 1000 字">
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            maxLength={1000}
            rows={4}
            placeholder="写点说明，玩家在消息中心能看到。"
            disabled={!canSend}
            className="w-full rounded-lg border border-line-strong bg-surface-2/60 px-3 py-2 text-sm text-ink-1 outline-none placeholder:text-ink-6 focus:border-gold disabled:opacity-50"
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="附件绑定元宝（可选）">
            <Input type="number" min={0} value={bindGold} onChange={(event) => setBindGold(event.target.value)} placeholder="不填 = 没有" disabled={!canSend} />
          </Field>
          <Field label="附件经验（可选）">
            <Input type="number" min={0} value={exp} onChange={(event) => setExp(event.target.value)} placeholder="不填 = 没有" disabled={!canSend} />
          </Field>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-ink-4">附件物品（可选，最多 20 条）</p>
            <Button variant="outline" onClick={() => setItems((prev) => [...prev, { goodId: "", count: "1" }])} disabled={!canSend || items.length >= 20}>
              加一件
            </Button>
          </div>
          {items.length === 0 ? (
            <p className="text-xs text-ink-6">没有物品附件 —— 只发绑定元宝 / 经验 / 纯文本也可以。</p>
          ) : (
            items.map((line, index) => (
              <div key={index} className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <EntityPickButton
                    value={line.goodId}
                    options={options}
                    kind="item"
                    pickerTitle={`选择第 ${index + 1} 件附件`}
                    hint="物品（装备 / 药品 / 材料）与时装都在这里；玩家在消息中心点领取才真的到手。"
                    emptyHint="附件清单是空的 —— 确认客户端配置已生成"
                    disabled={!canSend}
                    onChange={(goodId) => updateItem(index, { goodId })}
                  />
                </div>
                <Input
                  type="number"
                  min={1}
                  value={line.count}
                  onChange={(event) => updateItem(index, { count: event.target.value })}
                  className="w-24 shrink-0"
                  disabled={!canSend}
                />
                <Button variant="ghost" onClick={() => setItems((prev) => prev.filter((_, i) => i !== index))} disabled={!canSend}>
                  删除
                </Button>
              </div>
            ))
          )}
        </div>

        <div className="flex items-center gap-3">
          <Button variant="primary" onClick={submit} disabled={!canSubmit}>
            {sending ? "发送中…" : "发送"}
          </Button>
          {!canSend ? <p className="text-xs text-warn">当前管理员角色没有 gameMail:send 权限点，只能看不能发。</p> : null}
        </div>
      </Card>

      {sent ? (
        <Card className="flex flex-col gap-1 p-5">
          <p className="text-sm font-medium text-jade">已落进收件箱</p>
          <p className="text-xs text-ink-4">
            邮件 id <span className="font-mono text-ink-2">{sent.id}</span> · 频道 {sent.channel} · 标题「{sent.title}」
            {sent.bindGold > 0 || sent.exp > 0 || sent.attachments.length > 0 ? " · 附件待玩家领取" : " · 纯文本通知"}
          </p>
        </Card>
      ) : null}
    </div>
  );
}
