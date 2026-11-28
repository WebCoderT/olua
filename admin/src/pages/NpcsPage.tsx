import { useCallback, useEffect, useState } from "react";
import { formatTime, npcsApi, PERMISSION } from "../api";
import type { CreateNpc, Npc, PageResult } from "../api";
import { FrameAnimation } from "../components/FrameAnimation";
import { IconField } from "../components/ImagePicker";
import { anyPickerOpen } from "../components/pickerStack";
import { Modal } from "../components/Modal";
import { NpcAlignWorkbench } from "../components/NpcAlignWorkbench";
import { Pagination } from "../components/Pagination";
import { Button, Card, EmptyState, Field, Input, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";
import { PageHeader } from "../components/PageHeader";

/**
 * NPC 配置管理（#258，#1379 起支持手动新建 / 删除）
 *
 * id 由运营手填（保留 0002 / 1001 / 9002 的分段习惯）；删除前服务端查地图点位与任务引用，
 * 有引用会 409 提示先删引用。#603 第七域起**客户端不再存 NPC 的任何显示数据**：名称、素材目录、
 * 缩放、偏移都在这张表里，改完下次进游戏由 `GET /game-config` 快照整表重建客户端 `npcs`。
 * 只有点击行为（弹哪个窗）还在客户端 `configs/npcClicks`（那是 UI 组件，不能进库）。
 * 对话文案 seed 为空串（客户端暂无对话数据形态），在这里运营可维护。写操作要 `gameConfig:write`。
 */

/** 新建表单初值（id / label 必填，其余给合法缺省） */
const EMPTY_CREATE: CreateNpc = {
  id: "",
  label: "",
  dialog: "",
  src: "",
  scaleX: 1,
  scaleY: 1,
  posX: 0,
  posY: 0,
};
export function NpcsPage() {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [draftKeyword, setDraftKeyword] = useState("");
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const [data, setData] = useState<PageResult<Npc> | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Npc | null>(null);
  const [form, setForm] = useState<Npc | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<CreateNpc>({ ...EMPTY_CREATE });
  const [deleting, setDeleting] = useState<Npc | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await npcsApi.list({ page, size, keyword: keyword || undefined }));
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, [page, size, keyword]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitSearch = () => {
    setPage(1);
    setKeyword(draftKeyword.trim());
  };

  const resetSearch = () => {
    setDraftKeyword("");
    setPage(1);
    setKeyword("");
  };

  /** 每页条数变化：回第一页再拉（条数变了页码语义也变了） */
  const handleSizeChange = (next: number) => {
    setSize(next);
    setPage(1);
  };

  const openEdit = (item: Npc) => {
    setEditing(item);
    setForm({ ...item });
  };

  const closeEdit = () => {
    setEditing(null);
    setForm(null);
  };

  /** 编辑弹窗提交（部分更新：只发弹窗里有的字段） */
  const submitEdit = async () => {
    if (!editing || !form) return;
    try {
      await npcsApi.update(editing.id, {
        label: form.label,
        dialog: form.dialog,
        src: form.src,
        scaleX: form.scaleX,
        scaleY: form.scaleY,
        posX: form.posX,
        posY: form.posY,
      });
      toastSuccess(`NPC「${form.label}」已更新`);
      closeEdit();
      await load();
    } catch {
      /* 失败保持弹窗打开，请求层已统一提示 */
    }
  };

  /** 新建：trim 后提交，成功后关弹窗并刷新（id 撞车 409 由请求层中文提示，保持弹窗） */
  const submitCreate = async () => {
    try {
      const created = await npcsApi.create({ ...draft, id: draft.id.trim(), label: draft.label.trim() });
      toastSuccess(`NPC「${created.id} · ${created.label}」已新建，去「地图管理」把它放到图上`);
      setCreating(false);
      setDraft({ ...EMPTY_CREATE });
      await load();
    } catch {
      /* 保持弹窗打开 */
    }
  };

  /** 删除：服务端有引用会 409（中文提示先删引用），那时保持确认弹窗打开 */
  const submitDelete = async () => {
    if (!deleting) return;
    try {
      await npcsApi.delete(deleting.id);
      toastSuccess(`NPC「${deleting.id} · ${deleting.label}」已删除`);
      setDeleting(null);
      await load();
    } catch {
      /* 保持弹窗打开 */
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="NPC 配置"
        description={<>id 由运营手填，可新建 / 编辑 / 删除（删除前会查地图点位与任务引用）。客户端不再存 NPC 的任何显示数据 ——
            名称 / 素材 / 缩放 / 偏移都在这里改，下次进游戏生效（点击行为仍在客户端按 id 接线）。</>}
        actions={
          <Button disabled={!canWrite} onClick={() => { setDraft({ ...EMPTY_CREATE }); setCreating(true); }}>
            新建 NPC
          </Button>
        }
      />

      <Card>
        <div className="flex flex-wrap items-end gap-2">
          <Field width="w-56" label="id / 名称">
              <Input
                value={draftKeyword}
                placeholder="支持模糊匹配"
                onChange={(event) => setDraftKeyword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") submitSearch();
                }}
              />
            </Field>
          <Button onClick={submitSearch}>查询</Button>
          <Button variant="outline" onClick={resetSearch}>
            重置
          </Button>
        </div>
      </Card>

      <Card
        title="NPC 列表"
        actions={loading ? <Spinner /> : null}
        description={canWrite ? undefined : "当前角色没有「修改养成配置」权限，列表只读。"}
      >
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>图</th>
                <th className={thClass}>id</th>
                <th className={thClass}>名称</th>
                <th className={thClass}>素材目录</th>
                <th className={thClass}>缩放 / 偏移</th>
                <th className={thClass}>对话</th>
                <th className={thClass}>更新时间</th>
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {data?.list.map((item) => (
                <tr key={item.id} className="transition hover:bg-surface-4/30">
                  <td className={tdClass}>
                    <FrameAnimation atlas={item.src} alt={item.label} />
                  </td>
                  <td className={`${tdClass} font-mono text-xs text-ink-3`}>{item.id}</td>
                  <td className={`${tdClass} font-medium text-ink-1`}>{item.label}</td>
                  <td className={`${tdClass} font-mono text-xs text-ink-4`}>{item.src || <span className="text-ink-6">（未配置，不显示）</span>}</td>
                  <td className={`${tdClass} whitespace-nowrap font-mono text-xs text-ink-4`}>
                    ×{item.scaleX} / ×{item.scaleY}
                    <br />
                    ({item.posX}, {item.posY})
                  </td>
                  <td className={`${tdClass} max-w-[360px] truncate text-xs text-ink-4`} title={item.dialog}>
                    {item.dialog || <span className="text-ink-6">（未配置）</span>}
                  </td>
                  <td className={`${tdClass} text-xs text-ink-4`}>{formatTime(item.updatedAt)}</td>
                  <td className={`${tdClass} text-right`}>
                    <div className="flex justify-end gap-1">
                      <Button variant="outline" className="px-2.5 py-1 text-xs" disabled={!canWrite} onClick={() => openEdit(item)}>
                        编辑
                      </Button>
                      <Button variant="danger" className="px-2.5 py-1 text-xs" disabled={!canWrite} onClick={() => setDeleting(item)}>
                        删除
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!loading && data && data.list.length === 0 ? <EmptyState title="没有匹配的 NPC" description="换个筛选条件试试" /> : null}

        <Pagination page={page} size={size} total={data?.total ?? 0} onChange={setPage} onSizeChange={handleSizeChange} />
      </Card>

      {form ? (
        <Modal
          open
          title={<>编辑 NPC · {editing?.id}</>}
          hint="部分更新：只提交下方字段；对话文案传空串 = 清空。"
          size="md"
          /* Esc 先到编辑弹窗：图片选择器开着时不能让弹窗一起关（改了一半的内容会丢） */
          onClose={() => {
            if (!anyPickerOpen()) closeEdit();
          }}
          footer={<>
            <Button variant="outline" onClick={closeEdit}>
              取消
            </Button>
            <Button disabled={!form.label.trim()} onClick={() => void submitEdit()}>
              保存修改
            </Button>
          </>}
        >
          <Field label="名称">
            <Input value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} />
          </Field>
          <IconField
            label="素材目录"
            hint="resources 下的相对路径（图集动画，如 npc/2125）；空串 = 该 NPC 不显示"
            mode="atlas"
            rootDir="npc"
            placeholder="npc/2125"
            value={form.src}
            onChange={(path) => setForm({ ...form, src: path })}
          />
          <Field label="对齐工作台" hint="拖画布调偏移、改数字调缩放；画布上看到的相对关系 = 游戏里摆出来的">
            <NpcAlignWorkbench
              src={form.src}
              label={form.label}
              value={{ scaleX: form.scaleX, scaleY: form.scaleY, posX: form.posX, posY: form.posY }}
              onChange={(next) => setForm({ ...form, ...next })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="横向偏移" hint="像素，0 = 不偏移（±4000）">
              <Input
                type="number"
                step="1"
                value={form.posX}
                onChange={(event) => setForm({ ...form, posX: Number(event.target.value) })}
              />
            </Field>
            <Field label="纵向偏移" hint="像素，0 = 不偏移（±4000）">
              <Input
                type="number"
                step="1"
                value={form.posY}
                onChange={(event) => setForm({ ...form, posY: Number(event.target.value) })}
              />
            </Field>
          </div>
          <Field label="对话文案" hint="客户端暂无对话数据形态，先在这里维护（≤2000 字）">
            <textarea
              className="min-h-[96px] w-full rounded-lg border border-line-strong bg-surface-0 px-3 py-2 text-sm text-ink-1 outline-none transition focus:border-jade"
              maxLength={2000}
              value={form.dialog}
              onChange={(event) => setForm({ ...form, dialog: event.target.value })}
            />
          </Field>
        </Modal>
      ) : null}

      {creating ? (
        <Modal
          open
          title="新建 NPC"
          hint="id 手填（字母 / 数字 / 下划线 / 短横线，1~32 位），保留 0002 / 1001 / 9002 的分段习惯；建完在地图管理里放到图上。"
          size="md"
          onClose={() => setCreating(false)}
          footer={
            <>
              <Button variant="outline" onClick={() => setCreating(false)}>取消</Button>
              <Button
                disabled={!/^[A-Za-z0-9_-]{1,32}$/.test(draft.id.trim()) || !draft.label.trim()}
                onClick={() => void submitCreate()}
              >
                新建
              </Button>
            </>
          }
        >
          <div className="grid grid-cols-2 gap-3">
            <Field label="id" hint="唯一；字母 / 数字 / 下划线 / 短横线，1~32 位">
              <Input value={draft.id} placeholder="如 9003" onChange={(event) => setDraft({ ...draft, id: event.target.value })} />
            </Field>
            <Field label="名称">
              <Input value={draft.label} placeholder="如 称号使者" onChange={(event) => setDraft({ ...draft, label: event.target.value })} />
            </Field>
          </div>
          <IconField
            label="素材目录"
            hint="resources 下的相对路径（图集动画，如 npc/2125）；可留空，建完再补"
            mode="atlas"
            rootDir="npc"
            placeholder="npc/2125"
            value={draft.src ?? ""}
            onChange={(path) => setDraft({ ...draft, src: path })}
          />
          <div className="grid grid-cols-2 gap-3">
            <Field label="横向缩放" hint="0.1~10，缺省 1">
              <Input type="number" step="0.1" min={0.1} max={10} value={draft.scaleX}
                onChange={(event) => setDraft({ ...draft, scaleX: Number(event.target.value) })} />
            </Field>
            <Field label="纵向缩放" hint="0.1~10，缺省 1">
              <Input type="number" step="0.1" min={0.1} max={10} value={draft.scaleY}
                onChange={(event) => setDraft({ ...draft, scaleY: Number(event.target.value) })} />
            </Field>
          </div>
          <Field label="对话文案" hint="可留空（≤2000 字）">
            <textarea
              className="min-h-[80px] w-full rounded-lg border border-line-strong bg-surface-0 px-3 py-2 text-sm text-ink-1 outline-none transition focus:border-jade"
              maxLength={2000}
              value={draft.dialog}
              onChange={(event) => setDraft({ ...draft, dialog: event.target.value })}
            />
          </Field>
        </Modal>
      ) : null}

      {deleting ? (
        <Modal
          open
          title="删除 NPC"
          hint="有地图点位或任务引用时会被服务端拒绝（提示先去对应页删引用），不会连带删除。"
          size="sm"
          onClose={() => setDeleting(null)}
          footer={
            <>
              <Button variant="outline" onClick={() => setDeleting(null)}>取消</Button>
              <Button variant="danger" onClick={() => void submitDelete()}>确认删除</Button>
            </>
          }
        >
          <p className="text-sm text-ink-2">
            确认删除 NPC「{deleting.id} · {deleting.label}」？此操作不可撤销。
          </p>
        </Modal>
      ) : null}
    </div>
  );
}
