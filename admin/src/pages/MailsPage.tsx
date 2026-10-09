import { useCallback, useEffect, useState } from "react";
import { accountsApi, formatTime, mailsApi, PERMISSION } from "../api";
import type { Account, MailJob, MailQuery, MailTemplate, PageResult, SendMail } from "../api";
import { Pagination } from "../components/Pagination";
import { SortableTh, useSort } from "../components/sortable";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Select,
  Spinner,
  tableClass,
  tdClass,
  thClass,
  theadClass,
} from "../components/ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";

const PAGE_SIZE = 10;

/** 状态配色（中文名用服务端给的 `statusLabel`，不在这里另抄一份） */
const STATUS_TONE: Record<string, "green" | "red" | "amber" | "indigo" | "slate"> = {
  pending: "slate",
  sending: "indigo",
  retrying: "amber",
  sent: "green",
  failed: "red",
};

/** 自定义模板：标题与正文由运营当场填（其余模板用变量渲染） */
const CUSTOM_KEY = "custom";

/** 还没到终态的状态（用于「要不要自动刷新」） */
const IN_FLIGHT = new Set(["pending", "sending", "retrying"]);

/**
 * 邮件（运营触达第二切片 · 通道侧）
 *
 * ## 发信为什么不是「点完就发完」
 * 投递是**异步**的：点「发送」只是把信放进队列，后台调度器按节奏投递，
 * 失败会指数退避重试、用尽次数才标失败。所以界面上永远有「待发送 / 重试中」这几种中间态，
 * 而这页要如实把它们显示出来 —— 假装同步等待只会让运营在 SMTP 挂掉时干等一个超时。
 *
 * ## 界面能显示，但服务端才是权威
 * 发送按钮按 `mail:write` 禁用只是体验；真越权请求会被权限守卫拦成 403 / 30006。
 * 只读观察员连这一页都进不来（`mail:read` 不给它：投递记录里有玩家邮箱）。
 */
