import { useEffect, useState } from "react";
import type { MapCollision, MapDetail } from "../../api";
import { mapsApi, PERMISSION } from "../../api";
import { hasPermission } from "../../store/session";
import { toastSuccess } from "../../store/toast";
import { ConfirmDialog } from "../ConfirmDialog";
import { Modal } from "../Modal";
import { Button, Field, Input, Notice } from "../ui";
import { tiledBoxOf, worldBoxOf, type DrawBox } from "./MapCanvas";

/**
 * 碰撞盒表单（#676：管理端画完框就填它）
 *
 * ## 两种打开方式，同一份表单
 *
 * - **新建**：画布上拖完框 → 传 `draft`（Tiled 口径的矩形）；
 * - **编辑**：点图上已有的框 → 传 `box`（服务端返回的世界坐标）。
 *
 * ## 为什么这里是四个数字框，而不是「拖一拖就行」
 *
 * 碰撞盒经常要精确到像素（贴墙留 1px 缝、卡住门口的一段路），而画布上一个像素在 8192 的图上
 * 只对应屏幕上的 0.08px —— 拖出来的东西反而不准。所以画布负责「大概在哪」，
 * 这里负责「到底多少」。表单同时显示 Tiled 口径的左上角，方便对着 Tiled 编辑器改图的人核对。
 *
 * ## 允许超出地图边界
 *
 * 每张图四面围墙本来就画在图外（`x = -64`、宽 8320）。所以这里**不拦越界**，
 * 只在「整块在图外」时给一句提示 —— 那种盒子在画面上完全看不到，是数据错误的典型症状。
 */
