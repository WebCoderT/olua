/**
 * 实体目录：可视化选择器 / 卡片共用的「一项东西长什么样、叫什么、怎么搜」
 *
 * 为什么要有这一层：装备、物品、技能、药品、时装、称号档、战魂档、军衔档在界面上
 * 长得一样（图 + 名字 + 一行说明），但「名字查哪张表、图是单图还是图集首帧、按什么分组」
 * 各不相同。把这些口径收在这里，组件只认 `EntityOption`，于是同一个选择器能用在
 * 角色详情、掉落配置、邮件附件……**新增一处调用不用改组件**。
 *
 * 所有内容都来自 `api/gameData`（客户端配置的生成物），这里不写任何游戏数据 ——
 * 客户端加一件装备 / 一个技能，选择器自动多一条。
 */

import {
  drugIcon,
  drugIds,
  drugLevel,
  drugText,
  equipmentBaseId,
  equipmentIcon,
  equipmentOutAtlas,
  equipmentIds,
  equipmentLevel,
  equipmentName,
  equipmentSlot,
  equipmentSlotKeys,
  fashionDescription,
  fashionIcon,
  fashionIds,
  fashionText,
  itemDescription,
  itemIcon,
  itemIds,
  itemText,
  itemType,
  levelCount,
  mapIds,
  mapPreview,
  mapText,
  maxStackOf,
  MONSTER_TIER_LABELS,
  monsterIcon,
  monsterInfo,
  monsterOut,
  monsterRows,
  npcInfo,
  npcRows,
  rankMeta,
  skillDescription,
  skillIcon,
  skillIds,
  skillLevelReq,
  skillOwner,
  skillText,
  slotLabel,
  soulMeta,
  soulText,
  titleMeta,
  titleText,
} from "../../api";
import type { AppearanceItem } from "../../api";

/** 有「清单」可挑的实体种类 */
export type EntityKind = "equipment" | "item" | "skill" | "drug" | "fashion" | "map" | "monster" | "npc";

/** 有「阶梯」可挑的养成等级种类（下标从 1 起 = 第一档） */
export type LevelKind = "title" | "soul" | "rank";

/** 图标：单图（`icon` 是 resources 相对路径）或图集（`frame` 是图集目录，默认取首帧） */
export interface EntityImage {
  icon?: string;
  /** 单图扩展名（地图预览图是 jpg，不写默认 png） */
  ext?: "png" | "jpg";
  frame?: string;
  /**
   * 图集是否**循环播放**：边框 / 背景的光效流动（#749）、称号 / 战魂 / NPC 的整段动画、
   * 怪物 / 装备的站立动作 —— 首帧都判断不了「动起来长什么样」。
   * 开了这一档 `EntityImage` 会优先播 `frame`（没有 `icon` 时才轮到静态首帧）。
   */
  animate?: boolean;
  /**
   * 只播帧名以它开头的帧：怪物 / 装备的 `stand` 表把 8 个方向挤在一张图集里
   * （`d0_00 … d7_xx`），筛 `d0` 才是客户端里「朝下站立」那一条循环。
   */
  framePrefix?: string;
}

/** 选择器里的一项；也是卡片能渲染的最小信息 */
export interface EntityOption {
  id: string;
  label: string;
  /** 副标题：部位 / 等级 / 一句说明（截断到 30 字，太长会把卡片撑破） */
  note: string;
  /** 分组名（装备 = 部位，技能 = 拥有者，物品 = 部位 / 药品 / 材料） */
  group: string;
  image: EntityImage;
  /** 预先拼好的小写检索串（id + 名字 + 副标题 + 分组），搜索时只做包含判断 */
  search: string;
}

const NOTE_MAX = 30;

/**
 * 变体强度序号（`_p2s1` → 201）
 *
 * 装备 id 的字典序会把 `cloth_10` 排在 `cloth_1_p0s1` 前面，直接按 id 排看起来是乱的。
 * 这里把「前缀序号 + 后缀序号」摊成一个数，同款装备就从普通到超神依次排开。
 */
function variantRank(id: string): number {
  const match = /_p(\d+)s(\d+)$/.exec(id);
  return match ? Number(match[1]) * 100 + Number(match[2]) : 0;
}

