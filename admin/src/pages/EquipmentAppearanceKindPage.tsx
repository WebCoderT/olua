import { useCallback, useEffect, useMemo, useState } from "react";
import { equipmentBackgroundApi, equipmentBorderApi, formatTime, PERMISSION } from "../api";
import type { AppearanceAssignment, AppearanceEffect, AppearanceItem, CustomAppearance } from "../api";
import { GameFrame } from "../components/GameImage";
import { AppearanceEffectWorkbench, DEFAULT_EFFECT, describeEffect, isDefaultEffect } from "../components/AppearanceEffectWorkbench";
import type { AppearanceEffectValue } from "../components/AppearanceEffectWorkbench";
import { Modal } from "../components/Modal";
import { Badge, Button, Card, Field, Input, Select, Spinner } from "../components/ui";
import { PageHeader } from "../components/PageHeader";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";

/**
 * 装备边框页 / 装备详情背景页（#714 起是「实体清单」页）
 *
 * 两页共用这一套编辑器，只有配置不同（素材目录、key 格式、效果基准框）。
 * **清单本体在这里**：游戏里有哪些边框 / 背景（key + 显示效果），增删改查都做在
 * 列表里；「前后缀管理」页的关联棋盘与下方的特殊装备绑定都只是**引用**清单里的 key，
 * 属性（显示效果）改在清单里、保存时由服务端传播进引用处。
 *
 * 保存仍是**整边替换**（items + assignments + customs 一起提交）：assignments
 * 原样透传（棋盘归「前后缀管理」页），customs 在本页编辑。
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
  /** 素材类型 */
  kind: "border" | "background";
  /** 实体的名字（「边框」/「背景」，拼提示用） */
  noun: string;
  /** key 输入框的示例与提示 */
  keyExample: string;
  keyHint: string;
  /** key 格式（与服务端 appearanceKeyProblem 同口径，前置拦按钮） */
  keyPattern: RegExp;
  /** 首帧预览路径 */
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
      背包格子与身上装备槽的物品图标上那圈品质光效框。这里是**边框清单本体**：新增 / 删除边框、调显示效果都在列表里；
      哪个前后缀品质用哪个在「前后缀管理」页的棋盘里引用，特殊装备的单独绑定在本页下方。
      {updatedAt ? <span className="ml-1 text-slate-500">上次修改：{formatTime(updatedAt)}</span> : null}
    </>
  ),
  kind: "border",
  noun: "边框",
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
      物品详情弹窗的品质背景动画。这里是**背景清单本体**：新增 / 删除背景、调显示效果都在列表里；
      哪个前后缀品质用哪个在「前后缀管理」页的棋盘里引用，特殊装备的单独绑定在本页下方。
      {updatedAt ? <span className="ml-1 text-slate-500">上次修改：{formatTime(updatedAt)}</span> : null}
    </>
  ),
  kind: "background",
  noun: "背景",
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

export function EquipmentBordersPage() {
  return <EquipmentAppearanceKindPage config={BORDER_CONFIG} />;
}

export function EquipmentBackgroundPage() {
  return <EquipmentAppearanceKindPage config={BACKGROUND_CONFIG} />;
}

