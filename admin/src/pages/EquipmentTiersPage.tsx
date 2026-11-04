import { useCallback, useEffect, useState } from "react";
import { equipmentBackgroundApi, equipmentBorderApi, equipmentMetaApi, PERMISSION } from "../api";
import type { AppearanceAssignment, AppearanceEffect, CustomAppearance, EquipmentMeta } from "../api";
import { GameFrame } from "../components/GameImage";
import { AppearanceEffectWorkbench, DEFAULT_EFFECT, describeEffect, isDefaultEffect } from "../components/AppearanceEffectWorkbench";
import type { AppearanceEffectValue } from "../components/AppearanceEffectWorkbench";
import { Modal } from "../components/Modal";
import { Button, Card, Input, Spinner } from "../components/ui";
import { PageHeader } from "../components/PageHeader";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";

/**
 * 前后缀管理（#712）：档位定义 + 边框/背景的关联棋盘，一页管完
 *
 * 三件事都围着 equipment_meta 的前后缀档位转：
 * 1. **档位定义**（#697 从「装备配置」页弹窗迁出）：文案 + 属性倍率的增删改查，
 *    住在 `equipment_meta` 单行表，整份替换；只改定义，装备变体行不动 ——
 *    增删档位后要回「装备配置」点「重新生成变体」才按新档数重建；
 * 2. **边框关联**：前后缀组合 → 边框 key 的棋盘（#699 前从外观页拆来，现归本页）；
 * 3. **背景关联**：同上，详情弹窗背景。
 *
 * 棋盘保存仍是**整边替换**（assignments + customs 一起提交）：本页只改棋盘，
 * 提交时把拉到的自定义表**原样带回**，与边框/背景页互不覆盖的性质不变。
 * 特殊装备自定义表的增删改查仍在「装备边框」「装备详情背景」两页。
 */

//#region 档位定义（#697 的 TiersDialog 迁出为页内卡片）

/** 一档 = 一条文案 + 一个倍率（输入态都是字符串，提交时再解析） */
type TierDraft = { label: string; rate: string };

const TIER_LIMITS = { min: 1, max: 10, maxRate: 1000, maxLabelLength: 10 };

/** 输入框里的数字（trim 后能解析成有限数才算） */
const isNumber = (value: string): boolean => value.trim() !== "" && Number.isFinite(Number(value));

/** 一组档位的就地体检（返回第一条问题；null = 合法） */
function tierProblem(tiers: TierDraft[], kind: string): string | null {
  if (tiers.length < TIER_LIMITS.min) return `${kind}至少要留 ${TIER_LIMITS.min} 档`;
  if (tiers.length > TIER_LIMITS.max) return `${kind}最多 ${TIER_LIMITS.max} 档`;
  const seen = new Set<string>();
  for (const [index, tier] of tiers.entries()) {
    const label = tier.label.trim();
    if (!label) return `${kind}第 ${index + 1} 档没有填文案`;
    if (label.length > TIER_LIMITS.maxLabelLength) return `${kind}第 ${index + 1} 档的文案超过 ${TIER_LIMITS.maxLabelLength} 个字`;
    if (seen.has(label)) return `${kind}第 ${index + 1} 档的文案「${label}」重复了`;
    seen.add(label);
    if (!isNumber(tier.rate)) return `${kind}第 ${index + 1} 档的倍率不是数字`;
    if (Number(tier.rate) <= 0) return `${kind}第 ${index + 1} 档的倍率必须大于 0`;
    if (Number(tier.rate) > TIER_LIMITS.maxRate) return `${kind}第 ${index + 1} 档的倍率超出防御性上限（${TIER_LIMITS.maxRate}）`;
  }
  return null;
}