/** 同款聚类的键：基础件的名字（认不出基础件就退回 id，保证仍然稳定可排） */
function baseNameOf(id: string): string {
  const base = equipmentBaseId(id);
  return base ? equipmentName(base) || base : id;
}

/** 装备 / 物品的排序：部位 → 同款名字 → 变体强度（前后缀） */
function compareEquipmentLike(a: EntityOption, b: EntityOption): number {
  return (
    baseNameOf(a.id).localeCompare(baseNameOf(b.id), "zh-Hans-CN") ||
    variantRank(a.id) - variantRank(b.id) ||
    a.id.localeCompare(b.id)
  );
}

/** 描述截成一行副标题（换行会撑破卡片高度） */
function brief(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > NOTE_MAX ? `${flat.slice(0, NOTE_MAX)}…` : flat;
}

/** 物品 / 装备图标：装备表 → 药品表 → 物品表，取第一个查得到的 */
function itemLikeIcon(id: string): string {
  const base = equipmentBaseId(id);
  return (base ? equipmentIcon(base) : "") || drugIcon(id) || itemIcon(id);
}

/* ===========================================================================
 * 单个实体的名字 / 副标题 / 图标（卡片与选择器共用；卡片只要展示，不必建 option）
 * =========================================================================== */

export function entityLabel(kind: EntityKind, id: string): string {
  if (!id) return "";
  switch (kind) {
    case "equipment":
      return equipmentName(id) || `未知装备 ${id}`;
    case "item":
      // 背包里可能是装备：**必须**优先带前后缀的显示名（`equipmentName`），
      // 否则同一件衣服的 15 个变体在列表里全叫「* 唯一深爱(衣) *」，根本分不出「精良的·天级」
      return equipmentName(id) || itemText(id);
    case "skill":
      return skillText(id);
    case "drug":
      return drugText(id) || `未知药品 ${id}`;
    case "fashion":
      return fashionText(id) || `未知时装 ${id}`;
    case "map":
      return mapText(id) || `未知地图 ${id}`;
    case "monster": {
      // 种子里的出厂名：怪物名字的运行时权威是 monsters 表（管理端可改），
      // 选择器只负责「让你认出是哪只」，选中值永远是 id
      const row = monsterInfo(id);
      return row ? row.label : `未知怪物 ${id}`;
    }
    case "npc":
      return npcInfo(id)?.label ?? `未知 NPC ${id}`;
    default:
      return id;
  }
}

export function entityNote(kind: EntityKind, id: string): string {
  if (!id) return "";
  switch (kind) {
    case "equipment": {
      const slot = equipmentSlot(id);
      const level = equipmentLevel(id);
      // 部位认不出 = 客户端配置里没这件（旧存档脏数据），照实说，不编一个「未知部位」之外的名字
      return [slot ? slotLabel(slot) : "部位未知", level > 0 ? `Lv.${level}` : "等级未知", id].join(" · ");
    }
    case "item": {
      const slot = equipmentSlot(id);
      const level = equipmentLevel(id);
      // 装备带部位与等级（与装备选择器同一口径）；药品 / 材料退回描述
      if (slot) return [slotLabel(slot), level > 0 ? `Lv.${level}` : "", id].filter(Boolean).join(" · ");
      const description = itemDescription(id) || "";
      return brief(description) || itemType(id) || id;
    }
    case "skill": {
      const owner = skillOwner(id);
      const levelReq = skillLevelReq(id);
      const head = [owner === "monster" ? "怪物技能" : "玩家技能", levelReq > 0 ? `${levelReq} 级可学` : ""]
        .filter(Boolean)
        .join(" · ");
      return brief(skillDescription(id)) || head;
    }
    case "drug": {
      const level = drugLevel(id);
      return [level > 0 ? `Lv.${level} 可用` : "", `可叠 ${maxStackOf(id)}`].filter(Boolean).join(" · ");
    }
    case "fashion":
      return brief(fashionDescription(id)) || id;
    case "map":
      // 地图只有名字与小地图底图，没有等级之类（等级门槛在客户端 map.ts 里，后台不复制）
      return id ? `地图 id ${id}` : "";
    case "monster": {
      const row = monsterInfo(id);
      if (!row) return `怪物 key ${id}`;
      // key 一定要露出来：掉落 / 任务 / 成就里存的是它，运营核对时按 key 对账
      return [`Lv.${row.level}`, MONSTER_TIER_LABELS[row.tier] ?? row.tier, `key ${row.id}`].join(" · ");
    }
    case "npc":
      // NPC 的显示名有重名（四个「神装使者」），编号才是唯一身份
      return `NPC ${id}`;
    default:
      return id;
  }
}

