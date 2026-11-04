import { useCallback, useEffect, useMemo, useState } from "react";
import { equipmentBackgroundApi, equipmentBorderApi, formatTime, PERMISSION } from "../api";
import type { AppearanceAssignment, AppearanceEffect, AppearanceItem, AppearanceResourceScan, CustomAppearance } from "../api";
import { GameFrame } from "../components/GameImage";
import { AppearanceEffectWorkbench, DEFAULT_EFFECT, describeEffect, isDefaultEffect } from "../components/AppearanceEffectWorkbench";
import type { AppearanceEffectValue } from "../components/AppearanceEffectWorkbench";
import { Modal } from "../components/Modal";
import { Badge, Button, Card, Input, Select, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { PageHeader } from "../components/PageHeader";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";

/**
 * 装备边框页 / 装备详情背景页（#714 起是「实体清单」页）
 *
 * 两页共用这一套编辑器，只有配置不同（素材目录、key 格式、效果基准框）。
 * **清单本体在这里**：游戏里有哪些边框 / 背景（key + 显示效果），增删改查都做在
 * 清单表格里；「前后缀管理」页的关联棋盘与下方的特殊装备绑定都只是**引用**清单里的
 * key，属性（显示效果）改在清单里、保存时由服务端传播进引用处。
 *
 * 保存仍是**整边替换**（items + assignments + customs 一起提交）：assignments
 * 原样透传（棋盘归「前后缀管理」页），customs 在本页编辑。
 *
 * ## 从文件夹同步（#716）
 * 清单条目远少于磁盘素材（边框 84 组、背景 40 组），而且素材以后还会持续增删 ——
 * 「从文件夹同步」以资源文件夹为准整批增删清单：文件夹里有的全保留（effect 原样）、
 * 没有的条目移除（**被引用的也移除**，引用处显示异常由运营后续修，客户端安静跳过）。
 * 先扫盘出预览（新增 / 移除 / 移除且仍被引用），确认后才落库。手填 key 的编辑路径
 * 仍受「被引用不可删」校验保护 —— 两套口径各管各的场景。
 *
 * ## 每条的预览与效果
 * 每条带 `GameFrame` 首帧缩略图（素材本体经 /game-resources 同源直读，服务端不用存图）；
 * 「效果」按钮打开显示效果工作台（AppearanceEffectWorkbench）：以素材第一帧为基准，
 * 拖拽调偏移、滑杆调缩放 —— 与「装备对齐」工作台同一套交互取向。
 * effect 缺省 = 客户端默认适配（边框 contain 缩进 56×56 外框；背景宽度贴面板、
 * 高度按帧原始比例自适应、顶边贴面板顶）。
 *
 * ## 别名 / 分组 / 分页（#718）
 * sfx 编号记不住：每条可起**别名**（给人看的名字）与**分组**（素材系列），都是可选的
 * 纯管理端属性 —— 快照段不消费 items，客户端契约不变；「从文件夹同步」对存活条目
 * 连同别名 / 分组一起保留。表格按 key / 别名过滤、按分组下拉过滤，**客户端分页**每页 20 条。
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
      背包格子与身上装备槽的物品图标上那圈品质光效框。这里是**边框清单本体**：新增 / 删除边框、调显示效果都在表格里；
      哪个前后缀品质用哪个在「前后缀管理」页的棋盘里引用，特殊装备的单独绑定在本页下方。
      素材增删了别手填 —— 点「从文件夹同步」按磁盘素材整批更新。
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
      物品详情弹窗的品质背景动画。这里是**背景清单本体**：新增 / 删除背景、调显示效果都在表格里；
      哪个前后缀品质用哪个在「前后缀管理」页的棋盘里引用，特殊装备的单独绑定在本页下方。
      素材增删了别手填 —— 点「从文件夹同步」按磁盘素材整批更新。
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

/** 清单表格每页条数（#718 客户端分页：20 条一屏，翻页比滚动省眼） */
const PAGE_SIZE = 20;

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
  /** 清单表格的过滤词（#716：84 条边框不滤一眼扫不完；#718 起连别名一起匹配） */
  const [query, setQuery] = useState("");
  /** 分组过滤（#718；"" = 全部分组） */
  const [groupFilter, setGroupFilter] = useState("");
  /** 分页（#718；客户端分页，0 起） */
  const [page, setPage] = useState(0);
  /** 同步弹窗：预览（null = 还在扫）与执行状态 */
  const [syncOpen, setSyncOpen] = useState(false);
  const [scan, setScan] = useState<AppearanceResourceScan | null>(null);
  const [scanLoading, setScanLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);

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

  /** 过滤后的清单（带着原下标，编辑写回时好定位）：过滤词匹配 key 或别名，分组精确匹配 */
  const filteredItems = useMemo(() => {
    const word = query.trim().toLowerCase();
    return (items ?? [])
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => (word ? row.key.toLowerCase().includes(word) || (row.name ?? "").toLowerCase().includes(word) : true))
      .filter(({ row }) => (groupFilter ? row.group === groupFilter : true));
  }, [items, query, groupFilter]);

  /** 已有的全部分组（排序去重；分组过滤下拉的选项池） */
  const groups = useMemo(() => [...new Set((items ?? []).map((row) => row.group).filter((group): group is string => Boolean(group)))].sort(), [items]);

  /** 当前页的条目（客户端分页；过滤词 / 分组变化时由下面的 effect 拉回第一页） */
  const pageCount = Math.max(1, Math.ceil(filteredItems.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pagedItems = filteredItems.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  useEffect(() => {
    setPage(0);
  }, [query, groupFilter]);

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
          return {
            key: row.key.trim(),
            effect: isDefaultEffect(effect) ? undefined : effect,
            name: row.name?.trim() || undefined,
            group: row.group?.trim() || undefined,
          };
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

  /** 打开同步弹窗：先扫盘出预览（新增 / 移除 / 移除且仍被引用） */
  const openSync = async () => {
    setSyncOpen(true);
    setScan(null);
    setScanLoading(true);
    try {
      const data = config.kind === "border" ? await equipmentBorderApi.scanResources() : await equipmentBackgroundApi.scanResources();
      setScan(data);
    } catch {
      setSyncOpen(false); // 目录读不到等错误已由请求层提示，弹窗收起
    } finally {
      setScanLoading(false);
    }
  };

  /** 确认执行同步（服务端按文件夹重建清单，被引用的条目也允许移除） */
  const runSync = async () => {
    setSyncing(true);
    try {
      const result = config.kind === "border" ? await equipmentBorderApi.syncResources() : await equipmentBackgroundApi.syncResources();
      toastSuccess(
        `${config.noun}清单已按文件夹同步：新增 ${result.added.length} 条、移除 ${result.removed.length} 条，保留 ${result.kept} 条` +
          (result.removedReferenced.length ? `（${result.removedReferenced.length} 条仍被引用，引用处待修复）` : ""),
      );
      setSyncOpen(false);
      await load();
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setSyncing(false);
    }
  };

  const effectEntry = effectIndex !== null ? (items?.[effectIndex] ?? null) : null;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={config.title} description={config.description(updatedAt)} />

      {items ? (
        <Card
          title={`${config.noun}清单（${items.length} 条）`}
          description={`游戏里能用的${config.noun}都在这里：key 指向客户端资源包里的素材（填错了客户端会跳过并留日志），显示效果是这条素材的属性 —— 改这里，所有引用它的品质 / 特殊装备跟着变。别名 / 分组是给人看的标签（可选，客户端不消费），分组可用来过滤。被引用的条目不能删（先在引用处换别的${config.noun}；「从文件夹同步」不受这条限制 —— 以磁盘素材为准整批增删，同步会保留已填的别名 / 分组 / 效果）。`}
          actions={
            loading ? (
              <Spinner />
            ) : canWrite ? (
              <>
                <Input
                  placeholder="按 key / 别名过滤…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="w-44"
                />
                <Select value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)} className="w-32" title="按分组过滤">
                  <option value="">全部分组</option>
                  {groups.map((group) => (
                    <option key={group} value={group}>
                      {group}
                    </option>
                  ))}
                </Select>
                <Button variant="ghost" disabled={items.length >= 100} onClick={appendItem}>
                  添加一项
                </Button>
                <Button variant="ghost" onClick={() => void openSync()}>
                  从文件夹同步
                </Button>
                <Button disabled={saving || invalid !== null} loading={saving} onClick={() => void save()}>
                  保存全部
                </Button>
              </>
            ) : null
          }
        >
          {invalid ? <p className="text-xs text-amber-400">{invalid}</p> : null}
          {items.length === 0 ? (
            <p className="text-sm text-slate-400">清单空着 —— 点「添加一项」或「从文件夹同步」把素材加进来。</p>
          ) : filteredItems.length === 0 ? (
            <p className="text-sm text-slate-400">没有匹配「{query.trim() || groupFilter || "（过滤条件）"}」的条目。</p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className={tableClass}>
                  <thead className={theadClass}>
                    <tr>
                      <th className={thClass}>预览</th>
                      <th className={thClass}>key</th>
                      <th className={thClass}>别名</th>
                      <th className={thClass}>分组</th>
                      <th className={thClass}>显示效果</th>
                      <th className={thClass}>引用</th>
                      <th className={thClass}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedItems.map(({ row, index }) => {
                      const refs = referenceCount(row.key.trim());
                      return (
                        <tr key={index}>
                          <td className={tdClass}>
                            <GameFrame atlas={row.key ? config.atlasOf(row.key) : ""} size={40} alt={row.key} />
                          </td>
                          <td className={tdClass}>
                            <Input
                              value={row.key}
                              placeholder={config.keyExample}
                              disabled={!canWrite}
                              title={config.keyHint}
                              className="w-52 font-mono"
                              onChange={(event) => setItem(index, { key: event.target.value })}
                            />
                          </td>
                          <td className={tdClass}>
                            <Input
                              value={row.name ?? ""}
                              placeholder="给人看的名字（可选）"
                              disabled={!canWrite}
                              maxLength={32}
                              className="w-32"
                              onChange={(event) => setItem(index, { name: event.target.value })}
                            />
                          </td>
                          <td className={tdClass}>
                            <Input
                              value={row.group ?? ""}
                              placeholder="素材系列（可选）"
                              disabled={!canWrite}
                              maxLength={32}
                              className="w-28"
                              onChange={(event) => setItem(index, { group: event.target.value })}
                            />
                          </td>
                          <td className={tdClass}>
                            <Button variant="ghost" disabled={!canWrite} onClick={() => setEffectIndex(index)}>
                              效果 {row.effect ? describeEffect(row.effect as AppearanceEffectValue) : "默认"}
                            </Button>
                          </td>
                          <td className={tdClass}>{refs > 0 ? <Badge tone="indigo">引用 {refs}</Badge> : <Badge tone="slate">未引用</Badge>}</td>
                          <td className={tdClass}>
                            {canWrite ? (
                              <Button
                                variant="ghost"
                                disabled={refs > 0}
                                title={refs > 0 ? `被引用 ${refs} 次，先在引用处换别的${config.noun}` : undefined}
                                onClick={() => removeItem(index)}
                              >
                                删除
                              </Button>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {pageCount > 1 ? (
                <div className="flex items-center justify-end gap-2 pt-1 text-xs text-slate-400">
                  <span>
                    共 {filteredItems.length} 条 · 第 {safePage + 1} / {pageCount} 页
                  </span>
                  <Button variant="ghost" disabled={safePage <= 0} onClick={() => setPage(safePage - 1)}>
                    上一页
                  </Button>
                  <Button variant="ghost" disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)}>
                    下一页
                  </Button>
                </div>
              ) : null}
            </>
          )}
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
          {customs.length === 0 ? (
            <p className="text-sm text-slate-400">还没有特殊装备绑定（所有装备走「前后缀管理」页的棋盘）。</p>
          ) : (
            <div className="overflow-x-auto">
              <table className={tableClass}>
                <thead className={theadClass}>
                  <tr>
                    <th className={thClass}>装备标识</th>
                    <th className={thClass}>{config.noun}</th>
                    <th className={thClass}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {customs.map((row, index) => (
                    <tr key={index}>
                      <td className={tdClass}>
                        <Input value={row.equipment} disabled={!canWrite} className="w-56 font-mono" onChange={(event) => setCustom(index, { equipment: event.target.value })} />
                      </td>
                      <td className={tdClass}>
                        <Select value={row.key} disabled={!canWrite} className="w-52 font-mono" onChange={(event) => setCustom(index, { key: event.target.value })}>
                          <option value="">（选择{config.noun}）</option>
                          {(items ?? []).map((item) => (
                            <option key={item.key} value={item.key}>
                              {item.name?.trim() ? `${item.name.trim()}（${item.key}）` : item.key}
                            </option>
                          ))}
                        </Select>
                      </td>
                      <td className={tdClass}>
                        {canWrite ? (
                          <Button variant="ghost" onClick={() => removeCustom(index)}>
                            删除
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}

      <Modal
        open={effectIndex !== null}
        title={effectEntry ? `显示效果 · ${effectEntry.name?.trim() || effectEntry.key || "（未填 key）"}` : "显示效果"}
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

      <Modal
        open={syncOpen}
        title={`从文件夹同步${config.noun}清单`}
        size="lg"
        onClose={() => setSyncOpen(false)}
        footer={
          <>
            <Button variant="outline" onClick={() => setSyncOpen(false)} disabled={syncing}>
              取消
            </Button>
            <Button
              variant={scan && scan.removed.length > 0 ? "danger" : "primary"}
              loading={syncing}
              disabled={!scan || (scan.added.length === 0 && scan.removed.length === 0)}
              onClick={() => void runSync()}
            >
              执行同步
            </Button>
          </>
        }
      >
        {scanLoading || !scan ? (
          <div className="flex items-center gap-2 py-6 text-sm text-slate-400">
            <Spinner /> 正在扫描资源文件夹…
          </div>
        ) : (
          <div className="flex flex-col gap-3 text-sm text-slate-300">
            <p>
              以 <span className="break-all font-mono text-xs text-slate-400">{scan.dir}</span> 为准：文件夹里有
              <span className="mx-1 text-slate-100">{scan.keys.length}</span>个{config.noun}素材。
            </p>
            {scan.added.length === 0 && scan.removed.length === 0 ? (
              <p className="text-slate-400">清单与文件夹一致，无需同步。</p>
            ) : null}
            {scan.added.length > 0 ? (
              <section>
                <p className="text-emerald-400">将新增 {scan.added.length} 条（effect 缺省，之后可在清单里调）</p>
                <ChipList keys={scan.added} tone="text-emerald-300/80" />
              </section>
            ) : null}
            {scan.removed.length > 0 ? (
              <section>
                <p className="text-rose-400">将移除 {scan.removed.length} 条（文件夹里已没有对应素材）</p>
                <ChipList keys={scan.removed} tone="text-rose-300/80" />
              </section>
            ) : null}
            {scan.removedReferenced.length > 0 ? (
              <p className="rounded border border-amber-700/60 bg-amber-900/20 p-2 text-xs leading-relaxed text-amber-300">
                其中 {scan.removedReferenced.length} 条（{scan.removedReferenced.join("、")}）仍被前后缀棋盘 / 特殊装备绑定引用 ——
                同步照样移除，引用处会显示异常（客户端安静跳过），之后请在「前后缀管理」页或下方绑定区改引用别的{config.noun}。
              </p>
            ) : null}
          </div>
        )}
      </Modal>
    </div>
  );
}

/** 同步预览里的 key 长列表：等宽小字流式排布，超高内滚（84 条不撑破弹窗） */
function ChipList({ keys, tone }: { keys: string[]; tone: string }) {
  return (
    <p className={`mt-1 max-h-32 overflow-y-auto break-all font-mono text-xs leading-5 ${tone}`}>{keys.join("　")}</p>
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
    if ((row.name ?? "").trim().length > 32) return `清单第 ${index + 1} 条（${key}）的别名最长 32 字。`;
    if ((row.group ?? "").trim().length > 32) return `清单第 ${index + 1} 条（${key}）的分组名最长 32 字。`;
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
