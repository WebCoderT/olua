import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  avatarPath,
  formatTime,
  mapText,
  OCCUPATION_LABELS,
  PERMISSION,
  rolesApi,
  SEX_LABELS,
} from "../api";
import type { AdminRole, AdminRoleDetail, RolePatchPayload } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Modal } from "../components/Modal";
import { RoleAttributesCard } from "../components/RoleAttributesCard";
import { BagGrid } from "../components/entity/BagGrid";
import type { BagCellValue } from "../components/entity/BagGrid";
import { EntityCard } from "../components/entity/EntityCard";
import { EntityImage } from "../components/entity/EntityImage";
import { EntityPicker } from "../components/entity/EntityPicker";
import { EquipSlots } from "../components/entity/EquipSlots";
import { LevelLadder } from "../components/entity/LevelLadder";
import { SkillList } from "../components/entity/SkillList";
import type { SkillRow } from "../components/entity/SkillList";
import { entityImage, entityLabel, entityOptions } from "../components/entity/catalog";
import type { LevelKind } from "../components/entity/catalog";
import { GameIcon } from "../components/GameImage";
import { Badge, Button, Card, EmptyState, Spinner } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";
import { PageHeader } from "../components/PageHeader";

/**
 * 角色详情
 *
 * 版式目标：**一屏看完，不滚长页面**。
 * - 左窄栏：一张「角色」卡 = 身份（头像 / 名字 / 等级职业性别 / 所在地图）+ 货币与经验 + 战斗属性；
 * - 右宽栏：一张「装备」卡 = 穿戴槽位 + 时装 + 成长阶位（称号 / 战魂 / 军衔）；
 * - 大块内容（技能列表、7×11 背包网格、原始 JSON）各自进弹窗，页面本身不被撑长。
 *
 * **左栏那张卡是只读的**（用户 2026-11-01 定：身份 / 货币 / 属性不允许改）：所以那里是
 * 纯文本而不是「禁用态的输入框」—— 灰输入框看起来像「没权限」，纯文本才是「这里本来就不改」，
 * 也不会让人以为某个开关一开就能改。可改的只有右边的装备卡（穿戴 / 时装 / 阶位）。
 *
 * 可视化都来自 `components/entity/` 那套组件（同一份 `catalog`）：装备格、档位卡、
 * 背包网格、选择器。别处要「挑一个装备 / 物品 / 技能 / 时装」时直接复用，不用再写一份
 * 「id 输入框 + 名字提示」。
 *
 * 三条不变的约定：
 * 1. 结构化字段（装备 / 技能 / 背包）**整体提交**，其余字段只提交改动项（`buildPatch`）；
 * 2. 名字与图标一律来自 `api/gameData`（客户端配置的生成物），页面不硬编码游戏内容；
 * 3. 界面按权限只读（`ROLE_WRITE`），服务端仍会拒。
 */

/** 常用货币与经验（称号 / 战魂 / 军衔走档位选择器，不在这里） */
const NUMBER_FIELDS: { key: keyof RoleForm; label: string }[] = [
  { key: "gold", label: "金币" },
  { key: "bindGold", label: "绑定元宝" },
  { key: "silver", label: "银两" },
  { key: "exp", label: "经验" },
];

/** 三张养成等级表（`LevelKind` 与生成物的表一一对应） */
const GROWTH_FIELDS: { key: keyof RoleForm; kind: LevelKind }[] = [
  { key: "title", kind: "title" },
  { key: "soulOfWar", kind: "soul" },
  { key: "rank", kind: "rank" },
];

/** 表单初值：数字类全部是字符串（受控输入），结构化字段用组件自己的形状 */
interface RoleForm {
  name: string;
  occupation: string;
  sex: string;
  level: string;
  /** 空串 = 没有时装（提交时转成 null） */
  fashionCloth: string;
  avatar: string;
  onMap: string;
  gold: string;
  bindGold: string;
  silver: string;
  exp: string;
  /** 成长阶位（0 = 未激活） */
  soulOfWar: string;
  title: string;
  rank: string;
  equipments: Record<string, string | null>;
  skills: SkillRow[];
  bag: BagCellValue[];
}

/** 取 data 里的数字字段（缺失 / 非数字 → 空串，界面上就是空输入框） */
function readNumber(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  return typeof value === "number" ? String(value) : "";
}

