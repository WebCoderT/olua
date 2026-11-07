import { useCallback, useEffect, useState } from "react";
import { formatTime, levelScrollsApi, PERMISSION } from "../api";
import type { CreateLevelScroll, LevelScroll, LevelScrollPage, UpdateLevelScroll } from "../api";
import { GameIcon } from "../components/GameImage";
import { IconField } from "../components/ImagePicker";
import { anyPickerOpen } from "../components/pickerStack";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Modal } from "../components/Modal";
import { Pagination } from "../components/Pagination";
import { PageHeader } from "../components/PageHeader";
import { Badge, Button, Card, EmptyState, Field, Input, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";

/** 等级区间的取值上限（与服务端 `LEVEL_SCROLL_LEVEL_MAX` 对齐，只做输入框提示） */
const LEVEL_MAX = 10_000_000;

/** 出厂切法的跨度：每 1000 级一卷 */
const LEVEL_STEP = 1000;

/** 弹窗里编辑的字段（新建 / 编辑共用；id 只在新建时可填） */
type ScrollForm = {
  id: string;
  label: string;
  description: string;
  icon: string;
  minLevel: number;
  maxLevel: number;
  maxStack: number;
  sellPrice: number;
};

/**
 * 空表单：默认落在「下一段还没开过的区间」
 *
 * 卷轴是按等级往上开的，所以新建最常做的事就是「接着最后一卷往下开一段」——
 * 这里故意从 1~999 起（没有数据时的兜底），真正方便的是列表下方那句提示与
 * 「按最后一卷续开」按钮。
 */
function emptyForm(minLevel = 1): ScrollForm {
  return {
    id: "",
    label: "",
    description: "",
    icon: "item/scroll/level-scroll",
    minLevel,
    maxLevel: minLevel + LEVEL_STEP - 1,
    maxStack: 999,
    sellPrice: 0,
  };
}

/** 数字带千分位（6999 → 6,999；区间一眼看得清位数） */
function levelText(value: number): string {
  return value.toLocaleString("zh-CN");
}

/**
 * 升级卷轴配置（#787）
 *
 * 背包里「使用后硬性 +1 级」的道具，**带等级区间**：Lv1 只在 1 ~ 999 级可用，
 * 用出这段就换 Lv2（出厂 7 卷覆盖 1 ~ 6999）。等级区间是两个可改的列，不是代码规则 ——
 * 想开一卷 500 ~ 800 的怪卷照样能建（区间重叠也不报错，只是两卷都能用）。
 *
 * 增删改都在这一页：`id` 是背包引用的键，只在新建时可填（缺省按区间派生）；
 * 删除**只删配置行、不碰玩家存档**，背包里还引用它的格子会变成认不出的道具 ——
 * 客户端与结算都只是安静跳过（用不了，也不报错）。
 */
export function LevelScrollsPage() {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [draftKeyword, setDraftKeyword] = useState("");
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(50);
  const [data, setData] = useState<LevelScrollPage | null>(null);
  const [loading, setLoading] = useState(true);
  /** 正在编辑的行（null = 弹窗没开） */
  const [editing, setEditing] = useState<LevelScroll | null>(null);
  /** 正在新建（弹窗没开 = false） */
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<ScrollForm>(emptyForm());
  const [saving, setSaving] = useState(false);
  /** 待删除的行（二次确认弹窗） */
  const [removing, setRemoving] = useState<LevelScroll | null>(null);
  const [removingBusy, setRemovingBusy] = useState(false);
  /**
   * 已开到的最高等级（「按最高档续开一卷」的起点）
   *
   * **单独一条请求取**（`sort=minLevel&order=desc&size=1`），不从当前页里凑：
   * 卷轴是「每 1000 级一卷」开下去的，理论上能到上万卷，当前页的最高不一定是全表的最高 ——
   * 拿当前页凑出来的起点可能撞上已有区间（新建直接 50044，或者建出一段重叠的怪卷）。
   */
  const [topMaxLevel, setTopMaxLevel] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await levelScrollsApi.list({ page, size, keyword: keyword || undefined }));
      const top = await levelScrollsApi.list({ page: 1, size: 1, sort: "minLevel", order: "desc" });
      setTopMaxLevel(top.list[0]?.maxLevel ?? 0);
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, [page, size, keyword]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitSearch = () => {
    setPage(1);
    setKeyword(draftKeyword.trim());
  };

  const resetSearch = () => {
    setDraftKeyword("");
    setKeyword("");
    setPage(1);
  };

  /** 每页条数变化：回第一页再拉（条数变了页码语义也变了） */
  const handleSizeChange = (next: number) => {
    setSize(next);
    setPage(1);
  };

  /** 当前已开的最高等级（整表口径，见 `topMaxLevel` 的说明） */
  const highestMax = topMaxLevel;

  const openCreate = (startFromTop = false) => {
    // 「续开」：从当前最高等级 +1 起，跨一整个 1000 段
    const from = startFromTop && highestMax > 0 ? highestMax + 1 : 1;
    setCreating(true);
    setForm(emptyForm(from));
  };

  const openEdit = (item: LevelScroll) => {
    setEditing(item);
    setForm({
      id: item.id,
      label: item.label,
      description: item.description,
      icon: item.icon,
      minLevel: item.minLevel,
      maxLevel: item.maxLevel,
      maxStack: item.maxStack,
      sellPrice: item.sellPrice,
    });
  };

  const closeDialog = () => {
    setCreating(false);
    setEditing(null);
  };

  /** 新建：只发有值的字段，空串一律不发（让服务端按区间派生 id / 名称 / 描述） */
  const submitCreate = async () => {
    const body: CreateLevelScroll = {
      minLevel: form.minLevel,
      maxLevel: form.maxLevel,
      maxStack: form.maxStack,
      sellPrice: form.sellPrice,
    };
    if (form.id.trim()) body.id = form.id.trim();
    if (form.label.trim()) body.label = form.label.trim();
    if (form.description.trim()) body.description = form.description.trim();
    if (form.icon.trim()) body.icon = form.icon.trim();
    setSaving(true);
    try {
      const created = await levelScrollsApi.create(body);
      toastSuccess(`升级卷轴「${created.label}」已创建（id：${created.id}）`);
      closeDialog();
      await load();
    } catch {
      /* 失败保持弹窗打开，请求层已统一提示 */
    } finally {
      setSaving(false);
    }
  };

  /** 编辑（部分更新：只发弹窗里有的字段；id 不可改，所以不放进去） */
  const submitEdit = async () => {
    if (!editing) return;
    const body: UpdateLevelScroll = {
      label: form.label,
      description: form.description,
      icon: form.icon,
      minLevel: form.minLevel,
      maxLevel: form.maxLevel,
      maxStack: form.maxStack,
      sellPrice: form.sellPrice,
    };
    setSaving(true);
    try {
      await levelScrollsApi.update(editing.id, body);
      toastSuccess(`升级卷轴「${form.label}」已更新`);
      closeDialog();
      await load();
    } catch {
      /* 失败保持弹窗打开，请求层已统一提示 */
    } finally {
      setSaving(false);
    }
  };

  const submitRemove = async () => {
    if (!removing) return;
    setRemovingBusy(true);
    try {
      const result = await levelScrollsApi.delete(removing.id);
      toastSuccess(result.removed > 0 ? `已删除「${removing.label}」` : "这条刚被别人删掉了");
      setRemoving(null);
      await load();
    } catch {
      /* 失败保持弹窗打开，请求层已统一提示 */
    } finally {
      setRemovingBusy(false);
    }
  };

  const dialogOpen = creating || editing !== null;
  /** 区间反了（弹窗里的按钮据此禁用，省一次 400） */
  const rangeInvalid = form.minLevel > form.maxLevel;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="升级卷轴"
        description={
          <>
            使用后等级直接 +1（不消耗经验），但只能在各自的等级区间里用：Lv1 = 1~999、Lv2 = 1000~1999 …
            出厂 7 卷覆盖 1~6999。区间是两列可改的数，不是代码规则 —— 想开「500~800」的怪卷也能建。
            使用判定读服务端这张表，改完即时生效；删除只删配置行、不碰玩家存档。
          </>
        }
        actions={
          <div className="flex gap-2">
            <Button variant="outline" disabled={!canWrite} onClick={() => openCreate(true)}>
              按最高档续开一卷
            </Button>
            <Button disabled={!canWrite} onClick={() => openCreate(false)}>
              新建升级卷轴
            </Button>
          </div>
        }
      />

      <Card>
        <div className="flex flex-wrap items-end gap-2">
          <Field width="w-56" label="id / 名称 / 描述">
            <Input
              value={draftKeyword}
              placeholder="支持模糊匹配"
              onChange={(event) => setDraftKeyword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitSearch();
              }}
            />
          </Field>
          <Button onClick={submitSearch}>查询</Button>
          <Button variant="outline" onClick={resetSearch}>
            重置
          </Button>
        </div>
      </Card>

      <Card
        title="升级卷轴列表"
        actions={loading ? <Spinner /> : null}
        description={canWrite ? undefined : "当前角色没有「修改养成配置」权限，列表只读。"}
      >
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>图</th>
                <th className={thClass}>id</th>
                <th className={thClass}>名称</th>
                <th className={thClass}>可用等级</th>
                <th className={thClass}>堆叠</th>
                <th className={thClass}>售价</th>
                <th className={thClass}>更新时间</th>
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {data?.list.map((item) => (
                <tr key={item.id} className="transition hover:bg-slate-800/30">
                  <td className={tdClass}>
                    <GameIcon path={item.icon} alt={item.label} />
                  </td>
                  <td className={`${tdClass} font-mono text-xs text-slate-300`}>{item.id}</td>
                  <td className={tdClass}>
                    <span className="block font-medium text-slate-100">{item.label}</span>
                    <span className="mt-0.5 block max-w-[320px] truncate text-xs text-slate-500" title={item.description}>
                      {item.description || "—"}
                    </span>
                  </td>
                  <td className={tdClass}>
                    <Badge tone="amber">
                      {levelText(item.minLevel)} ~ {levelText(item.maxLevel)}
                    </Badge>
                  </td>
                  <td className={tdClass}>{item.maxStack}</td>
                  <td className={tdClass}>{item.sellPrice > 0 ? levelText(item.sellPrice) : "不可出售"}</td>
                  <td className={`${tdClass} text-xs text-slate-400`}>{formatTime(item.updatedAt)}</td>
                  <td className={`${tdClass} text-right`}>
                    <div className="flex justify-end gap-2">
                      <Button variant="outline" className="px-2.5 py-1 text-xs" disabled={!canWrite} onClick={() => openEdit(item)}>
                        编辑
                      </Button>
                      <Button variant="danger" className="px-2.5 py-1 text-xs" disabled={!canWrite} onClick={() => setRemoving(item)}>
                        删除
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!loading && data && data.list.length === 0 ? (
          <EmptyState title="没有匹配的升级卷轴" description="换个筛选条件，或点右上角「新建升级卷轴」" />
        ) : null}

        <Pagination page={page} size={size} total={data?.total ?? 0} onChange={setPage} onSizeChange={handleSizeChange} />
      </Card>

      {dialogOpen ? (
        <Modal
          open
          title={creating ? "新建升级卷轴" : <>编辑升级卷轴 · {editing?.id}</>}
          hint={
            creating
              ? "只填「等级区间」就能建：id / 名称 / 描述留空会按区间自动派生（区间正好是 1~999 / 1000~1999 … 时是 level_scroll_卷号，否则是 level_scroll_下限_上限）。"
              : "部分更新：只提交下方字段。id 是背包引用的键，不可修改（改 id 等于换一件物品）。"
          }
          size="md"
          /* Esc 先到编辑弹窗：选择器开着时不能把编辑弹窗一起关掉（改了一半的内容会丢） */
          onClose={() => {
            if (!anyPickerOpen()) closeDialog();
          }}
          footer={
            <>
              <Button variant="outline" onClick={closeDialog} disabled={saving}>
                取消
              </Button>
              <Button
                disabled={saving || rangeInvalid || (!creating && !form.label.trim())}
                loading={saving}
                onClick={() => void (creating ? submitCreate() : submitEdit())}
              >
                {creating ? "创建" : "保存修改"}
              </Button>
            </>
          }
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="可用等级下限" hint={`含本级；1 ~ ${LEVEL_MAX}`}>
              <Input
                type="number"
                min={1}
                max={LEVEL_MAX}
                value={String(form.minLevel)}
                onChange={(event) => setForm({ ...form, minLevel: Math.max(1, Math.floor(Number(event.target.value) || 1)) })}
              />
            </Field>
            <Field label="可用等级上限" hint="含本级；用出这段就换下一卷">
              <Input
                type="number"
                min={1}
                max={LEVEL_MAX}
                value={String(form.maxLevel)}
                onChange={(event) => setForm({ ...form, maxLevel: Math.max(1, Math.floor(Number(event.target.value) || 1)) })}
              />
            </Field>
          </div>
          {rangeInvalid ? (
            <p className="text-xs text-rose-400">下限不能大于上限（现在是 {form.minLevel} ~ {form.maxLevel}）。</p>
          ) : (
            <p className="text-xs text-slate-500">
              这一卷在 {levelText(form.minLevel)} ~ {levelText(form.maxLevel)} 级可用；用完之后角色等级正好是{" "}
              {levelText(form.maxLevel + 1)} 级 —— 再要升就得换下一卷。
            </p>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Button
              variant="outline"
              className="justify-self-start"
              onClick={() => setForm({ ...form, maxLevel: form.minLevel + LEVEL_STEP - 1 })}
            >
              按 1000 级跨度补满上限
            </Button>
          </div>

          {creating ? (
            <Field label="id" hint="留空 = 按区间派生（推荐）；小写字母开头，只能用小写字母 / 数字 / 下划线">
              <Input value={form.id} placeholder="留空自动生成，如 level_scroll_8" onChange={(event) => setForm({ ...form, id: event.target.value })} />
            </Field>
          ) : (
            <Field label="id" hint="主键，创建后不可修改（背包里按它引用）">
              <Input value={form.id} disabled />
            </Field>
          )}

          <Field label="名称" hint={creating ? "留空 = 「升级卷轴 Lv卷号」或「升级卷轴 下限~上限」" : undefined}>
            <Input value={form.label} placeholder={creating ? "留空自动生成，如 升级卷轴 Lv8" : undefined} onChange={(event) => setForm({ ...form, label: event.target.value })} />
          </Field>
          <Field label="描述" hint={creating ? "留空 = 「等级 X ~ Y 时可用…」" : undefined}>
            <Input value={form.description} placeholder={creating ? "留空自动生成" : undefined} onChange={(event) => setForm({ ...form, description: event.target.value })} />
          </Field>
          <IconField
            label="图标"
            hint="resources 相对路径（如 item/scroll/level-scroll，不带扩展名）；空串 = 不显示图标"
            rootDir="item"
            placeholder="item/scroll/level-scroll"
            value={form.icon}
            onChange={(path) => setForm({ ...form, icon: path })}
          />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="堆叠上限" hint="背包里最多叠多少个">
              <Input
                type="number"
                min={1}
                max={999}
                value={String(form.maxStack)}
                onChange={(event) => setForm({ ...form, maxStack: Math.min(999, Math.max(1, Math.floor(Number(event.target.value) || 1))) })}
              />
            </Field>
            <Field label="售卖价" hint="0 = 不可出售">
              <Input
                type="number"
                min={0}
                value={String(form.sellPrice)}
                onChange={(event) => setForm({ ...form, sellPrice: Math.max(0, Math.floor(Number(event.target.value) || 0)) })}
              />
            </Field>
          </div>
        </Modal>
      ) : null}

      <ConfirmDialog
        open={removing !== null}
        title="删除升级卷轴"
        description={
          removing
            ? `确定删除「${removing.label}」（${removing.id}，${levelText(removing.minLevel)} ~ ${levelText(removing.maxLevel)} 级）？只删配置行，玩家背包里还引用它的格子会变成认不出的道具 —— 用不了，也不报错。`
            : undefined
        }
        confirmText="删除"
        loading={removingBusy}
        onConfirm={() => void submitRemove()}
        onCancel={() => setRemoving(null)}
      />
    </div>
  );
}
