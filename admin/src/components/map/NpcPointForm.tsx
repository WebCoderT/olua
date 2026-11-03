import { useEffect, useState } from "react";
import type { DrawPoint } from "./MapCanvas";
import type { MapDetail, MapNpc } from "../../api";
import { mapsApi, PERMISSION } from "../../api";
import { hasPermission } from "../../store/session";
import { toastSuccess } from "../../store/toast";
import { ConfirmDialog } from "../ConfirmDialog";
import { EntityPickButton } from "../entity/EntityPickButton";
import { entityOptions } from "../entity/catalog";
import { Modal } from "../Modal";
import { anyPickerOpen } from "../pickerStack";
import { Button, Field, Input, Notice } from "../ui";
import { tiledPointOf, worldPointOf } from "./MapCanvas";

/**
 * NPC 点位表单（#672：在图上点一下 → 这里选是哪个 NPC）
 *
 * ## 两种打开方式，同一份表单
 *
 * - **新建**：画布 `npc` 模式点空白 → 传 `draft`（Tiled 口径的点，"放在哪"已经定了）；
 * - **编辑**：点图上已有的点 → 传 `point`（服务端返回的世界坐标）。
 *
 * 坐标允许手改（两个输入框，Tiled 口径），因为「把它挪到那个门中间」这种微调靠拖动反而更慢。
 * 输入与拖动共用同一份换算（`worldPointOf`），所以两条路写进库里的是同一个数。
 *
 * ## 为什么不在这里判越界
 *
 * 「在不在图内」是**服务端**按地图尺寸算的（`pointInBounds`，容差 1px）。页面再算一遍就是
 * 第二个口径 —— 服务端改了容差页面还在放行。所以这里只管提交，越界由服务端拒（400 + 中文原因），
 * 历史上已越界的行由列表里的红字提示。
 *
 * ## 同一个 NPC 一张图只放一个
 *
 * 服务端 409（`map_npcs` 有 `(map_id, npc_id)` 唯一索引）。页面先查一遍只是为了**当场**说话
 * （不用等一次往返），判据与服务端一致：同图 + 同 npcId + 不是自己这一行。
 */