/**
 * 装备槽位：`equipments` 是「槽位 → 装备」—— #816 起值是 `{ id, bound?, from? }`（槽位带绑定与溯源），
 * 更早的存档是裸 id 字符串。管理端只编辑「穿哪件」，所以两种形状都收敛成 id：
 * 绑定 / 溯源是服务端在穿脱与掉落时写的事实，**运营不该在这里改**（改了就成刷可交易装备的通道）。
 *
 * 键来自**角色自己的数据**（不是管理端硬编码的清单）：部位表在生成物里有（`EquipSlots`
 * 按它排序），但角色实际有哪些键仍以数据为准 —— 旧存档带了个已经删掉的部位时，
 * 这件装备还得看得见（不然存一次就真没了）。
 */
function readEquipments(data: Record<string, unknown>): Record<string, string | null> {
  const source = data.equipments;
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  const rows: Record<string, string | null> = {};
  for (const [slot, value] of Object.entries(source as Record<string, unknown>)) {
    if (typeof value === "string") {
      rows[slot] = value ? value : null;
      continue;
    }
    // { id, bound?, from? }：只取 id（服务端 PATCH 收到 id 后会保留原有的绑定与溯源）
    const id = value && typeof value === "object" ? (value as { id?: unknown }).id : null;
    rows[slot] = typeof id === "string" && id ? id : null;
  }
  return rows;
}

/** 技能：`skills` 是「技能 id → 等级」 */
function readSkillRows(data: Record<string, unknown>): SkillRow[] {
  const source = data.skills;
  if (!source || typeof source !== "object" || Array.isArray(source)) return [];
  return Object.entries(source as Record<string, unknown>).map(([id, level]) => ({
    id,
    level: typeof level === "number" ? String(level) : "",
  }));
}

/** 把二维背包读成稀疏格子（只列有东西的格子；行列是数字，交给网格组件铺位置） */
function readBagCells(data: Record<string, unknown>): BagCellValue[] {
  const bag = data.bag;
  if (!Array.isArray(bag)) return [];
  const cells: BagCellValue[] = [];
  bag.forEach((rowValue, row) => {
    if (!Array.isArray(rowValue)) return;
    rowValue.forEach((cell, col) => {
      if (!cell || typeof cell !== "object" || Array.isArray(cell)) return;
      const item = cell as { id?: unknown; count?: unknown };
      if (typeof item.id !== "string" || !item.id) return;
      cells.push({ row, col, id: item.id, count: typeof item.count === "number" ? item.count : 1 });
    });
  });
  return cells;
}

/** 存档里的背包形状（`bag` 是二维数组：行数 = 外层长度，列数 = 最长一行） */
function readBagShape(data: Record<string, unknown>): { rows: number; cols: number } {
  const bag = data.bag;
  if (!Array.isArray(bag) || bag.length === 0) return { rows: 0, cols: 0 };
  const cols = bag.reduce<number>((max, line) => (Array.isArray(line) ? Math.max(max, line.length) : max), 0);
  return { rows: bag.length, cols };
}

function toForm(role: AdminRole): RoleForm {
  const data = role.data;
  return {
    name: role.name,
    occupation: role.occupation,
    sex: role.sex,
    level: String(role.level),
    fashionCloth: typeof data.fashionCloth === "string" ? data.fashionCloth : "",
    avatar: readNumber(data, "avatar"),
    onMap: typeof data.onMap === "string" ? data.onMap : "",
    gold: readNumber(data, "gold"),
    bindGold: readNumber(data, "bindGold"),
    silver: readNumber(data, "silver"),
    exp: readNumber(data, "exp"),
    soulOfWar: readNumber(data, "soulOfWar"),
    title: readNumber(data, "title"),
    rank: readNumber(data, "rank"),
    equipments: readEquipments(data),
    skills: readSkillRows(data),
    bag: readBagCells(data),
  };
}