function EquipmentAppearanceKindPage({ config }: { config: KindConfig }) {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  /** 清单本体（#714）：key + 显示效果，增删改查都做在这里 */
  const [items, setItems] = useState<AppearanceItem[] | null>(null);
  /** 棋盘原样透传（棋盘归「前后缀管理」页，本页不动它） */
  const [assignments, setAssignments] = useState<AppearanceAssignment[] | null>(null);
  /** 特殊装备绑定（特殊装备 → 清单里的 key，优先于棋盘） */
  const [customs, setCustoms] = useState<CustomAppearance[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  /** 正在调显示效果的清单条目下标（null = 工作台关着） */
  const [effectIndex, setEffectIndex] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = config.kind === "border" ? await equipmentBorderApi.get() : await equipmentBackgroundApi.get();
      setUpdatedAt(data.updatedAt);
      setItems(data.items ?? []);
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

  const setItem = (index: number, next: Partial<AppearanceItem>) => {
    setItems((current) => (current ? current.map((row, i) => (i === index ? { ...row, ...next } : row)) : current));
  };
  const appendItem = () => setItems((current) => (current ? [...current, { key: "" }] : current));
  const removeItem = (index: number) => setItems((current) => (current ? current.filter((_, i) => i !== index) : current));

  const setCustom = (index: number, next: Partial<CustomAppearance>) => {
    setCustoms((current) => (current ? current.map((row, i) => (i === index ? { ...row, ...next } : row)) : current));
  };
  const appendCustom = () => setCustoms((current) => (current ? [...current, { equipment: "", key: "" }] : current));
  const removeCustom = (index: number) => setCustoms((current) => (current ? current.filter((_, i) => i !== index) : current));

  /** 某个 key 被引用了几次（棋盘 + 特殊装备绑定；>0 时禁止删除该条目） */
  const referenceCount = (key: string): number => {
    const inBoard = (assignments ?? []).filter((row) => row.key === key).length;
    const inCustoms = (customs ?? []).filter((row) => row.key === key).length;
    return inBoard + inCustoms;
  };

  /** 效果工作台的读写口：把 value 写回正在编辑的那条清单条目 */
  const effectValue = (() => {
    if (effectIndex === null) return DEFAULT_EFFECT;
    return (items?.[effectIndex]?.effect as AppearanceEffectValue | undefined) ?? DEFAULT_EFFECT;
  })();
  const setEffectValue = (value: AppearanceEffectValue) => {
    if (effectIndex === null) return;
    setItem(effectIndex, { effect: isDefaultEffect(value) ? undefined : (value as AppearanceEffect) });
  };

  /** 逐项体检：清单 key 格式 / 唯一、绑定装备唯一且引用存在 —— 服务端也会拒，先在这里拦按钮 */
  const invalid = useMemo(() => describeInvalid(items, customs, config), [items, customs, config]);

  const save = async () => {
    if (!items || !customs || !assignments || invalid) return;
    setSaving(true);
    try {
      const payload = {
        items: items.map((row) => {
          const effect = row.effect as AppearanceEffectValue | undefined;
          return { key: row.key.trim(), effect: isDefaultEffect(effect) ? undefined : effect };
        }),
        assignments,
        customs: customs.map((row) => ({ equipment: row.equipment.trim(), key: row.key.trim() })),
      };
      const data = config.kind === "border" ? await equipmentBorderApi.update(payload) : await equipmentBackgroundApi.update(payload);
      setUpdatedAt(data.updatedAt);
      setItems(data.items ?? []);
      setAssignments(data.assignments ?? []);
      setCustoms(data.customs ?? []);
      toastSuccess(config.savedToast);
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setSaving(false);
    }
  };

  const effectEntry = effectIndex !== null ? (items?.[effectIndex] ?? null) : null;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={config.title} description={config.description(updatedAt)} />

      {items ? (
        <Card
          title={`${config.noun}清单（${items.length} 条）`}
          description={`游戏里能用的${config.noun}都在这里：key 指向客户端资源包里的素材（填错了客户端会跳过并留日志），显示效果是这条素材的属性 —— 改这里，所有引用它的品质 / 特殊装备跟着变。被引用的条目不能删（先在引用处换别的${config.noun}）。`}
          actions={
            loading ? (
              <Spinner />
            ) : canWrite ? (
              <>
                <Button variant="ghost" disabled={items.length >= 100} onClick={appendItem}>
                  添加一项
                </Button>
                <Button disabled={saving || invalid !== null} loading={saving} onClick={() => void save()}>
                  保存全部
                </Button>
              </>
            ) : null
          }
        >
          {invalid ? <p className="text-xs text-amber-400">{invalid}</p> : null}
          {items.length === 0 ? <p className="text-sm text-slate-400">清单空着 —— 点「添加一项」把素材 key 加进来。</p> : null}
          <div className="flex flex-col gap-3">
            {items.map((row, index) => {
              const refs = referenceCount(row.key.trim());
              return (
                <div key={index} className="grid grid-cols-1 items-end gap-3 rounded border border-slate-700/60 p-3 sm:grid-cols-[auto_2fr_auto_auto_auto]">
                  <GameFrame atlas={row.key ? config.atlasOf(row.key) : ""} size={44} alt={row.key} />
                  <Field label="key" hint={config.keyHint}>
                    <Input value={row.key} placeholder={config.keyExample} disabled={!canWrite} onChange={(event) => setItem(index, { key: event.target.value })} />
                  </Field>
                  <Button variant="ghost" disabled={!canWrite} onClick={() => setEffectIndex(index)}>
                    效果 {row.effect ? describeEffect(row.effect as AppearanceEffectValue) : ""}
                  </Button>
                  {refs > 0 ? <Badge tone="indigo">引用 {refs}</Badge> : <Badge tone="slate">未引用</Badge>}
                  {canWrite ? (
                    <Button variant="ghost" disabled={refs > 0} title={refs > 0 ? `被引用 ${refs} 次，先在引用处换别的${config.noun}` : undefined} onClick={() => removeItem(index)}>
                      删除
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </Card>
      ) : null}

      {customs ? (
        <Card
          title={`特殊装备绑定（${customs.length} 条）`}
          description={`优先于前后缀棋盘。装备填变体 id（如 weapon_20_p4s2）只影响那一个变体；填基础件 key（如 weapon_20）影响它的全部变体。${config.noun}从清单里选 —— 显示效果在清单那条上改。`}
          actions={
            canWrite ? (
              <Button variant="ghost" onClick={appendCustom}>
                添加一条
              </Button>
            ) : null
          }
        >
          {customs.length === 0 ? <p className="text-sm text-slate-400">还没有特殊装备绑定（所有装备走「前后缀管理」页的棋盘）。</p> : null}
          <div className="flex flex-col gap-3">
            {customs.map((row, index) => (
              <div key={index} className="grid grid-cols-1 items-end gap-3 rounded border border-slate-700/60 p-3 sm:grid-cols-[2fr_2fr_auto]">
                <Field label="装备标识" hint="变体 id 或基础件 key">
                  <Input value={row.equipment} disabled={!canWrite} onChange={(event) => setCustom(index, { equipment: event.target.value })} />
                </Field>
                <Field label={config.noun} hint="从清单里选；显示效果在清单条目上改">
                  <Select value={row.key} disabled={!canWrite} onChange={(event) => setCustom(index, { key: event.target.value })}>
                    <option value="">（选择{config.noun}）</option>
                    {(items ?? []).map((item) => (
                      <option key={item.key} value={item.key}>
                        {item.key}
                      </option>
                    ))}
                  </Select>
                </Field>
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
        title={effectEntry ? `显示效果 · ${effectEntry.key || "（未填 key）"}` : "显示效果"}
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
            hint={`${config.effectHint}（改动实时生效，点「完成」回页面再「保存全部」才会提交；保存后所有引用这条${config.noun}的品质一起变）`}
          />
        ) : null}
      </Modal>
    </div>
  );
}

//#region 校验

/** 返回第一条问题（null = 没问题）。服务端也会校验，这里只是让按钮先别让人白点 */
function describeInvalid(items: AppearanceItem[] | null, customs: CustomAppearance[] | null, config: KindConfig): string | null {
  if (!items || !customs) return null;
  const known = new Set<string>();
  for (const [index, row] of items.entries()) {
    const key = row.key.trim();
    if (!key) return `清单第 ${index + 1} 条没有填 key。`;
    if (!config.keyPattern.test(key)) return `清单第 ${index + 1} 条的 key「${row.key}」格式不对（应为 ${config.keyExample} 这样）。`;
    if (known.has(key)) return `清单第 ${index + 1} 条的 key「${key}」重复了。`;
    known.add(key);
  }
  const seen = new Set<string>();
  for (const [index, row] of customs.entries()) {
    if (!row.equipment.trim()) return `特殊装备第 ${index + 1} 条没有填装备标识。`;
    if (seen.has(row.equipment.trim())) return `特殊装备第 ${index + 1} 条的装备「${row.equipment}」重复了。`;
    seen.add(row.equipment.trim());
    if (!known.has(row.key.trim())) return `特殊装备第 ${index + 1} 条（${row.equipment.trim()}）引用的「${row.key.trim() || "（空）"}」不在清单里 —— 先在清单里添加，或改选别的。`;
  }
  return null;
}

//#endregion