export function NpcPointFormDialog({
  open,
  mapId,
  detail,
  point,
  draft,
  onClose,
  onSaved,
}: {
  open: boolean;
  mapId: string;
  detail: MapDetail;
  /** 编辑态：服务端已有的那一行 */
  point: MapNpc | null;
  /** 新建态：画布上点出来的落点（Tiled 口径） */
  draft: DrawPoint | null;
  onClose: () => void;
  /** 保存 / 删除成功后回调（上层据此刷新详情并提示） */
  onSaved: (message: string) => void;
}) {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const npcOptions = entityOptions("npc");
  const [npcId, setNpcId] = useState("");
  const [x, setX] = useState("0");
  const [y, setY] = useState("0");
  const [saving, setSaving] = useState(false);
  const [askingDelete, setAskingDelete] = useState(false);

  /** 打开时按当前形态重置：编辑读那一行，新建用画布落点；NPC 沿用上一次选的（连着放几个多半是同一个） */
  useEffect(() => {
    if (!open) return;
    const at = point ? tiledPointOf(point) : draft;
    setX(String(round(at?.x ?? 0)));
    setY(String(round(at?.y ?? 0)));
    setNpcId((previous) => point?.npcId ?? previous);
    setAskingDelete(false);
    // 只跟开合与目标点位走：把 x / y 放进来会让「用户正在输入」被自己覆盖
  }, [open, point?.id, draft?.x, draft?.y]);

  if (!open) return null;

  const xValue = Number(x);
  const yValue = Number(y);
  const coordsOk = Number.isFinite(xValue) && Number.isFinite(yValue);
  const world = coordsOk ? worldPointOf({ x: xValue, y: yValue }) : null;
  const taken =
    npcId !== "" &&
    detail.npcPoints.some((item) => item.npcId === npcId && item.id !== (point?.id ?? -1));
  const valid = npcId !== "" && coordsOk && !taken;

  const submit = async () => {
    if (!valid || saving || !world) return;
    setSaving(true);
    try {
      const body = { npcId, cx: world.cx, cy: world.cy };
      const saved = point
        ? await mapsApi.updateNpc(mapId, String(point.id), body)
        : await mapsApi.createNpc(mapId, body);
      toastSuccess(`NPC「${saved.npcLabel}」已${point ? "更新" : "放下"}：(${saved.cx}, ${saved.cy})`);
      onSaved(`${point ? "已更新" : "已放下"} NPC「${saved.npcLabel}」`);
    } catch {
      /* 错误已由请求层统一提示（越界 / 同一个 NPC 已在这张图上都有中文文案） */
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!point || saving) return;
    setSaving(true);
    try {
      await mapsApi.deleteNpc(mapId, String(point.id));
      toastSuccess(`NPC「${point.npcLabel}」已从这张图移除`);
      onSaved(`已移除 NPC「${point.npcLabel}」`);
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
        title={point ? `NPC 点位 #${point.id}「${point.npcLabel}」` : "在这张图放一个 NPC"}
        hint={
          point
            ? "整份覆盖：NPC 与坐标一次提交。正在图里的人要换图 / 重进才看到新的位置。"
            : "落点已经带上了，这里只选「放哪个 NPC」；坐标也可以直接改。"
        }
        size="md"
        onClose={() => {
          // NPC 选择器叠在本弹窗上：关选择器不该顺手把关了一半的表单一起关掉
          if (!anyPickerOpen()) onClose();
        }}
        footer={
          <>
            {point ? (
              <Button variant="ghost" className="mr-auto text-rose-300" disabled={saving} onClick={() => setAskingDelete(true)}>
                从这张图移除
              </Button>
            ) : null}
            <Button variant="outline" disabled={saving} onClick={onClose}>
              取消
            </Button>
            <Button disabled={!valid || saving || !canWrite} loading={saving} onClick={() => void submit()}>
              {point ? "保存改动" : "放下"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 rounded-xl border border-slate-800 bg-slate-900/40 px-3 py-2 text-[11px] text-slate-400">
            <Info label="地图坐标（Tiled）" value={`${round(xValue || 0)}, ${round(yValue || 0)}`} />
            <Info label="世界坐标（入库）" value={world ? `${world.cx}, ${world.cy}` : "—"} />
          </div>

          <Field label="NPC">
            <EntityPickButton
              kind="npc"
              value={npcId}
              options={npcOptions}
              pickerTitle="选择 NPC"
              placeholder="点这里挑一个 NPC"
              hint="候选来自服务端 npcs 表（管理端「NPC 配置」页可改名字与素材，清单没有增删）"
              onChange={setNpcId}
            />
          </Field>
          {taken ? <p className="-mt-1.5 text-[11px] text-rose-300">这张图里已经有这个 NPC 了：一张图只放一个（同一 NPC 不需要两个摊位）</p> : null}

          <div className="grid grid-cols-2 gap-2">
            <Field label="地图 x（左上角原点、向右为正）">
              <Input type="number" value={x} onChange={(event) => setX(event.target.value)} />
            </Field>
            <Field label="地图 y（左上角原点、向下为正）">
              <Input type="number" value={y} onChange={(event) => setY(event.target.value)} />
            </Field>
          </div>

          <Notice tone="amber" title="何时生效">
            客户端下次进图时按快照把 NPC 摆到新位置（正在图里的人要换图 / 重进）。
            越界的点会被服务端直接拒 —— 点位必须落在 <code>[0, {detail.width}] × [0, {detail.height}]</code>（地图像素）以内。
          </Notice>
        </div>
      </Modal>

      <ConfirmDialog
        open={askingDelete}
        title="把 NPC 从这张图移除？"
        description={`「${point?.npcLabel ?? ""}」的这个点位会立刻从库里删掉。正在图里的人要换图 / 重进才看不到它。`}
        confirmText="移除"
        loading={saving}
        onConfirm={() => void remove()}
        onCancel={() => setAskingDelete(false)}
      />
    </>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-slate-500">{label}</p>
      <p className="mt-0.5 font-mono text-slate-300">{value}</p>
    </div>
  );
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