function TiersCard({ onChanged }: { onChanged: () => void }) {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [prefixTiers, setPrefixTiers] = useState<TierDraft[] | null>(null);
  const [suffixTiers, setSuffixTiers] = useState<TierDraft[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const row = await equipmentMetaApi.get();
      setPrefixTiers(row.prefixLabels.map((label, index) => ({ label, rate: String(row.prefixRates[index] ?? 1) })));
      setSuffixTiers(row.suffixLabels.map((label, index) => ({ label, rate: String(row.suffixRates[index] ?? 1) })));
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const problem = prefixTiers && suffixTiers ? tierProblem(prefixTiers, "前缀") ?? tierProblem(suffixTiers, "后缀") : "加载中";
  const patchTier = (kind: "prefix" | "suffix", index: number, next: Partial<TierDraft>) => {
    const setter = kind === "prefix" ? setPrefixTiers : setSuffixTiers;
    setter((current) => (current ?? []).map((tier, i) => (i === index ? { ...tier, ...next } : tier)));
  };
  const appendTier = (kind: "prefix" | "suffix") => {
    const setter = kind === "prefix" ? setPrefixTiers : setSuffixTiers;
    setter((current) => [...(current ?? []), { label: "新档", rate: "1" }]);
  };
  const removeTier = (kind: "prefix" | "suffix", index: number) => {
    const setter = kind === "prefix" ? setPrefixTiers : setSuffixTiers;
    setter((current) => (current ?? []).filter((_, i) => i !== index));
  };

  const submit = async () => {
    if (!prefixTiers || !suffixTiers || problem) return;
    setSaving(true);
    try {
      await equipmentMetaApi.update({
        prefixLabels: prefixTiers.map((tier) => tier.label.trim()),
        prefixRates: prefixTiers.map((tier) => Number(tier.rate)),
        suffixLabels: suffixTiers.map((tier) => tier.label.trim()),
        suffixRates: suffixTiers.map((tier) => Number(tier.rate)),
      });
      toastSuccess("前后缀档位已保存（档位定义即改即生效；装备变体要回「装备配置」页点「重新生成变体」才会按新档数重建）");
      onChanged();
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setSaving(false);
    }
  };

  const renderTiers = (kind: "prefix" | "suffix", tiers: TierDraft[] | null) => {
    const kindLabel = kind === "prefix" ? "前缀" : "后缀";
    return (
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            {kindLabel}档位（{tiers?.length ?? 0} 档，序号即档位 id）
          </h3>
          <Button variant="ghost" disabled={!canWrite || !tiers || tiers.length >= TIER_LIMITS.max} onClick={() => appendTier(kind)}>
            添加一档
          </Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] border-separate border-spacing-1">
            <thead>
              <tr>
                <th className="w-12 text-xs font-normal text-slate-500">序号</th>
                <th className="text-xs font-normal text-slate-400">文案</th>
                <th className="w-28 text-xs font-normal text-slate-400">属性倍率</th>
                <th className="w-16 text-right text-xs font-normal text-slate-400">操作</th>
              </tr>
            </thead>
            <tbody>
              {(tiers ?? []).map((tier, index) => (
                <tr key={index}>
                  <td className="text-center text-xs text-slate-500">{index}</td>
                  <td>
                    <Input value={tier.label} disabled={!canWrite} onChange={(event) => patchTier(kind, index, { label: event.target.value })} />
                  </td>
                  <td>
                    <Input
                      type="number"
                      step="0.01"
                      min={0.01}
                      value={tier.rate}
                      disabled={!canWrite}
                      onChange={(event) => patchTier(kind, index, { rate: event.target.value })}
                    />
                  </td>
                  <td className="text-right">
                    <Button variant="ghost" disabled={!canWrite || (tiers?.length ?? 0) <= TIER_LIMITS.min} onClick={() => removeTier(kind, index)}>
                      删除
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    );
  };

  return (
    <Card
      title="前后缀档位"
      description="文案用于客户端拼品质名（如「精良的·天级」），倍率用于「重新生成变体」时算属性。保存即改档位定义，但已展开的装备变体行不变 —— 增删档位后回「装备配置」页点「重新生成变体」。"
      actions={
        loading ? (
          <Spinner />
        ) : canWrite ? (
          <Button disabled={Boolean(problem) || saving} loading={saving} onClick={() => void submit()}>
            保存档位
          </Button>
        ) : null
      }
    >
      {loading || !prefixTiers || !suffixTiers ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {renderTiers("prefix", prefixTiers)}
          {renderTiers("suffix", suffixTiers)}
          {problem ? <p className="text-xs text-red-300">{problem}</p> : null}
        </div>
      )}
    </Card>
  );
}

//#endregion

//#region 关联棋盘（前后缀组合 → 边框/背景 key）

/** 两块棋盘唯一的差异点 */
interface BoardConfig {
  kind: "border" | "background";
  title: string;
  description: string;
  /** key 输入框的示例 */
  keyExample: string;
  /** key 格式（与服务端 appearanceKeyProblem 同口径，前置拦按钮） */
  keyPattern: RegExp;
  /** 棋盘格首帧预览路径 */
  atlasOf: (key: string) => string;
  /** 效果基准框（游戏像素）：边框 = 56×56 外框；背景 = 详情弹窗面板 240×200 */
  effectBox: { width: number; height: number };
  /** 工作台适配口径：contain（边框）/ width-top（背景，宽度贴框、顶边对齐） */
  effectFit: "contain" | "width-top";
  /** 参考内框（只画不做基准）：边框场景的 40×40 物品图标 */
  effectInnerBox: { width: number; height: number } | null;
  effectZoom: number;
  effectHint: string;
  savedToast: string;
}

const BOARD_CONFIGS: Record<"border" | "background", BoardConfig> = {
  border: {
    kind: "border",
    title: "边框关联",
    description: "背包格子与身上装备槽的物品图标上那圈品质光效框：哪个前后缀品质用哪个边框。每格都必须有 key：缺哪格，哪个品质就没有边框。特殊装备的单独配置在「装备边框」页。",
    keyExample: "sfx_30123_0",
    keyPattern: /^sfx_\d+_0$/,
    atlasOf: (key) => `borders/${key}`,
    effectBox: { width: 56, height: 56 },
    effectFit: "contain",
    effectInnerBox: { width: 40, height: 40 },
    effectZoom: 3,
    effectHint:
      "虚线外框 = 客户端 56×56 适配外框（游戏像素 ×3 画），内框 = 物品图标 40×40。第一帧按 contain 缩进外框后居中 —— 拖动改偏移、滑杆改倍率，客户端按同样的口径渲染（y 向上）。",
    savedToast: "边框关联已保存（玩家下次进游戏拉配置后生效）",
  },
  background: {
    kind: "background",
    title: "背景关联",
    description: "物品详情弹窗的品质背景动画：哪个前后缀品质用哪个背景。每格都必须有 key：缺哪格，哪个品质就没有背景。特殊装备的单独配置在「装备详情背景」页。",
    keyExample: "sfx_16000",
    keyPattern: /^sfx_\d+$/,
    atlasOf: (key) => `backgrounds/${key}`,
    effectBox: { width: 240, height: 200 },
    effectFit: "width-top",
    effectInnerBox: null,
    effectZoom: 1.5,
    effectHint:
      "虚线框 = 详情弹窗面板（240×200，实际高度随内容自适应）。背景宽度贴面板、高度按帧原始比例自适应、顶边贴面板顶 —— 拖动改偏移（y 向上）、滑杆改倍率（>1 会超出面板宽）。",
    savedToast: "背景关联已保存（玩家下次进游戏拉配置后生效）",
  },
};

/** 草稿里的棋盘格（下标 = comboIndex，后缀档优先、档内前缀递增，与服务端展开顺序一致） */
interface ComboCell {
  key: string;
  effect?: AppearanceEffectValue;
}

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

/** 服务端 effect（可缺省）→ 工作台数值 */
const toEffectValue = (effect: AppearanceEffect | undefined): AppearanceEffectValue | undefined =>
  effect ? { x: effect.x, y: effect.y, scale: effect.scale } : undefined;

/** 关联棋盘卡片：一个 kind 一块（边框 / 背景各一块，互不读写对方的数据） */
function AssociationBoard({ config, metaVersion }: { config: BoardConfig; metaVersion: number }) {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [meta, setMeta] = useState<EquipmentMeta | null>(null);
  const [board, setBoard] = useState<ComboCell[] | null>(null);
  /** 自定义表拉到后**原样保存**：棋盘保存是整边替换，提交时带回，别把边框/背景页配的自定义冲掉 */
  const [customs, setCustoms] = useState<CustomAppearance[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [effectIndex, setEffectIndex] = useState<number | null>(null);

  const prefixLabels = meta?.prefixLabels ?? [];
  const suffixLabels = meta?.suffixLabels ?? [];
  const prefixCount = Math.max(prefixLabels.length, 1);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [data, metaRow] = await Promise.all([
        config.kind === "border" ? equipmentBorderApi.get() : equipmentBackgroundApi.get(),
        equipmentMetaApi.get(),
      ]);
      setMeta(metaRow);
      setBoard(toBoard(data.assignments ?? [], metaRow.prefixLabels.length, metaRow.suffixLabels.length));
      setCustoms(data.customs ?? []);
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, [config.kind]);

  useEffect(() => {
    void load();
  }, [load, metaVersion]);

  const setCell = (combo: number, next: Partial<ComboCell>) => {
    setBoard((current) => {
      if (!current) return current;
      const rows = current.slice();
      rows[combo] = { ...rows[combo], ...next };
      return rows;
    });
  };

  /** 逐格体检：每格都得有合法 key —— 服务端也会拒，但先在这里把按钮拦住 */
  const invalid = (() => {
    if (!board) return null;
    const kindLabel = config.kind === "border" ? "边框" : "背景";
    const where = (combo: number) => `第 ${Math.floor(combo / prefixCount) + 1} 行第 ${(combo % prefixCount) + 1} 列`;
    for (const [combo, cell] of board.entries()) {
      if (!cell.key.trim()) return `棋盘有一格空着（${where(combo)}）—— 缺哪格哪个品质就没${kindLabel}。`;
      if (!config.keyPattern.test(cell.key.trim())) return `棋盘${where(combo)}的 key「${cell.key}」格式不对（应为 ${config.keyExample} 这样）。`;
    }
    return null;
  })();

  const save = async () => {
    if (!board || !customs || !meta || invalid) return;
    setSaving(true);
    try {
      const payload = {
        assignments: board.map((cell, combo) => ({
          prefix: combo % prefixCount,
          suffix: Math.floor(combo / prefixCount),
          key: cell.key.trim(),
          effect: isDefaultEffect(cell.effect) ? undefined : { x: cell.effect!.x, y: cell.effect!.y, scale: cell.effect!.scale },
        })),
        customs,
      };
      const data = config.kind === "border" ? await equipmentBorderApi.update(payload) : await equipmentBackgroundApi.update(payload);
      setBoard(toBoard(data.assignments ?? [], meta.prefixLabels.length, meta.suffixLabels.length));
      setCustoms(data.customs ?? []);
      toastSuccess(config.savedToast);
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setSaving(false);
    }
  };

  const effectCell = effectIndex !== null ? (board?.[effectIndex] ?? null) : null;

  return (
    <Card
      title={config.title}
      description={config.description}
      actions={
        loading ? (
          <Spinner />
        ) : canWrite ? (
          <Button disabled={!board || saving || invalid !== null} loading={saving} onClick={() => void save()}>
            保存全部
          </Button>
        ) : null
      }
    >
      {loading || !board ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : (
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
                            <Button variant="ghost" disabled={!canWrite} className="text-xs" onClick={() => setEffectIndex(combo)}>
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
      )}

      <Modal
        open={effectIndex !== null}
        title={effectCell ? `显示效果 · 棋盘格` : "显示效果"}
        size="lg"
        onClose={() => setEffectIndex(null)}
        footer={
          <Button onClick={() => setEffectIndex(null)} disabled={!canWrite}>
            完成
          </Button>
        }
      >
        {effectCell ? (
          <AppearanceEffectWorkbench
            atlas={effectCell.key ? config.atlasOf(effectCell.key) : ""}
            box={config.effectBox}
            fit={config.effectFit}
            innerBox={config.effectInnerBox}
            value={effectCell.effect ?? DEFAULT_EFFECT}
            onChange={(value) => {
              if (effectIndex === null) return;
              setCell(effectIndex, { effect: isDefaultEffect(value) ? undefined : value });
            }}
            zoom={config.effectZoom}
            hint={`${config.effectHint}（改动实时生效，点「完成」回页面再「保存全部」才会提交）`}
          />
        ) : null}
      </Modal>
    </Card>
  );
}

//#endregion

export function EquipmentTiersPage() {
  /** 档位保存后棋盘行列会变：版本号 +1 触发两块棋盘按新档数重拉 */
  const [metaVersion, setMetaVersion] = useState(0);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="前后缀管理"
        description="装备品质的两根轴（前缀档 × 后缀档）与它们到边框 / 背景的关联，都在这一页。改档位只动「定义」，装备变体要回「装备配置」页重建；改关联只动映射，素材本体在客户端资源包里。"
      />
      <TiersCard onChanged={() => setMetaVersion((v) => v + 1)} />
      <AssociationBoard config={BOARD_CONFIGS.border} metaVersion={metaVersion} />
      <AssociationBoard config={BOARD_CONFIGS.background} metaVersion={metaVersion} />
    </div>
  );
}
