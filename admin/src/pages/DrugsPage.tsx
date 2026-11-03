import { useCallback, useEffect, useState } from "react";
import { drugIcon, drugsApi, formatTime, PERMISSION } from "../api";
import type { Drug, PageResult } from "../api";
import { GameIcon } from "../components/GameImage";
import { ImagePicker } from "../components/ImagePicker";
import { Modal } from "../components/Modal";
import { Pagination } from "../components/Pagination";
import { Badge, Button, Card, EmptyState, Field, Input, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";
import { PageHeader } from "../components/PageHeader";

/** 回复摘要（列表列太窄，只报关键数；完整数值在编辑弹窗里） */
function effectSummary(item: Drug): string {
  const parts: string[] = [];
  if (item.effectHp > 0) parts.push(`血 ${item.effectHp}`);
  if (item.effectMp > 0) parts.push(`蓝 ${item.effectMp}`);
  if (item.effectHpPercent > 0) parts.push(`血 ${item.effectHpPercent}%`);
  if (item.effectMpPercent > 0) parts.push(`蓝 ${item.effectMpPercent}%`);
  return parts.length > 0 ? parts.join(" · ") : "—";
}

/**
 * 药品配置管理（#253，养成配置第五页）
 *
 * **没有「新建」「删除」**：药品 id 清单固定（被掉落表与背包引用，启动时 seed 落库），
 * 只有「编辑」。使用等级（`level`）自 #643 起可改：它只影响展示与背包排序，
 * 服务端用药**不拦等级**（玩家血少时越级吃药是合理操作）。
 * 四项回复量是 effects 数组按键求和后的单值（客户端逐项累加，语义等价）。
 * 魔法药走百分比回复、金创药走固定值 —— 同一张表里两种口径并存，编辑时看数值本身。
 * 商城售价不在这里（唯一写入口归商城定价 issue）。写操作要 `gameConfig:write`。
 */
export function DrugsPage() {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [draftKeyword, setDraftKeyword] = useState("");
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const [data, setData] = useState<PageResult<Drug> | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Drug | null>(null);
  const [form, setForm] = useState<Drug | null>(null);
  /** 图标选择器开合（编辑弹窗里的「选择」按钮） */
  const [picking, setPicking] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await drugsApi.list({ page, size, keyword: keyword || undefined }));
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
    setPage(1);
    setKeyword("");
  };

  /** 每页条数变化：回第一页再拉（条数变了页码语义也变了） */
  const handleSizeChange = (next: number) => {
    setSize(next);
    setPage(1);
  };

  const openEdit = (item: Drug) => {
    setEditing(item);
    setForm({ ...item });
  };

  const closeEdit = () => {
    setPicking(false);
    setEditing(null);
    setForm(null);
  };

  /** 编辑弹窗提交（部分更新：只发弹窗里有的字段） */
  const submitEdit = async () => {
    if (!editing || !form) return;
    try {
      await drugsApi.update(editing.id, {
        label: form.label,
        description: form.description,
        icon: form.icon,
        level: form.level,
        sellPrice: form.sellPrice,
        maxStack: form.maxStack,
        cooldown: form.cooldown,
        effectHp: form.effectHp,
        effectMp: form.effectMp,
        effectHpPercent: form.effectHpPercent,
        effectMpPercent: form.effectMpPercent,
      });
      toastSuccess(`药品「${form.label}」已更新`);
      closeEdit();
      await load();
    } catch {
      /* 失败保持弹窗打开，请求层已统一提示 */
    }
  };

  const numberField = (label: string, hint: string, key: keyof Drug, min: number, max: number) => (
    <Field label={label} hint={hint}>
      <Input
        type="number"
        min={min}
        max={max}
        value={String(form?.[key] ?? 0)}
        onChange={(event) => setForm(form ? ({ ...form, [key]: Math.max(min, Math.floor(Number(event.target.value) || 0)) } as Drug) : form)}
      />
    </Field>
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="药品配置"
        description={<>id 清单固定（被掉落表与背包引用），只可编辑、不可新增 / 删除；使用等级可改（只影响展示与背包排序，不拦用药）。
            商城售价归「商城定价」管理，不在这里。</>}
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
        title="药品列表"
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
                <th className={thClass}>等级</th>
                <th className={thClass}>回复</th>
                <th className={thClass}>冷却</th>
                <th className={thClass}>售价</th>
                <th className={thClass}>堆叠</th>
                <th className={thClass}>更新时间</th>
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {data?.list.map((item) => (
                <tr key={item.id} className="transition hover:bg-slate-800/30">
                  <td className={tdClass}>
                    <GameIcon path={item.icon || drugIcon(item.id)} alt={item.label} />
                  </td>
                  <td className={`${tdClass} font-mono text-xs text-slate-300`}>{item.id}</td>
                  <td className={tdClass}>
                    <span className="block font-medium text-slate-100">{item.label}</span>
                    <span className="mt-0.5 block max-w-[240px] truncate text-xs text-slate-500" title={item.description}>
                      {item.description}
                    </span>
                  </td>
                  <td className={tdClass}>{item.level}</td>
                  <td className={`${tdClass} text-xs text-slate-300`}>{effectSummary(item)}</td>
                  <td className={tdClass}>{item.cooldown}s</td>
                  <td className={tdClass}>{item.sellPrice}</td>
                  <td className={tdClass}>
                    <Badge tone="slate">{item.maxStack}</Badge>
                  </td>
                  <td className={`${tdClass} text-xs text-slate-400`}>{formatTime(item.updatedAt)}</td>
                  <td className={`${tdClass} text-right`}>
                    <Button variant="outline" className="px-2.5 py-1 text-xs" disabled={!canWrite} onClick={() => openEdit(item)}>
                      编辑
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!loading && data && data.list.length === 0 ? <EmptyState title="没有匹配的药品" description="换个筛选条件试试" /> : null}

        <Pagination page={page} size={size} total={data?.total ?? 0} onChange={setPage} onSizeChange={handleSizeChange} />
      </Card>

      {form ? (
        <>
          <Modal
            open
            title={<>编辑药品 · {editing?.id}</>}
            hint="部分更新：只提交下方字段；回复量按「血/蓝固定值 + 百分比」四项独立生效（客户端各自封顶结算）。"
            size="md"
            /* Esc 先到编辑弹窗：选择器开着时不能把编辑弹窗一起关掉（改了一半的内容会丢） */
            onClose={() => {
              if (!picking) closeEdit();
            }}
            footer={<>
              <Button variant="outline" onClick={closeEdit}>
                取消
              </Button>
              <Button disabled={!form.label.trim()} onClick={() => void submitEdit()}>
                保存修改
              </Button>
            </>}
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="名称">
                <Input value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} />
              </Field>
              <Field label="售卖价" hint="0 = 不可售卖；商城售价归「商城定价」管理">
                <Input
                  type="number"
                  min={0}
                  value={String(form.sellPrice)}
                  onChange={(event) => setForm({ ...form, sellPrice: Math.max(0, Math.floor(Number(event.target.value) || 0)) })}
                />
              </Field>
            </div>
            <Field label="描述">
              <Input value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
            </Field>
            <Field label="图标" hint="resources 相对路径（如 item/fs_2，不带扩展名）；空串 = 不显示图标">
              <div className="flex items-center gap-2">
                {/* 当前值的即时预览：换图时不用等保存就能看出对不对 */}
                <GameIcon path={form.icon} alt={form.label} zoomable={false} />
                <Input
                  className="flex-1"
                  value={form.icon}
                  placeholder="item/fs_2"
                  onChange={(event) => setForm({ ...form, icon: event.target.value })}
                />
                <Button variant="outline" className="shrink-0" onClick={() => setPicking(true)}>
                  选择图片
                </Button>
              </div>
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {numberField("使用等级", "展示与背包排序用；服务端用药不拦等级", "level", 1, 60)}
              {numberField("固定回复生命", "使用后立即回复的 HP", "effectHp", 0, 100000000)}
              {numberField("固定回复魔法", "使用后立即回复的 MP", "effectMp", 0, 100000000)}
              {numberField("百分比回复血（%）", "按角色 maxHp 的百分比，50 = 50%", "effectHpPercent", 0, 100)}
              {numberField("百分比回复蓝（%）", "按角色 maxMp 的百分比，50 = 50%", "effectMpPercent", 0, 100)}
              {numberField("使用冷却（秒）", "0 = 无冷却", "cooldown", 0, 3600)}
              {numberField("堆叠上限", "背包里最多叠多少个", "maxStack", 1, 9999)}
            </div>
          </Modal>
          {/*
            图标选择器叠在编辑弹窗之上。Esc 是两个 Modal 各挂一个 window 监听：
            编辑弹窗先注册、先收到 —— 不拦一下就会「关选择器顺带把编辑弹窗也关了」，
            改了一半的内容全丢。放行条件见上面的 onClose。
          */}
          {picking ? (
            <ImagePicker
              open
              title="选择药品图标"
              rootDir="item"
              value={form.icon}
              onSelect={(path) => setForm({ ...form, icon: path })}
              onClose={() => setPicking(false)}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}
