import { useEffect, useState } from "react";
import type { MapDetail, MapSpawnArea } from "../../api";
import { mapsApi, PERMISSION } from "../../api";
import { hasPermission } from "../../store/session";
import { toastSuccess } from "../../store/toast";
import { ConfirmDialog } from "../ConfirmDialog";
import { EntityPickButton } from "../entity/EntityPickButton";
import { entityOptions } from "../entity/catalog";
import { Modal } from "../Modal";
import { anyPickerOpen } from "../pickerStack";
import { Button, Field, Input, Notice } from "../ui";
import { tiledBoxOf, worldBoxOf, type DrawBox } from "./MapCanvas";

/**
 * 刷怪区表单（#667：管理端画完框就填它）
 *
 * ## 两种打开方式，同一份表单
 *
 * - **新建**：画布上拖完框 → 传 `draft`（Tiled 口径的矩形）；
 * - **编辑**：点图上已有的区域 → 传 `area`（服务端返回的世界坐标）。
 *
 * 两者的矩形都在这里被摊平成同一份「四至」显示，提交时统一换回世界坐标 —— 页面上不出现
 * 「这个框是刚画的、那个框是读库的」这种需要用户自己记住的差别。
 *
 * ## 为什么数量只有一个输入框
 *
 * 表里是 `min` / `max`，但播种一直只按 `max` 展开（`min` 没被读过）。表单上摆两个数字
 * 只会让人问「min 填了为什么没反应」—— 所以只收 `count`，服务端落库时 `min = max = count`。
 *
 * ## 区域名
 *
 * 同图唯一（服务端 409）。新建时默认给一个没用过的「刷怪区 N」—— 让用户先从「名字」这道
 * 手续里解放出来，想改再改；重名不让提交，但**不偷偷改名**（偷偷改名会让人以为自己起的名字生效了）。
 */
