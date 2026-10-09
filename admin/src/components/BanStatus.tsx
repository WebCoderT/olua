import { banStateOf, formatTime } from "../api";
import type { Account } from "../api";
import { Badge } from "./ui";

/**
 * 账号封禁状态（列表与详情共用）
 *
 * 「封禁已到期」是真实状态而不是显示错误：那个号现在就能登录，只是库里的状态列
 * 还没被定时器扫回去（最多晚一分钟）。用琥珀色单独标出来，运营一眼能分清
 * 「封着」和「该解了」。
 *
 * 列表里空间紧，原因与到期时间挂在 `title` 上；详情用 `showReason` 展开成一行小字。
 */
export function BanStatus({ account, showReason = false }: { account: Account; showReason?: boolean }) {
  const state = banStateOf(account);
  const detail = `${account.banReason ? `原因：${account.banReason}` : "未填写原因"}${
    account.banUntil !== null ? ` · 至 ${formatTime(account.banUntil)}` : " · 永久"
  }`;

  if (!state.banned) {
    return state.expired ? <Badge tone="amber">{state.text}</Badge> : <Badge tone="green">正常</Badge>;
  }
  if (!showReason) {
    return (
      <span title={detail}>
        <Badge tone="red">{state.text}</Badge>
      </span>
    );
  }
  return (
    <div className="flex flex-col items-start gap-1">
      <Badge tone="red">{state.text}</Badge>
      <span className="text-xs text-slate-500">{detail}</span>
    </div>
  );
}