export function entityImage(kind: EntityKind, id: string): EntityImage {
  if (!id) return {};
  switch (kind) {
    case "equipment": {
      const base = equipmentBaseId(id);
      const icon = base ? equipmentIcon(base) : "";
      // 外观站立动画：同款变体共用一套外观，基础件剥回来查（没配外观的退静态图标）
      const outAtlas = equipmentOutAtlas(id);
      return {
        ...(icon ? { icon } : {}),
        ...(outAtlas ? { frame: `${outAtlas}/stand`, animate: true, framePrefix: "d0" } : {}),
      };
    }
    case "item": {
      const icon = itemLikeIcon(id);
      return icon ? { icon } : {};
    }
    case "skill": {
      const icon = skillIcon(id);
      return icon ? { icon } : {};
    }
    case "drug": {
      const icon = drugIcon(id);
      return icon ? { icon } : {};
    }
    case "fashion": {
      const icon = fashionIcon(id);
      return icon ? { icon } : {};
    }
    case "map": {
      const preview = mapPreview(id);
      return preview ? { icon: preview, ext: "jpg" } : {};
    }
    case "monster": {
      // 站立动画（`monster/out/<key>/stand` 筛 `d0`）优先；缺演示行的怪退回静态头像
      const icon = monsterIcon(id);
      const out = monsterOut(id);
      return {
        ...(icon ? { icon } : {}),
        ...(out ? { frame: `${out}/stand`, animate: true, framePrefix: "d0" } : {}),
      };
    }
    case "npc": {
      // NPC 的素材是图集动画目录（`npc/2125`），整段循环播
      const src = npcInfo(id)?.src ?? "";
      return src ? { frame: src, animate: true } : {};
    }
    default:
      return {};
  }
}

/* ===========================================================================
 * 清单（选择器的候选集）
 * =========================================================================== */

/** 物品分组：装备按部位、药品、材料、其它（顺序在这里定，选择器只按组名排） */
function itemGroupOf(id: string): string {
  const slot = equipmentSlot(id);
  if (slot) return slotLabel(slot);
  if (drugText(id)) return "药品";
  const type = itemType(id);
  if (type === "material") return "材料";
  return "其它";
}

function optionOf(kind: EntityKind, id: string, group: string): EntityOption {
  const label = entityLabel(kind, id);
  const note = entityNote(kind, id);
  return {
    id,
    label,
    note,
    group,
    image: entityImage(kind, id),
    search: `${id} ${label} ${note} ${group}`.toLowerCase(),
  };
}

/**
 * 构建某一类的全部候选（模块级缓存：2200 多条的清单只建一次，
 * 否则每次打开选择器都要重新查两千多次表，输入框会卡）
 */
const optionCache = new Map<EntityKind, EntityOption[]>();

