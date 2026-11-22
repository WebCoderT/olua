import { useEffect, useState } from "react";
import type { MapCollision, MapDetail } from "../../api";
import { mapsApi, PERMISSION } from "../../api";
import { hasPermission } from "../../store/session";
import { toastSuccess } from "../../store/toast";
import { ConfirmDialog } from "../ConfirmDialog";
import { Modal } from "../Modal";
import { Button, Field, Input, Notice } from "../ui";
import { type DrawPoint } from "./MapCanvas";

/**
 * 碰撞多边形表单（#676 画完就填它；#1190 从矩形四数字框升级为顶点列表）
 *
 * ## 两种打开方式，同一份表单
 *
 * - **新建**：画布上点绘封闭（点第一个点闭合）→ 传 `draft`（Tiled 口径的顶点序列）；
 * - **编辑**：点图上已有的多边形（或列表入口）→ 传 `box`（服务端返回的世界坐标顶点）。
 *
 * ## 为什么还要一个数字表单，画布不就够了
 *
 * 碰撞经常要精确到像素（贴墙留 1px 缝、卡住门口的一段路），而画布上一个像素在 8192 的图上
 * 只对应屏幕上的 0.08px —— 点出来的东西反而不准。所以画布负责「大概在哪」，
 * 这里负责「到底多少」：每个顶点一对 (x, y) 数字框，行内可删，底部可加。
 *
 * ## 允许超出地图边界
 *
 * 每张图四面围墙本来就画在图外（`x = -64`）。所以这里**不拦越界**，
 * 只在「整块在图外」（按顶点包围盒判，与服务端 `polygonBBoxFullyOutside` 同口径）时给一句提示
 * —— 那种多边形在画面上完全看不到，是数据错误的典型症状。
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
  /** 新建态：画布点绘出来的顶点序列（Tiled 口径，≥3 点） */
  draft: DrawPoint[] | null;
  onClose: () => void;
  /** 保存 / 删除成功后回调（上层据此刷新详情并提示） */
  onSaved: (message: string) => void;
}) {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  /** 顶点草稿：世界坐标的字符串形态（输入框直接编辑，提交时统一收两位小数） */
  const [points, setPoints] = useState<Array<{ x: string; y: string }>>([]);
  const [saving, setSaving] = useState(false);
  const [askingDelete, setAskingDelete] = useState(false);

  /** 打开时按当前形态重置（编辑读库里的顶点，新建用画布草稿换算成世界坐标） */
  useEffect(() => {
    if (!open) return;
    // 画布草稿是 Tiled 口径（y 向下），进表单统一转成世界坐标（y 轴向上、为负）
    const initial = box ? box.points.map(([x, y]) => ({ x: String(x), y: String(y) })) : (draft ?? []).map((p) => ({ x: String(p.x), y: String(-p.y) }));
    setPoints(initial);
    setAskingDelete(false);
    // 只跟开合与目标走：把 points 放进依赖会让「用户正在输入」被自己覆盖
  }, [open, box?.id, draft]);

  if (!open) return null;

  const numbers = points.map((p) => ({ x: Number(p.x), y: Number(p.y) }));
  const allFinite = numbers.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  const valid = numbers.length >= 3 && allFinite && numbers.every((p, i) => {
    const q = numbers[(i + 1) % numbers.length];
    return Math.hypot(q.x - p.x, q.y - p.y) >= 1;
  });
  // 整块在图外：按顶点包围盒判（图的 y 范围是 [-height, 0]），与服务端同口径。
  // 这里是**输入过程中的即时提示**（值还没落库，服务端算不出来）—— 权威值仍是保存后返回的
  // `fullyOutside`，两处口径必须一致，改一处就要改另一处。
  const xs = numbers.map((p) => p.x);
  const ys = numbers.map((p) => p.y);
  const fullyOutside =
    numbers.length >= 3 &&
    allFinite &&
    (Math.max(...xs) <= 0 ||
      Math.min(...xs) >= detail.width ||
      Math.max(...ys) <= -detail.height ||
      Math.min(...ys) >= 0);
  // 自交的即时提示：交给服务端拦（文案能带上「边与边相交」），这里只做同口径的预检
  // 会拖慢每次输入，所以画布 / 表单都不预检 —— 服务端 400 的中文文案由请求层统一提示。

  const setPoint = (index: number, key: "x" | "y", value: string) => {
    setPoints(points.map((p, i) => (i === index ? { ...p, [key]: value } : p)));
  };

  const removePoint = (index: number) => {
    if (points.length <= 3) return;
    setPoints(points.filter((_, i) => i !== index));
  };

  /** 在末尾补一个顶点：取最后一个顶点往右挪 16px（≥1px 边长就合法，位置用户自己再调） */
  const appendPoint = () => {
    const last = numbers[numbers.length - 1];
    const base = Number.isFinite(last?.x) ? last.x : 0;
    const baseY = Number.isFinite(last?.y) ? last.y : 0;
    setPoints([...points, { x: String(round2(base + 16)), y: String(round2(baseY)) }]);
  };

  const submit = async () => {
    if (!valid || saving) return;
    setSaving(true);
    try {
      // numbers 已经是世界坐标（画布草稿进表单时 useEffect 已转过一次 Tiled→世界，
      // 编辑态读的更是库里的原值）—— 这里只做两位小数取整，**绝不能再过 worldPointsOf**：
      // 那会把 y 再翻一次（#1196 的双重取负：多边形被翻到地图上方，画布裁掉、看不见）。
      const body = { points: numbers.map((p) => [round2(p.x), round2(p.y)] as [number, number]) };
      const saved = box ? await mapsApi.updateCollision(mapId, String(box.id), body) : await mapsApi.createCollision(mapId, body);
      toastSuccess(`碰撞多边形 #${saved.id} 已${box ? "更新" : "新建"}：${saved.points.length} 个顶点`);
      onSaved(`${box ? "已更新" : "已新建"}碰撞多边形 #${saved.id}`);
    } catch {
      /* 错误已由请求层统一提示（顶点数 / 边长 / 自交 / 图不存在都有中文文案） */
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!box || saving) return;
    setSaving(true);
    try {
      await mapsApi.deleteCollision(mapId, String(box.id));
      toastSuccess(`碰撞多边形 #${box.id} 已删除`);
      onSaved(`已删除碰撞多边形 #${box.id}`);
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
        title={box ? `碰撞多边形 #${box.id}` : "新建碰撞多边形"}
        hint={
          box
            ? "整份顶点覆盖：挪顶点 / 增删顶点一次提交。改完图里的人要换图 / 重进才会觉得「这里能过去了」。"
            : "画布上点绘封闭的多边形已经带上顶点，这里可以精确调整（贴墙的缝、门口的缺口）。"
        }
        size="md"
        onClose={onClose}
        footer={
          <>
            {box ? (
              <Button variant="ghost" className="mr-auto text-ember-hi" disabled={saving} onClick={() => setAskingDelete(true)}>
                删除这个碰撞多边形
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
          <p className="text-[11px] text-ink-5">
            顶点按绘制顺序首尾自动闭合（第 {numbers.length} 个连回第 1 个）。世界坐标 y 轴向上，
            图内的 y 一定是负数；Tiled 口径的 y 是它的相反数。
          </p>

          <div className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
            {points.map((p, i) => (
              <div key={i} className="flex items-end gap-2">
                <span className="w-10 shrink-0 pb-2 text-[11px] text-ink-5">#{i + 1}</span>
                <Field label="x（世界）">
                  <Input type="number" value={p.x} onChange={(event) => setPoint(i, "x", event.target.value)} />
                </Field>
                <Field label="y（世界，负）">
                  <Input type="number" value={p.y} onChange={(event) => setPoint(i, "y", event.target.value)} />
                </Field>
                <Button
                  variant="ghost"
                  className="mb-0.5 shrink-0 text-ember-hi"
                  disabled={points.length <= 3}
                  title={points.length <= 3 ? "封闭最少要 3 个顶点" : "删除这个顶点"}
                  onClick={() => removePoint(i)}
                >
                  删
                </Button>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between">
            <Button variant="outline" disabled={!canWrite || numbers.length >= 64} onClick={appendPoint}>
              加一个顶点
            </Button>
            <span className="text-[11px] text-ink-5">
              {numbers.length < 3 ? "至少要 3 个顶点" : numbers.length >= 64 ? "顶点已达上限（64）" : `${numbers.length} / 64 个顶点`}
            </span>
          </div>

          {!allFinite ? (
            <Notice tone="warn" title="顶点坐标还没填完">
              每个顶点都要是数字 —— 空着或写了非数字的顶点提交不了。
            </Notice>
          ) : null}

          <div className="grid grid-cols-2 gap-2 rounded-xl border border-line bg-surface-2/40 px-3 py-2 text-[11px] text-ink-4">
            <div>
              <p className="text-ink-5">顶点包围盒（世界坐标）</p>
              <p className="mt-0.5 font-mono text-ink-3">
                {allFinite && numbers.length >= 3
                  ? `x ∈ [${round2(Math.min(...xs))}, ${round2(Math.max(...xs))}]、y ∈ [${round2(Math.min(...ys))}, ${round2(Math.max(...ys))}]`
                  : "—"}
              </p>
            </div>
            <div>
              <p className="text-ink-5">地图范围（世界坐标）</p>
              <p className="mt-0.5 font-mono text-ink-3">
                x ∈ [0, {detail.width}]、y ∈ [-{detail.height}, 0]
              </p>
            </div>
          </div>

          {fullyOutside ? (
            <Notice tone="warn" title="这个多边形整块在地图外">
              它不会挡任何东西，画面上也看不到（四面围墙是「跨边界」而不是「整块在外」，那种是对的）。
              如果不是故意的，检查一下 y 的正负 —— 世界坐标 y 向上，所以图内的 y 一定是负数或 0。
            </Notice>
          ) : (
            <p className="text-[11px] text-ink-5">
              允许超出地图边界：四面围墙本来就画在图外（把玩家关在图里的手段）。图里的人要换图 / 重进才生效。
            </p>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        open={askingDelete}
        title="删除这个碰撞多边形？"
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
