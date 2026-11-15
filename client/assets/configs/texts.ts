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
  //#region 浮动提示：三条成长线共用（称号 / 战魂 / 军衔）
  /** 运营一档都没开放（链为空）—— 与「已满级」「断链」分开，别把没开放的线说成玩家满级了 */
  title_growth_closed_tip: "称号升级暂未开放",
  soul_growth_closed_tip: "战魂升级暂未开放",
  rank_growth_closed_tip: "军衔晋升暂未开放",
  /** 升级弹窗左列表在链为空时的占位（不铺一排假卡片） */
  label_growth_chain_empty: "暂未开放",

  //#region 浮动提示：战魂
  /** 战魂已到最高阶 */
  soul_max_tip: "战魂已满级",
  /** 当前阶不在运营配置的成长链上（与「满级」区分：是路被改了，不是到头了） */
  soul_chain_locked_tip: "当前战魂不在可升级的成长链上，无法续升",
  /** 绑定元宝不足以升级（{need} = 所需绑定元宝） */
  soul_bind_gold_tip: "绑定元宝不足，升级需要 {need}",
  /** 战魂升级成功（{level} 阶 · {label}） */
  soul_upgrade_tip: "战魂升级成功：{level} 阶 · {label}",

  //#region 浮动提示：称号
  /** 称号已到最高阶 */
  title_max_tip: "称号已满级",
  /** 当前称号不在运营配置的成长链上（渠道被改成非「称号升级」，或这一级被移出链） */
  title_chain_locked_tip: "当前称号不在可升级的成长链上，无法续升",
  /** 绑定元宝不足以升级（{need} = 所需绑定元宝） */
  title_bind_gold_tip: "绑定元宝不足，升级需要 {need}",
  /** 称号升级成功（{level} 阶 · {label}） */
  title_upgrade_tip: "称号升级成功：{level} 阶 · {label}",

  //#region 浮动提示：军衔
  /** 军衔已到最高阶 */
  rank_max_tip: "军衔已满衔",
  /** 当前阶不在进阶链上（军衔按阶连续，正常不会出现；留作三条线同一口径的兜底） */
  rank_chain_locked_tip: "当前军衔不在进阶链上，无法晋升",
  /** 绑定元宝不足以晋升（{need} = 所需绑定元宝） */
  rank_bind_gold_tip: "绑定元宝不足，晋升需要 {need}",
  /** 军衔晋升成功（{level} 阶 · {label}） */
  rank_upgrade_tip: "军衔晋升：{level} 阶 · {label}",

  //#region 浮动提示：物品与背包
  /** 该物品没有可用的使用方式 */
  good_unsupported_tip: "该物品暂无可以使用的方式",
  /** 该物品不能穿戴 */
  equip_unsupported_tip: "该物品不能穿戴",
  /** 背包已满，脱不下装备 */
  bag_full_tip: "背包已满，无法脱下装备",
  /** 槽位里的装备已不在配置表中 */
  equip_missing_tip: "该装备已不存在",
  /** 装备槽「更好装备」提示角标（点击角标一键换上背包里更好的装备） */
  label_equip_upgrade_hint: "换",
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
  /** 销毁确认框标题（拖出背包弹窗时弹出，见 components/dialogs/ConfirmDialog） */
  bag_discard_confirm_title: "销毁物品",
  /** 销毁确认框正文（{name} 物品名 · {count} 整格数量） */
  bag_discard_confirm_text: "确定销毁「{name}」×{count}？销毁后无法恢复。",
  /** 丢弃完成（{name} · {count}） */
  bag_discard_done_tip: "已丢弃「{name}」×{count}",
  /** 格子里没有可丢弃的物品 */
  bag_discard_empty_tip: "这里没有可丢弃的物品",
  /** 药品效果未实现 */
  drug_unsupported_tip: "该药品效果暂未开放",
  /** 血量已满 */
  drug_full_tip: "血量已满",
  /** 魔法值已满 */
  drug_mp_full_tip: "魔法值已满",
  /** 使用货币道具（{name} 道具名 · {amount} 本次入账 · {currency} 货币名 · {balance} 入账后余额） */
  money_use_success_tip: "使用「{name}」：+{amount} {currency}（当前 {balance}）",
  /** 该道具暂时用不了（服务端表里没有这一行 / 面额没配 / 币种认不出） */
  money_use_invalid_tip: "该道具暂时用不了",
  /** 使用升级卷轴（{name} 道具名 · {from} 使用前等级 · {level} 使用后等级） */
  level_scroll_use_success_tip: "使用「{name}」：等级 {from} → {level}",
  /** 该道具暂时用不了（不是升级卷轴 / 服务端卷轴表里没有这一行） */
  level_scroll_use_invalid_tip: "该道具暂时用不了",
  /** 等级不在这一卷的区间里（{name} 道具名 · {min} 下限 · {max} 上限 · {level} 当前等级） */
  level_scroll_level_out_of_range_tip: "「{name}」只能在 {min} ~ {max} 级使用（当前 {level} 级）",
  /** 复活请求失败（服务端拒绝或网络不通；死亡弹窗保留可重试） */
  revive_failed_tip: "复活失败，请稍后重试",

  //#region 浮动提示：拾取
  /** 拾取到物品（{names} = 物品名列表或「名称 x数量」） */
  pickup_tip: "拾取 {names}",
  /** 背包满导致拾取失败 */
  pickup_full_tip: "背包已满",
  /** 多件物品并列时的分隔符 */
  label_list_separator: "、",
  /** 单件物品的「名称 x数量」写法 */
  label_good_count: "{name} x{count}",

  //#region 浮动提示：拾取失败（#804 / docs/18 §6.4 的九种 code，每种都有话说）
  /**
   * 别人的掉落还在保护期（{owner} 归属者名字 · {n} 剩余秒数）
   *
   * 服务端也会回同样的意思，但那条要等一个来回；本地预判能省掉这次请求，
   * 提示就提前量出来了（判不出来时不拦，见 DropRule.canPickLocally）。
   */
  drop_protected_tip: "「{owner}」击杀的物品，{n} 秒后可拾取",
  /** 已经被别人捡走了（{name} = 拾取者名字） */
  drop_already_picked_tip: "物品已被「{name}」拾取",
  /** 过期了（服务端清场掉了，玩家主动点它时给一句解释） */
  drop_expired_tip: "物品已消失",
  /** 站得太远（服务端拾取距离闸拒了） */
  drop_too_far_tip: "距离太远，请靠近后再拾取",
  /** 不在同一张图上（换图时的迟到请求） */
  drop_not_on_map_tip: "不在同一地图，无法拾取",
  /** 这件掉落物服务端已经没有了（不再无限重试，节点直接收掉） */
  drop_unknown_tip: "物品已不存在",
  /** 物品被运营下架了（配置里查不到这件东西） */
  drop_item_gone_tip: "该物品已下架，无法拾取",
  /** 登录态异常（角色被踢 / 账号已下线）：拾取链路整体不可用，提示重登 */
  drop_login_abnormal_tip: "登录状态异常，请重新登录",
  /** 其余没归类的失败（服务端加了新 code 而客户端还没跟上时兜底） */
  drop_pick_failed_tip: "拾取失败，请稍后再试",
  /** 归属者前缀（{name} = 归属者名字；只在别人的掉落上出现，保护期内可见） */
  drop_owner_prefix: "{name}的",
  /** 稀有掉落全服公告（{killer} 击杀者 · {map} 地图名 · {monster} 怪物名 · {items} 物品列表） */
  drop_notice_tip: "{killer} 在 {map} 击败 {monster}，掉落 {items}",

  //#region 浮动提示：商城
  /** 购买成功（{name} = 物品全名，{price} = 成交价） */
  mall_buy_success_tip: "购买成功：{name}（{price} 绑定元宝）",
  /** 绑定元宝不足 */
  mall_bind_gold_not_enough_tip: "绑定元宝不足，无法购买",
  /** 商品已下架（id 解析不到配置，或该物品不在商城上架范围） */
  mall_good_missing_tip: "该商品已下架",
  /** 商城购买按钮 */
  label_mall_buy: "购 买",
  /** 购买等级不足时的按钮文案（{level} = 商城配置的购买等级；按钮同时置灰禁点，#758） */
  mall_level_lock: "Lv.{level} 解锁",
  /** 当前分类没有商品 / 商城还没建分类时的空提示（#758） */
  mall_empty_tip: "暂无商品，请稍后再来",
  /**
   * 卡片品质行里表示「药品」的那两个字（#763）
   *
   * 药品没有前后缀，那一行不能空着：空着会和「品质配置异常」看起来一样。
   */
  mall_good_kind_drug: "药品",
  /**
   * 商城卡片上的价格（{value} = configs/mall.getMallPrice 的结果）
   *
   * 带单位：卡片右侧孤零零一个数字会被读成「数量」而不是「要花多少」。
   */
  mall_price: "{value} 绑元",
  /** 商城分页：翻页按钮文案与页码（{page} = 当前页，{total} = 总页数，见 configs/mall.getMallGoods 分页） */
  label_mall_first_page: "首 页",
  label_mall_prev_page: "上一页",
  label_mall_next_page: "下一页",
  label_mall_last_page: "末 页",
  mall_page_indicator: "第 {page} / {total} 页",
  /**
   * 限购与库存（#846）
   *
   * 卡片只有 100 高、塞不下第四行，所以这两条挤在**品质行左侧**（品质行让出价格那一段宽度
   * 之后还剩一截），由 SHRINK 兜长文案：
   * - `mall_daily_bought`：今天买了几件 / 每天限购几件（只有配置了限购才显示）
   * - `mall_stock_left`：全服还剩几件（只有配置了库存才显示）
   * - `mall_extra_sep`：两条同时存在时的分隔符
   */
  mall_daily_bought: "今日{bought}/{limit}",
  mall_stock_left: "剩{count}",
  mall_extra_sep: " · ",
  /** 限购 / 库存用尽时按钮文案（按钮同时置灰禁点；服务端仍是权威，50029 / 50030） */
  mall_sold_out: "已售罄",
  mall_daily_full: "今日买满",

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
  /**
   * 服务端把位置拉回来了（#811）
   *
   * 措辞刻意模糊（「网络波动」而不是「你在作弊」）：正常玩家遇到这条基本都是上报抖动，
   * 而作弊的人看到这句话也不会因此收敛 —— 说清楚反而让前者以为自己被封了
   */
  position_corrected_tip: "网络波动，位置已校正",
  /** 当前状态不允许寻路 */
  map_move_refuse_tip: "当前状态无法寻路",
  /** 死亡状态不可传送 */
  map_teleport_dead_tip: "死亡状态无法传送",
  /** 地图预览大图加载失败 */
  map_preview_load_error_tip: "地图预览图加载失败",
  map_config_loading_tip: "地图配置还没加载完，请稍后再打开",

  //#region 浮动提示：活动与功能解锁
  /** 泡点活动开启 */
  activity_started_tip: "泡点活动已开启，尽情享受吧～",
  /** 功能未解锁（{feature} 功能 · {level} 级开放） */
  feature_locked_tip: "{feature}功能需要在{level}级后开放",
  /**
   * 入口已放出但功能还没做（{feature} = 入口名）
   *
   * 与上一条要分开：`feature_locked_tip` 是「等级不够、练级就能用」，
   * 这条是「还没做」。两者混用会让玩家以为练级能解锁一个根本不存在的功能（#485）
   */
  feature_coming_soon: "{feature}功能正在开发中",

  //#region 浮动提示：选角与角色管理
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
  /** 地图配置不存在（服务端回 field=unknown：#859 起未知图直接拒） */
  reject_map_missing: "地图不存在",
  /** 还没有位置记录（新号 / 老档第一次上线）：服务端只准进新手村（#859） */
  reject_map_start: "还没有落脚点，先回新手村再来",
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
  /** 军衔卡片状态（已授衔 / 未授衔） */
  label_rank_active: "已授衔",
  label_rank_locked: "未授衔",
  /** 当前军衔（未授衔时用 label_rank_none） */
  label_rank_current: "当前军衔：{level} 阶 · {label}",
  label_rank_none: "尚未授衔",
  /** 军衔徽记上的阶数进度（{level} / {total}） */
  label_rank_progress: "第 {level} 阶 / 共 {total} 阶",
  /**
   * 头顶红字上的军衔（{rank} = 军衔名，如「振威校尉」）
   * 军衔没有素材动画，头顶这行红字就是它的外显；未授衔时不显示（整行清空）
   */
  label_rank_head: "【{rank}】",
  /** 绑定元宝余额（{value}） */
  label_bind_gold: "绑定元宝：{value}",
  /** 性别文案（校验提示用） */
  label_sex_boy: "男性",
  label_sex_girl: "女性",
  /** 删除角色按钮（正常态 / 两步确认的待确认态，见 configs/hudLayout.roleSelectorLayout.manageRole） */
  label_role_delete: "删除",
  label_role_delete_confirm: "确认删除",
  /** 创建角色弹窗的确认按钮（用通用红底图 + 这行字，见 configs/hudLayout.roleSelectorLayout.createDialog.createButton） */
  label_role_create: "创建",
  /** 管理模式提示条 */
  label_role_delete_hint: "点击角色上方的删除按钮移除角色",
  /** 选角界面角色名牌（脚下；{name} = 角色名，{level} = 等级） */
  label_role_name_plate: "{name} Lv.{level}",
  /** 创建角色弹窗右上角关闭按钮（通用红底图 + 这行字，见 configs/hudLayout.roleSelectorLayout.createDialog.closeButton） */
  label_close: "×",

  //#region 界面标签：属性与装备
  /** 属性分组标题（特殊属性暂未接入，等有行可填时再加回来，见 GameUiHelper.applyRoleAttributeListStyle 的注释） */
  label_attributes_base: "基础属性",
  /** 装备详情：等级与部位（{level} · {slot}） */
  label_good_detail_info: "等级 {level} · {slot}",
  /** 装备详情：部位兜底名（配置里查不到槽位时） */
  label_good_slot_fallback: "装备",
  /** 装备详情：回收价（{price}） */
  label_good_detail_recycle: "回收价 {price} 绑定元宝",
  /** 装备对比：段标题（悬停背包装备按住 Ctrl 时显示身上穿戴的对比） */
  label_good_detail_compare_title: "对比 · 身上穿戴",
  /** 装备对比：逐项行（{worn} 穿戴值 · {value} 候选值 · {delta} 带符号差值） */
  label_good_detail_compare_row: "{worn} → {value}（{delta}）",
  /** 装备对比：战斗力行（{worn} · {value} · {delta} 同上口径） */
  label_good_detail_compare_combat: "战斗力 {worn} → {value}（{delta}）",
  /** 装备对比：发现提示（该槽位身上有穿戴但未按 Ctrl 时显示） */
  label_good_detail_compare_hint: "按住 Ctrl 与身上装备对比",
  /** 装备对比：属性名（战斗力行用，与角色信息弹窗的战斗力图标同一个词） */
  label_combat: "战斗力",
  /** 物品详情：已绑定（绑定角色 = 不允许交易；#789 只做标记与展示，交易系统另行开工） */
  label_good_detail_bound: "已绑定 · 不可交易",
  /** 物品详情：掉落溯源三段（只有装备带溯源；{role} 击杀者 · {monster} 怪物 · {time} 掉落时间） */
  label_good_detail_origin_role: "掉落者 {role}",
  label_good_detail_origin_monster: "怪物 {monster}",
  label_good_detail_origin_time: "掉落于 {time}",
  /** 物品详情：溯源时间格式（MM-DD HH:mm，日期跨天时要看得见） */
  label_good_detail_origin_time_format: "{month}月{day}日 {hour}:{minute}",

  //#region 界面标签：背包操作按钮（文案在这里，几何见 configs/layout/dialogs.bagDialogLayout）
  /** 「一键整理」按钮 */
  label_bag_tidy: "一键整理",
  /** 「一键回收」按钮（正常态 / 两步确认的待确认态） */
  label_bag_recycle: "一键回收",
  label_bag_recycle_confirm: "确认回收",
  /** 「丢弃」按钮（正常态 / 丢弃模式激活态 —— 点击开关丢弃模式） */
  label_bag_discard: "丢弃",
  label_bag_discard_exit: "退出丢弃",

  //#region 界面标签：通用确认框（几何见 configs/layout/dialogs.confirmDialogLayout）
  /** 「确定」按钮（确认不可恢复的操作） */
  label_confirm_ok: "确 定",
  /** 「取消」按钮（放弃操作，数据保持原样） */
  label_confirm_cancel: "取 消",

  //#region 界面标签：飘字与技能列表
  /** 伤害飘字（{value} = 伤害数值） */
  label_damage: "-{value}",
  /** 格挡飘字（{value} = 格挡后实际扣减的伤害） */
  label_damage_block: "格挡 {value}",
  /** 等级压制飘字（#826 第三批；{value} = 压制后的实际伤害，可能为 0） */
  label_damage_suppressed: "压制 {value}",
  /** 闪避飘字 */
  label_damage_miss: "MISS",
  /** 技能释放飘字（{skill}） */
  label_skill_release: "释放{skill}",
  /** 经验飘字（{exp}） */
  label_exp_gain: "+{exp} 经验",
  /** 技能熟练等级前缀（lv.N）/ 未学习 */
  label_skill_level: "lv.{level}",
  label_skill_unlearned: "未学习",
  /** 剩余技能点（#828 技能升级；{points} = 当前点数） */
  label_skill_points: "技能点：{points}",
  /** 技能升级成功的浮动提示（{skill} 技能名 / {level} 新等级 / {cost} 花费 / {remain} 剩余点数） */
  label_skill_upgrade_tip: "「{skill}」升到 lv.{level}（花 {cost} 点，剩 {remain} 点）",
  /** 四维名称（#833 属性加点；键与服务端 ATTR_KEYS / 存档 data.attrs 逐项一致） */
  label_attr_str: "力量",
  label_attr_agi: "敏捷",
  label_attr_vit: "体质",
  label_attr_spi: "精神",
  /** 四维的作用（加点界面的行内说明；与 docs/23 §9.1 的映射一致） */
  label_attr_str_desc: "物理攻击",
  label_attr_agi_desc: "暴击率",
  label_attr_vit_desc: "生命上限 / 物防",
  label_attr_spi_desc: "法术攻击 / 法力",
  /** 剩余属性点（{points} = 当前可分配点数） */
  label_attr_points: "属性点：{points}",
  /** 加点成功的浮动提示（{attr} 四维名 / {points} 剩余点数） */
  label_attr_allocate_tip: "{attr} +1（剩 {points} 点）",
  /** 洗点成功的浮动提示（{refund} 退还点数 / {cost} 消耗的绑定元宝） */
  label_attr_reset_tip: "洗点完成：退还 {refund} 点，消耗 {cost} 绑定元宝",
  /** 洗点确认弹窗（价格只在服务端：确认框不写金额，成功/失败提示里才有准确数字） */
  label_attr_reset_title: "洗 点",
  label_attr_reset_confirm: "洗点会把四项全部归零，已分配的点数全部退还，并消耗一笔绑定元宝。确定要洗点吗？",

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

  //#region 悬停详情行模板：状态数值（{percent}/{factor}/{multiplier} 来自 configs/status 的 combat 字段）
  /** 格挡类状态（{percent} = 触发概率百分数，{factor} = 触发时伤害乘的系数） */
  hover_status_block: "格挡概率 {percent}%，触发时本次伤害 ×{factor}",
  /** 防御类状态（{multiplier} = 防御乘法系数） */
  hover_status_defense: "防御 ×{multiplier}",

  //#region 加载进度
  /** 加载中（{percent}），无阶段说明时用 */
  progress_loading: "加载中 {percent}%",
  /** 加载中 + 阶段说明（{percent} · {tip}） */
  progress_loading_tip: "加载中 {percent}% · {tip}",
  /** 加载失败 */
  progress_failed: "加载失败，请重新进入",
  /** 阶段：拉运营配置快照（#604：进游戏前的硬依赖） */
  progress_config: "运营配置",
  /** 运营配置快照没拿到（#604）：停下并等玩家点重试，不构建游戏世界 */
  progress_config_failed: "配置加载失败，请重试",
  /** 失败面板上的重试按钮 */
  progress_config_retry: "重试",
  /** 契约破坏（服务端漏发段 / 形状不对）：{detail} = 逐条清单（段名 + 原因） */
  config_snapshot_incomplete: "服务端配置快照不完整：{detail}",
  /** 快照过了校验但落库时抛错：{detail} = 错误信息 */
  config_snapshot_apply_failed: "配置快照落库失败：{detail}",
  /** 请求本身没成（服务端没起 / 断网 / 令牌失效） */
  config_snapshot_unreachable: "连不上服务端，配置没拉下来",
  /** 同上，带错误详情 */
  config_snapshot_unreachable_detail: "连不上服务端，配置没拉下来（{detail}）",

  // 段名（「称号配置」「等级表」…）不在这里：它们是契约清单的一部分，跟着
  // configs/snapshot-contract.ts 的 SNAPSHOT_SECTIONS 一起写 —— 两处各留一份必然漂。
  /** 阶段：读地图 */
  progress_map: "地图信息",
  /** 阶段：无需预加载 */
  progress_none: "无需预加载",
  /** 阶段：帧动画（{done}/{total}） */
  progress_frames: "帧动画 {done}/{total}",

  //#region 网络与账号（服务端互动；兜底文案 —— 服务端给了提示语时优先用服务端的）
  /** 连不上服务端 */
  net_unreachable_tip: "无法连接服务器，请检查网络后重试",
  /** 请求超时 */
  net_timeout_tip: "网络超时，请稍后重试",
  /** 服务端返回的不是约定格式 */
  net_parse_tip: "服务器返回数据异常，请稍后重试",
  /** 其它网络异常兜底 */
  net_unknown_tip: "网络异常，请稍后重试",
  /** 实时通道断了（会自动重连；重连成功另有一条提示） */
  realtime_disconnected_tip: "与服务器的连接已断开，正在重新连接…",
  /** 实时通道断线之后又连回来了 */
  realtime_reconnected_tip: "已重新连接服务器",
  /** 实时通道被同账号的另一条连接顶掉（服务端一个账号只留一条连接，见 utils/net/RealtimeClient） */
  realtime_replaced_tip: "账号已在其它窗口登录，本窗口已断开",
  /** 登录/注册表单未填写完整 */
  login_input_empty_tip: "请输入账号和密码",
  /**
   * 登录页顶部：当前区服（{zone} = 区名）
   *
   * 区服在**登录页**就定（#1009）：登录前拉公共活区列表 `GET /zones` 选一个，
   * 登录成功后先按它 `POST /zones/select`，选角页拉到的就是这个区的角色。
   * 登录前拿不到「我在这个区有几个角色」（那要令牌），所以只显示区名，不显示角色数。
   */
  zone_current_label: "区服：{zone}",
  /** 登录页顶部：当前区服 + 可点击切换（只有两个及以上活区时才用这条） */
  zone_switch_label: "区服：{zone}（点击切换）",
  /** 选服弹窗标题 */
  zone_select_title: "选择区服",
  /** 选服弹窗说明（为什么必须先选一个区） */
  zone_select_hint: "不同区服的角色互不相通，进游戏前先选一个区",
  /** 弹窗里标记「上次在」的区（= 本机记着的那个区，勾在登录页默认选中的那行） */
  zone_tag_current: "上次在",
  /** 弹窗里标记运营推荐的区（管理端 zones.recommended） */
  zone_tag_recommended: "推荐",
  /** 区状态：开放中（弹窗里每行中间那列） */
  zone_status_open: "开放中",
  /** 区状态：维护中（列举里置灰，点不了） */
  zone_status_maintenance: "维护中",
  /** 区状态：已关闭（不可逆，只能等运营合区处理） */
  zone_status_closed: "已关闭",
  /** 点维护中的区时的提示（不静默，否则玩家以为点坏了） */
  zone_unavailable_tip: "该区正在维护，暂时进不去",
  /** 点已关闭的区时的提示 */
  zone_closed_tip: "该区已关闭，无法进入",
  /** 在登录页选好区（{zone} = 区名；真正落到服务端是在点登录之后） */
  zone_picked_tip: "已选择 {zone}",
  /** 登录后按所选区切换失败、自动换了一个还能进的区（{from} = 原区名，{to} = 兜底区名） */
  zone_fallback_tip: "{from} 暂时进不去，已切换到 {to}",
  /**
   * 列表标题上的区名前缀（{zone} = 区名）
   *
   * 排行榜与帮会列表都是**按区**的数据（P2 / P3 之后），标题不写区名的话，
   * 玩家在 2 区打开看到「共 30 人上榜」，会以为是全服的数据。
   */
  zone_title_prefix: "{zone} · ",
  /**
   * 登录页区服列表拉取失败
   *
   * 不阻塞登录：拿不到列表就不显示区名，登录后按服务端记着的当前区走
   * （角色列表本来也是按那个区拉的）。这条提示只是让玩家知道「这次没得选」。
   */
  zone_load_failed_tip: "区服列表拉取失败，按上次的区进入",
  /**
   * 登录页整版文案（#1036，按 design/olua-login 设计稿）
   *
   * 全部是玩家可见文案，按仓库惯例收在这里（config-leak 审计：ui/ 不写中文字面量）。
   * 顶栏 / 面板标题这类要拉宽字距的标题直接把空格写进文案（客户端 Label 没有字距属性）。
   */

  /** 左上品牌副标（主标是真实 LOGO 图，见 images.ts.gameLogo） */
  login_brand_sub: "OLUA",
  /** 顶栏版本胶囊（{version} = 服务端配置版本号，GET /game-config/version） */
  login_version_label: "VER {version}",
  /** 版本号拉取失败：整个胶囊隐藏，不显示编造的版本 */
  login_version_unavailable: "-",
  /** 首屏左列眉题 */
  login_eyebrow: "全新资料片 · 沙城争霸",
  /** 首屏左列一句话简介 */
  login_tagline: "屠龙再启，兄弟聚首；一刀一级，热血攻沙。尘封的石门今日再度开启，等待归来的城主。",
  /** 职业预览标签：战士 / 法师 / 道士（与本作三职业对应） */
  login_class_warrior: "战士",
  login_class_mage: "法师",
  login_class_taoist: "道士",
  /** 职业预览说明（点对应标签时显示） */
  login_class_desc_warrior: "近战肉搏，高血高防；一柄重剑冲锋破甲，是沙城里最可靠的前排。",
  login_class_desc_mage: "远程法术，火墙雷电群攻清场；爆发极高，走位决定生死。",
  login_class_desc_taoist: "召唤神兽，施毒治愈辅助；攻守兼备，是队伍里稳得住的后背。",
  /** 公告栏左端的标签字 */
  login_notice_label: "公告",
  /** 登录面板标题 */
  login_panel_title: "账 号 登 录",
  /** 选服按钮：区列表还没拿到时的占位 */
  login_zone_unknown: "正在获取区服列表…",
  /** 选服按钮左端的固定标签字 */
  login_server_label: "区服",
  /** 记住账号勾选框 */
  login_remember: "记住账号",
  /** 忘记密码入口（客户端暂无找回功能：飘字说明，暂时放置） */
  login_forgot: "忘记密码",
  login_forgot_tip: "找回密码：请通过官网账号中心验证",
  /** 主按钮（设计稿「进入游戏」） */
  login_enter_button: "进 入 游 戏",
  /** 面板次要入口：注册新账号（与登录共用上方账号/密码输入框） */
  login_register: "注册新账号",
  /** 面板底部合规文案 */
  login_foot_notice: "健康游戏忠告 · 抵制不良游戏",
  /** 底部条版权 */
  login_copyright: "© 2026 Olua 运营团队 · 保留所有权利",
  /** 底部条协议入口（客户端暂无协议页：飘字说明，暂时放置） */
  login_link_agreement: "用户协议",
  login_link_privacy: "隐私政策",
  login_link_minor: "未成年人保护",
  login_link_todo_tip: "相关协议与政策请前往官网查看",
  /** 游戏修复入口（客户端暂无资源校验功能：飘字说明，暂时放置） */
  login_repair: "游戏修复",
  login_repair_tip: "正在校验本地资源完整性…",
  /** 背景音开关（登录页背景音见 SoundManager.login_bgm） */
  login_music_off_tip: "背景音乐已静音",
  login_music_on_tip: "背景音乐已开启",
  /**
   * 地图标题后的线号后缀（#1016；{channel} = 玩家视角的线号 = 服务端 channel + 1）
   *
   * 服务端口径里公共线是 `0`、分线 `1..N`（见 room-key.util），玩家眼里的「1 线」就是公共线。
   * 拼接方（SmallMap）只在 `channel > 0` 时拼这条 —— 公共线保持原来的纯图名，
   * 分线才追加「· 2 线」这样的后缀。
   */
  map_channel_suffix: " · {channel}线",
  /** 选线弹窗标题（#1016） */
  channel_select_title: "选择线路",
  /** 选线弹窗说明（为什么同一张图会有好几条线） */
  channel_select_hint: "人多拥挤的线路可以去别的线，怪物与掉落各线各一份",
  /** 选线弹窗：标记当前所在的那条线 */
  channel_tag_current: "当前",
  /** 选线弹窗：一行的线名（{channel} = 玩家视角的线号） */
  channel_row_label: "{channel}线",
  /** 换线成功（{channel} = 玩家视角的线号） */
  channel_changed_tip: "已切换到{channel}线",
  /** 点了自己所在的线（不浪费一次往返，直接提示） */
  channel_same_tip: "你已在这条线上",
  /** 有请求在途时又点了别的线（一次只换一条，服务端总是回帧，不会永远等不到） */
  channel_busy_tip: "正在切换线路，请稍候",
  /** 通道不在线（断线中）：换线是纯实时通道操作，发不出去 */
  channel_offline_tip: "网络未连接，暂时无法换线",
  /** 目标线满员（{channel} = 玩家视角的线号） */
  channel_full_tip: "{channel}线已满",
  /** 目标线满员且服务端指了一条还有空位的线（{suggest} = 线号） */
  channel_full_suggest_tip: "{channel}线已满，{suggest}线还有空位",
  /** 目标线不存在（本地 maxChannels 与服务端错位时的兜底提示） */
  channel_unknown_tip: "这条线路不存在",
  /** 本区维护中 / 已合并，换线被拒（马上还会被踢回登录页，这里先给一句） */
  channel_zone_tip: "本区状态异常，暂时无法换线",
  /** 换线请求超时（服务端没回帧；留在原线，可以再试） */
  channel_timeout_tip: "切换超时，请稍后再试",
  /** 登录成功（{name} = 账号名） */
  login_success_tip: "登录成功，欢迎 {name}",
  /** 注册成功（{name} = 账号名） */
  register_success_tip: "注册成功，欢迎 {name}",
  /** 角色创建成功（服务端已保存后才提示） */
  role_create_success_tip: "角色创建成功",

  /**
   * 角色数据已被后台修改，已自动同步为最新
   *
   * 触发场景：玩家在游戏里、管理员在后台改了同一个角色。
   * 本地那份存档是「改之前」的基线，推上去会把后台改动抹掉，所以以服务端为准（见 utils/net/RoleSync）。
   */
  role_sync_conflict_tip: "角色数据已在后台被修改，已同步为最新数据",
  /** 角色已被后台删除（本地不该继续玩一个不存在的角色，回选角场景重来） */
  role_sync_missing_tip: "角色已被删除，请重新选择角色",
  /**
   * 角色已被管理员下线（账号的在线角色被清掉）
   *
   * 与「已被删除」分开：角色的存档还在，回选角界面重新选一次就能继续玩
   * （见 utils/net/RoleSync 的 kicked 分支）。
   */
  role_sync_kicked_tip: "你的角色已被管理员下线，请重新选择角色进入游戏",

  //#region 公告（玩家侧展示；拉取接口见服务端 GET /announcements/active）
  /** 级别标签：普通 */
  label_announcement_level_normal: "普通",
  /** 级别标签：重要 */
  label_announcement_level_important: "重要",
  /** 时间窗：开始时间未设（立即生效） */
  label_announcement_immediate: "立即生效",
  /** 时间窗：结束时间未设（不设截止） */
  label_announcement_longterm: "长期有效",
  /** 时间窗整体（{from} → {to}） */
  label_announcement_window: "{from} → {to}",
  /** 列表条目的第二行：级别 · 时间窗（{level} = 级别文案，{window} = 上面的时间窗） */
  label_announcement_item_meta: "{level} · {window}",
  /** 公告板：一条公告都没有 */
  label_announcement_empty: "暂无公告",
  /** 公告板：拉取失败（列表位置上的兜底说明） */
  label_announcement_load_failed: "公告加载失败，请稍后再试",
  /** 公告板：还没选公告时的提示 */
  label_announcement_pick: "请从左侧选择一条公告",
} as const;

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

/** 造一个文案引用（校验层用，省得到处写对象字面量） */
export function textRef(key: string, params?: TextParams): TextRef {
  return { key, params };
}