export function MailsPage() {
  const canWrite = hasPermission(PERMISSION.MAIL_WRITE);
  // 关联玩家要用账号检索接口，没有「查看账号」权限时干脆不给这个入口
  const canReadAccount = hasPermission(PERMISSION.ACCOUNT_READ);

  // —— 发信表单 ——
  const [templates, setTemplates] = useState<MailTemplate[]>([]);
  const [to, setTo] = useState("");
  const [templateKey, setTemplateKey] = useState("");
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [accountKeyword, setAccountKeyword] = useState("");
  const [accountOptions, setAccountOptions] = useState<Account[]>([]);
  const [account, setAccount] = useState<Account | null>(null);
  const [searching, setSearching] = useState(false);
  const [sending, setSending] = useState(false);

  // —— 投递记录 ——
  const [draft, setDraft] = useState({ keyword: "", status: "" });
  const [query, setQuery] = useState({ keyword: "", status: "" });
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(PAGE_SIZE);
  const [data, setData] = useState<PageResult<MailJob> | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  // 与服务端默认（createdAt 倒序）保持一致，免得表头箭头骗人
  const { sort, order, toggle } = useSort({ initial: { sort: "createdAt", order: "desc" }, onChange: () => setPage(1) });

  const loadTemplates = useCallback(async () => {
    try {
      const list = await mailsApi.templates();
      setTemplates(list);
      // 默认选第一个（欢迎邮件），运营最常见的路径就是它
      setTemplateKey((current) => current || list[0]?.key || "");
    } catch {
      /* 错误已由请求层统一提示 */
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(
        await mailsApi.list({
          page,
          size,
          keyword: query.keyword || undefined,
          status: (query.status || undefined) as MailQuery["status"],
          sort,
          order,
        }),
      );
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, [page, size, query, sort, order]);

  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 有「还没投完」的任务时自动刷新
   *
   * 邮件是异步投递的，不自动刷新的话运营得一直手动点 —— 而「到底发没发出去」
   * 恰恰是他最想知道的事。终态（已发送 / 最终失败）不会变，所以那时停掉轮询。
   */
  useEffect(() => {
    const inFlight = (data?.list ?? []).some((item) => IN_FLIGHT.has(item.status));
    if (!inFlight) return;
    const timer = setInterval(() => void load(), 3_000);
    return () => clearInterval(timer);
  }, [data, load]);

  const template = templates.find((item) => item.key === templateKey) ?? null;
  const isCustom = templateKey === CUSTOM_KEY;

  const searchAccounts = async () => {
    if (!accountKeyword.trim()) return;
    setSearching(true);
    try {
      const result = await accountsApi.list({ keyword: accountKeyword.trim(), size: 10 });
      setAccountOptions(result.list);
      if (result.list.length === 0) toastSuccess("没有匹配的账号");
    } catch {
      /* 统一提示 */
    } finally {
      setSearching(false);
    }
  };

  const submitSend = async () => {
    setSending(true);
    try {
      const result = await mailsApi.send({
        to: to.trim(),
        // 下拉框给的是字符串，枚举字段要收口（服务端也会拒非法值，但类型层面必须先过）
        templateKey: templateKey as SendMail["templateKey"],
        accountId: account?.id,
        variables: isCustom ? undefined : variables,
        subject: isCustom ? subject : undefined,
        body: isCustom ? body : undefined,
      });
      toastSuccess(`已加入投递队列（${result.status === "pending" ? "等待后台发送" : result.status}）`);
      setTo("");
      setVariables({});
      setSubject("");
      setBody("");
      setAccount(null);
      setAccountOptions([]);
      setAccountKeyword("");
      setPage(1);
      await load();
    } catch {
      /* 统一提示（含「邮件通道未启用」这类可展示的业务错误） */
    } finally {
      setSending(false);
    }
  };

  const retry = async (item: MailJob) => {
    setBusyId(item.id);
    try {
      await mailsApi.retry(item.id);
      toastSuccess("已重新放回队列");
      await load();
    } catch {
      /* 统一提示 */
    } finally {
      setBusyId(null);
    }
  };

  const submitSearch = () => {
    setPage(1);
    setQuery({ ...draft, keyword: draft.keyword.trim() });
  };

  const resetSearch = () => {
    const empty = { keyword: "", status: "" };
    setDraft(empty);
    setPage(1);
    setQuery(empty);
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-50">邮件</h1>
        <p className="mt-1 text-xs text-slate-500">
          给指定玩家发邮件。<strong className="text-slate-400">点「发送」只是入队</strong>，后台调度器负责真正投递 ——
          失败会自动重试（指数退避），用尽次数才标为失败并保留原因。未配置 SMTP 时通道整体禁用，接口会直接说明原因。
        </p>
      </div>

      <Card title="发送邮件" description={canWrite ? undefined : "当前角色没有「发送邮件」权限，表单只读。"}>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[240px] flex-1">
              <span className="mb-1.5 block text-xs font-medium text-slate-400">收件邮箱</span>
              <Input
                value={to}
                placeholder="player@example.com"
                disabled={!canWrite}
                onChange={(event) => setTo(event.target.value)}
              />
            </div>
            <div className="w-48">
              <span className="mb-1.5 block text-xs font-medium text-slate-400">模板</span>
              <Select
                value={templateKey}
                disabled={!canWrite}
                onChange={(event) => {
                  setTemplateKey(event.target.value);
                  setVariables({});
                }}
              >
                {templates.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          {template ? <p className="text-xs text-slate-500">{template.hint}</p> : null}

          {canReadAccount ? (
            <div>
              <span className="mb-1.5 block text-xs font-medium text-slate-400">关联玩家账号（可选，只为追溯）</span>
              {account ? (
                <div className="flex items-center gap-2 text-sm text-slate-300">
                  <Badge tone="indigo">{account.username}</Badge>
                  <span className="text-xs text-slate-500">（不是投递凭据，不填也照样发）</span>
                  <Button variant="outline" className="px-2.5 py-1 text-xs" onClick={() => setAccount(null)}>
                    取消关联
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    className="w-56"
                    value={accountKeyword}
                    placeholder="按账号名搜索"
                    disabled={!canWrite}
                    onChange={(event) => setAccountKeyword(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void searchAccounts();
                    }}
                  />
                  <Button variant="outline" disabled={!canWrite} loading={searching} onClick={() => void searchAccounts()}>
                    搜索
                  </Button>
                  {accountOptions.map((item) => (
                    <Button
                      key={item.id}
                      variant="outline"
                      className="px-2.5 py-1 text-xs"
                      onClick={() => {
                        setAccount(item);
                        setAccountOptions([]);
                      }}
                    >
                      {item.username}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          ) : null}

          {/* 模板变量：按模板声明的必填项动态生成 —— 模板是数据，界面不硬编码有哪些变量 */}
          {!isCustom && template?.variables.length ? (
            <div className="flex flex-wrap items-end gap-3">
              {template.variables.map((name) => (
                <div key={name} className="min-w-[180px] flex-1">
                  <span className="mb-1.5 block text-xs font-medium text-slate-400">{name}</span>
                  <Input
                    value={variables[name] ?? ""}
                    disabled={!canWrite}
                    placeholder={`${name}（必填）`}
                    onChange={(event) => setVariables({ ...variables, [name]: event.target.value })}
                  />
                </div>
              ))}
            </div>
          ) : null}

          {isCustom ? (
            <div className="flex flex-col gap-3">
              <div>
                <span className="mb-1.5 block text-xs font-medium text-slate-400">标题</span>
                <Input value={subject} disabled={!canWrite} onChange={(event) => setSubject(event.target.value)} />
              </div>
              <div>
                <span className="mb-1.5 block text-xs font-medium text-slate-400">正文（纯文本）</span>
                <textarea
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-indigo-500"
                  rows={4}
                  value={body}
                  disabled={!canWrite}
                  onChange={(event) => setBody(event.target.value)}
                />
              </div>
            </div>
          ) : null}

          <div>
            <Button disabled={!canWrite || !to.trim()} loading={sending} onClick={() => void submitSend()}>
              发送（加入队列）
            </Button>
          </div>
        </div>
      </Card>

      <Card title="投递记录" actions={loading ? <Spinner /> : null}>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">邮箱 / 标题 / 账号名</span>
            <Input
              value={draft.keyword}
              placeholder="支持模糊匹配"
              onChange={(event) => setDraft({ ...draft, keyword: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitSearch();
              }}
            />
          </div>
          <div className="w-40">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">状态</span>
            <Select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value })}>
              <option value="">全部</option>
              <option value="pending">待发送</option>
              <option value="sending">发送中</option>
              <option value="retrying">重试中</option>
              <option value="sent">已发送</option>
              <option value="failed">发送失败</option>
            </Select>
          </div>
          <Button onClick={submitSearch}>查询</Button>
          <Button variant="outline" onClick={resetSearch}>
            重置
          </Button>
          <Button variant="outline" onClick={() => void load()}>
            刷新
          </Button>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <SortableTh label="收件邮箱" field="toEmail" sort={sort} order={order} onToggle={toggle} />
                <th className={thClass}>关联账号</th>
                <th className={thClass}>标题</th>
                <SortableTh label="状态" field="status" sort={sort} order={order} onToggle={toggle} />
                <SortableTh label="已尝试" field="attempts" sort={sort} order={order} onToggle={toggle} />
                <th className={thClass}>失败原因</th>
                <th className={thClass}>发起人</th>
                <SortableTh label="入队时间" field="createdAt" sort={sort} order={order} onToggle={toggle} />
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {data?.list.map((item) => (
                <tr key={item.id} className="transition hover:bg-slate-800/30">
                  <td className={tdClass}>
                    <span className="block max-w-[200px] truncate text-slate-100" title={item.to}>
                      {item.to}
                    </span>
                  </td>
                  <td className={tdClass}>{item.accountName ?? <span className="text-slate-600">未关联</span>}</td>
                  <td className={tdClass}>
                    <span className="block max-w-[240px] truncate text-slate-300" title={item.subject}>
                      {item.subject}
                    </span>
                    <span className="mt-0.5 block max-w-[240px] truncate text-xs text-slate-500" title={item.body}>
                      {item.body}
                    </span>
                  </td>
                  <td className={tdClass}>
                    <Badge tone={STATUS_TONE[item.status] ?? "slate"}>{item.statusLabel}</Badge>
                  </td>
                  <td className={tdClass}>{item.attempts}</td>
                  <td className={`${tdClass} max-w-[220px] text-xs text-red-300`}>
                    <span className="block truncate" title={item.lastError ?? ""}>
                      {item.lastError ?? "—"}
                    </span>
                  </td>
                  <td className={tdClass}>{item.createdBy ?? "—"}</td>
                  <td className={tdClass}>{formatTime(item.createdAt)}</td>
                  <td className={`${tdClass} text-right`}>
                    {/* 只有最终失败的能重投：其它状态重投会造成重复发信 */}
                    <Button
                      variant="outline"
                      className="px-2.5 py-1 text-xs"
                      disabled={!canWrite || item.status !== "failed"}
                      loading={busyId === item.id}
                      onClick={() => void retry(item)}
                    >
                      重投
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!loading && data && data.list.length === 0 ? (
          <EmptyState title="没有投递记录" description="发一封试试，或换个筛选条件" />
        ) : null}

        <Pagination
          page={page}
          size={size}
          total={data?.total ?? 0}
          onChange={setPage}
          onSizeChange={(value) => {
            setSize(value);
            setPage(1);
          }}
        />
      </Card>
    </div>
  );
}