/** 数值文本 → 数字（空串 / 非数字返回 undefined，调用方据此跳过该字段） */
function toNumber(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** 装备槽是否等价（键集合 + 每个槽位的值） */
function sameEquipments(current: Record<string, string | null>, original: Record<string, string | null>): boolean {
  const keys = Object.keys(current);
  if (keys.length !== Object.keys(original).length) return false;
  return keys.every((key) => (current[key] ?? null) === (original[key] ?? null));
}

/** 技能行是否等价（顺序无关：id 对得上、等级一致） */
function sameSkills(current: SkillRow[], original: SkillRow[]): boolean {
  if (current.length !== original.length) return false;
  return current.every((row) => original.some((item) => item.id === row.id && item.level === row.level));
}

/** 背包格子是否等价（顺序无关，位置也算） */
function sameBag(current: BagCellValue[], original: BagCellValue[]): boolean {
  if (current.length !== original.length) return false;
  return current.every((cell) =>
    original.some(
      (item) => item.row === cell.row && item.col === cell.col && item.id === cell.id && item.count === cell.count,
    ),
  );
}

/**
 * 只提交真正改动过的字段
 *
 * 结构化字段（装备 / 技能 / 背包）例外：服务端是**整体替换**这三项，所以只要有一处改动就提交完整的一份。
 */
function buildPatch(role: AdminRole, form: RoleForm): RolePatchPayload {
  const original = toForm(role);
  const patch: RolePatchPayload = {};

  if (form.name.trim() !== original.name) patch.name = form.name.trim();
  // 表单是受控输入（字符串），赋值时收口到服务端枚举；非法值服务端会拒
  if (form.occupation !== original.occupation) patch.occupation = form.occupation as RolePatchPayload["occupation"];
  if (form.sex !== original.sex) patch.sex = form.sex as RolePatchPayload["sex"];
  if (form.onMap.trim() !== original.onMap) patch.onMap = form.onMap.trim();

  // 时装存的是**时装 id**（fashions 表主键，如 cloth_2），#377 起不再是编号；空串 = 脱掉
  if (form.fashionCloth !== original.fashionCloth) {
    patch.fashionCloth = form.fashionCloth.trim() || null;
  }
  for (const { key } of NUMBER_FIELDS) {
    if (form[key] === original[key]) continue;
    const value = toNumber(form[key] as string);
    if (value === undefined) continue;
    patch[key as "gold" | "bindGold" | "silver" | "exp"] = value;
  }
  for (const { key } of GROWTH_FIELDS) {
    if (form[key] === original[key]) continue;
    const value = toNumber(form[key] as string);
    if (value === undefined) continue;
    patch[key as "soulOfWar" | "title" | "rank"] = value;
  }
  if (form.level !== original.level) {
    const level = toNumber(form.level);
    if (level !== undefined) patch.level = level;
  }

  if (!sameEquipments(form.equipments, original.equipments)) {
    const equipments: Record<string, string | null> = {};
    for (const [slot, id] of Object.entries(form.equipments)) {
      const key = slot.trim();
      if (!key) continue;
      equipments[key] = id && id.trim() ? id.trim() : null;
    }
    patch.equipments = equipments;
  }
  if (!sameSkills(form.skills, original.skills)) {
    const skills: Record<string, number> = {};
    for (const row of form.skills) {
      const id = row.id.trim();
      const level = toNumber(row.level);
      if (!id || level === undefined) continue;
      skills[id] = level;
    }
    patch.skills = skills;
  }
  if (!sameBag(form.bag, original.bag)) {
    patch.bag = form.bag.map((cell) => ({ row: cell.row, col: cell.col, id: cell.id, count: cell.count }));
  }
  return patch;
}

/**
 * 只读展示项（身份 / 货币与经验）
 *
 * 这两段按需求**不允许修改**，所以这里只有标签与值，没有输入框 —— 不是「禁用态的输入框」：
 * 灰掉的输入框看起来像「没权限」，纯文本才是「这里本来就不改」。
 */
function ReadOnlyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] text-slate-500">{label}</p>
      <p className="truncate text-xs font-medium tabular-nums text-slate-100" title={value}>
        {value}
      </p>
    </div>
  );
}

