import { useCallback, useEffect, useState } from "react";
import { announcementsApi, ANNOUNCEMENT_LEVEL_LABELS, formatTime, PERMISSION } from "../api";
import type { Announcement, AnnouncementQuery, CreateAnnouncement, PageResult, UpdateAnnouncement } from "../api";
import { AnnouncementDialog } from "../components/AnnouncementDialog";
import type { AnnouncementFormValue } from "../components/AnnouncementDialog";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Pagination } from "../components/Pagination";
import { SortableTh, useSort } from "../components/sortable";
import { Badge, Button, Card, EmptyState, Input, Select, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";

const PAGE_SIZE = 10;

/** 级别配色：重要标红，普通保持中性 */
const LEVEL_TONE: Record<string, "red" | "slate"> = {
  important: "red",
  normal: "slate",
};

/**
 * 生效状态的中文名与配色
 *
 * **「是不是生效中」由服务端给**（`active`，判据在服务端 SQL 里，与玩家侧拉取接口同源）；
 * 这里只负责把「为什么不在生效中」翻译出来给运营看 —— 停用 / 未开始 / 已过期三选一。
 * 即使本地时钟与服务端有偏差，也只是这三行文案会先变一下，不影响任何判定。
 */
function stateOf(item: Announcement): { label: string; tone: "green" | "red" | "amber" | "slate" } {
  if (!item.enabled) return { label: "已停用", tone: "red" };
  if (item.active) return { label: "生效中", tone: "green" };
  if (item.startsAt !== null && item.startsAt > Date.now()) return { label: "未开始", tone: "amber" };
  return { label: "已过期", tone: "slate" };
}

/** 时间窗的人读形式（null 分别表示「立即生效」「不设截止」） */
function windowText(item: Announcement): string {
  const from = item.startsAt === null ? "立即" : formatTime(item.startsAt);
  const to = item.endsAt === null ? "长期" : formatTime(item.endsAt);
  return `${from} → ${to}`;
}

/**
 * 公告管理（运营触达第一切片）
 *
 * 发布 / 编辑 / 删除三个写操作都要 `announcement:write`，只读观察员能看不能改 ——
 * 界面按权限禁用按钮只是体验，服务端权限守卫才是权威（越权会拿到 403 / 30006）。
 * 「生效中」这一列刻意不自己算时间，用服务端返回的 `active`。
 */
export function AnnouncementsPage() {
  const canWrite = hasPermission(PERMISSION.ANNOUNCEMENT_WRITE);
  const [draft, setDraft] = useState({ keyword: "", level: "", enabled: "", active: "" });
  const [query, setQuery] = useState({ keyword: "", level: "", enabled: "", active: "" });
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(PAGE_SIZE);
  const [data, setData] = useState<PageResult<Announcement> | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Announcement | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Announcement | null>(null);
  const [deleting, setDeleting] = useState(false);

  // 与服务端默认（updatedAt 倒序）保持一致，免得表头箭头骗人
  const { sort, order, toggle } = useSort({ initial: { sort: "updatedAt", order: "desc" }, onChange: () => setPage(1) });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(
        await announcementsApi.list({
          page,
          size,
          keyword: query.keyword || undefined,
          level: (query.level || undefined) as AnnouncementQuery["level"],
          enabled: (query.enabled || undefined) as AnnouncementQuery["enabled"],
          active: (query.active || undefined) as AnnouncementQuery["active"],
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
    void load();
  }, [load]);

  const submitSearch = () => {
    setPage(1);
    setQuery({ ...draft, keyword: draft.keyword.trim() });
  };

  const resetSearch = () => {
    const empty = { keyword: "", level: "", enabled: "", active: "" };
    setDraft(empty);
    setPage(1);
    setQuery(empty);
  };

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const openEdit = (item: Announcement) => {
    setEditing(item);
    setDialogOpen(true);
  };

  /** 新建 / 编辑共用入口（新建只发有值的字段，编辑走部分更新） */
  const submitDialog = async (value: AnnouncementFormValue): Promise<boolean> => {
    try {
      if (editing) {
        const body: UpdateAnnouncement = {
          title: value.title,
          content: value.content,
          level: value.level as UpdateAnnouncement["level"],
          enabled: value.enabled,
          startsAt: value.startsAt,
          endsAt: value.endsAt,
        };
        await announcementsApi.update(editing.id, body);
        toastSuccess("公告已更新");
      } else {
        const body: CreateAnnouncement = {
          title: value.title,
          content: value.content,
          level: value.level as CreateAnnouncement["level"],
          enabled: value.enabled,
          startsAt: value.startsAt ?? undefined,
          endsAt: value.endsAt ?? undefined,
        };
        await announcementsApi.create(body);
        toastSuccess("公告已发布");
      }
      setDialogOpen(false);
      setEditing(null);
      await load();
      return true;
    } catch {
      // 失败时保持弹窗打开，运营可以直接改完再提交（错误提示由请求层统一给）
      return false;
    }
  };

  /**
   * 启用 / 停用
   *
   * 只回传 `enabled` 一个字段 —— 这正是把编辑做成**部分更新**的用处：
   * 停用一条公告不该把它的正文按列表里的旧值覆盖回去。
   */
  const toggleEnabled = async (item: Announcement) => {
    setBusyId(item.id);
    try {
      await announcementsApi.update(item.id, { enabled: !item.enabled });
      toastSuccess(item.enabled ? "已停用，玩家立刻看不到" : "已启用");
      await load();
    } catch {
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await announcementsApi.remove(pendingDelete.id);
      toastSuccess(`已删除公告「${pendingDelete.title}」`);
      setPendingDelete(null);
      // 删掉的是本页最后一条且不在第一页时回退一页，否则原地刷新
      if (data && data.list.length === 1 && page > 1) setPage(page - 1);
      else await load();
    } catch {
      /* 统一提示 */
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-50">公告</h1>
          <p className="mt-1 text-xs text-slate-500">
            面向全服的运营消息。玩家侧由 <code className="text-slate-400">GET /announcements/active</code> 拉取「当前生效中」的那一批（无需登录，登录页也能显示）；
            生效 = 已启用 且 在时间窗内，两个条件由服务端判定。
          </p>
        </div>
        <Button disabled={!canWrite} onClick={openCreate}>
          发布公告
        </Button>
      </div>

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">标题 / 正文</span>
            <Input
              value={draft.keyword}
              placeholder="支持模糊匹配"
              onChange={(event) => setDraft({ ...draft, keyword: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitSearch();
              }}
            />
          </div>
          <div className="w-32">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">级别</span>
            <Select value={draft.level} onChange={(event) => setDraft({ ...draft, level: event.target.value })}>
              <option value="">全部</option>
              {Object.entries(ANNOUNCEMENT_LEVEL_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </div>
          <div className="w-32">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">生效状态</span>
            <Select value={draft.active} onChange={(event) => setDraft({ ...draft, active: event.target.value })}>
              <option value="">全部</option>
              <option value="true">生效中</option>
              <option value="false">不在生效窗口</option>
            </Select>
          </div>
          <div className="w-32">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">启用开关</span>
            <Select value={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.value })}>
              <option value="">全部</option>
              <option value="true">已启用</option>
              <option value="false">已停用</option>
            </Select>
          </div>
          <Button onClick={submitSearch}>查询</Button>
          <Button variant="outline" onClick={resetSearch}>
            重置
          </Button>
        </div>
      </Card>

      <Card
        title="公告列表"
        actions={loading ? <Spinner /> : null}
        description={canWrite ? undefined : "当前角色没有「发布 / 编辑公告」权限，列表只读。"}
      >
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <SortableTh label="标题" field="title" sort={sort} order={order} onToggle={toggle} />
                <SortableTh label="级别" field="level" sort={sort} order={order} onToggle={toggle} />
                <th className={thClass}>状态</th>
                <th className={thClass}>生效时间窗</th>
                <SortableTh label="启用" field="enabled" sort={sort} order={order} onToggle={toggle} />
                <th className={thClass}>发布人</th>
                <SortableTh label="更新时间" field="updatedAt" sort={sort} order={order} onToggle={toggle} />
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {data?.list.map((item) => {
                const state = stateOf(item);
                return (
                  <tr key={item.id} className="transition hover:bg-slate-800/30">
                    <td className={tdClass}>
                      <span className="block max-w-[260px] truncate font-medium text-slate-100" title={item.title}>
                        {item.title}
                      </span>
                      <span className="mt-0.5 block max-w-[260px] truncate text-xs text-slate-500" title={item.content}>
                        {item.content}
                      </span>
                    </td>
                    <td className={tdClass}>
                      <Badge tone={LEVEL_TONE[item.level] ?? "slate"}>{ANNOUNCEMENT_LEVEL_LABELS[item.level] ?? item.level}</Badge>
                    </td>
                    <td className={tdClass}>
                      <Badge tone={state.tone}>{state.label}</Badge>
                    </td>
                    <td className={`${tdClass} text-xs text-slate-400`}>{windowText(item)}</td>
                    <td className={tdClass}>{item.enabled ? <Badge tone="green">已启用</Badge> : <Badge tone="slate">已停用</Badge>}</td>
                    <td className={tdClass}>{item.createdBy ?? "—"}</td>
                    <td className={tdClass}>{formatTime(item.updatedAt)}</td>
                    <td className={`${tdClass} text-right`}>
                      <div className="flex justify-end gap-2">
                        <Button variant="outline" className="px-2.5 py-1 text-xs" disabled={!canWrite} onClick={() => openEdit(item)}>
                          编辑
                        </Button>
                        <Button
                          variant="outline"
                          className="px-2.5 py-1 text-xs"
                          disabled={!canWrite}
                          loading={busyId === item.id}
                          onClick={() => void toggleEnabled(item)}
                        >
                          {item.enabled ? "停用" : "启用"}
                        </Button>
                        <Button
                          variant="danger"
                          className="px-2.5 py-1 text-xs"
                          disabled={!canWrite}
                          onClick={() => setPendingDelete(item)}
                        >
                          删除
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {!loading && data && data.list.length === 0 ? (
          <EmptyState title="没有匹配的公告" description="换个筛选条件，或点右上角发布第一条公告" />
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

      <AnnouncementDialog
        open={dialogOpen}
        initial={editing}
        onCancel={() => {
          setDialogOpen(false);
          setEditing(null);
        }}
        onSubmit={submitDialog}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除公告"
        description={
          pendingDelete
            ? `将删除公告「${pendingDelete.title}」，不可恢复。如果只是想让它不再对玩家展示，请改用「停用」或设置结束时间。`
            : ""
        }
        confirmText="确认删除"
        loading={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
