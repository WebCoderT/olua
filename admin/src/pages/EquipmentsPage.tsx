import { useCallback, useEffect, useMemo, useState } from "react";
import { equipmentsApi, equipmentVariantsApi, formatTime, OCCUPATION_LABELS, PERMISSION, SEX_LABELS, slotLabel } from "../api";
import type {
  ConfigAttributes,
  CreateEquipment,
  Equipment,
  EquipmentListItem,
  EquipmentSlotSummary,
  EquipmentVariantRebuildResult,
  PageResult,
} from "../api";
import { AttributesGrid, crossedRangeKeys } from "../components/AttributesEditor";
import { EntityPickButton } from "../components/entity/EntityPickButton";
import { entityOptions } from "../components/entity/catalog";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { EquipmentVariantsDialog } from "../components/EquipmentVariantsDialog";
import { FrameAnimation } from "../components/FrameAnimation";
import { GameIcon } from "../components/GameImage";
import { IconField } from "../components/ImagePicker";
import { anyPickerOpen } from "../components/pickerStack";
import { Modal } from "../components/Modal";
import { Pagination } from "../components/Pagination";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";
import { PageHeader } from "../components/PageHeader";

/** 属性摘要（列表列太窄，只报几个关键数；完整数值在编辑弹窗里） */
function attributeSummary(item: Equipment): string {
  const a = item.attributes;
  return `生命 ${a.maxHp} · 物攻 ${a.physicalAttack.min}~${a.physicalAttack.max} · 物防 ${a.physicalDefense.min}~${a.physicalDefense.max}`;
}

/**
 * 部位页签（#773：列表按部位拆开，页签上的件数来自 `GET admin/equipments/summary`）
 *
 * 顺序就是服务端 `equipment_slots.sort_order` —— 与角色弹窗的槽位排列、背包「一键整理」
 * 的部位序同一份，管理端不另排。件数为 0 的部位照样出现（页签上显示 0）：那是「这里
 * 还空着、可以在这一栏新建」，凭空少一个部位只会让人以为漏了。
 */
