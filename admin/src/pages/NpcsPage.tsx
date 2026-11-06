import { useCallback, useEffect, useState } from "react";
import { formatTime, npcsApi, PERMISSION } from "../api";
import type { Npc, PageResult } from "../api";
import { FrameAnimation } from "../components/FrameAnimation";
import { IconField } from "../components/ImagePicker";
import { anyPickerOpen } from "../components/pickerStack";
import { Modal } from "../components/Modal";
import { Pagination } from "../components/Pagination";
import { Button, Card, EmptyState, Field, Input, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";
import { PageHeader } from "../components/PageHeader";

/**
 * NPC 配置管理（#258，养成配置第七页）
 *
 * id 清单固定（被 Tiled 地图对象组引用，启动时 seed 落库）——**没有「新建」「删除」**，
 * 只有「编辑」。#603 第七域起**客户端不再存 NPC 的任何显示数据**：名称、素材目录、缩放、
 * 偏移都在这张表里，改完下次进游戏由 `GET /game-config` 快照整表重建客户端 `npcs`。
 * 只有点击行为（弹哪个窗）还在客户端 `configs/npcClicks`（那是 UI 组件，不能进库）。
 * 对话文案 seed 为空串（客户端暂无对话数据形态），在这里运营可维护。写操作要 `gameConfig:write`。
 */
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

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="NPC 配置"
        description={<>id 清单固定（被 Tiled 地图对象组引用），只可编辑、不可新增 / 删除。客户端不再存 NPC 的任何显示数据 ——
            名称 / 素材 / 缩放 / 偏移都在这里改，下次进游戏生效（点击行为仍在客户端按 id 接线）。</>}
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
                <tr key={item.id} className="transition hover:bg-slate-800/30">
                  <td className={tdClass}>
                    <FrameAnimation atlas={item.src} alt={item.label} />
                  </td>
                  <td className={`${tdClass} font-mono text-xs text-slate-300`}>{item.id}</td>
                  <td className={`${tdClass} font-medium text-slate-100`}>{item.label}</td>
                  <td className={`${tdClass} font-mono text-xs text-slate-400`}>{item.src || <span className="text-slate-600">（未配置，不显示）</span>}</td>
                  <td className={`${tdClass} whitespace-nowrap font-mono text-xs text-slate-400`}>
                    ×{item.scaleX} / ×{item.scaleY}
                    <br />
                    ({item.posX}, {item.posY})
                  </td>
                  <td className={`${tdClass} max-w-[360px] truncate text-xs text-slate-400`} title={item.dialog}>
                    {item.dialog || <span className="text-slate-600">（未配置）</span>}
                  </td>
                  <td className={`${tdClass} text-xs text-slate-400`}>{formatTime(item.updatedAt)}</td>
                  <td className={`${tdClass} text-right`}>
                    <Button variant="outline" className="px-2.5 py-1 text-xs" disabled={!canWrite} onClick={() => openEdit(item)}>
                      编辑
                    </Button>
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
          <div className="grid grid-cols-2 gap-3">
            <Field label="横向缩放" hint="1 = 原尺寸（0.1~10）">
              <Input
                type="number"
                step="0.1"
                min={0.1}
                max={10}
                value={form.scaleX}
                onChange={(event) => setForm({ ...form, scaleX: Number(event.target.value) })}
              />
            </Field>
            <Field label="纵向缩放" hint="1 = 原尺寸（0.1~10）">
              <Input
                type="number"
                step="0.1"
                min={0.1}
                max={10}
                value={form.scaleY}
                onChange={(event) => setForm({ ...form, scaleY: Number(event.target.value) })}
              />
            </Field>
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
              className="min-h-[96px] w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-emerald-500"
              maxLength={2000}
              value={form.dialog}
              onChange={(event) => setForm({ ...form, dialog: event.target.value })}
            />
          </Field>
        </Modal>
      ) : null}
    </div>
  );
}
