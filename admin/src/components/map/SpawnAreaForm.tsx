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
 * 刷怪区表单（#667：管理端画完框就填它 / #852：加投放密度）
 *
 * ## 两种打开方式，同一份表单
 *
 * - **新建**：画布上拖完框 → 传 `draft`（Tiled 口径的矩形）；
 * - **编辑**：点图上已有的区域 → 传 `area`（服务端返回的世界坐标）。
 *
 * 两者的矩形都在这里被摊平成同一份「四至」显示，提交时统一换回世界坐标 —— 页面上不出现
 * 「这个框是刚画的、那个框是读库的」这种需要用户自己记住的差别。
 *
 * ## 数量是「上限」，密度是「按倍率缩放它」
 *
 * 表里是 `min` / `max` 两列，#852 起 `count` 只落 `max`、`min` 固定 0：世界每秒算
 * `目标 = max × 时段系数 × 人数系数`，下限留 0 才让低谷真的降得下来。三个密度字段全部
 * 可留空（空 = 1.0 / 无峰谷），不填就是「这一区恒定 max 只」，与加密度前完全一样。
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
  const [peak, setPeak] = useState("");
  const [off, setOff] = useState("");
  const [hours, setHours] = useState("");
  const [saving, setSaving] = useState(false);
  const [askingDelete, setAskingDelete] = useState(false);

  /** 打开时按当前形态重置：名字给个没用过的默认值，怪物跟上次选的一样（连着画几个区多半是同一只怪） */
  useEffect(() => {
    if (!open) return;
    setName(area ? area.name : freeName(detail));
    setMonsterKey((previous) => area?.monsterKey ?? previous);
    setCount(String(area ? area.max : 1));
    setPeak(area && area.densityPeak !== null ? String(area.densityPeak) : "");
    setOff(area && area.densityOff !== null ? String(area.densityOff) : "");
    setHours(area?.peakHours ?? "");
    setAskingDelete(false);
    // 只跟开合与目标区域走：把 name / detail 放进依赖会让「用户正在输入」被自己覆盖
  }, [open, area?.id, draft]);

  /** 当前矩形：编辑读库（世界坐标反算），新建用画布草稿 */
  const box = area ? tiledBoxOf(area) : draft;
  if (!open || !box) return null;
  const world = area ? { cx: area.cx, cy: area.cy, w: area.w, h: area.h } : worldBoxOf(box);

  const trimmed = name.trim();
  const countValue = Number(count);
  const peakValue = densityValue(peak);
  const offValue = densityValue(off);
  const hoursText = hours.trim();
  const densityOk = peakValue !== "invalid" && offValue !== "invalid";
  const hoursOk = hoursText === "" || /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.test(hoursText);
  const nameTaken =
    !!detail.spawnAreas.find((item) => item.name.trim() === trimmed && item.id !== (area?.id ?? -1)) && trimmed !== "";
  const valid =
    trimmed !== "" &&
    monsterKey !== "" &&
    Number.isFinite(countValue) &&
    countValue >= 1 &&
    countValue <= 200 &&
    densityOk &&
    hoursOk &&
    !nameTaken;

  const submit = async () => {
    if (!valid || saving) return;
    setSaving(true);
    try {
      const body = {
        name: trimmed,
        monsterKey,
        count: Math.floor(countValue),
        // 留空就给 undefined：服务端是整份覆盖，空值等于「清掉这一项的密度」
        densityPeak: typeof peakValue === "number" ? peakValue : undefined,
        densityOff: typeof offValue === "number" ? offValue : undefined,
        peakHours: hoursText === "" ? undefined : hoursText,
        ...world,
      };
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
            ? "整份覆盖：名字 / 怪物 / 数量 / 密度 / 位置尺寸一次提交。改完 1 秒内按新配置对齐。"
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
            <Info
              label={area ? "此刻目标" : "格数"}
              value={
                area
                  ? `${area.targetNow} 只`
                  : `约 ${Math.max(1, Math.round(box.width / (detail.tileWidth || 1)))} × ${Math.max(1, Math.round(box.height / (detail.tileHeight || 1)))}`
              }
            />
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

          <Field label="数量上限（1~200，这一区最多维持多少只）">
            <Input type="number" min={1} max={200} value={count} onChange={(event) => setCount(event.target.value)} />
          </Field>

          <div className="grid gap-2 sm:grid-cols-3">
            <Field label="高峰系数（留空 = 1.0）">
              <Input type="number" min={0} max={5} step={0.1} value={peak} placeholder="如 1.5" onChange={(event) => setPeak(event.target.value)} />
            </Field>
            <Field label="低谷系数（留空 = 1.0）">
              <Input type="number" min={0} max={5} step={0.1} value={off} placeholder="如 0.5" onChange={(event) => setOff(event.target.value)} />
            </Field>
            <Field label="高峰时段（留空 = 无峰谷）">
              <Input value={hours} maxLength={32} placeholder="19:00-23:00" onChange={(event) => setHours(event.target.value)} />
            </Field>
          </div>
          {!densityOk ? <p className="-mt-1.5 text-[11px] text-rose-300">系数要填 0~5 之间的数字，或者留空</p> : null}
          {!hoursOk ? <p className="-mt-1.5 text-[11px] text-rose-300">时段要写成 19:00-23:00（可跨零点 22:00-02:00），或者留空</p> : null}

          <Notice tone="amber" title="何时生效">
            世界<b>每秒</b>按「目标只数 vs 场上只数」对齐：少的补（每次最多 2 只）、多的删（先删死亡等重生的，再删最久没被攻击的，
            5 秒内被打过的保留）。改完<b>1 秒内</b>生效，不用等分域卸载。目标 = 数量上限 × 时段系数 × 人数系数（图上每多一人 +10%，最多 +50%）。
          </Notice>
        </div>
      </Modal>

      <ConfirmDialog
        open={askingDelete}
        title="删除这个刷怪区？"
        description={`「${area?.name ?? ""}」会立刻从库里删掉。场上这一区多出来的怪会在 1 秒内被裁掉（正在被打的会留到脱手），之后不再补新怪。`}
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

/**
 * 密度输入 → 三态：空 = null（不配这一项）、合法 = 数值、非法 = "invalid"
 *
 * 三态而不是「null / NaN」：空与非法在页面上是两件事 —— 空要提交成「清掉密度」，
 * 非法要拦住不让提交并在框下面报错。
 */
function densityValue(text: string): number | "invalid" | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 && value <= 5 ? value : "invalid";
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
