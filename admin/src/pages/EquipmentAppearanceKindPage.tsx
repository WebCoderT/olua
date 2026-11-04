import { useCallback, useEffect, useMemo, useState } from "react";
import { equipmentBackgroundApi, equipmentBorderApi, formatTime, PERMISSION } from "../api";
import type { AppearanceAssignment, AppearanceEffect, CustomAppearance } from "../api";
import { GameFrame } from "../components/GameImage";
import { AppearanceEffectWorkbench, DEFAULT_EFFECT, describeEffect, isDefaultEffect } from "../components/AppearanceEffectWorkbench";
import type { AppearanceEffectValue } from "../components/AppearanceEffectWorkbench";
import { Modal } from "../components/Modal";
import { Button, Card, Field, Input, Spinner } from "../components/ui";
import { PageHeader } from "../components/PageHeader";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";

/**
 * 装备边框页 / 装备详情背景页（#699 拆分、#700 加显示效果、#712 棋盘迁走）
 *
 * 两页共用这一套编辑器，只有配置不同（素材目录、效果基准框）。
 * #712 起「前后缀品质 ↔ 边框/背景」的关联棋盘归「前后缀管理」页，本页只管
 * **特殊装备自定义表**（可增删改查，优先于棋盘）。
 *
 * 保存仍是**整边替换**（assignments + customs 一起提交）：本页不动棋盘，
 * 提交时把拉到的棋盘**原样带回**，「前后缀管理」页配的关联不会被冲掉。
 *
 * ## 每条的预览与效果
 * 每条带 `GameFrame` 首帧缩略图（素材本体经 /game-resources 同源直读，服务端不用存图）；
 * 「效果」按钮打开显示效果工作台（AppearanceEffectWorkbench）：以素材第一帧为基准，
 * 拖拽调偏移、滑杆调缩放 —— 与「装备对齐」工作台同一套交互取向。
 * effect 缺省 = 客户端默认适配（边框 contain 缩进 56×56 外框；背景宽度贴面板、
 * 高度按帧原始比例自适应、顶边贴面板顶）。
 */

/** 单边页面配置（两页唯一的差异点） */
interface KindConfig {
  /** 页面与卡片标题 */
  title: string;
  /** 页头描述 */
  description: (updatedAt: number | null) => React.ReactNode;
  /** 素材类型（决定效果基准说明） */
  kind: "border" | "background";
  /** key 输入框的示例与提示 */
  keyExample: string;
  keyHint: string;
  /** 棋盘格 / 自定义行的首帧预览路径 */
  atlasOf: (key: string) => string;
  /** 效果基准框（游戏像素）：边框 = 56×56 外框；背景 = 详情弹窗面板 240×200 */
  effectBox: { width: number; height: number };
  /** 工作台适配口径：contain（边框）/ width-top（背景，宽度贴框、顶边对齐） */
  effectFit: "contain" | "width-top";
  /** 参考内框（只画不做基准）：边框场景的 40×40 物品图标 */
  effectInnerBox: { width: number; height: number } | null;
  /** 工作台画布放大倍数 */
  effectZoom: number;
  /** 效果工作台顶部的一句话说明 */
  effectHint: string;
  /** 保存成功的 toast 文案 */
  savedToast: string;
}

const BORDER_CONFIG: KindConfig = {
  title: "装备边框",
  description: (updatedAt) => (
    <>
      背包格子与身上装备槽的物品图标上那圈品质光效框。前后缀品质用哪个边框在「前后缀管理」页的「边框关联」棋盘里改；
      本页管**特殊装备的单独边框**（优先于棋盘）。素材本体在客户端资源包里，玩家下次进游戏拉配置后生效。
      {updatedAt ? <span className="ml-1 text-slate-500">上次修改：{formatTime(updatedAt)}</span> : null}
    </>
  ),
  kind: "border",
  keyExample: "sfx_30123_0",
  keyHint: "resources/borders 下的图集名，如 sfx_30123_0（长什么样见客户端 tools/border-preview.png 编号索引图）",
  atlasOf: (key) => `borders/${key}`,
  effectBox: { width: 56, height: 56 },
  effectFit: "contain",
  effectInnerBox: { width: 40, height: 40 },
  effectZoom: 3,
  effectHint:
    "虚线外框 = 客户端 56×56 适配外框（游戏像素 ×3 画），内框 = 物品图标 40×40。第一帧按 contain 缩进外框后居中 —— 拖动改偏移、滑杆改倍率，客户端按同样的口径渲染（y 向上）。",
  savedToast: "装备边框已保存（玩家下次进游戏拉配置后生效）",
};

