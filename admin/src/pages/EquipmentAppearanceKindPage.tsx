import { useCallback, useEffect, useMemo, useState } from "react";
import { equipmentBackgroundApi, equipmentBorderApi, equipmentMetaApi, formatTime, PERMISSION } from "../api";
import type { AppearanceAssignment, AppearanceEffect, CustomAppearance, EquipmentMeta } from "../api";
import { GameFrame } from "../components/GameImage";
import { AppearanceEffectWorkbench, DEFAULT_EFFECT, describeEffect, isDefaultEffect } from "../components/AppearanceEffectWorkbench";
import type { AppearanceEffectValue } from "../components/AppearanceEffectWorkbench";
import { Modal } from "../components/Modal";
import { Button, Card, Field, Input, Spinner } from "../components/ui";
import { PageHeader } from "../components/PageHeader";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";

/**
 * 装备边框页 / 装备详情背景页（#699 拆分、#700 加显示效果）
 *
 * 两页共用这一套编辑器，只有配置不同（key 格式、素材目录、效果基准框）。
 * 每页管自己的半边：品质棋盘（行 = 后缀档、列 = 前缀档，每格一条映射）+
 * 特殊装备自定义表（可增删改查，优先于棋盘）。保存是**整边替换**且互不影响 ——
 * 边框页保存不会动背景页正在改的东西。
 *
 * ## 每格 / 每条的预览与效果
 * 每条映射带 `GameFrame` 首帧缩略图（素材本体经 /game-resources 同源直读，服务端不用存图）；
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
  /** 素材类型（决定 key 格式校验与效果基准说明） */
  kind: "border" | "background";
  /** key 输入框的示例与提示 */
  keyExample: string;
  keyHint: string;
  /** key 格式（与服务端 appearanceKeyProblem 同口径，前置拦按钮） */
  keyPattern: RegExp;
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
      背包格子与身上装备槽的物品图标上那圈品质光效框：哪个前后缀品质用哪个边框、特殊装备单独用哪个，都在这里改。
      素材本体在客户端资源包里，这里只改映射与显示效果，玩家下次进游戏拉配置后生效。
      {updatedAt ? <span className="ml-1 text-slate-500">上次修改：{formatTime(updatedAt)}</span> : null}
    </>
  ),
  kind: "border",
  keyExample: "sfx_30123_0",
  keyHint: "resources/borders 下的图集名，如 sfx_30123_0（长什么样见客户端 tools/border-preview.png 编号索引图）",
  keyPattern: /^sfx_\d+_0$/,
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
      物品详情弹窗的品质背景动画：哪个前后缀品质用哪个背景、特殊装备单独用哪个，都在这里改。
      素材本体在客户端资源包里，这里只改映射与显示效果，玩家下次进游戏拉配置后生效。
      {updatedAt ? <span className="ml-1 text-slate-500">上次修改：{formatTime(updatedAt)}</span> : null}
    </>
  ),
  kind: "background",
  keyExample: "sfx_16000",
  keyHint: "resources/backgrounds 下的帧序列目录名，如 sfx_16000",
  keyPattern: /^sfx_\d+$/,
  atlasOf: (key) => `backgrounds/${key}`,
  effectBox: { width: 240, height: 200 },
  effectFit: "width-top",
  effectInnerBox: null,
  effectZoom: 1.5,
  effectHint:
    "虚线框 = 详情弹窗面板（240×200，实际高度随内容自适应）。背景宽度贴面板、高度按帧原始比例自适应、顶边贴面板顶 —— 拖动改偏移（y 向上）、滑杆改倍率（>1 会超出面板宽）。",
  savedToast: "装备详情背景已保存（玩家下次进游戏拉配置后生效）",
};

/** 草稿里的棋盘格（下标 = comboIndex，后缀档优先、档内前缀递增，与服务端展开顺序一致） */
interface ComboCell {
  key: string;
  effect?: AppearanceEffectValue;
}