export function SpawnAreaFormDialog({
  open,
  mapId,
  detail,
  area,
  draft,
  onClose,
  onSaved,
}: {
  open: boolean;
  mapId: string;
  detail: MapDetail;
  /** 编辑态：服务端已有的那一行 */
  area: MapSpawnArea | null;
  /** 新建态：画布上拖出来的框（Tiled 口径） */
  draft: DrawBox | null;
  onClose: () => void;
  /** 保存 / 删除成功后回调（上层据此刷新详情并提示） */
  onSaved: (message: string) => void;
}) {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const monsterOptions = entityOptions("monster");
  const [name, setName] = useState("");
  const [monsterKey, setMonsterKey] = useState("");
  const [count, setCount] = useState("1");
  const [saving, setSaving] = useState(false);
  const [askingDelete, setAskingDelete] = useState(false);

  /** 打开时按当前形态重置：名字给个没用过的默认值，怪物跟上次选的一样（连着画几个区多半是同一只怪） */
  useEffect(() => {
    if (!open) return;
    setName(area ? area.name : freeName(detail));
    setMonsterKey((previous) => area?.monsterKey ?? previous);
    setCount(String(area ? area.max : 1));
    setAskingDelete(false);
    // 只跟开合与目标区域走：把 name / detail 放进依赖会让「用户正在输入」被自己覆盖
  }, [open, area?.id, draft]);

  /** 当前矩形：编辑读库（世界坐标反算），新建用画布草稿 */
  const box = area ? tiledBoxOf(area) : draft;
  if (!open || !box) return null;
  const world = area ? { cx: area.cx, cy: area.cy, w: area.w, h: area.h } : worldBoxOf(box);

  const trimmed = name.trim();
  const countValue = Number(count);
  const nameTaken =
    !!detail.spawnAreas.find((item) => item.name.trim() === trimmed && item.id !== (area?.id ?? -1)) && trimmed !== "";
  const valid = trimmed !== "" && monsterKey !== "" && Number.isFinite(countValue) && countValue >= 1 && countValue <= 200 && !nameTaken;

  const submit = async () => {
    if (!valid || saving) return;
    setSaving(true);
    try {
      const body = { name: trimmed, monsterKey, count: Math.floor(countValue), ...world };
      const saved = area
        ? await mapsApi.updateSpawnArea(mapId, String(area.id), body)
        : await mapsApi.createSpawnArea(mapId, body);
      toastSuccess(`刷怪区「${saved.name}」已${area ? "更新" : "新建"}：${saved.monsterLabel} × ${saved.max}`);
      onSaved(`${area ? "已更新" : "已新建"}刷怪区「${saved.name}」—— ${saved.monsterLabel} × ${saved.max}`);
    } catch {
      /* 错误已由请求层统一提示（越界 / 重名 / 怪不存在都有中文文案） */
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!area || saving) return;
    setSaving(true);
    try {
      await mapsApi.deleteSpawnArea(mapId, String(area.id));
      toastSuccess(`刷怪区「${area.name}」已删除`);
      onSaved(`已删除刷怪区「${area.name}」`);
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
        title={area ? `刷怪区 #${area.id}「${area.name}」` : "新建刷怪区"}
        hint={
          area
            ? "整份覆盖：名字 / 怪物 / 数量 / 位置尺寸一次提交。改完要等这张图的世界实例重新加载才按新配置刷怪。"
            : "画布上拖出来的框已经带上位置与尺寸，这里只填「刷什么、刷几只」。"
        }
        size="md"
        onClose={() => {
          // 怪物选择器叠在本弹窗上：关选择器不该顺手把关了一半的表单一起关掉
          if (!anyPickerOpen()) onClose();
        }}
        footer={
          <>
            {area ? (
              <Button variant="ghost" className="mr-auto text-rose-300" disabled={saving} onClick={() => setAskingDelete(true)}>
                删除这个区
              </Button>
            ) : null}
            <Button variant="outline" disabled={saving} onClick={onClose}>
              取消
            </Button>
            <Button disabled={!valid || saving || !canWrite} loading={saving} onClick={() => void submit()}>
              {area ? "保存改动" : "创建"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 rounded-xl border border-slate-800 bg-slate-900/40 px-3 py-2 text-[11px] text-slate-400 sm:grid-cols-4">
            <Info label="左上角（Tiled）" value={`${round(box.x)}, ${round(box.y)}`} />
            <Info label="尺寸（像素）" value={`${round(box.width)} × ${round(box.height)}`} />
            <Info label="世界中心" value={`${round(world.cx)}, ${round(world.cy)}`} />
            <Info label="格数" value={`约 ${Math.max(1, Math.round(box.width / (detail.tileWidth || 1)))} × ${Math.max(1, Math.round(box.height / (detail.tileHeight || 1)))}`} />
          </div>

          <Field label="区域名（同一张图内唯一）">
            <Input value={name} maxLength={24} placeholder="如：1号刷怪区" onChange={(event) => setName(event.target.value)} />
          </Field>
          {nameTaken ? <p className="-mt-1.5 text-[11px] text-rose-300">这张图里已经有同名区域了，换一个名字</p> : null}

          <Field label="怪物">
            <EntityPickButton
              kind="monster"
              value={monsterKey}
              options={monsterOptions}
              pickerTitle="选择怪物"
              placeholder="点这里挑一只怪"
              hint="候选来自服务端 monsters 表（管理端可改数值，清单与客户端种子同源）"
              onChange={setMonsterKey}
            />
          </Field>

          <Field label="数量（1~200，这一区维持多少只）">
            <Input type="number" min={1} max={200} value={count} onChange={(event) => setCount(event.target.value)} />
          </Field>

          <Notice tone="amber" title="何时生效">
            世界只在该图分域<b>还没有实例</b>时按区域播种。这张图现在如果有人，新区域或改过的数量要等分域卸载
            （10 分钟没人）或重启实时进程才会按新配置刷出来；删掉的区域，场上已有的怪也不会消失。
          </Notice>
        </div>
      </Modal>

      <ConfirmDialog
        open={askingDelete}
        title="删除这个刷怪区？"
        description={`「${area?.name ?? ""}」会立刻从库里删掉。场上已经刷出来的怪不受影响，但下次播种时这一区不再有怪。`}
        confirmText="删除"
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

/** 一个这张图还没用过的默认区域名（`刷怪区 1` / `刷怪区 2` …） */
function freeName(detail: MapDetail): string {
  const used = new Set(detail.spawnAreas.map((item) => item.name));
  for (let index = detail.spawnAreas.length + 1; index < detail.spawnAreas.length + 100; index += 1) {
    const candidate = `刷怪区 ${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `刷怪区 ${Date.now() % 1000}`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