const BACKGROUND_CONFIG: KindConfig = {
  title: "装备详情背景",
  description: (updatedAt) => (
    <>
      物品详情弹窗的品质背景动画。前后缀品质用哪个背景在「前后缀管理」页的「背景关联」棋盘里改；
      本页管**特殊装备的单独背景**（优先于棋盘）。素材本体在客户端资源包里，玩家下次进游戏拉配置后生效。
      {updatedAt ? <span className="ml-1 text-slate-500">上次修改：{formatTime(updatedAt)}</span> : null}
    </>
  ),
  kind: "background",
  keyExample: "sfx_16000",
  keyHint: "resources/backgrounds 下的帧序列目录名，如 sfx_16000",
  atlasOf: (key) => `backgrounds/${key}`,
  effectBox: { width: 240, height: 200 },
  effectFit: "width-top",
  effectInnerBox: null,
  effectZoom: 1.5,
  effectHint:
    "虚线框 = 详情弹窗面板（240×200，实际高度随内容自适应）。背景宽度贴面板、高度按帧原始比例自适应、顶边贴面板顶 —— 拖动改偏移（y 向上）、滑杆改倍率（>1 会超出面板宽）。",
  savedToast: "装备详情背景已保存（玩家下次进游戏拉配置后生效）",
};

export function EquipmentBordersPage() {
  return <EquipmentAppearanceKindPage config={BORDER_CONFIG} />;
}

export function EquipmentBackgroundPage() {
  return <EquipmentAppearanceKindPage config={BACKGROUND_CONFIG} />;
}