export function EquipmentBordersPage() {
  return <EquipmentAppearanceKindPage config={BORDER_CONFIG} />;
}

export function EquipmentBackgroundPage() {
  return <EquipmentAppearanceKindPage config={BACKGROUND_CONFIG} />;
}

function EquipmentAppearanceKindPage({ config }: { config: KindConfig }) {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [meta, setMeta] = useState<EquipmentMeta | null>(null);
  const [board, setBoard] = useState<ComboCell[] | null>(null);
  const [customs, setCustoms] = useState<CustomAppearance[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  /** 正在调显示效果的条目（null = 工作台关着） */
  const [effectTarget, setEffectTarget] = useState<{ kind: "combo" | "custom"; index: number } | null>(null);

  /** 档位标签（棋盘的行列头）；meta 没拉到时按空清单渲染（loading 态会兜住） */
  const prefixLabels = meta?.prefixLabels ?? [];
  const suffixLabels = meta?.suffixLabels ?? [];
  const prefixCount = Math.max(prefixLabels.length, 1);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [data, metaRow] = await Promise.all([config.kind === "border" ? equipmentBorderApi.get() : equipmentBackgroundApi.get(), equipmentMetaApi.get()]);
      setMeta(metaRow);
      setUpdatedAt(data.updatedAt);
      setBoard(toBoard(data.assignments ?? [], metaRow.prefixLabels.length, metaRow.suffixLabels.length));
      setCustoms(data.customs ?? []);
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, [config]);

  useEffect(() => {
    void load();
  }, [load]);

  const setCell = (combo: number, next: Partial<ComboCell>) => {
    setBoard((current) => {
      if (!current) return current;
      const rows = current.slice();
      rows[combo] = { ...rows[combo], ...next };
      return rows;
    });
  };

  const setCustom = (index: number, next: Partial<CustomAppearance>) => {
    setCustoms((current) => (current ? current.map((row, i) => (i === index ? { ...row, ...next } : row)) : current));
  };

  const appendCustom = () => setCustoms((current) => (current ? [...current, { equipment: "", key: "" }] : current));
  const removeCustom = (index: number) => setCustoms((current) => (current ? current.filter((_, i) => i !== index) : current));

  /** 效果工作台的读写口：把 value 写回正在编辑的那一条 */
  const effectValue = (() => {
    if (!effectTarget) return DEFAULT_EFFECT;
    const effect = effectTarget.kind === "combo" ? board?.[effectTarget.index]?.effect : customs?.[effectTarget.index]?.effect;
    return effect ?? DEFAULT_EFFECT;
  })();
  const setEffectValue = (value: AppearanceEffectValue) => {
    if (!effectTarget) return;
    const next = isDefaultEffect(value) ? undefined : value;
    if (effectTarget.kind === "combo") setCell(effectTarget.index, { effect: next });
    else setCustom(effectTarget.index, { effect: next as AppearanceEffect | undefined });
  };

  /** 逐项体检：key 格式 / 自定义装备唯一 —— 服务端也会拒，但先在这里把按钮拦住 */
  const invalid = useMemo(() => describeInvalid(board, customs, prefixCount, config), [board, customs, prefixCount, config]);

  const save = async () => {
    if (!board || !customs || !meta) return;
    const payload = buildPayload(board, customs, meta.prefixLabels.length);
    setSaving(true);
    try {
      const data = config.kind === "border" ? await equipmentBorderApi.update(payload) : await equipmentBackgroundApi.update(payload);
      setUpdatedAt(data.updatedAt);
      setBoard(toBoard(data.assignments ?? [], meta.prefixLabels.length, meta.suffixLabels.length));
      setCustoms(data.customs ?? []);
      toastSuccess(config.savedToast);
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setSaving(false);
    }
  };

  const effectEntry = (() => {
    if (!effectTarget) return null;
    if (effectTarget.kind === "combo") return board?.[effectTarget.index] ?? null;
    return customs?.[effectTarget.index] ?? null;
  })();

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={config.title} description={config.description(updatedAt)} />

      <Card
        title={`前后缀品质映射（${prefixLabels.length * suffixLabels.length} 格棋盘）`}
        actions={
          loading ? (
            <Spinner />
          ) : canWrite ? (
            <Button disabled={!board || saving || invalid !== null} loading={saving} onClick={() => void save()}>
              保存全部
            </Button>
          ) : null
        }
        description={
          canWrite
            ? `行 = 后缀（${suffixLabels.join(" / ") || "—"}），列 = 前缀（${prefixLabels.join(" → ") || "—"}）。每格都必须有 key：缺哪格，哪个品质就没有${config.kind === "border" ? "边框" : "背景"}。保存是整边替换（棋盘 + 自定义表一起提交），另一边不受影响。档位在「装备配置」页的前后缀弹窗里增删。`
            : "当前角色没有「修改养成配置」权限，本页只读。"
        }
      >
        {board ? (
          <div className="flex flex-col gap-4">
            {invalid ? <p className="text-xs text-amber-400">{invalid}</p> : null}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-separate border-spacing-1">
                <thead>
                  <tr>
                    <th className="w-16 text-xs font-normal text-slate-500">后缀 \ 前缀</th>
                    {prefixLabels.map((prefix) => (
                      <th key={prefix} className="text-xs font-normal text-slate-400">
                        {prefix}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {suffixLabels.map((suffix, s) => (
                    <tr key={suffix}>
                      <td className="text-xs text-slate-400">{suffix}</td>
                      {prefixLabels.map((_, p) => {
                        const combo = s * prefixCount + p;
                        const cell = board[combo];
                        return (
                          <td key={combo} className="align-top">
                            <div className="flex flex-col items-stretch gap-1 rounded border border-slate-800/80 p-1.5">
                              <GameFrame atlas={cell?.key ? config.atlasOf(cell.key) : ""} size={44} alt={`${suffix}·${prefixLabels[p]}`} />
                              <Input
                                value={cell?.key ?? ""}
                                placeholder={config.keyExample}
                                disabled={!canWrite}
                                className="text-xs"
                                onChange={(event) => setCell(combo, { key: event.target.value })}
                              />
                              <Button variant="ghost" disabled={!canWrite} className="text-xs" onClick={() => setEffectTarget({ kind: "combo", index: combo })}>
                                效果 {cell?.effect ? describeEffect(cell.effect) : ""}
                              </Button>
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </Card>

      {customs ? (
        <Card
          title={`特殊装备（${customs.length} 条）`}
          description={`优先于棋盘。装备填变体 id（如 weapon_20_p4s2）只影响那一个变体；填基础件 key（如 weapon_20）影响它的全部变体。${config.kind === "background" ? "写给特殊装备的专属弹窗背景。" : ""}`}
          actions={
            canWrite ? (
              <Button variant="ghost" onClick={appendCustom}>
                添加一条
              </Button>
            ) : null
          }
        >
          {customs.length === 0 ? <p className="text-sm text-slate-400">还没有自定义条目（所有装备走上面的棋盘）。</p> : null}
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
                <Button variant="ghost" disabled={!canWrite} onClick={() => setEffectTarget({ kind: "custom", index: index })}>
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
        open={effectTarget !== null}
        title={
          effectEntry
            ? `显示效果 · ${effectTarget?.kind === "combo" ? "棋盘格" : "equipment" in effectEntry
              ? effectEntry.equipment || "（未填装备标识）"
              : "棋盘格"}`
            : "显示效果"
        }
        size="lg"
        onClose={() => setEffectTarget(null)}
        footer={
          <Button onClick={() => setEffectTarget(null)} disabled={!canWrite}>
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

//#region 草稿 ↔ 提交体与校验

/** combo 下标（后缀档优先，档内前缀递增）—— 与服务端出厂值的展开顺序一致 */
const comboIndex = (prefix: number, suffix: number, prefixCount: number) => suffix * prefixCount + prefix;

function toBoard(rows: AppearanceAssignment[], prefixCount: number, suffixCount: number): ComboCell[] {
  const board: ComboCell[] = Array.from({ length: prefixCount * suffixCount }, () => ({ key: "" }));
  for (const row of rows) {
    const p = Number(row.prefix);
    const s = Number(row.suffix);
    if (p >= 0 && p < prefixCount && s >= 0 && s < suffixCount) {
      board[comboIndex(p, s, prefixCount)] = { key: row.key, effect: toEffectValue(row.effect) };
    }
  }
  return board;
}

/** 服务端 effect（可缺省）→ 工作台数值（缺省 = {0,0,1}，保存时若是默认值就不带字段） */
function toEffectValue(effect: AppearanceEffect | undefined): AppearanceEffectValue | undefined {
  return effect ? { x: effect.x, y: effect.y, scale: effect.scale } : undefined;
}

const EQUIPMENT_ID = /^[A-Za-z0-9_\-]+$/;

/** 返回第一条问题（null = 没问题）。服务端也会校验，这里只是让按钮先别让人白点 */
function describeInvalid(board: ComboCell[] | null, customs: CustomAppearance[] | null, prefixCount: number, config: KindConfig): string | null {
  if (!board || !customs) return null;
  const kindLabel = config.kind === "border" ? "边框" : "背景";
  const where = (combo: number) => `第 ${Math.floor(combo / prefixCount) + 1} 行第 ${(combo % prefixCount) + 1} 列`;
  for (const [combo, cell] of board.entries()) {
    if (!cell.key.trim()) return `棋盘有一格空着（${where(combo)}）—— 缺哪格哪个品质就没${kindLabel}。`;
    if (!config.keyPattern.test(cell.key.trim())) {
      return `棋盘${where(combo)}的 key「${cell.key}」格式不对（应为 ${config.keyExample} 这样）。`;
    }
  }
  const seen = new Set<string>();
  for (const [index, row] of customs.entries()) {
    if (!row.equipment.trim()) return `自定义表第 ${index + 1} 条没有填装备标识。`;
    if (!EQUIPMENT_ID.test(row.equipment.trim())) return `自定义表第 ${index + 1} 条的装备标识「${row.equipment}」只能用字母、数字、下划线与短横线。`;
    if (seen.has(row.equipment.trim())) return `自定义表第 ${index + 1} 条的装备「${row.equipment}」重复了。`;
    seen.add(row.equipment.trim());
    if (!row.key.trim()) return `自定义表第 ${index + 1} 条没有填 key。`;
  }
  return null;
}

/**
 * 草稿 → 提交体（逐字段显式列；默认效果不带 effect 字段，省一点快照体积）
 *
 * 棋盘格的 trim 在这里做（输入框里贴进来带空格是常态）；格式校验交给 describeInvalid 拦按钮。
 */
function buildPayload(board: ComboCell[], customs: CustomAppearance[], prefixCount: number) {
  const toEffect = (effect: AppearanceEffectValue | undefined): AppearanceEffect | undefined => {
    if (!effect || isDefaultEffect(effect)) return undefined;
    return { x: effect.x, y: effect.y, scale: effect.scale };
  };
  return {
    assignments: board.map((cell, combo) => ({
      prefix: combo % prefixCount,
      suffix: Math.floor(combo / prefixCount),
      key: cell.key.trim(),
      effect: toEffect(cell.effect),
    })),
    customs: customs.map((row) => ({
      equipment: row.equipment.trim(),
      key: row.key.trim(),
      effect: toEffect(toEffectValue(row.effect)),
    })),
  };
}

//#endregion