export function CollisionFormDialog({
  open,
  mapId,
  detail,
  box,
  draft,
  onClose,
  onSaved,
}: {
  open: boolean;
  mapId: string;
  detail: MapDetail;
  /** 编辑态：服务端已有的那一行 */
  box: MapCollision | null;
  /** 新建态：画布上拖出来的框（Tiled 口径） */
  draft: DrawBox | null;
  onClose: () => void;
  /** 保存 / 删除成功后回调（上层据此刷新详情并提示） */
  onSaved: (message: string) => void;
}) {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [form, setForm] = useState({ cx: "", cy: "", w: "", h: "" });
  const [saving, setSaving] = useState(false);
  const [askingDelete, setAskingDelete] = useState(false);

  /** 打开时按当前形态重置（编辑读库里的值，新建用画布草稿换算出来的世界坐标） */
  useEffect(() => {
    if (!open) return;
    const initial = box ?? worldBoxOf(draft ?? { x: 0, y: 0, width: 0, height: 0 });
    setForm({ cx: String(initial.cx), cy: String(initial.cy), w: String(initial.w), h: String(initial.h) });
    setAskingDelete(false);
    // 只跟开合与目标走：把 form 放进依赖会让「用户正在输入」被自己覆盖
  }, [open, box?.id, draft]);

  if (!open) return null;

  const numbers = { cx: Number(form.cx), cy: Number(form.cy), w: Number(form.w), h: Number(form.h) };
  const valid =
    [numbers.cx, numbers.cy, numbers.w, numbers.h].every((value) => Number.isFinite(value)) &&
    numbers.w >= 1 &&
    numbers.h >= 1;
  // 与 Tiled 口径对照（左上角），只在数值有效时算 —— 填到一半显示乱码更糟
  const tiled = valid ? tiledBoxOf(numbers) : null;
  // 整块在图外：与 Tiled 口径无关，按世界坐标判（图的 y 范围是 [-height, 0]）。
  // 这里是**输入过程中的即时提示**（值还没落库，服务端算不出来）—— 权威值仍是保存后返回的
  // `fullyOutside`（`rectFullyOutside` 唯一判据），两处口径必须一致，改一处就要改另一处。
  const fullyOutside =
    valid &&
    (numbers.cx + numbers.w / 2 <= 0 ||
      numbers.cx - numbers.w / 2 >= detail.width ||
      numbers.cy - numbers.h / 2 >= 0 ||
      numbers.cy + numbers.h / 2 <= -detail.height);

  const submit = async () => {
    if (!valid || saving) return;
    setSaving(true);
    try {
      const body = { cx: round2(numbers.cx), cy: round2(numbers.cy), w: round2(numbers.w), h: round2(numbers.h) };
      const saved = box ? await mapsApi.updateCollision(mapId, String(box.id), body) : await mapsApi.createCollision(mapId, body);
      toastSuccess(`碰撞盒 #${saved.id} 已${box ? "更新" : "新建"}：(${saved.cx}, ${saved.cy}) ${saved.w}×${saved.h}`);
      onSaved(`${box ? "已更新" : "已新建"}碰撞盒 #${saved.id}`);
    } catch {
      /* 错误已由请求层统一提示（宽高不足 / 图不存在都有中文文案） */
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!box || saving) return;
    setSaving(true);
    try {
      await mapsApi.deleteCollision(mapId, String(box.id));
      toastSuccess(`碰撞盒 #${box.id} 已删除`);
      onSaved(`已删除碰撞盒 #${box.id}`);
    } catch {
      /* 同上 */
    } finally {
      setSaving(false);
      setAskingDelete(false);
    }
  };

  return (
    <>
      <Modal
        open
        title={box ? `碰撞盒 #${box.id}` : "新建碰撞盒"}
        hint={
          box
            ? "整份覆盖：中心与尺寸一次提交。改完图里的人要换图 / 重进才会觉得「这里能过去了」。"
            : "画布上拖出来的框已经带上位置与尺寸，这里可以精确调整（贴墙的缝、门口的缺口）。"
        }
        size="md"
        onClose={onClose}
        footer={
          <>
            {box ? (
              <Button variant="ghost" className="mr-auto text-rose-300" disabled={saving} onClick={() => setAskingDelete(true)}>
                删除这个碰撞盒
              </Button>
            ) : null}
            <Button variant="outline" disabled={saving} onClick={onClose}>
              取消
            </Button>
            <Button disabled={!valid || saving || !canWrite} loading={saving} onClick={() => void submit()}>
              {box ? "保存改动" : "创建"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Field label="中心 x（世界）">
              <Input type="number" value={form.cx} onChange={(event) => setForm({ ...form, cx: event.target.value })} />
            </Field>
            <Field label="中心 y（世界，负）">
              <Input type="number" value={form.cy} onChange={(event) => setForm({ ...form, cy: event.target.value })} />
            </Field>
            <Field label="宽（像素）">
              <Input type="number" min={1} value={form.w} onChange={(event) => setForm({ ...form, w: event.target.value })} />
            </Field>
            <Field label="高（像素）">
              <Input type="number" min={1} value={form.h} onChange={(event) => setForm({ ...form, h: event.target.value })} />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-2 rounded-xl border border-slate-800 bg-slate-900/40 px-3 py-2 text-[11px] text-slate-400">
            <div>
              <p className="text-slate-500">左上角（Tiled 口径，对着编辑器核）</p>
              <p className="mt-0.5 font-mono text-slate-300">{tiled ? `${round2(tiled.x)}, ${round2(tiled.y)}` : "—"}</p>
            </div>
            <div>
              <p className="text-slate-500">地图范围（世界坐标）</p>
              <p className="mt-0.5 font-mono text-slate-300">
                x ∈ [0, {detail.width}]、y ∈ [-{detail.height}, 0]
              </p>
            </div>
          </div>

          {fullyOutside ? (
            <Notice tone="amber" title="这个盒子整块在地图外">
              它不会挡任何东西，画面上也看不到（四面围墙是「跨边界」而不是「整块在外」，那种是对的）。
              如果不是故意的，检查一下 y 的正负 —— 世界坐标 y 向上，所以图内的 y 一定是负数或 0。
            </Notice>
          ) : (
            <p className="text-[11px] text-slate-500">
              允许超出地图边界：四面围墙本来就画在图外（把玩家关在图里的手段）。图里的人要换图 / 重进才生效。
            </p>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        open={askingDelete}
        title="删除这个碰撞盒？"
        description={`#${box?.id ?? ""} 会立刻从库里删掉。图里的人要换图 / 重进才会觉得「这里能过去了」。`}
        confirmText="删除"
        loading={saving}
        onConfirm={() => void remove()}
        onCancel={() => setAskingDelete(false)}
      />
    </>
  );
}

/** 两位小数：与画布 / 服务端同一口径（拖出来带浮点，进库没有意义） */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