function EquipmentAppearanceKindPage({ config }: { config: KindConfig }) {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  /** 棋盘原样保存（#712 起棋盘归「前后缀管理」页，本页只透传，保证整边替换不冲掉它） */
  const [assignments, setAssignments] = useState<AppearanceAssignment[] | null>(null);
  const [customs, setCustoms] = useState<CustomAppearance[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  /** 正在调显示效果的条目下标（null = 工作台关着） */
  const [effectIndex, setEffectIndex] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = config.kind === "border" ? await equipmentBorderApi.get() : await equipmentBackgroundApi.get();
      setUpdatedAt(data.updatedAt);
      setAssignments(data.assignments ?? []);
      setCustoms(data.customs ?? []);
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, [config.kind]);

  useEffect(() => {
    void load();
  }, [load]);

  const setCustom = (index: number, next: Partial<CustomAppearance>) => {
    setCustoms((current) => (current ? current.map((row, i) => (i === index ? { ...row, ...next } : row)) : current));
  };

  const appendCustom = () => setCustoms((current) => (current ? [...current, { equipment: "", key: "" }] : current));
  const removeCustom = (index: number) => setCustoms((current) => (current ? current.filter((_, i) => i !== index) : current));

  /** 效果工作台的读写口：把 value 写回正在编辑的那一条 */
  const effectValue = (() => {
    if (effectIndex === null) return DEFAULT_EFFECT;
    return customs?.[effectIndex]?.effect ?? DEFAULT_EFFECT;
  })();
  const setEffectValue = (value: AppearanceEffectValue) => {
    if (effectIndex === null) return;
    setCustom(effectIndex, { effect: isDefaultEffect(value) ? undefined : (value as AppearanceEffect) });
  };

  /** 逐项体检：装备标识唯一、key 非空 —— 服务端也会拒，但先在这里把按钮拦住 */
  const invalid = useMemo(() => describeInvalid(customs), [customs]);

  const save = async () => {
    if (!customs || !assignments || invalid) return;
    setSaving(true);
    try {
      const data = config.kind === "border"
        ? await equipmentBorderApi.update({ assignments, customs: buildCustomPayload(customs) })
        : await equipmentBackgroundApi.update({ assignments, customs: buildCustomPayload(customs) });
      setUpdatedAt(data.updatedAt);
      setAssignments(data.assignments ?? []);
      setCustoms(data.customs ?? []);
      toastSuccess(config.savedToast);
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setSaving(false);
    }
  };

  const effectEntry = effectIndex !== null ? (customs?.[effectIndex] ?? null) : null;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={config.title} description={config.description(updatedAt)} />

      {customs ? (
        <Card
          title={`特殊装备（${customs.length} 条）`}
          description={`优先于棋盘。装备填变体 id（如 weapon_20_p4s2）只影响那一个变体；填基础件 key（如 weapon_20）影响它的全部变体。${config.kind === "background" ? "写给特殊装备的专属弹窗背景。" : ""}`}
          actions={
            loading ? (
              <Spinner />
            ) : canWrite ? (
              <>
                <Button variant="ghost" onClick={appendCustom}>
                  添加一条
                </Button>
                <Button disabled={saving || invalid !== null} loading={saving} onClick={() => void save()}>
                  保存全部
                </Button>
              </>
            ) : null
          }
        >
          {customs.length === 0 ? <p className="text-sm text-slate-400">还没有自定义条目（所有装备走「前后缀管理」页的关联棋盘）。</p> : null}
          {invalid ? <p className="text-xs text-amber-400">{invalid}</p> : null}
          <div className="flex flex-col gap-3">
            {customs.map((row, index) => (
              <div key={index} className="grid grid-cols-1 items-end gap-3 rounded border border-slate-700/60 p-3 sm:grid-cols-[auto_2fr_2fr_auto_auto]">
                <GameFrame atlas={row.key ? config.atlasOf(row.key) : ""} size={44} alt={row.equipment} />
                <Field label="装备标识" hint="变体 id 或基础件 key">
                  <Input value={row.equipment} disabled={!canWrite} onChange={(event) => setCustom(index, { equipment: event.target.value })} />
                </Field>
                <Field label="key" hint={config.keyHint}>
                  <Input value={row.key} placeholder={config.keyExample} disabled={!canWrite} onChange={(event) => setCustom(index, { key: event.target.value })} />
                </Field>
                <Button variant="ghost" disabled={!canWrite} onClick={() => setEffectIndex(index)}>
                  效果 {row.effect ? describeEffect(row.effect) : ""}
                </Button>
                {canWrite ? (
                  <Button variant="ghost" onClick={() => removeCustom(index)}>
                    删除
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <Modal
        open={effectIndex !== null}
        title={effectEntry ? `显示效果 · ${effectEntry.equipment || "（未填装备标识）"}` : "显示效果"}
        size="lg"
        onClose={() => setEffectIndex(null)}
        footer={
          <Button onClick={() => setEffectIndex(null)} disabled={!canWrite}>
            完成
          </Button>
        }
      >
        {effectEntry ? (
          <AppearanceEffectWorkbench
            atlas={effectEntry.key ? config.atlasOf(effectEntry.key) : ""}
            box={config.effectBox}
            fit={config.effectFit}
            innerBox={config.effectInnerBox}
            value={effectValue}
            onChange={setEffectValue}
            zoom={config.effectZoom}
            hint={`${config.effectHint}（改动实时生效，点「完成」回页面再「保存全部」才会提交）`}
          />
        ) : null}
      </Modal>
    </div>
  );
}

//#region 校验与提交体

const EQUIPMENT_ID = /^[A-Za-z0-9_\-]+$/;

/** 返回第一条问题（null = 没问题）。服务端也会校验，这里只是让按钮先别让人白点 */
function describeInvalid(customs: CustomAppearance[] | null): string | null {
  if (!customs) return null;
  const seen = new Set<string>();
  for (const [index, row] of customs.entries()) {
    if (!row.equipment.trim()) return `第 ${index + 1} 条没有填装备标识。`;
    if (!EQUIPMENT_ID.test(row.equipment.trim())) return `第 ${index + 1} 条的装备标识「${row.equipment}」只能用字母、数字、下划线与短横线。`;
    if (seen.has(row.equipment.trim())) return `第 ${index + 1} 条的装备「${row.equipment}」重复了。`;
    seen.add(row.equipment.trim());
    if (!row.key.trim()) return `第 ${index + 1} 条没有填 key。`;
  }
  return null;
}

/**
 * 自定义表草稿 → 提交体（逐字段显式列；默认效果不带 effect 字段，省一点快照体积）
 *
 * 字段的 trim 在这里做（输入框里贴进来带空格是常态）；格式校验交给 describeInvalid 拦按钮。
 */
function buildCustomPayload(customs: CustomAppearance[]) {
  const toEffect = (effect: AppearanceEffectValue | undefined): AppearanceEffect | undefined => {
    if (!effect || isDefaultEffect(effect)) return undefined;
    return { x: effect.x, y: effect.y, scale: effect.scale };
  };
  return customs.map((row) => ({
    equipment: row.equipment.trim(),
    key: row.key.trim(),
    effect: toEffect(row.effect as AppearanceEffectValue | undefined),
  }));
}

//#endregion