function SlotTabs({
  summary,
  active,
  onChange,
}: {
  summary: EquipmentSlotSummary | null;
  active: string;
  onChange: (slot: string) => void;
}) {
  const tabs = [{ slot: "", label: "全部", count: summary?.total ?? 0 }, ...(summary?.slots ?? [])];
  return (
    <div className="flex flex-wrap gap-1.5">
      {tabs.map((tab) => {
        const selected = tab.slot === active;
        return (
          <button
            key={tab.slot || "all"}
            type="button"
            onClick={() => onChange(tab.slot)}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition ${
              selected
                ? "border-gold/60 bg-gold/15 text-gold-hi"
                : "border-line-strong text-ink-3 hover:border-line-strong hover:bg-surface-4/60"
            }`}
          >
            {tab.label}
            <span className={selected ? "text-gold/80" : "text-ink-5"}>{tab.count}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * 新建装备弹窗（#773）
 *
 * 只收「身份 + 基础数值」：资源细节（缩放 / 旋转 / 锚点 / 8 向位置）与八项属性一律从
 * **模板**（同部位的一件现成装备）复制 —— 让运营手抄 8 个方向的位置是折磨，抄错还会把
 * 新装备画到屏幕外。建完在「编辑」弹窗里逐项改。
 *
 * `id` 留空由服务端按 `部位_序号` 生成（该部位最大序号 + 1），不填就对了；要固定 id
 *（比如资源目录名已经按它起好）才手填。
 *
 * **等级 / 售价留空 = 跟模板**（#777）：这两格一旦有值就会盖掉模板的值，所以空串按
 * 「不传」处理。以前是「加载模板后把第一件的等级售价填进输入框」，看起来像跟模板，
 * 其实换了模板也不刷新 —— 改一个部位就得手动改两次。
 */
function EquipmentCreateDialog({
  open,
  slots,
  defaultSlot,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  slots: Array<{ slot: string; label: string; count: number }>;
  defaultSlot: string;
  onCancel: () => void;
  onSubmit: (value: CreateEquipment) => Promise<boolean>;
}) {
  const [slot, setSlot] = useState(defaultSlot);
  const [templateId, setTemplateId] = useState("");
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  // 空串 = 跟模板（服务端 `dto.level ?? template.level`）；填了才覆盖
  const [level, setLevel] = useState("");
  const [sellPrice, setSellPrice] = useState("");
  const [occupation, setOccupation] = useState("4");
  const [sex, setSex] = useState("3");
  const [bindOnDrop, setBindOnDrop] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSlot(defaultSlot || slots[0]?.slot || "");
    setId("");
    setLabel("");
    setLevel("");
    setSellPrice("");
    setOccupation("4");
    setSex("3");
    setBindOnDrop(false);
    setSubmitting(false);
  }, [open, defaultSlot, slots]);

  /**
   * 模板候选 = 选中部位的全部装备。
   *
   * 走 `catalog` 而不是拉接口：一个部位已经有 100+ 件（戒指 136），列表接口的 `size`
   * 上限就是 100 —— 拉不全，而且下拉里翻 130 项找一件装备本身也没法用。选择器自带
   * 关键字搜索与分组，正好。
   */
  const templateOptions = useMemo(() => {
    const group = slots.find((row) => row.slot === slot)?.label ?? slotLabel(slot);
    return entityOptions("equipment").filter((option) => option.group === group);
  }, [slot, slots]);

  /**
   * 换部位就把模板换成该部位第一件（图标 / 图集 / 几何都靠它带出来）。
   *
   * 只在**部位真的变了**时动 `templateId` —— 用 `templateSlot` 记住上次为哪个部位挑过，
   * 这样运营手动选「空白」之后不会被下一帧又塞回第一件。
   */
  const [templateSlot, setTemplateSlot] = useState("");
  useEffect(() => {
    if (!open || templateSlot === slot) return;
    setTemplateSlot(slot);
    setTemplateId(templateOptions[0]?.id ?? "");
  }, [open, slot, templateOptions, templateSlot]);

  if (!open) return null;

  // 空串 = 跟模板，所以「空」是合法值；填了才校验
  const levelValid = level.trim() === "" || (Number.isInteger(Number(level)) && Number(level) >= 1);
  const priceValid = sellPrice.trim() === "" || (Number.isInteger(Number(sellPrice)) && Number(sellPrice) >= 0);
  const canSubmit = label.trim().length > 0 && levelValid && priceValid && slot !== "" && !submitting;

  const submit = async () => {
    setSubmitting(true);
    const ok = await onSubmit({
      // 空串一律当「不传」：服务端按部位生成 id、按模板补等级售价，比传空串 / 0 语义清楚
      id: id.trim() || undefined,
      slot,
      label: label.trim(),
      templateId: templateId || undefined,
      level: level.trim() ? Number(level) : undefined,
      sellPrice: sellPrice.trim() ? Number(sellPrice) : undefined,
      occupation,
      sex,
      bindOnDrop,
    });
    setSubmitting(false);
    return ok;
  };

  return (
    <Modal
      open
      title="新建装备"
      hint="部位与名称是身份；id 留空由服务端按「部位_序号」生成。资源与八项属性从模板复制，建完在「编辑」里逐项改。"
      size="md"
      onClose={onCancel}
      footer={
        <>
          <Button variant="outline" disabled={submitting} onClick={onCancel}>
            取消
          </Button>
          <Button disabled={!canSubmit} loading={submitting} onClick={() => void submit()}>
            新建
          </Button>
        </>
      }
    >
      <div className="mt-5 flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="部位" hint="决定角色弹窗里的槽位；部位清单归「装备槽位」表">
            <Select value={slot} onChange={(event) => setSlot(event.target.value)}>
              {slots.map((row) => (
                <option key={row.slot} value={row.slot}>
                  {row.label}（{row.count}）
                </option>
              ))}
            </Select>
          </Field>
          <Field label="模板" hint="复制图标 / 图集 / 几何 / 职业性别 / 描述 / 八项属性；选「空白」就是白纸（客户端看不到外观）">
            <EntityPickButton
              value={templateId}
              options={templateOptions}
              onChange={setTemplateId}
              kind="equipment"
              pickerTitle={`选择模板（${slots.find((row) => row.slot === slot)?.label ?? slot}）`}
              hint="只列这个部位的装备；模板决定新装备长什么样"
              emptyHint="这个部位还没有装备 —— 先建一件，或用「空白」建个不带外观的"
              placeholder="空白（复制默认值）"
            />
          </Field>
          <Field label="装备 id" hint="留空自动生成（如 cloth_33）；只能小写字母开头 + 小写字母/数字/下划线">
            <Input value={id} placeholder="留空自动生成" onChange={(event) => setId(event.target.value)} />
          </Field>
          <Field label="名称" hint="≤50 字；前后缀由客户端拼在名字前后">
            <Input value={label} placeholder="如 玄铁重甲" onChange={(event) => setLabel(event.target.value)} />
          </Field>
          <Field label="穿戴需求等级" hint="留空 = 跟模板；装备定强的锚点">
            <Input
              type="number"
              min={1}
              value={level}
              placeholder="跟模板"
              onChange={(event) => setLevel(event.target.value)}
            />
          </Field>
          <Field label="售卖价" hint="留空 = 跟模板；0 = 不可售卖（商城售价归「商城」页）">
            <Input
              type="number"
              min={0}
              value={sellPrice}
              placeholder="跟模板"
              onChange={(event) => setSellPrice(event.target.value)}
            />
          </Field>
          <Field label="职业限制">
            <Select value={occupation} onChange={(event) => setOccupation(event.target.value)}>
              {Object.entries(OCCUPATION_LABELS).map(([code, text]) => (
                <option key={code} value={code}>
                  {text}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="性别限制">
            <Select value={sex} onChange={(event) => setSex(event.target.value)}>
              {Object.entries(SEX_LABELS).map(([code, text]) => (
                <option key={code} value={code}>
                  {text}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="掉落绑定" hint="掉落时强制绑定角色（绑定后不可交易）；不强制时由怪物标记 / 掉落参数随机决定">
            <Select value={bindOnDrop ? "true" : "false"} onChange={(event) => setBindOnDrop(event.target.value === "true")}>
              <option value="false">不强制（按掉落参数随机）</option>
              <option value="true">强制绑定</option>
            </Select>
          </Field>
        </div>
        {!levelValid || !priceValid ? (
          <p className="rounded-lg border border-ember/40 bg-ember/10 px-3 py-2 text-xs text-ember-hi">
            等级需为 ≥1 的整数，售卖价需为 ≥0 的整数。
          </p>
        ) : null}
        <p className="text-xs text-ink-5">
          新建会<b className="text-ink-4">连带展开这件装备的全部前后缀变体</b>（档数取「装备设置」里的前缀 /
          后缀档数，出厂 15 个）—— 变体才是客户端真正认得的东西，少了它们商城与掉落都挂不上。
        </p>
      </div>
    </Modal>
  );
}

/**
 * 装备基础件编辑弹窗（#252 起；#603 第九域扩到「全部显示字段」）
 *
 * 三段：
 * 1. **文案与限制** —— 名称 / 描述 / 职业 / 性别 / 等级 / 售卖价；
 * 2. **资源与几何** —— 图标 / 内观图集 / 外观图集 / 标签 / 两轴缩放 / 内观锚点与旋转 /
 *    外观 8 向位置（出厂值，实际效果以「装备对齐」工作台为准）；
 * 3. **八项基础属性** —— 整份提交、整份替换。
 *
 * 校验分工：可解析性（数字 / 8 个方向 / min ≤ max）在这里做即时提示，权威在服务端
 * （DTO 校验 + 400 错误码）。资源路径只校验「非空 / 长度」，**不校验文件是否存在** ——
 * 素材归属远程发布包，管理端不该按本地文件判存在性。
 */
type EquipmentDraft = {
  label: string;
  description: string;
  occupation: string;
  sex: string;
  level: string;
  sellPrice: string;
  icon: string;
  inAtlas: string;
  outAtlas: string;
  tags: string;
  outScale: string;
  inScaleX: string;
  inScaleY: string;
  inRotate: string;
  inPosX: string;
  inPosY: string;
  outPositions: Array<{ x: string; y: string }>;
  attributes: ConfigAttributes;
  /** 掉落时强制绑定角色（绑定后不可交易）；不勾则由怪物标记 / 掉落参数随机决定 */
  bindOnDrop: boolean;
};

/** 与服务端 `EQUIPMENT_DIRECTIONS` 同序：up / right_up / right / right_down / down / left_down / left / left_up */
const POSITION_DIRECTIONS = ["上", "右上", "右", "右下", "下", "左下", "左", "左上"];

/** 8 向位置缺省补齐（老行可能只有 4 个或空数组） */
function padPositions(points: Equipment["outPositions"] | undefined): Array<{ x: string; y: string }> {
  return Array.from({ length: POSITION_DIRECTIONS.length }, (_, index) => {
    const point = points?.[index];
    return { x: String(point?.x ?? 0), y: String(point?.y ?? 0) };
  });
}

function toDraft(item: Equipment): EquipmentDraft {
  return {
    label: item.label,
    description: item.description ?? "",
    occupation: item.occupation,
    sex: item.sex,
    level: String(item.level),
    sellPrice: String(item.sellPrice),
    icon: item.icon ?? "",
    inAtlas: item.inAtlas ?? "",
    outAtlas: item.outAtlas ?? "",
    tags: (item.tags ?? []).join("、"),
    outScale: String(item.outScale ?? 1),
    inScaleX: String(item.inScaleX ?? 1),
    inScaleY: String(item.inScaleY ?? 1),
    inRotate: String(item.inRotate ?? 0),
    inPosX: String(item.inPosX ?? 0),
    inPosY: String(item.inPosY ?? 0),
    outPositions: padPositions(item.outPositions),
    attributes: { ...item.attributes },
    bindOnDrop: item.bindOnDrop === true,
  };
}

/** 数字输入统一按「空 = 0」以外的语义处理：非数字算非法，避免静默写 0 */
const isNumber = (value: string): boolean => value.trim() !== "" && Number.isFinite(Number(value));

function EquipmentEditDialog({
  open,
  initial,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  initial: Equipment | null;
  onCancel: () => void;
  onSubmit: (value: {
    label: string;
    description: string;
    occupation: string;
    sex: string;
    icon: string;
    inAtlas: string;
    outAtlas: string;
    tags: string[];
    outScale: number;
    inScaleX: number;
    inScaleY: number;
    inRotate: number;
    inPosX: number;
    inPosY: number;
    outPositions: Array<{ x: number; y: number }>;
    level: number;
    sellPrice: number;
    attributes: ConfigAttributes;
    bindOnDrop: boolean;
  }) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<EquipmentDraft | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open || !initial) return;
    setDraft(toDraft(initial));
    setSubmitting(false);
  }, [open, initial]);

  /** 区间交叉（min > max）的键集合；空 = 合法 */
  const crossedKeys = useMemo(() => (draft ? crossedRangeKeys(draft.attributes) : []), [draft]);

  if (!open || !draft || !initial) return null;

  const patch = (next: Partial<EquipmentDraft>) => setDraft({ ...draft, ...next });
  const numbers = [draft.level, draft.sellPrice, draft.outScale, draft.inScaleX, draft.inScaleY, draft.inRotate, draft.inPosX, draft.inPosY];
  const positionsOk = draft.outPositions.length === POSITION_DIRECTIONS.length && draft.outPositions.every((point) => isNumber(point.x) && isNumber(point.y));
  const levelValid = Number.isInteger(Number(draft.level)) && Number(draft.level) >= 1;
  const priceValid = Number.isInteger(Number(draft.sellPrice)) && Number(draft.sellPrice) >= 0;
  const canSubmit = numbers.every(isNumber) && positionsOk && levelValid && priceValid && crossedKeys.length === 0 && !submitting;

  const submit = async () => {
    setSubmitting(true);
    const ok = await onSubmit({
      label: draft.label.trim(),
      description: draft.description.trim(),
      occupation: draft.occupation,
      sex: draft.sex,
      icon: draft.icon.trim(),
      inAtlas: draft.inAtlas.trim(),
      outAtlas: draft.outAtlas.trim(),
      // 标签用顿号 / 逗号 / 空格分隔都收（运营从表格里粘过来常见半角逗号）
      tags: draft.tags
        .split(/[、,，\s]+/)
        .map((tag) => tag.trim())
        .filter(Boolean),
      outScale: Number(draft.outScale),
      inScaleX: Number(draft.inScaleX),
      inScaleY: Number(draft.inScaleY),
      inRotate: Number(draft.inRotate),
      inPosX: Number(draft.inPosX),
      inPosY: Number(draft.inPosY),
      outPositions: draft.outPositions.map((point) => ({ x: Number(point.x), y: Number(point.y) })),
      level: Number(draft.level),
      sellPrice: Number(draft.sellPrice),
      attributes: draft.attributes,
      bindOnDrop: draft.bindOnDrop,
    });
    setSubmitting(false);
    if (!ok) return;
  };

  return (
    <Modal
      open
      title={<>编辑装备 · {initial.id}</>}
      hint={
        <>
          部位 {slotLabel(initial.slot)}（不可改）· 变体属性 = 这里的基础属性 × 前后缀倍率，改基础件即改全部 15 个变体。
          资源路径与几何是**出厂值**：工作台（装备对齐 / 内观对齐）调过的装备，实际效果以工作台为准、每次进图另发。
        </>
      }
      size="lg"
      /* Esc 先到编辑弹窗：图片选择器开着时不能让编辑弹窗一起关（改了一半的内容会丢） */
      onClose={() => {
        if (!anyPickerOpen()) onCancel();
      }}
      footer={
        <>
          <Button variant="outline" disabled={submitting} onClick={onCancel}>
            取消
          </Button>
          <Button disabled={!canSubmit} loading={submitting} onClick={() => void submit()}>
            保存修改
          </Button>
        </>
      }
    >
      <section className="flex flex-col gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-4">文案与限制</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="名称" hint="≤50 字；前后缀由客户端拼在名字前后">
            <Input value={draft.label} onChange={(event) => patch({ label: event.target.value })} />
          </Field>
          <Field label="标签" hint="顿号或逗号分隔，最多 8 个（如「第一大陆」）；详情弹窗展示，无逻辑含义">
            <Input value={draft.tags} onChange={(event) => patch({ tags: event.target.value })} />
          </Field>
          <Field label="职业限制">
            <Select value={draft.occupation} onChange={(event) => patch({ occupation: event.target.value })}>
              {Object.entries(OCCUPATION_LABELS).map(([code, text]) => (
                <option key={code} value={code}>
                  {text}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="性别限制">
            <Select value={draft.sex} onChange={(event) => patch({ sex: event.target.value })}>
              {Object.entries(SEX_LABELS).map(([code, text]) => (
                <option key={code} value={code}>
                  {text}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="穿戴需求等级" hint="装备定强的锚点；属性是存档值，改等级不会自动重算">
            <Input type="number" min={1} value={draft.level} onChange={(event) => patch({ level: event.target.value })} />
          </Field>
          <Field label="售卖价" hint="0 = 不可售卖；商城售价归「商城定价」管理，不在这里">
            <Input type="number" min={0} value={draft.sellPrice} onChange={(event) => patch({ sellPrice: event.target.value })} />
          </Field>
          <Field label="掉落绑定" hint="掉落时强制绑定角色（绑定后不可交易）—— 与怪物侧的「掉落整体强制绑定」是「或」的关系">
            <Select value={draft.bindOnDrop ? "true" : "false"} onChange={(event) => patch({ bindOnDrop: event.target.value === "true" })}>
              <option value="false">不强制（按掉落参数随机）</option>
              <option value="true">强制绑定</option>
            </Select>
          </Field>
        </div>
        <Field label="描述" hint="≤500 字；空 = 清空（详情弹窗正文）">
          <textarea
            className="w-full rounded-lg border border-line-strong bg-surface-2/60 px-3 py-2 text-sm text-ink-1 outline-none focus:border-gold"
            rows={3}
            value={draft.description}
            onChange={(event) => patch({ description: event.target.value })}
          />
        </Field>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-4">资源与几何</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <IconField
            label="图标"
            hint="resources 相对路径（不含扩展名），如 equipment/clothes/icon/005"
            placeholder="equipment/clothes/icon/005"
            value={draft.icon}
            onChange={(path) => patch({ icon: path })}
          />
          <IconField
            label="内观图集"
            hint="角色弹窗里穿在身上的那套"
            mode="atlas"
            rootDir="equipment/clothes/in"
            placeholder="equipment/clothes/in/005"
            value={draft.inAtlas}
            onChange={(path) => patch({ inAtlas: path })}
          />
          <IconField
            label="外观图集"
            hint="场景里跟着角色走的那个（整套动作图集，没有单张封面）"
            mode="atlas"
            rootDir="equipment/clothes/out"
            placeholder="equipment/clothes/out/005"
            value={draft.outAtlas}
            onChange={(path) => patch({ outAtlas: path })}
          />
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Field label="外观缩放" hint="1 = 原尺寸">
            <Input type="number" step="0.01" value={draft.outScale} onChange={(event) => patch({ outScale: event.target.value })} />
          </Field>
          <Field label="内观 X 缩放">
            <Input type="number" step="0.01" value={draft.inScaleX} onChange={(event) => patch({ inScaleX: event.target.value })} />
          </Field>
          <Field label="内观 Y 缩放">
            <Input type="number" step="0.01" value={draft.inScaleY} onChange={(event) => patch({ inScaleY: event.target.value })} />
          </Field>
          <Field label="内观旋转" hint="度，0 = 不转">
            <Input type="number" step="1" value={draft.inRotate} onChange={(event) => patch({ inRotate: event.target.value })} />
          </Field>
          <Field label="内观锚点 X" hint="弹窗中心为原点">
            <Input type="number" step="0.5" value={draft.inPosX} onChange={(event) => patch({ inPosX: event.target.value })} />
          </Field>
          <Field label="内观锚点 Y" hint="y 向上为正">
            <Input type="number" step="0.5" value={draft.inPosY} onChange={(event) => patch({ inPosY: event.target.value })} />
          </Field>
        </div>
        <div>
          <p className="mb-2 text-xs text-ink-4">
            外观 8 向位置（相对角色脚底锚点，y 向上）—— 出厂值；工作台保存过的装备以工作台为准
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {POSITION_DIRECTIONS.map((direction, index) => (
              <div key={direction} className="rounded-lg border border-line-strong/60 bg-surface-2/40 p-2">
                <p className="mb-1 text-[11px] text-ink-4">{direction}</p>
                <div className="flex gap-1">
                  <Input
                    type="number"
                    step="0.5"
                    className="px-2 py-1 text-xs"
                    value={draft.outPositions[index]?.x ?? "0"}
                    onChange={(event) => {
                      const next = draft.outPositions.slice();
                      next[index] = { x: event.target.value, y: next[index]?.y ?? "0" };
                      patch({ outPositions: next });
                    }}
                  />
                  <Input
                    type="number"
                    step="0.5"
                    className="px-2 py-1 text-xs"
                    value={draft.outPositions[index]?.y ?? "0"}
                    onChange={(event) => {
                      const next = draft.outPositions.slice();
                      next[index] = { x: next[index]?.x ?? "0", y: event.target.value };
                      patch({ outPositions: next });
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-4">基础属性（整份替换）</h3>
        <AttributesGrid
          attributes={draft.attributes}
          onChange={(attributes) => patch({ attributes })}
          header=""
          crossed={crossedKeys}
        />
      </section>
      {!levelValid || !priceValid || !positionsOk || !numbers.every(isNumber) ? (
        <p className="rounded-lg border border-ember/40 bg-ember/10 px-3 py-2 text-xs text-ember-hi">
          等级需为 ≥1 的整数、售卖价需为 ≥0 的整数；缩放 / 旋转 / 锚点与 8 向位置都要能解析成数字（8 个方向缺一不可）。
        </p>
      ) : null}
    </Modal>
  );
}

/**
 * 装备配置管理（#252 只能改；#773 起可新建 / 删除，列表按部位拆页签）
 *
 * **只收基础件**（如 `cloth_1`）：变体（`_pXsY`）是基础件乘前后缀倍率展开的，运营通常只改
 * 基础件这一份（要逐档微调在列表上点「N 个变体」）。
 *
 * 三件事：
 * - **页签**按部位切（`summary` 给的件数），顺序 = 槽位表 `sort_order`；
 * - **新建**：只填身份 + 基础数值，资源与属性从同部位的模板复制，服务端**连带展开全部变体**；
 * - **删除**：连带删变体与工作台几何；商城还在架就拒绝（先下架），玩家身上的引用会失效
 *   （确认弹窗讲清这条）。
 *
 * 商城售价不在这里（唯一写入口归「商城」页）。写操作要 `gameConfig:write`。
 */
export function EquipmentsPage() {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  /** 页签：空串 = 全部部位 */
  const [activeSlot, setActiveSlot] = useState("");
  const [summary, setSummary] = useState<EquipmentSlotSummary | null>(null);
  const [draft, setDraft] = useState({ keyword: "", minLevel: "", maxLevel: "" });
  const [query, setQuery] = useState({ keyword: "", minLevel: "", maxLevel: "" });
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const [data, setData] = useState<PageResult<EquipmentListItem> | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Equipment | null>(null);
  /** 变体弹窗（#781：变体不再单开一页，从列表的「N 个变体」点开） */
  const [variantsOf, setVariantsOf] = useState<Equipment | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Equipment | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [rebuildOpen, setRebuildOpen] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);

  /** 页签件数（新建 / 删除后要重拉，否则页签上的数会落后于列表） */
  const loadSummary = useCallback(async () => {
    try {
      setSummary(await equipmentsApi.summary());
    } catch {
      /* 错误已由请求层统一提示；页签会退回只有「全部」一档 */
    }
  }, []);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(
        await equipmentsApi.list({
          page,
          size,
          keyword: query.keyword || undefined,
          slot: activeSlot || undefined,
          minLevel: query.minLevel === "" ? undefined : Number(query.minLevel),
          maxLevel: query.maxLevel === "" ? undefined : Number(query.maxLevel),
        }),
      );
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, [activeSlot, page, size, query]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitSearch = () => {
    setPage(1);
    setQuery({ keyword: draft.keyword.trim(), minLevel: draft.minLevel.trim(), maxLevel: draft.maxLevel.trim() });
  };

  const resetSearch = () => {
    setDraft({ keyword: "", minLevel: "", maxLevel: "" });
    setActiveSlot("");
    setPage(1);
    setQuery({ keyword: "", minLevel: "", maxLevel: "" });
  };

  /** 切页签：筛选条不动（关键字 / 等级段是叠加条件），只回到第一页 —— 页码换了语义 */
  const switchSlot = (slot: string) => {
    setActiveSlot(slot);
    setPage(1);
  };

  /** 每页条数变化：回第一页再拉（条数变了页码语义也变了） */
  const handleSizeChange = (next: number) => {
    setSize(next);
    setPage(1);
  };

  /** 编辑弹窗提交（整份提交：弹窗里所有显示字段 + 属性；服务端逐字段校验） */
  const submitDialog = async (value: {
    label: string;
    description: string;
    occupation: string;
    sex: string;
    icon: string;
    inAtlas: string;
    outAtlas: string;
    tags: string[];
    outScale: number;
    inScaleX: number;
    inScaleY: number;
    inRotate: number;
    inPosX: number;
    inPosY: number;
    outPositions: Array<{ x: number; y: number }>;
    level: number;
    sellPrice: number;
    attributes: ConfigAttributes;
    bindOnDrop: boolean;
  }): Promise<boolean> => {
    if (!editing) return false;
    try {
      await equipmentsApi.update(editing.id, value);
      toastSuccess(`装备「${editing.label}」已更新`);
      setDialogOpen(false);
      setEditing(null);
      await load();
      return true;
    } catch {
      return false;
    }
  };

  /** 新建（#773）：服务端连带展开全部变体；建完切到该部位的页签，否则新装备会被当前筛选藏起来 */
  const submitCreate = async (value: CreateEquipment): Promise<boolean> => {
    try {
      const result = await equipmentsApi.create(value);
      toastSuccess(`装备「${result.equipment.label}」已新建（连带 ${result.variants} 个变体）`);
      setCreating(false);
      setActiveSlot(result.equipment.slot);
      setPage(1);
      await Promise.all([load(), loadSummary()]);
      return true;
    } catch {
      /* 失败保持弹窗打开（错误已由请求层统一提示） */
      return false;
    }
  };

  /** 删除（#773）：连带删变体与工作台几何；商城还在架会 409（请求层把服务端文案弹出来） */
  const submitDelete = async () => {
    if (!deleting) return;
    setDeletingBusy(true);
    try {
      const result = await equipmentsApi.delete(deleting.id);
      toastSuccess(`已删除装备「${deleting.label}」（连带 ${result.variants} 个变体）`);
      setDeleting(null);
      // 删空的页签会变成 0 件：留在原页签没意义，回「全部」看全景
      setActiveSlot((current) => {
        const remain = summary?.slots.find((row) => row.slot === current);
        return remain && remain.count <= 1 ? "" : current;
      });
      await Promise.all([load(), loadSummary()]);
    } catch {
      /* 失败保持弹窗打开 */
    } finally {
      setDeletingBusy(false);
    }
  };

  /** 重建全部装备变体（#697）：按当前前后缀倍率整批重算；卖价保留、属性 / 名称 / 等级覆盖 */
  const submitRebuild = async () => {
    setRebuilding(true);
    try {
      const result: EquipmentVariantRebuildResult = await equipmentVariantsApi.rebuild();
      toastSuccess(`已重建 ${result.variants} 个装备变体（${result.bases} 基础件 × ${result.combos} 组合）`);
      setRebuildOpen(false);
      await Promise.all([load(), loadSummary()]);
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setRebuilding(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="装备配置"
        actions={
          canWrite ? (
            <div className="flex gap-2">
              <Button variant="outline" disabled={rebuilding} onClick={() => setRebuildOpen(true)}>
                重新生成变体
              </Button>
              <Button onClick={() => setCreating(true)}>新建装备</Button>
            </div>
          ) : null
        }
        description={<>只收基础件（如 cloth_1），变体（_pXsY）是基础件乘前后缀倍率展开的 —— 通常只改基础件这一份，
            要逐档微调就在列表里点「N 个变体」，弹窗里能看能改每一档。列表按部位分页签；新建一件会连带展开它的全部变体，
            删除会连带删掉变体与工作台几何（商城还在架时不许删，先下架）。名称 / 描述 / 职业性别 / 图标与图集 / 标签 / 缩放 / 锚点 /
            8 向位置都在编辑弹窗里；商城售价归「商城」页，不在这里。</>}
      />

      <Card>
        <div className="flex flex-col gap-3">
          <SlotTabs summary={summary} active={activeSlot} onChange={switchSlot} />
          <div className="flex flex-wrap items-end gap-2">
            <Field width="w-56" label="id / 名称">
              <Input
                value={draft.keyword}
                placeholder="支持模糊匹配"
                onChange={(event) => setDraft({ ...draft, keyword: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter") submitSearch();
                }}
              />
            </Field>
            <Field width="w-28" label="等级 ≥">
              <Input
                type="number"
                min={1}
                value={draft.minLevel}
                onChange={(event) => setDraft({ ...draft, minLevel: event.target.value })}
              />
            </Field>
            <Field width="w-28" label="等级 ≤">
              <Input
                type="number"
                min={1}
                value={draft.maxLevel}
                onChange={(event) => setDraft({ ...draft, maxLevel: event.target.value })}
              />
            </Field>
            <Button onClick={submitSearch}>查询</Button>
            <Button variant="outline" onClick={resetSearch}>
              重置
            </Button>
          </div>
        </div>
      </Card>

      <Card
        title="装备基础件列表"
        actions={loading ? <Spinner /> : null}
        description={canWrite ? undefined : "当前角色没有「修改养成配置」权限，列表只读。"}
      >
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>图</th>
                <th className={thClass}>id</th>
                <th className={thClass}>部位</th>
                <th className={thClass}>名称</th>
                <th className={thClass}>等级</th>
                <th className={thClass}>售卖价</th>
                <th className={thClass}>变体</th>
                <th className={thClass}>属性摘要</th>
                <th className={thClass}>掉落绑定</th>
                <th className={thClass}>更新时间</th>
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {data?.list.map((item) => (
                <tr key={item.id} className="transition hover:bg-surface-4/30">
                  <td className={tdClass}>
                    {item.outAtlas ? (
                      // 外观站立动画筛 d0（8 方向挤一张表）；没配外观的装备退回静态图标
                      <FrameAnimation atlas={`${item.outAtlas}/stand`} alt={item.label} framePrefix="d0" />
                    ) : (
                      <GameIcon path={item.icon ?? ""} alt={item.label} />
                    )}
                  </td>
                  <td className={`${tdClass} font-mono text-xs text-ink-3`}>{item.id}</td>
                  <td className={tdClass}>
                    <Badge tone="muted">{slotLabel(item.slot)}</Badge>
                  </td>
                  <td className={`${tdClass} font-medium text-ink-1`}>{item.label}</td>
                  <td className={tdClass}>{item.level}</td>
                  <td className={tdClass}>{item.sellPrice}</td>
                  <td className={tdClass}>
                    {/* 件数就是入口（#781）：点开是这个变体的弹窗，不再跳独立页 */}
                    <button
                      type="button"
                      title="看这件装备的全部变体"
                      className="rounded-md border border-line-strong px-2 py-0.5 text-xs text-ink-3 transition hover:border-gold/60 hover:bg-gold/10 hover:text-gold-hi"
                      onClick={() => setVariantsOf(item)}
                    >
                      {item.variantCount ?? 0} 个
                    </button>
                  </td>
                  <td className={`${tdClass} text-xs text-ink-4`}>{attributeSummary(item)}</td>
                  <td className={tdClass}>
                    <Badge tone={item.bindOnDrop ? "warn" : "muted"}>{item.bindOnDrop ? "强制绑定" : "—"}</Badge>
                  </td>
                  <td className={`${tdClass} text-xs text-ink-4`}>{formatTime(item.updatedAt)}</td>
                  <td className={`${tdClass} text-right`}>
                    <Button
                      variant="outline"
                      className="px-2.5 py-1 text-xs"
                      disabled={!canWrite}
                      onClick={() => {
                        setEditing(item);
                        setDialogOpen(true);
                      }}
                    >
                      编辑
                    </Button>
                    <Button
                      variant="ghost"
                      className="ml-1 px-2.5 py-1 text-xs text-ember-hi hover:bg-ember/10"
                      disabled={!canWrite}
                      onClick={() => setDeleting(item)}
                    >
                      删除
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!loading && data && data.list.length === 0 ? (
          <EmptyState
            title={activeSlot ? `「${slotLabel(activeSlot)}」下还没有装备` : "没有匹配的装备"}
            description={activeSlot ? "点右上角「新建装备」，部位已按当前页签预选" : "换个筛选条件试试"}
          />
        ) : null}

        <Pagination page={page} size={size} total={data?.total ?? 0} onChange={setPage} onSizeChange={handleSizeChange} />
      </Card>

      <EquipmentEditDialog
        open={dialogOpen}
        initial={editing}
        onCancel={() => {
          setDialogOpen(false);
          setEditing(null);
        }}
        onSubmit={submitDialog}
      />

      <EquipmentVariantsDialog
        equipment={variantsOf}
        onClose={() => setVariantsOf(null)}
        onChanged={() => void load()}
      />

      <EquipmentCreateDialog
        open={creating}
        slots={summary?.slots ?? []}
        defaultSlot={activeSlot}
        onCancel={() => setCreating(false)}
        onSubmit={submitCreate}
      />

      <ConfirmDialog
        open={deleting !== null}
        title={deleting ? `删除装备「${deleting.label}」？` : "删除装备？"}
        description={
          deleting
            ? `会连带删除 ${deleting.id} 的全部前后缀变体，以及「装备对齐 / 内观对齐」工作台里指向它的几何。` +
              "背包或身上还引用这件装备的角色，那些格子会变成认不出的路径（属性不再生效）—— 删之前先确认没人穿着。" +
              "商城还在架时服务端会拒绝，先去「商城」页下架。"
            : undefined
        }
        confirmText="删除"
        loading={deletingBusy}
        onConfirm={() => void submitDelete()}
        onCancel={() => setDeleting(null)}
      />

      <ConfirmDialog
        open={rebuildOpen}
        title="重新生成全部装备变体？"
        description="按当前前后缀倍率整批重算：属性 / 名称 / 穿戴等级会被覆盖；卖价保留原值（新增组合按公式垫底）。档位缩小后，被删档的变体行会消失 —— 身上还穿 / 背包还放的该档装备会变成无效引用。服务端即时生效，客户端下次拉配置生效。"
        confirmText="重新生成"
        loading={rebuilding}
        onConfirm={() => void submitRebuild()}
        onCancel={() => setRebuildOpen(false)}
      />
    </div>
  );
}
