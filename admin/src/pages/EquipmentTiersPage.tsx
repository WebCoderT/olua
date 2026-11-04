import { useCallback, useEffect, useState } from "react";
import { equipmentBackgroundApi, equipmentBorderApi, equipmentMetaApi, PERMISSION } from "../api";
import type { AppearanceAssignment, AppearanceItem, CustomAppearance, EquipmentMeta } from "../api";
import { GameFrame } from "../components/GameImage";
import { Button, Card, Input, Select, Spinner } from "../components/ui";
import { PageHeader } from "../components/PageHeader";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";

/**
 * 前后缀管理（#712 建页、#714 起棋盘只做引用）
 *
 * 三件事都围着 equipment_meta 的前后缀档位转：
 * 1. **档位定义**（#697 从「装备配置」页弹窗迁出）：文案 + 属性倍率的增删改查，
 *    住在 `equipment_meta` 单行表，整份替换；只改定义，装备变体行不动 ——
 *    增删档位后要回「装备配置」点「重新生成变体」才按新档数重建；
 * 2. **边框关联**：前后缀组合 → 边框的引用棋盘；
 * 3. **背景关联**：同上，详情弹窗背景。
 *
 * ## 棋盘只是引用（#714）
 * 边框 / 背景**清单本体**住在「装备边框」「装备详情背景」两页（key + 显示效果），
 * 棋盘每格只是从清单里**选一个 key**；显示效果是清单条目的属性，改在清单页，
 * 服务端保存时把效果传播进引用处。所以本页没有效果编辑，保存提交的 assignments
 * 也不带 effect。
 *
 * 棋盘保存仍是**整边替换**：本页只改 assignments，items 与 customs **原样带回**，
 * 与清单页互不覆盖的性质不变。
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

//#region 关联棋盘（前后缀组合 → 引用清单里的 key）

/** 两块棋盘唯一的差异点 */
interface BoardConfig {
  kind: "border" | "background";
  title: string;
  /** 清单所在页的名字（引导语用） */
  listPage: string;
  noun: string;
  /** 棋盘格首帧预览路径 */
  atlasOf: (key: string) => string;
  savedToast: string;
}

const BOARD_CONFIGS: Record<"border" | "background", BoardConfig> = {
  border: {
    kind: "border",
    title: "边框关联",
    listPage: "装备边框",
    noun: "边框",
    atlasOf: (key) => `borders/${key}`,
    savedToast: "边框关联已保存（玩家下次进游戏拉配置后生效）",
  },
  background: {
    kind: "background",
    title: "背景关联",
    listPage: "装备详情背景",
    noun: "背景",
    atlasOf: (key) => `backgrounds/${key}`,
    savedToast: "背景关联已保存（玩家下次进游戏拉配置后生效）",
  },
};

/** 草稿里的棋盘格（下标 = comboIndex，后缀档优先、档内前缀递增，与服务端展开顺序一致；只存引用的 key） */
type ComboCell = string;

/** combo 下标（后缀档优先，档内前缀递增）—— 与服务端出厂值的展开顺序一致 */
const comboIndex = (prefix: number, suffix: number, prefixCount: number) => suffix * prefixCount + prefix;

function toBoard(rows: AppearanceAssignment[], prefixCount: number, suffixCount: number): ComboCell[] {
  const board: ComboCell[] = Array.from({ length: prefixCount * suffixCount }, () => "");
  for (const row of rows) {
    const p = Number(row.prefix);
    const s = Number(row.suffix);
    if (p >= 0 && p < prefixCount && s >= 0 && s < suffixCount) {
      board[comboIndex(p, s, prefixCount)] = row.key;
    }
  }
  return board;
}

/** 关联棋盘卡片：一个 kind 一块（边框 / 背景各一块，互不读写对方的数据） */
function AssociationBoard({ config, metaVersion }: { config: BoardConfig; metaVersion: number }) {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [meta, setMeta] = useState<EquipmentMeta | null>(null);
  /** 清单（引用的选项池；本体在「装备边框」/「装备详情背景」页，这里只读） */
  const [items, setItems] = useState<AppearanceItem[] | null>(null);
  const [board, setBoard] = useState<ComboCell[] | null>(null);
  /** 自定义表拉到后**原样保存**：棋盘保存是整边替换，提交时带回，别把清单页配的自定义冲掉 */
  const [customs, setCustoms] = useState<CustomAppearance[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

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
      setItems(data.items ?? []);
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

  const setCell = (combo: number, key: string) => {
    setBoard((current) => {
      if (!current) return current;
      const rows = current.slice();
      rows[combo] = key;
      return rows;
    });
  };

  /** 逐格体检：每格都得引用清单里的 key —— 服务端也会拒，但先在这里把按钮拦住 */
  const invalid = (() => {
    if (!board || !items) return null;
    const known = new Set(items.map((item) => item.key));
    for (const [combo, key] of board.entries()) {
      const where = `第 ${Math.floor(combo / prefixCount) + 1} 行第 ${(combo % prefixCount) + 1} 列`;
      if (!key.trim()) return `棋盘有一格空着（${where}）—— 缺哪格哪个品质就没${config.noun}。`;
      if (!known.has(key.trim())) return `棋盘${where}引用的「${key}」不在${config.noun}清单里 —— 先去「${config.listPage}」页添加。`;
    }
    return null;
  })();

  const save = async () => {
    if (!board || !items || !customs || !meta || invalid) return;
    setSaving(true);
    try {
      const payload = {
        // 棋盘只是引用：不带 effect（效果归清单，服务端保存时按清单传播）
        assignments: board.map((key, combo) => ({ prefix: combo % prefixCount, suffix: Math.floor(combo / prefixCount), key: key.trim() })),
        customs,
        items,
      };
      const data = config.kind === "border" ? await equipmentBorderApi.update(payload) : await equipmentBackgroundApi.update(payload);
      setItems(data.items ?? []);
      setBoard(toBoard(data.assignments ?? [], meta.prefixLabels.length, meta.suffixLabels.length));
      setCustoms(data.customs ?? []);
      toastSuccess(config.savedToast);
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title={config.title}
      description={`哪个前后缀品质用哪个${config.noun}。每格从${config.noun}清单里选一个 —— 清单与显示效果在「${config.listPage}」页管理；每格都必须选：缺哪格，哪个品质就没有${config.noun}。`}
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
      {loading || !board || !items ? (
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
                      const key = board[combo] ?? "";
                      return (
                        <td key={combo} className="align-top">
                          <div className="flex flex-col items-stretch gap-1 rounded border border-slate-800/80 p-1.5">
                            <GameFrame atlas={key ? config.atlasOf(key) : ""} size={44} alt={`${suffix}·${prefixLabels[p]}`} />
                            <Select value={key} disabled={!canWrite} className="text-xs" onChange={(event) => setCell(combo, event.target.value)}>
                              <option value="">（选择{config.noun}）</option>
                              {items.map((item) => (
                                <option key={item.key} value={item.key}>
                                  {item.key}
                                </option>
                              ))}
                            </Select>
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
        description="装备品质的两根轴（前缀档 × 后缀档）与它们到边框 / 背景的关联，都在这一页。改档位只动「定义」，装备变体要回「装备配置」页重建；关联棋盘只是引用 —— 边框 / 背景的清单与显示效果在「装备边框」「装备详情背景」两页管理。"
      />
      <TiersCard onChanged={() => setMetaVersion((v) => v + 1)} />
      <AssociationBoard config={BOARD_CONFIGS.border} metaVersion={metaVersion} />
      <AssociationBoard config={BOARD_CONFIGS.background} metaVersion={metaVersion} />
    </div>
  );
}
