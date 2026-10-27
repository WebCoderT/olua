/**
 * 业务码（响应体 code 字段）
 *
 * 约定：0 = 成功；其余按模块分段（1xxxx 账号 / 2xxxx 角色 / 3xxxx 管理端 / 4xxxx 通用 / 5xxxx 公告）。
 * HTTP 状态码照旧语义化，code 只表达「业务上发生了什么」，客户端据 code 决定提示与分支。
 */
export const BizCode = {
  /** 成功 */
  OK: 0,

  //#region 通用
  /** 参数校验不通过 */
  PARAM_INVALID: 40000,
  /** 未登录 / 缺少令牌 */
  UNAUTHORIZED: 40100,
  /** 令牌非法 */
  TOKEN_INVALID: 40101,
  /** 令牌过期 */
  TOKEN_EXPIRED: 40102,
  /**
   * 令牌已被主动作废（口令被重置 / 修改后重新签发）
   *
   * 令牌是无状态的，光改密码不会让已签发的旧令牌失效 —— 所以账号与管理员的表里各有
   * 一个 `token_version`，签发时写进载荷、每次请求回查库比对（见 AuthGuard）。
   * 收到这个码应当清掉本地令牌、回到登录界面（与 TOKEN_EXPIRED 同样处理）。
   */
  TOKEN_REVOKED: 40103,
  /** 无权访问该资源 */
  FORBIDDEN: 40300,
  /** 资源不存在 */
  NOT_FOUND: 40400,
  /** 与现有数据冲突 */
  CONFLICT: 40900,
  /** 服务器内部错误 */
  INTERNAL: 50000,

  //#region 账号
  /** 账号已存在 */
  ACCOUNT_EXISTS: 10001,
  /** 账号不存在 */
  ACCOUNT_NOT_FOUND: 10002,
  /** 密码错误 */
  PASSWORD_WRONG: 10003,
  /** 账号已被封禁 */
  ACCOUNT_DISABLED: 10004,
  /** 登录失败次数过多，临时锁定（限流见 common/security/login-throttle.service） */
  LOGIN_LOCKED: 10005,
  /**
   * 本服已关闭新账号注册
   *
   * 与「账号已存在」区分开：前者是运营开关（不该提示玩家换个名字重试），
   * 后者是重名。客户端只需原样展示服务端文案。
   */
  REGISTER_CLOSED: 10006,
  /** 同一邮箱已被别的账号绑定（大小写不敏感；未填写不限） */
  ACCOUNT_EMAIL_EXISTS: 10007,

  //#region 角色
  /** 角色数量已达上限 */
  ROLE_LIMIT: 20001,
  /** 角色不存在 */
  ROLE_NOT_FOUND: 20002,
  /** 角色数据不合法 */
  ROLE_DATA_INVALID: 20003,
  /** 角色 id 已存在 */
  ROLE_ID_EXISTS: 20004,
  /** 同一账号下角色重名 */
  ROLE_NAME_EXISTS: 20005,
  /**
   * 角色已被别处修改（乐观锁冲突）
   *
   * 客户端推送进度时带的 revision 与服务端当前值不一致 —— 典型场景是玩家在游戏里，
   * 管理员在后台改了这个角色。客户端收到它应当**拉取最新数据后再继续**，
   * 而不是拿本地旧数据覆盖（否则后台的改动会被玩家的下一次同步抹掉）。
   */
  ROLE_REVISION_CONFLICT: 20006,
  /**
   * 角色已被管理员下线（不再是账号当前的在线角色）
   *
   * 管理员在后台「踢下线」后清掉 `accounts.online_role_id`，此时客户端手上那份存档
   * 就不该再写回来了 —— 否则踢了等于没踢（玩家本地缓存还在，会一直推进度）。
   * 客户端收到它应当提示并回到选角界面。
   */
  ROLE_KICKED: 20007,
  /** 成长线升级目标不合法（不是升级链上当前阶位的下一阶；防跳级/防并发错位） */
  GROWTH_TARGET_INVALID: 20008,
  /** 成长线升级绑定元宝不足 */
  GROWTH_GOLD_NOT_ENOUGH: 20009,
  /** 成长线不可经升级获得（称号渠道为 grant / unavailable 时拒绝升级链扣费） */
  GROWTH_CHANNEL_LOCKED: 20010,
  /** 商城购买绑定元宝不足 */
  MALL_GOLD_NOT_ENOUGH: 20011,
  /** 商城购买背包已满（装备不可叠加，每件占一格，网格内没有空格） */
  MALL_BAG_FULL: 20012,
  /** 用药目标不合法（格子为空 / 格子里不是药品 / 药品没有任何生效回复量） */
  DRUG_USE_TARGET_INVALID: 20013,
  /** 用药无需进行（血量与魔法值均已满，回复不动任何一项） */
  DRUG_RESOURCE_FULL: 20014,

  //#region 管理端
  /** 管理员账号已存在 */
  ADMIN_EXISTS: 30001,
  /** 管理员不存在 */
  ADMIN_NOT_FOUND: 30002,
  /** 管理员密码错误 */
  ADMIN_PASSWORD_WRONG: 30003,
  /** 管理端注册码错误 */
  ADMIN_REGISTER_CODE_WRONG: 30004,
  /** 管理员账号已停用 */
  ADMIN_DISABLED: 30005,
  /** 管理员权限不足（令牌有效，但角色没有该接口要求的权限点） */
  ADMIN_PERMISSION_DENIED: 30006,
  /** 保护性拒绝（如把最后一个超级管理员降级 / 停用） */
  ADMIN_PROTECTED: 30007,
  /** 管理员角色不合法 */
  ADMIN_ROLE_INVALID: 30008,
  /** 管理端登录失败次数过多，临时锁定 */
  ADMIN_LOGIN_LOCKED: 30009,
  /** 管理员自助改密时原密码不正确 */
  ADMIN_OLD_PASSWORD_WRONG: 30010,
  /** 新密码与当前密码相同 */
  ADMIN_PASSWORD_SAME: 30011,
  /**
   * 管理端注册已关闭
   *
   * 与「注册码不正确」（30004）区分开：那个是「码填错了」，这个是「压根没开注册」——
   * 运维看到 30004 会去翻注册码，看到这个才会去改 `.env`。
   */
  ADMIN_REGISTER_CLOSED: 30012,

  //#region 公告
  /** 公告不存在（已被删，或 id 传错） */
  ANNOUNCEMENT_NOT_FOUND: 50001,
  /**
   * 公告生效时间窗不合法（结束时间不晚于开始时间）
   *
   * 单独给一个码而不是并进「参数校验不通过」（40000）：前者是**跨字段**的组合错误，
   * 管理端要能把它定位到「时间窗」这一组控件上，而不是丢一句泛泛的「参数不合法」。
   */
  ANNOUNCEMENT_TIME_RANGE_INVALID: 50002,

  //#region 邮件
  /**
   * 邮件通道未启用（SMTP 没配齐）
   *
   * 单独一个码而不是复用「服务不可用」：运维看到这个码要去配 `.env`，
   * 看到通用的 500 只会去翻日志。通道未启用是**配置问题**，接口要能把它
   * 说成人话给界面显示，而不是静默让邮件消失。
   */
  MAIL_DISABLED: 50003,
  /** 收件账号不存在（关联玩家时传了不存在的 accountId） */
  MAIL_ACCOUNT_NOT_FOUND: 50004,
  /** 收件邮箱缺失：既没传 `to`，账号上也没有邮箱 */
  MAIL_ADDRESS_MISSING: 50005,
  /** 模板不存在 */
  MAIL_TEMPLATE_NOT_FOUND: 50006,
  /** 模板必填变量缺失（宁可拒发，也不要发出「亲爱的 ，」这种信） */
  MAIL_VARIABLE_MISSING: 50007,
  /** 投递任务不存在 */
  MAIL_JOB_NOT_FOUND: 50008,
  /**
   * 重投的前提不满足（只有最终失败的任务能重投）
   *
   * 与 50008 分开：任务不存在是「id 传错了」，这个是「任务在，但当前状态不允许这个动作」。
   */
  MAIL_JOB_NOT_RETRYABLE: 50009,

  //#region 养成配置（称号 / 战魂）
  /** 称号等级不存在（等级序列固定 1..34，不存在的 level 一定是传错了） */
  TITLE_NOT_FOUND: 50010,
  /** 战魂阶数不存在（阶数序列固定 1..37） */
  SOUL_NOT_FOUND: 50011,
  /** 等级经验不存在（等级序列固定 1..roleMaxLevel） */
  LEVEL_EXP_NOT_FOUND: 50012,
  /** 曲线分段不存在（曲线键或段序传错；分段不可增删，只许改内容） */
  GROWTH_SEGMENT_NOT_FOUND: 50013,
  /** 标量参数不存在（参数清单由 seed 固定） */
  GROWTH_SCALAR_NOT_FOUND: 50014,
  /** 军衔阶数不存在（阶数序列固定 1..100） */
  RANK_NOT_FOUND: 50015,
  /** 装备基础件不存在（id 清单由客户端配置 seed 固定，不可增删行） */
  EQUIPMENT_NOT_FOUND: 50016,
  /** 药品不存在（id 清单由客户端配置 seed 固定，不可增删行） */
  DRUG_NOT_FOUND: 50017,
  /** 物品不存在（id 清单由客户端配置 seed 固定，不可增删行） */
  ITEM_NOT_FOUND: 50018,
  /** 怪物不存在（key 清单由客户端配置 seed 固定，不可增删行） */
  MONSTER_NOT_FOUND: 50019,
  /** NPC 不存在（id 清单由客户端配置 seed 固定，不可增删行） */
  NPC_NOT_FOUND: 50020,
  /** 商城商品不存在（商品清单 = 生成物的装备全量，id 不在清单里不能定价） */
  MALL_GOOD_NOT_FOUND: 50021,
  /** 时装不存在（id 清单由客户端配置 seed 固定，不可增删行） */
  FASHION_NOT_FOUND: 50022,
  /** 具名掉落表不存在（seed 有 common/elite/boss/default，可动态增删） */
  DROP_TABLE_NOT_FOUND: 50023,
  /** 怪物掉落配置不存在（key 清单与怪物一一对应，不可增删行） */
  MONSTER_DROP_NOT_FOUND: 50024,
  /** 技能不存在（角色技能清单由生成物 seed 固定；怪物技能由 #12 主体那一刀接管增删） */
  SKILL_NOT_FOUND: 50029,
  /** 状态不存在（清单 seed 自生成物 STATUSES，不可增删行） */
  STATUS_NOT_FOUND: 50030,

  //#region 任务（#396）
  /** 任务不存在（配置表里没有这个 id） */
  QUEST_NOT_FOUND: 50031,
  /** 任务当前状态不允许这个动作（未接取就交付 / 重复接取 / 进度未满就交付 / 主线前置未完成等） */
  QUEST_STATE_INVALID: 20015,
  /** 任务等级不够（低于 minLevel 接不了） */
  QUEST_LEVEL_LOW: 20016,
  /** 收集型任务材料不足（交付时背包里没有足够的目标物品） */
  QUEST_MATERIAL_SHORT: 20017,
  //#endregion

  //#region 经济：出售 / 回收（#397）
  /**
   * 该物品不可出售（配置里没有价签）
   *
   * 「不可卖」是**数据决定**的：共享快照 `SELL_PRICES` 里没有这个 id 就卖不了 ——
   * 任务物、关键道具靠这条拦住。与「物品不存在」（40400）分开：前者是规则，后者是入参写错。
   */
  SELL_NOT_SELLABLE: 20018,
  /** 背包里的数量不够卖（整单拒绝，不做部分扣除） */
  SELL_NOT_ENOUGH: 20019,
  //#endregion

  //#region 区服（多开区 / 合并区）
  /** 区服不存在（注册选区传了没有的 id；合并的 from / to 传错） */
  ZONE_NOT_FOUND: 50025,
  /** 区服已并入其他区（对注册来说是「这个区进不去了」；对合并来说是 from 已经合过） */
  ZONE_MERGED: 50026,
  /** 区服名已存在 */
  ZONE_NAME_EXISTS: 50027,
  /** 不能把区合并进它自己 */
  ZONE_MERGE_SAME: 50028,

  //#region 社交：帮会（#388）
  /** 帮会不存在（列表里刚被解散 / id 传错） */
  GUILD_NOT_FOUND: 50101,
  /** 帮会名已存在 */
  GUILD_NAME_EXISTS: 50102,
  /** 已经在某个帮会里（一个人只能在一个帮会 —— 建帮、申请、入帮都先过这道） */
  GUILD_ALREADY_IN: 50103,
  /** 不在任何帮会里（退出 / 改公告 / 审批这类「帮内动作」的前提） */
  GUILD_NOT_IN: 50104,
  /**
   * 职位不够
   *
   * 与 `FORBIDDEN`（40300）分开：那是「连这个门都进不去」，这里是「帮内职位不够」——
   * 客户端要能区分「我不是这个帮的人」和「我是成员但没这个权」。
   */
  GUILD_PERMISSION_DENIED: 50105,
  /** 帮主不能直接退出（先转让或解散）；也不能被踢 */
  GUILD_LEADER_LOCKED: 50106,
  /** 帮会人数已满 */
  GUILD_FULL: 50107,
  /** 目标不合法（转让/踢人/审批的对象不是本帮成员，或指向自己） */
  GUILD_TARGET_INVALID: 50108,
  //#endregion

  //#region 社交：好友与敌人（#389）

  /** 按角色名找不到人（好友/敌人都按名字加，不暴露 id 搜索） */
  SOCIAL_ROLE_NOT_FOUND: 50109,
  /** 不能对自己做社交动作（加自己好友 / 标自己敌人） */
  SOCIAL_TARGET_SELF: 50110,
  /**
   * 已经是好友，或已有待处理的申请
   *
   * 与「加过一次就静默成功」分开：玩家点两次要能看到「已经有了」，
   * 否则会误以为没加上去而反复点。**唯一例外**是对方也在等我 —— 那种情况直接当成同意。
   */
  SOCIAL_ALREADY_FRIEND: 50111,
  /** 没有这条好友关系（删一个本来就不是好友的人） */
  SOCIAL_FRIEND_NOT_FOUND: 50112,
  /** 已经是敌人（重复标记） */
  SOCIAL_ENEMY_EXISTS: 50113,
  /** 不是敌人（解除一个本来就没标的） */
  SOCIAL_ENEMY_NOT_FOUND: 50114,
  /** 好友数量到达上限 */
  SOCIAL_FRIEND_FULL: 50115,
  /** 同名角色不止一个（角色名只在同一账号内唯一），让玩家改从「附近」或帮会成员里加 */
  SOCIAL_NAME_AMBIGUOUS: 50116,
  //#endregion

  //#region 屏蔽与举报（#398）

  /** 已经拉黑过这个人（重复拉黑） */
  SOCIAL_BLOCK_EXISTS: 50117,
  /** 没有这条屏蔽（解除一个本来就没拉黑的） */
  SOCIAL_BLOCK_NOT_FOUND: 50118,
  /** 屏蔽名单满了（防刷表；见 common/constants/social.ts 的 BLOCK_LIMIT_DEFAULT） */
  SOCIAL_BLOCK_FULL: 50119,
  /**
   * 已经举报过这个人、还没处理完
   *
   * 同一对「我 → 他」只留一条 pending：举报是给人工处理用的证据，
   * 连点二十次不会让人更快被处理，只会让列表里全是同一个人。
   */
  SOCIAL_REPORT_EXISTS: 50120,
  //#endregion

  //#region 队伍（#399）

  /** 你还没加入任何队伍（离开 / 解散 / 踢人时） */
  PARTY_NOT_FOUND: 50121,
  /** 队伍已满（上限见 PARTY_MEMBER_LIMIT） */
  PARTY_FULL: 50122,
  /** 已经在队伍里（自己建队 / 邀请一个已经有队的人） */
  PARTY_ALREADY_IN: 50123,
  /** 只有队长能做这件事（踢人 / 转让 / 解散） */
  PARTY_NOT_LEADER: 50124,
  /** 目标不在你的队伍里（踢人 / 转让队长） */
  PARTY_NOT_MEMBER: 50125,
  /**
   * 没有这条邀请（或已过期）
   *
   * 过期与「本来就没有」不分开报：对玩家来说结果一样（得让人重新邀请），
   * 分开报只会让客户端多写一个分支。
   */
  PARTY_INVITE_NOT_FOUND: 50126,
  /** 已经邀请过这个人、还没过期（重复邀请） */
  PARTY_INVITE_EXISTS: 50127,
  /** 对方不在线（邀请必须即时送达，离线收不到帧） */
  PARTY_TARGET_OFFLINE: 50128,
  /** 不能邀请自己 */
  PARTY_INVITE_SELF: 50129,
  /**
   * 我拉黑了对方，不能邀他入队
   *
   * 只有「我拉黑他」这一个方向会报这个码：那是**我自己的设置**，说清楚才能解除。
   * 反方向（他拉黑我）一律回 `PARTY_TARGET_OFFLINE` —— 说破等于把屏蔽变成可观测信号
   * （与 #398 私聊同一纪律）。
   */
  PARTY_INVITE_BLOCKED: 50130,
  //#endregion

  //#region 成就（#401）

  /** 成就 id 不存在（配置被运营删了，而客户端还拿着旧快照） */
  ACHIEVEMENT_NOT_FOUND: 50131,
  /**
   * 还没达成，不能领奖
   *
   * 与「已领过」分开报：前者是「再去打两只」，后者是「你已经拿过了」——
   * 合成一个码会让玩家以为成就丢了。
   */
  ACHIEVEMENT_NOT_ACHIEVED: 50132,
  /** 奖励已经领过了（不可重复领） */
  ACHIEVEMENT_CLAIMED: 50133,
  //#endregion

  //#region 游戏内邮件（#429）

  /** 邮件不存在（被删了 / id 抄错；也可能是别人的邮件 —— 不区分，免得成了越权探测口） */
  MAIL_NOT_FOUND: 50141,
  /** 这封邮件的附件已经领过了 */
  MAIL_ALREADY_CLAIMED: 50142,
  /** 附件还没领，不能删（删了等于替玩家扔掉奖励） */
  MAIL_UNCLAIMED: 50143,
  //#endregion
} as const;