export function entityOptions(kind: EntityKind): EntityOption[] {
  const cached = optionCache.get(kind);
  if (cached) return cached;

  let options: EntityOption[] = [];
  if (kind === "equipment") {
    // 顺序 = 客户端部位顺序（衣服 → 武器 → 项链…），组内同款聚在一起、从普通到超神
    const order = new Map(equipmentSlotKeys().map((slot, index) => [slotLabel(slot), index]));
    options = equipmentIds()
      .map((id) => optionOf("equipment", id, slotLabel(equipmentSlot(id)) || "部位未知"))
      .sort((a, b) => {
        const ga = order.get(a.group) ?? 99;
        const gb = order.get(b.group) ?? 99;
        return ga !== gb ? ga - gb : compareEquipmentLike(a, b);
      });
  } else if (kind === "item") {
    const order = new Map<string, number>([
      ...equipmentSlotKeys().map((slot, index) => [slotLabel(slot), index] as [string, number]),
      ["药品", 90],
      ["材料", 91],
      ["其它", 92],
    ]);
    options = itemIds()
      .map((id) => optionOf("item", id, itemGroupOf(id)))
      .sort((a, b) => {
        const ga = order.get(a.group) ?? 99;
        const gb = order.get(b.group) ?? 99;
        if (ga !== gb) return ga - gb;
        // 装备那几组按「同款 + 变体强度」；药品 / 材料按名字
        const aEquip = !!equipmentSlot(a.id);
        const bEquip = !!equipmentSlot(b.id);
        if (aEquip && bEquip) return compareEquipmentLike(a, b);
        return a.label.localeCompare(b.label, "zh-Hans-CN") || a.id.localeCompare(b.id);
      });
  } else if (kind === "skill") {
    options = skillIds()
      .map((id) => optionOf("skill", id, skillOwner(id) === "monster" ? "怪物技能" : "玩家技能"))
      .sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN") || a.id.localeCompare(b.id));
  } else if (kind === "drug") {
    options = drugIds()
      .map((id) => optionOf("drug", id, "药品"))
      .sort((a, b) => drugLevel(a.id) - drugLevel(b.id) || a.label.localeCompare(b.label, "zh-Hans-CN"));
  } else if (kind === "map") {
    // 按 id 数值序（地图 id 是 "0" / "1" / "10"，字典序会把 10 排在 2 前面）
    options = mapIds()
      .map((id) => optionOf("map", id, "地图"))
      .sort((a, b) => Number(a.id) - Number(b.id));
  } else if (kind === "monster") {
    // `monsterRows()` 已按等级 → id 排好；分组用定位（普通 / 精英 / 首领），
    // 组内保持等级序 —— 运营找怪时想的是「我要一只 30 级左右的」，不是字母序
    options = monsterRows().map((row) =>
      optionOf("monster", row.id, MONSTER_TIER_LABELS[row.tier] ?? row.tier),
    );
  } else if (kind === "npc") {
    options = npcRows().map((row) => optionOf("npc", row.id, "NPC"));
  } else {
    options = fashionIds()
      .map((id) => optionOf("fashion", id, "时装"))
      .sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN"));
  }

  optionCache.set(kind, options);
  return options;
}

/** 按分组过滤（`null` = 全部组）；组名按清单里首次出现的顺序返回 */
export function groupNames(options: EntityOption[]): string[] {
  const seen: string[] = [];
  for (const option of options) if (!seen.includes(option.group)) seen.push(option.group);
  return seen;
}

/**
 * 掉落用物品清单：装备**只列基础件**，药品 / 材料照旧
 *
 * 为什么：一件基础装有 15 个前后缀变体（`cloth_1_p3s2` …），它们不是「不同的掉落物」——
 * 掉出来是哪一档由变体表决定，不是靠运营在掉落条目里一件件点名。以前把 555 个变体全铺进
 * 候选，运营挑一条 `helmet_1_p2s1` 就等于把「掉什么品质」写死在这只怪身上。
 * 判据用 `equipmentBaseId`（基础件返回自身，变体返回它的基础件，非装备返回空）。
 */
let dropItemCache: EntityOption[] | null = null;

export function dropItemOptions(): EntityOption[] {
  if (dropItemCache) return dropItemCache;
  dropItemCache = entityOptions("item").filter((option) => {
    const base = equipmentBaseId(option.id);
    return !base || base === option.id;
  });
  return dropItemCache;
}

/** 关键字 + 分组过滤（关键字对 id / 名字 / 副标题都匹配） */
export function filterOptions(options: EntityOption[], keyword: string, group: string | null): EntityOption[] {
  const needle = keyword.trim().toLowerCase();
  return options.filter((option) => {
    if (group && option.group !== group) return false;
    return !needle || option.search.includes(needle);
  });
}

/* ===========================================================================
 * 装备外观（边框 / 详情背景）：清单条目 → 同一套 EntityOption（#749）
 * =========================================================================== */

/** 外观清单的两种素材；素材目录与客户端资源同口径（边框 `effect/border`、背景 `effect/background`） */
export type AppearanceKind = "border" | "background";