/** 角色详情与编辑（表单按「修改角色」权限点决定可编辑性） */
export function RoleDetailPage() {
  const canWrite = hasPermission(PERMISSION.ROLE_WRITE);
  const canSelect = hasPermission(PERMISSION.ROLE_SELECT);
  const canDelete = hasPermission(PERMISSION.ROLE_DELETE);
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [role, setRole] = useState<AdminRoleDetail | null>(null);
  const [form, setForm] = useState<RoleForm | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // 弹窗：时装选择（装备卡里）/ 技能编辑 / 背包编辑 / 原始数据。
  // 地图不在这里：它属于「身份」，身份卡是只读的
  const [fashionOpen, setFashionOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [bagOpen, setBagOpen] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  // 弹窗里的草稿：只有点「保存并关闭」才写回 form 并落库，关掉就是丢弃
  const [draftSkills, setDraftSkills] = useState<SkillRow[]>([]);
  const [draftBag, setDraftBag] = useState<BagCellValue[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await rolesApi.detail(id);
      setRole(data);
      setForm(toForm(data));
    } catch {
      /* 统一提示 */
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 保存：默认提交当前表单，也可以带一份覆盖值
   *
   * 覆盖值是给弹窗用的（技能 / 背包）：弹窗点「保存并关闭」时，`setForm` 还没生效，
   * 必须把草稿直接交给保存函数，否则会走上次的表单状态、看起来「保存了没变化」。
   */
  const save = async (override?: RoleForm): Promise<boolean> => {
    const target = override ?? form;
    if (!role || !target) return false;
    const patch = buildPatch(role, target);
    if (Object.keys(patch).length === 0) {
      toastSuccess("没有需要保存的改动");
      return true;
    }
    setSaving(true);
    try {
      const updated = await rolesApi.patch(role.id, patch);
      setRole(updated);
      setForm(toForm(updated));
      toastSuccess("已保存；角色在线时玩家会在下一次同步拿到最新数据");
      return true;
    } catch {
      /* 统一提示 */
      return false;
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!role) return;
    setDeleting(true);
    try {
      await rolesApi.remove(role.id);
      toastSuccess(`已删除角色 ${role.name}`);
      navigate("/roles", { replace: true });
    } catch {
      /* 统一提示 */
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const setOnline = async () => {
    if (!role) return;
    try {
      const updated = await rolesApi.select(role.id);
      setRole(updated);
      toastSuccess(`已把「${updated.name}」设为该账号的在线角色`);
    } catch {
      /* 统一提示 */
    }
  };

  if (loading && !role) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-400">
        <Spinner /> 加载中…
      </div>
    );
  }

  if (!role || !form) return <EmptyState title="角色不存在" description="它可能已经被删除了" />;

  const update = <K extends keyof RoleForm>(key: K, value: RoleForm[K]) => setForm({ ...form, [key]: value });
  const readonlyHint = canWrite ? undefined : "当前角色没有「修改角色」权限，字段只读（服务端同样会拒绝保存请求）。";

  // 背包网格：以存档里的形状为基准，form 里有更靠外的格子就把网格撑到能看见（不缩）
  const savedShape = readBagShape(role.data);
  let bagRows = savedShape.rows;
  let bagCols = savedShape.cols;
  for (const cell of form.bag) {
    bagRows = Math.max(bagRows, cell.row + 1);
    bagCols = Math.max(bagCols, cell.col + 1);
  }

  const avatar = avatarPath(form.occupation, form.sex);
  const occupationLabel = OCCUPATION_LABELS[form.occupation] ?? form.occupation;
  const sexLabel = SEX_LABELS[form.sex] ?? form.sex;

  return (
    <div className="flex flex-col gap-3">
      {/* 头部：身份 + 全部「打开大块内容」的入口，一行放完 */}
      <PageHeader
        title={
          <>
            {role.name}
            {role.online ? <Badge tone="indigo">在线</Badge> : null}
            <span className="text-xs font-normal text-slate-500">修订 #{role.revision}</span>
          </>
        }
        description={
          <>
            角色 id：{role.id} · 账号：
            {role.accountName ? (
              <Link to={`/accounts/${role.accountId}`} className="text-indigo-300 hover:text-indigo-200">
                {role.accountName}
              </Link>
            ) : (
              "—"
            )}
            {" · "}更新：{formatTime(role.updatedAt)}
          </>
        }
        actions={
          <>
            <Button
              variant="outline"
              className="px-2.5 py-1 text-xs"
              onClick={() => {
                // 每次打开都从当前表单重新取草稿：上一次「放弃改动」关掉后不该残留
                setDraftSkills(form.skills);
                setSkillsOpen(true);
              }}
            >
              技能 {form.skills.length}
            </Button>
            <Button
              variant="outline"
              className="px-2.5 py-1 text-xs"
              onClick={() => {
                setDraftBag(form.bag);
                setBagOpen(true);
              }}
            >
              背包 {form.bag.length}/{bagRows * bagCols}
            </Button>
            <Button variant="outline" className="px-2.5 py-1 text-xs" onClick={() => setRawOpen(true)}>
              原始数据
            </Button>
            {/* 发消息（#437）：带上当前角色 id 跳到补发页，运营不用再手抄一遍 */}
            {hasPermission(PERMISSION.GAME_MAIL_SEND) ? (
              <Link to={`/mail-send?roleId=${encodeURIComponent(role.id)}`}>
                <Button variant="outline" className="px-2.5 py-1 text-xs">
                  发消息
                </Button>
              </Link>
            ) : null}
            <Link to="/roles">
              <Button variant="outline" className="px-2.5 py-1 text-xs">
                返回列表
              </Button>
            </Link>
            <Button
              className="px-2.5 py-1 text-xs"
              variant="outline"
              onClick={() => void setOnline()}
              disabled={!canSelect || role.online}
            >
              设为在线
            </Button>
            <Button className="px-2.5 py-1 text-xs" variant="danger" onClick={() => setConfirmDelete(true)} disabled={!canDelete}>
              删除
            </Button>
          </>
        }
      />

      {/* 主体：左窄栏一张「角色」卡（身份 / 货币 / 属性，**只读**），右宽栏「装备」（可改，含时装与成长阶位） */}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(340px,420px)_minmax(0,1fr)]">
        <div className="flex flex-col gap-3">
          <Card dense title="角色" description="只读：身份 / 货币与经验 / 战斗属性（服务端重算）">
            <div className="flex flex-col gap-3">
              {/* 身份（只读展示，没有输入框） */}
              <div className="flex gap-2.5">
                <div className="flex w-16 shrink-0 flex-col items-center gap-1">
                  <GameIcon path={avatar} alt={`${occupationLabel}${sexLabel}头像`} size={56} />
                  <span className="text-[10px] text-slate-500">编号 {form.avatar || 0}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-100" title={form.name}>
                    {form.name}
                  </p>
                  <div className="mt-1 grid grid-cols-3 gap-x-3 gap-y-1">
                    <ReadOnlyValue label="等级" value={form.level || "—"} />
                    <ReadOnlyValue label="职业" value={occupationLabel} />
                    <ReadOnlyValue label="性别" value={sexLabel} />
                  </div>
                  <div className="mt-1.5 flex min-w-0 items-center gap-1.5">
                    <span className="shrink-0 text-[10px] text-slate-500">所在地图</span>
                    {form.onMap.trim() ? (
                      <>
                        <EntityImage image={entityImage("map", form.onMap.trim())} size={22} alt={mapText(form.onMap.trim())} />
                        <span className="truncate text-xs text-slate-200">{mapText(form.onMap.trim())}</span>
                      </>
                    ) : (
                      <span className="text-xs text-slate-600">未在地图上</span>
                    )}
                  </div>
                </div>
              </div>

              {/* 货币与经验（只读） */}
              <div className="border-t border-slate-800 pt-3">
                <p className="mb-1.5 text-[10px] uppercase tracking-wide text-slate-500">货币与经验</p>
                <div className="grid grid-cols-4 gap-2">
                  {NUMBER_FIELDS.map(({ key, label }) => (
                    <ReadOnlyValue key={key} label={label} value={(form[key] as string) || "0"} />
                  ))}
                </div>
              </div>

              {/* 战斗属性（服务端重算，只读） */}
              <div className="border-t border-slate-800 pt-3">
                <RoleAttributesCard derived={role.derived} bare />
              </div>
            </div>
          </Card>
        </div>

        <div className="flex flex-col gap-3">
          <Card dense
            title="装备"
            description={
              readonlyHint ?? "点格子挑装备（默认只列本部位），× 卸下；时装与称号 / 战魂 / 军衔也在这里改。"
            }
          >
            <div className="flex flex-col gap-3">
              <EquipSlots value={form.equipments} disabled={!canWrite} onChange={(next) => update("equipments", next)} />

              {/* 时装 + 成长阶位：都是「一项外观 / 一个档位」，并成一行，不再各占一张卡 */}
              <div className="border-t border-slate-800 pt-3">
                <p className="mb-2 text-[10px] uppercase tracking-wide text-slate-500">时装与成长阶位</p>
                {/* auto-fit 而不是 xl 断点：这一行的宽度跟的是**卡片**（右栏 460~700 都可能），
                    不是视口 —— 按视口排版会让 1280 下四格挤成 105px，「未激活」被竖排成四个字 */}
                <div
                  className="grid gap-2"
                  style={{ gridTemplateColumns: "repeat(auto-fit, minmax(155px, 1fr))" }}
                >
                  <EntityCard
                    badge="时装"
                    label={form.fashionCloth ? entityLabel("fashion", form.fashionCloth) : ""}
                    note={form.fashionCloth ? form.fashionCloth : undefined}
                    image={form.fashionCloth ? entityImage("fashion", form.fashionCloth) : {}}
                    placeholder="未穿时装"
                    size={32}
                    disabled={!canWrite}
                    onClick={() => setFashionOpen(true)}
                    onClear={() => update("fashionCloth", "")}
                    clearTitle="脱掉时装"
                  />
                  {GROWTH_FIELDS.map(({ key, kind }) => (
                    <LevelLadder
                      key={key}
                      kind={kind}
                      compact
                      value={Number(form[key]) || 0}
                      disabled={!canWrite}
                      onChange={(level) => update(key, String(level))}
                    />
                  ))}
                </div>
              </div>
            </div>
          </Card>
        </div>
      </div>

      {/* 保存条：一直可见（页面不滚，它也不会跑） */}
      <div className="sticky bottom-0 z-30 flex flex-wrap items-center justify-end gap-2 rounded-xl border border-slate-800 bg-slate-900/95 px-3 py-2 shadow-lg shadow-black/30 backdrop-blur">
        <span className="mr-auto text-xs text-slate-500">
          {canWrite ? "只提交改动过的字段；装备 / 技能 / 背包是整体替换。" : readonlyHint}
        </span>
        <Button variant="outline" onClick={() => setForm(toForm(role))} disabled={!canWrite || saving}>
          重置
        </Button>
        <Button onClick={() => void save()} loading={saving} disabled={!canWrite}>
          保存改动
        </Button>
      </div>

      {/* —— 弹窗：技能（大块内容不进页面） —— */}
      <Modal
        open={skillsOpen}
        title={`技能（${form.skills.length} 个）`}
        hint="图标 + 名字 + 描述来自客户端配置；改完点「保存并关闭」才会落库。"
        size="lg"
        onClose={() => setSkillsOpen(false)}
        footer={
          <>
            <Button variant="outline" onClick={() => setSkillsOpen(false)}>
              放弃改动
            </Button>
            <Button
              loading={saving}
              disabled={!canWrite}
              onClick={async () => {
                if (await save({ ...form, skills: draftSkills })) setSkillsOpen(false);
              }}
            >
              保存并关闭
            </Button>
          </>
        }
      >
        <SkillList
          rows={draftSkills}
          disabled={!canWrite}
          onChange={setDraftSkills}
        />
      </Modal>

      {/* —— 弹窗：背包（7×11 网格不进页面） —— */}
      <Modal
        open={bagOpen}
        title={`背包（${form.bag.length} / ${bagRows * bagCols} 格）`}
        hint={`网格按存档里的形状铺开（${bagRows} 行 × ${bagCols} 列）；点格子放东西 / 改数量。改完点「保存并关闭」才会落库。`}
        size="lg"
        onClose={() => setBagOpen(false)}
        footer={
          <>
            <Button
              variant="outline"
              disabled={!canWrite || draftBag.length === 0}
              onClick={() => setDraftBag([])}
            >
              清空背包
            </Button>
            <Button variant="outline" onClick={() => setBagOpen(false)}>
              放弃改动
            </Button>
            <Button
              loading={saving}
              disabled={!canWrite}
              onClick={async () => {
                if (await save({ ...form, bag: draftBag })) setBagOpen(false);
              }}
            >
              保存并关闭
            </Button>
          </>
        }
      >
        <BagGrid cells={draftBag} rows={bagRows} cols={bagCols} disabled={!canWrite} onChange={setDraftBag} />
      </Modal>

      {/* —— 弹窗：原始数据（只读） —— */}
      <Modal
        open={rawOpen}
        title="完整角色数据（只读）"
        hint="客户端 entities/Role 的原始快照；这里没做的字段（快捷键绑定、速度倍率…）请用游戏内功能改。"
        size="lg"
        onClose={() => setRawOpen(false)}
      >
        <pre className="overflow-auto rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-xs leading-relaxed text-slate-400">
          {JSON.stringify(role.data, null, 2)}
        </pre>
      </Modal>

      <EntityPicker
        open={fashionOpen}
        title="选择时装"
        hint="时装 id 来自 fashions 表（客户端外观资源同源）；选中即穿上，× 可脱掉。"
        options={entityOptions("fashion")}
        current={form.fashionCloth}
        onSelect={(next) => update("fashionCloth", next)}
        onClose={() => setFashionOpen(false)}
      />

      <ConfirmDialog
        open={confirmDelete}
        title="删除角色"
        description={`将删除角色「${role.name}」，操作不可恢复。`}
        confirmText="确认删除"
        loading={deleting}
        onConfirm={() => void remove()}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}
