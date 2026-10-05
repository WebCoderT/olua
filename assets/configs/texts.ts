import type { TextRef } from "../types/common";

/**
 * 界面文案（**唯一来源**）
 *
 * 核心代码（ui/、skills/）只做逻辑，不写任何面向玩家的中文：
 * - 静态文案：`uiTexts.xxx`
 * - 带数据：模板里写 `{占位符}`，调用处传 params（如 `getText("soul_bind_gold_tip", { need: 100 })`）
 * - 校验/拒绝原因：产出 `TextRef`（见 GameHelper），由提示层统一取文案
 *
 * 命名：`*_tip` = 浮动提示（可能带错误色）；`reject_*` = 穿戴/进图校验原因；
 * `label_*` = 界面上的固定标签；`hover_*` = 悬停详情的行模板；`progress_*` = 加载进度。
 * 自查：`node tools/audit-config-leak.cjs`（ui/ 里出现中文即报警）。
 */
export const uiTexts = {
  //#region 浮动提示：战魂
  /** 战魂已到最高阶 */
  soul_max_tip: "战魂已满级",
  /** 绑定元宝不足以升级（{need} = 所需绑定元宝） */
  soul_bind_gold_tip: "绑定元宝不足，升级需要 {need}",
  /** 战魂升级成功（{level} 阶 · {label}） */
  soul_upgrade_tip: "战魂升级成功：{level} 阶 · {label}",

  //#region 浮动提示：称号
  /** 称号已到最高阶 */
  title_max_tip: "称号已满级",
  /** 绑定元宝不足以升级（{need} = 所需绑定元宝） */
  title_bind_gold_tip: "绑定元宝不足，升级需要 {need}",
  /** 称号升级成功（{level} 阶 · {label}） */
  title_upgrade_tip: "称号升级成功：{level} 阶 · {label}",

  //#region 浮动提示：物品与背包
  /** 该物品没有可用的使用方式 */
  good_unsupported_tip: "该物品暂无可以使用的方式",
  /** 该物品不能穿戴 */
  equip_unsupported_tip: "该物品不能穿戴",
  /** 背包已满，脱不下装备 */
  bag_full_tip: "背包已满，无法脱下装备",
  /** 槽位里的装备已不在配置表中 */
  equip_missing_tip: "该装备已不存在",
  /** 整理完成 */
  bag_tidy_tip: "背包已整理",
  /** 背包本身已经整齐，无需整理 */
  bag_tidy_noop_tip: "背包已经很整齐了",
  /** 批量回收无可回收装备 */
  bag_recycle_empty_tip: "背包里没有可回收的装备",
  /** 批量回收结果（{count} 件 · {price} 绑定元宝） */
  bag_recycle_tip: "回收 {count} 件装备，获得 {price} 绑定元宝",
  /** 批量回收二次确认（{count} 件 · {price} 绑定元宝） */
  bag_recycle_confirm_tip: "将回收 {count} 件装备，可得 {price} 绑定元宝（再点一次确认）",
  /** 进入丢弃模式 */
  bag_discard_mode_tip: "点击物品即可丢弃（整格丢弃，不可恢复）",
  /** 丢弃的两步确认（第一次点击，{name} 物品名 · {count} 整格数量） */
  bag_discard_confirm_tip: "再点一次丢弃「{name}」×{count}，丢弃后无法恢复",
  /** 丢弃完成（{name} · {count}） */
  bag_discard_done_tip: "已丢弃「{name}」×{count}",
  /** 格子里没有可丢弃的物品 */
  bag_discard_empty_tip: "这里没有可丢弃的物品",
  /** 药品效果未实现 */
  drug_unsupported_tip: "该药品效果暂未开放",
  /** 血量已满 */
  drug_full_tip: "血量已满",

  //#region 浮动提示：拾取
  /** 拾取到物品（{names} = 物品名列表或「名称 x数量」） */
  pickup_tip: "拾取 {names}",
  /** 背包满导致拾取失败 */
  pickup_full_tip: "背包已满",
  /** 多件物品并列时的分隔符 */
  label_list_separator: "、",
  /** 单件物品的「名称 x数量」写法 */
  label_good_count: "{name} x{count}",

  //#region 浮动提示：技能
  /** 技能未学习（{skill}） */
  skill_not_learned_tip: "尚未学习 {skill}",
  /** 技能冷却中（{skill}） */
  skill_cooldown_tip: "{skill} 冷却中",
  /** 魔法值不足（当前 {mp}，需要 {cost}） */
  skill_mp_tip: "魔法值不足（当前 {mp}，需要 {cost}）",
  /** 单体技能无可攻击目标（{skill}） */
  skill_no_target_tip: "{skill} 无可攻击目标",
  /** 超出技能距离 */
  skill_distance_tip: "距离太远，无法攻击！",

  //#region 浮动提示：自动战斗与寻路
  /** 没有可自动释放的技能 */
  auto_battle_no_skill_tip: "没有可自动释放的技能，无法挂机",
  /** 挂机开启 */
  auto_battle_on_tip: "自动挂机已开启",
  /** 挂机关闭 */
  auto_battle_off_tip: "自动挂机已关闭",
  /** 目标不可达，停止自动攻击 */
  auto_battle_unreachable_tip: "无法接近目标，已停止自动攻击",
  /** 寻路到达 */
  map_move_arrive_tip: "已到达目的地",
  /** 寻路无解 */
  map_move_unreachable_tip: "无法到达目标位置",
  /** 当前状态不允许寻路 */
  map_move_refuse_tip: "当前状态无法寻路",
  /** 死亡状态不可传送 */
  map_teleport_dead_tip: "死亡状态无法传送",
  /** 地图预览大图加载失败 */
  map_preview_load_error_tip: "地图预览图加载失败",

  //#region 浮动提示：活动与功能解锁
  /** 泡点活动开启 */
  activity_started_tip: "泡点活动已开启，尽情享受吧～",
  /** 功能未解锁（{feature} 功能 · {level} 级开放） */
  feature_locked_tip: "{feature}功能需要在{level}级后开放",

  //#region 浮动提示：选角与角色管理
  /** 进入管理模式（选角界面「管理」按钮） */
  role_delete_mode_tip: "点击角色上方的删除按钮可删除角色",
  /** 删除角色的两步确认（第一次点击，{name} = 角色名） */
  role_delete_confirm_tip: "再点一次确认删除角色「{name}」，删除后无法恢复",
  /** 删除成功（{name}） */
  role_delete_done_tip: "角色「{name}」已删除",
  /** 待删除的角色已不存在（存档被外部改动等） */
  role_delete_missing_tip: "角色不存在，无法删除",

  //#region 穿戴 / 进图校验（GameHelper 产出 TextRef）
  /** 取不到在线角色 */
  reject_no_role: "角色不存在",
  /** 装备等级不足（{level}） */
  reject_equip_level: "需要等级 {level}",
  /** 装备性别不符（{sex}） */
  reject_equip_sex: "{sex}角色才能穿戴",
  /** 装备职业不符 */
  reject_equip_occupation: "职业不符，无法穿戴",
  /** 地图配置不存在 */
  reject_map_missing: "地图不存在",
  /** 地图等级不足（{map} · {level}） */
  reject_map_level: "{map} 需要等级达到 {level} 级",
  /** 地图战斗力不足（{map} · {combat}） */
  reject_map_combat: "{map} 需要战斗力达到 {combat}",
  /** 地图战魂阶数不足（{map} · {soul}） */
  reject_map_soul: "{map} 需要战魂等级达到 {soul} 阶",

  //#region 界面标签：角色与战魂
  /** 战魂卡片状态（已激活 / 未激活） */
  label_soul_active: "已激活",
  label_soul_locked: "未激活",
  /** 当前战魂（未激活时用 label_soul_none） */
  label_soul_current: "当前战魂：{level} 阶 · {label}",
  label_soul_none: "尚未激活战魂",
  /** 称号卡片状态（已激活 / 未激活） */
  label_title_active: "已激活",
  label_title_locked: "未激活",
  /** 当前称号（未激活时用 label_title_none） */
  label_title_current: "当前称号：{level} 阶 · {label}",
  label_title_none: "尚未激活称号",
  /** 绑定元宝余额（{value}） */
  label_bind_gold: "绑定元宝：{value}",
  /** 性别文案（校验提示用） */
  label_sex_boy: "男性",
  label_sex_girl: "女性",
  /** 删除角色按钮（正常态 / 两步确认的待确认态，见 configs/hudLayout.roleSelectorLayout.manageRole） */
  label_role_delete: "删除",
  label_role_delete_confirm: "确认删除",
  /** 管理模式提示条 */
  label_role_delete_hint: "点击角色上方的删除按钮移除角色",

  //#region 界面标签：属性与装备
  /** 属性分组标题 */
  label_attributes_base: "基础属性",
  label_attributes_special: "特殊属性",
  /** 装备详情：等级与部位（{level} · {slot}） */
  label_good_detail_info: "等级 {level} · {slot}",
  /** 装备详情：部位兜底名（配置里查不到槽位时） */
  label_good_slot_fallback: "装备",
  /** 装备详情：回收价（{price}） */
  label_good_detail_recycle: "回收价 {price} 绑定元宝",

  //#region 界面标签：背包操作按钮（文案在这里，几何见 configs/layout/dialogs.bagDialogLayout）
  /** 「一键整理」按钮 */
  label_bag_tidy: "一键整理",
  /** 「一键回收」按钮（正常态 / 两步确认的待确认态） */
  label_bag_recycle: "一键回收",
  label_bag_recycle_confirm: "确认回收",
  /** 「丢弃」按钮（正常态 / 丢弃模式激活态 —— 点击开关丢弃模式） */
  label_bag_discard: "丢弃",
  label_bag_discard_exit: "退出丢弃",

  //#region 界面标签：飘字与技能列表
  /** 伤害飘字（{value} = 伤害数值） */
  label_damage: "-{value}",
  /** 闪避飘字 */
  label_damage_miss: "MISS",
  /** 技能释放飘字（{skill}） */
  label_skill_release: "释放{skill}",
  /** 经验飘字（{exp}） */
  label_exp_gain: "+{exp} 经验",
  /** 技能熟练等级前缀（lv.N）/ 未学习 */
  label_skill_level: "lv.{level}",
  label_skill_unlearned: "未学习",

  //#region 悬停详情行模板
  hover_skill_type: "类型：{type}（{target}）",
  hover_skill_level: "开启等级：{level}",
  hover_skill_mp: "魔法消耗：{cost}",
  hover_skill_cooldown: "冷却时间：{seconds} 秒",
  hover_skill_distance: "使用距离：{distance}",
  hover_skill_mastery: "熟练等级：{level}",
  /** 动态行前缀（悬停详情每帧刷新那一行） */
  hover_prefix_cooldown: "冷却剩余",
  hover_prefix_remaining: "剩余时间",
  /** 动态行取值（{seconds} 保留一位小数） */
  hover_row_seconds: "{prefix}：{seconds} 秒",
  hover_row_ready: "{prefix}：就绪",

  //#region 加载进度
  /** 加载中（{percent}），无阶段说明时用 */
  progress_loading: "加载中 {percent}%",
  /** 加载中 + 阶段说明（{percent} · {tip}） */
  progress_loading_tip: "加载中 {percent}% · {tip}",
  /** 加载失败 */
  progress_failed: "加载失败，请重新进入",
  /** 阶段：读地图 */
  progress_map: "地图信息",
  /** 阶段：无需预加载 */
  progress_none: "无需预加载",
  /** 阶段：帧动画（{done}/{total}） */
  progress_frames: "帧动画 {done}/{total}",
} as const;

/** 文案 key（uiTexts 的键） */
export type TextKey = keyof typeof uiTexts;

/** 文案模板参数 */
export type TextParams = Record<string, string | number>;

/**
 * 模板替换：把 `{name}` 换成 params.name
 * 缺参时保留原样（便于一眼看出漏传），而不是静默变成 undefined
 */
export function formatTemplate(template: string, params?: TextParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (raw, key: string) => {
    const value = params[key];
    return value === undefined ? raw : `${value}`;
  });
}

/**
 * 取文案（核心代码取文案的唯一入口）
 * key 未登记时返回 key 本身并告警，避免运行期白屏式排查
 */
export function getText(key: string, params?: TextParams): string {
  const template = (uiTexts as Record<string, string>)[key];
  if (template === undefined) {
    console.warn(`[texts] 未登记的文案 key：${key}`);
    return key;
  }
  return formatTemplate(template, params);
}

/** 取文案引用（校验层产出 TextRef、展示层消费的桥梁） */
export function formatText(ref: TextRef): string {
  return getText(ref.key, ref.params);
}

/** 造一个文案引用（校验层用，省得到处写对象字面量） */
export function textRef(key: string, params?: TextParams): TextRef {
  return { key, params };
}