const APPEARANCE_RES_DIR: Record<AppearanceKind, string> = {
  border: "effect/border",
  background: "effect/background",
};

/** 没有分组的条目落到这一组：分组 chips 里永远有它，不会出现「选了全部却少几条」 */
export const APPEARANCE_NO_GROUP = "未分组";

/**
 * 边框 / 背景清单 → 可视化选择器的候选
 *
 * 与「实体目录」里其他 kind 的区别：那些是**游戏数据表**（名字 / 图标由 id 查出来），
 * 这里的候选是**运营自己维护的素材清单**（`border_items` / `background_items`），
 * 别名与分组本来就是管理端属性 —— 正好直接当选择器里的 label / group 用。
 *
 * - `id` = key（要落到库里的就是它，客户端只认这个）；
 * - `label` = 别名（没起别名就退回 key，让人能一眼看出「这条还没取名」）；
 * - `note` = key · 分组（有别名时 key 必须在，不然挑中后不知道存的是什么）；
 * - `image.animate` = 逐帧播放：边框光效 / 背景动画看首帧判断不了。
 */
export function appearanceOptions(kind: AppearanceKind, items: AppearanceItem[]): EntityOption[] {
  return items.map((item) => {
    const key = item.key.trim();
    const name = (item.name ?? "").trim();
    const group = (item.group ?? "").trim();
    const note = name ? [key, group].filter(Boolean).join(" · ") : group ? `${group} · 未起别名` : "未起别名";
    return {
      id: key,
      label: name || key,
      note: brief(note),
      group: group || APPEARANCE_NO_GROUP,
      image: { frame: `${APPEARANCE_RES_DIR[kind]}/${key}`, animate: true },
      search: `${key} ${name} ${group}`.toLowerCase(),
    };
  });
}

/* ===========================================================================
 * 养成等级（称号 / 战魂 / 军衔）：把「第几档」也做成同一套 EntityOption
 * =========================================================================== */

export function levelOptions(kind: LevelKind): EntityOption[] {
  const options: EntityOption[] = [];
  for (let level = 1; level <= levelCount(kind); level += 1) {
    const label = levelLabel(kind, level);
    const note = levelNote(kind, level);
    options.push({
      id: String(level),
      label: label || `第 ${level} 档`,
      note,
      group: kind === "title" ? "称号" : kind === "soul" ? "战魂" : "军衔",
      image: levelImage(kind, level),
      search: `${level} ${label} ${note}`.toLowerCase(),
    });
  }
  return options;
}

export function levelLabel(kind: LevelKind, level: number): string {
  if (kind === "title") return titleText(level);
  if (kind === "soul") return soulText(level);
  const meta = rankMeta(level);
  return meta ? `${meta.tier} · ${meta.label}` : "";
}

export function levelNote(kind: LevelKind, level: number): string {
  if (kind === "title") {
    const meta = titleMeta(level);
    return meta ? `升到该级需 ${meta.bindGold} 绑定元宝` : "";
  }
  if (kind === "soul") {
    const meta = soulMeta(level);
    return meta ? `升到该阶需 ${meta.bindGold} 绑定元宝` : "";
  }
  return `第 ${level} 阶`;
}

export function levelImage(kind: LevelKind, level: number): EntityImage {
  if (kind === "title") {
    const meta = titleMeta(level);
    return meta?.animation ? { frame: meta.animation, animate: true } : {};
  }
  if (kind === "soul") {
    const meta = soulMeta(level);
    return meta?.animation ? { frame: meta.animation, animate: true } : {};
  }
  // 军衔没有动画资源（客户端也只显示名字）
  return {};
}

/** 称号 / 战魂那一档的说明文案（卡片副标题用它，比「升到该级需 X」有用） */
export function levelDescription(kind: LevelKind, level: number): string {
  const meta = kind === "title" ? titleMeta(level) : kind === "soul" ? soulMeta(level) : null;
  return meta ? brief(meta.description) : "";
}

export const LEVEL_KIND_LABELS: Record<LevelKind, string> = {
  title: "称号",
  soul: "战魂",
  rank: "军衔",
};
