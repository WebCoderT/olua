/**
 * 军衔种子（#590 起服务端唯一书写处）
 *
 * 与战魂（37 阶，soul-seed）和称号（34 阶，title-seed）同一套做法，差异只有两点：
 * - **没有素材**：军衔的外观就是头顶信息栏里的一行红字（军衔名），没有 animation 字段；
 * - **阶数多、跨度长**：100 阶平均分 10 个大段（每段 10 阶），大段之间用 factor 跳档。
 *
 * 属性**不在这里拍数值**，而是按阶映射到一个「等效角色等级」，取该等级的角色裸属性再打折，
 * 于是 growth-seed 的角色曲线一改，军衔强度自动跟着走（不会出现「升了几十阶毫无感觉」）。
 *
 * 强度定位：满衔 100 阶 ≈ 60 级角色裸属性的 0.35 × 1.5 ≈ 52.5%，
 * 夹在满阶称号（0.3 × 1.3 ≈ 39%）与满阶战魂（0.5 × 1.35 ≈ 67%）之间。
 * （#590 从客户端 configs/rank 原样搬入，插值公式与取整口径逐字节保留。）
 */

import { getRoleLevelAttributes, ROLE_MAX_LEVEL } from "./growth-seed";

/** 一个大段（10 阶）：段名 + 段内强度系数 + 该段的 10 个军衔 */
interface RankTierSeed {
  /** 段名（弹窗列表与徽记上展示，如「校尉」） */
  tier: string;
  /** 大段强度系数（1.00 → 1.50，每段 +0.05、最后一段 +0.10） */
  factor: number;
  /** 段内 10 个军衔（顺序即阶数顺序，由低到高） */
  ranks: { label: string; description: string }[];
}

/** 军衔序列（10 大段 × 10 阶 = 100 阶，顺序即阶数顺序） */
const RANK_TIER_ROWS: RankTierSeed[] = [
  {
    tier: "兵卒",
    factor: 1,
    ranks: [
      { label: "新兵", description: "刚入伍的毛头小子，铁甲还带着新铁的凉气。" },
      { label: "列兵", description: "站得笔直的列兵，喊起号子来最有精神。" },
      { label: "上等兵", description: "操练最勤的上等兵，教头已经记住了他的名字。" },
      { label: "伍长", description: "带五个人的伍长，第一次有了要照看的兄弟。" },
      { label: "什长", description: "管十个兄弟的什长，夜里替人站过岗。" },
      { label: "队正", description: "领一队人的队正，号令一出队伍立即成列。" },
      { label: "屯长", description: "屯田练兵的屯长，粮草与刀枪一起管。" },
      { label: "曲长", description: "领一曲之兵的曲长，第一次独立列阵迎敌。" },
      { label: "部曲督", description: "督领部曲的军官，营中大小事务都要过他手。" },
      { label: "牙门将", description: "牙门之下执旗的将领，自此正式踏上仕途。" },
    ],
  },
  {
    tier: "校尉",
    factor: 1.05,
    ranks: [
      { label: "陪戎校尉", description: "陪侍军旅的散号校尉，算是有了正经品级。" },
      { label: "仁勇校尉", description: "仁而能勇的校尉，士卒愿意跟着他冲锋。" },
      { label: "致果校尉", description: "果决敢断的校尉，箭雨之中也不退半步。" },
      { label: "翊麾校尉", description: "翊卫麾下的校尉，护着帅旗不离左右。" },
      { label: "宣节校尉", description: "掌宣威持节的校尉，出使诸营传令。" },
      { label: "游骑校尉", description: "率游骑巡哨的校尉，来去如风不留踪迹。" },
      { label: "昭武校尉", description: "昭显武德的校尉，演武场上连克三营。" },
      { label: "振威校尉", description: "振扬军威的校尉，一声怒喝能止住溃兵。" },
      { label: "果毅校尉", description: "果毅敢死的校尉，攻坚拔寨从不落于人后。" },
      { label: "折冲校尉", description: "折冲御侮的校尉，能挡下敌军第一波冲阵。" },
    ],
  },
  {
    tier: "都尉",
    factor: 1.1,
    ranks: [
      { label: "建节都尉", description: "持节建威的都尉，可代主帅行令。" },
      { label: "奉车都尉", description: "掌车驾仪仗的都尉，出入军前最是显赫。" },
      { label: "强弩都尉", description: "统强弩营的都尉，箭阵所过寸草不生。" },
      { label: "骑都尉", description: "统骑军的都尉，马蹄声起便是敌营噩梦。" },
      { label: "轻车都尉", description: "领轻车的都尉，驰突如风不留痕迹。" },
      { label: "奉国都尉", description: "奉国讨逆的都尉，凡有战事必在其列。" },
      { label: "护军都尉", description: "掌护军的都尉，兼管诸营军法。" },
      { label: "中垒都尉", description: "领中垒营的都尉，是中军最硬的一面盾。" },
      { label: "虎贲都尉", description: "统虎贲锐士的都尉，专破敌之精锐。" },
      { label: "羽林都尉", description: "统羽林禁军的都尉，拱卫中军大帐。" },
    ],
  },
  {
    tier: "中郎将",
    factor: 1.15,
    ranks: [
      { label: "五官中郎将", description: "五官中郎将，位列诸郎将之首。" },
      { label: "左中郎将", description: "左中郎将，领左军宿卫。" },
      { label: "右中郎将", description: "右中郎将，掌右军宿卫。" },
      { label: "虎贲中郎将", description: "虎贲中郎将，麾下皆是敢死之士。" },
      { label: "羽林中郎将", description: "羽林中郎将，禁军之中最锋利的一支。" },
      { label: "护军中郎将", description: "护军中郎将，诸将之中专掌监察。" },
      { label: "武卫中郎将", description: "武卫中郎将，贴身护卫主帅安危。" },
      { label: "龙骧中郎将", description: "龙骧中郎将，所部如龙腾跃不可挡。" },
      { label: "神策中郎将", description: "神策中郎将，掌神策军的机要之师。" },
      { label: "金吾中郎将", description: "金吾中郎将，执金吾之权巡警诸营。" },
    ],
  },
  {
    tier: "将军",
    factor: 1.2,
    ranks: [
      { label: "偏将军", description: "偏将军，独领一军为侧翼。" },
      { label: "裨将军", description: "裨将军，辅佐主帅调度诸军。" },
      { label: "荡寇将军", description: "荡寇将军，专司扫荡流寇与残敌。" },
      { label: "折冲将军", description: "折冲将军，善以少击众破敌锋锐。" },
      { label: "讨逆将军", description: "讨逆将军，奉命讨伐叛逆之师。" },
      { label: "平南将军", description: "平南将军，镇抚南方诸城。" },
      { label: "镇北将军", description: "镇北将军，坐镇北疆要塞。" },
      { label: "征西将军", description: "征西将军，西征千里拓地开疆。" },
      { label: "安东将军", description: "安东将军，安定东路边境。" },
      { label: "前将军", description: "前将军，大军锋头，最先接敌。" },
    ],
  },
  {
    tier: "重号将军",
    factor: 1.25,
    ranks: [
      { label: "后将军", description: "后将军，掌全军后卫与辎重。" },
      { label: "右将军", description: "右将军，位列上将掌右军。" },
      { label: "左将军", description: "左将军，位列上将掌左军。" },
      { label: "卫将军", description: "卫将军，总领京师宿卫。" },
      { label: "车骑将军", description: "车骑将军，车骑并进势不可当。" },
      { label: "骠骑将军", description: "骠骑将军，轻骑千里取敌首级。" },
      { label: "大将军", description: "大将军，一人之下总揽兵权。" },
      { label: "大都督", description: "大都督，督率诸军大小战事。" },
      { label: "太尉", description: "太尉，掌天下兵马的最高武职。" },
      { label: "大司马", description: "大司马，与太尉同列，军政尽归其手。" },
    ],
  },
  {
    tier: "公卿",
    factor: 1.3,
    ranks: [
      { label: "开府仪同三司", description: "开府仪同三司，以自己的名义开府置僚。" },
      { label: "柱国", description: "柱国，国之柱石，皇帝以下第一等勋职。" },
      { label: "上柱国", description: "上柱国，柱国之上，策勋十二转。" },
      { label: "天策上将", description: "天策上将，位在王公之上，总揽内外军事。" },
      { label: "尚书令", description: "尚书令，总领尚书台处理军国文书。" },
      { label: "中书令", description: "中书令，掌中书出纳军令。" },
      { label: "太师", description: "太师，三师之首，天子所师法。" },
      { label: "太傅", description: "太傅，辅导天子兼参机要。" },
      { label: "太保", description: "太保，护持社稷，位极人臣。" },
      { label: "三公", description: "三公并座，谈笑之间定天下兵事。" },
    ],
  },
  {
    tier: "王爵",
    factor: 1.35,
    ranks: [
      { label: "郡王", description: "郡王，食邑一郡，名列宗室。" },
      { label: "嗣王", description: "嗣王，承袭王爵的嫡系贵胄。" },
      { label: "亲王", description: "亲王，一字封号，尊荣无两。" },
      { label: "一字并肩王", description: "一字并肩王，与天子并肩同列。" },
      { label: "摄政王", description: "摄政王，君幼则代行朝政。" },
      { label: "镇国王", description: "镇国王，坐镇国都以镇四方。" },
      { label: "护国王", description: "护国王，兵符在手，护国安邦。" },
      { label: "兵马大元帅", description: "兵马大元帅，天下兵马皆听号令。" },
      { label: "天下兵马大元帅", description: "天下兵马大元帅，帅旗所指，万军景从。" },
      { label: "九锡之臣", description: "九锡之臣，人臣之赏已至极处。" },
    ],
  },
  {
    tier: "神将",
    factor: 1.4,
    ranks: [
      { label: "护国军神", description: "护国军神，殁后受祠，香火不断。" },
      { label: "镇国军神", description: "镇国军神，谁言战事，必先称其名。" },
      { label: "天策军神", description: "天策军神，天策府世代供奉的战神。" },
      { label: "九天神将", description: "九天神将，自九天而降的战魂。" },
      { label: "十方神将", description: "十方神将，十方来朝，皆执兵戈。" },
      { label: "天罡战神", description: "天罡战神，天罡三十六之首位。" },
      { label: "北斗战神", description: "北斗战神，执北斗之柄以断兵灾。" },
      { label: "南天战神", description: "南天战神，一怒而南天变色。" },
      { label: "玄天战神", description: "玄天战神，掌玄天兵符。" },
      { label: "紫微神将", description: "紫微神将，紫微星下的兵主神将。" },
    ],
  },
  {
    tier: "神话",
    factor: 1.5,
    ranks: [
      { label: "万军之主", description: "万军之主，一令之下，万军皆动。" },
      { label: "百战之王", description: "百战之王，身临百战而甲不沾尘。" },
      { label: "不败军神", description: "不败军神，凡战必克，史书难书其名。" },
      { label: "无双军神", description: "无双军神，天下无二，古今无对。" },
      { label: "天下第一军神", description: "天下第一军神，此名一出，诸将默然。" },
      { label: "执掌兵戈者", description: "执掌兵戈者，兵戈之气皆归其掌。" },
      { label: "诸天神帅", description: "诸天神帅，统领诸天兵将。" },
      { label: "万古军神", description: "万古军神，万古以来唯一军神。" },
      { label: "兵道之主", description: "兵道之主，兵家之道由其一言而定。" },
      { label: "兵主临世", description: "兵主临世，战神亲临人间，四海兵戈尽息。" },
    ],
  },
];

/**
 * 军衔强度曲线（军衔属性 = 等效等级的角色裸属性 × rate × 大段 factor）
 * - 1 阶「新兵」≈ 2 级角色（刚授衔只是象征性加成）
 * - 满衔 100 阶 ≈ 60 级角色的 0.35 × 1.5 ≈ 52.5%
 * rate 取值：称号 0.3 < 军衔 0.35 < 战魂 0.5（军衔比战魂便宜、比称号强力，靠 100 阶的长度取胜）
 */
export const RANK_GROWTH = {
  /** 1 阶对应的等效角色等级 */
  fromLevel: 2,
  /** 满阶对应的等效角色等级 */
  toLevel: ROLE_MAX_LEVEL,
  /** 属性折扣率（再乘各段 factor） */
  rate: 0.35,
  /** 晋升价格基数：晋到 N 阶消耗 priceBase × N²（与战魂 300、称号 200 同一形态，军衔最便宜） */
  priceBase: 30,
} as const;

/** 军衔总阶数（10 段 × 10 阶 = 100） */
export const RANK_TOTAL = RANK_TIER_ROWS.reduce((total, source) => total + source.ranks.length, 0);

/** 阶 → 等效角色等级（线性映射；**不取整**，见 getEquivalentAttributes 的插值说明） */
function getEquivalentLevel(level: number): number {
  const span = Math.max(1, RANK_TOTAL - 1);
  return RANK_GROWTH.fromLevel + ((level - 1) / span) * (RANK_GROWTH.toLevel - RANK_GROWTH.fromLevel);
}

/**
 * 取「等效等级」上的角色裸属性（**按两侧整数等级线性插值**）
 *
 * ⚠ 这里绝不能把分数等级直接喂给 getRoleLevelAttributes：growth-seed 的分段线性曲线
 * 每段只在自己的 from~to 区间内成立，段与段之间是「跳档」的（第 10 级 262 血、第 11 级 330 血）。
 * 对 10~11 之间的分数等级，sampleGrowth 会拿下一段的斜率从 11 级往回外推，
 * 算出的值比第 10 级还低 —— 实测直接传分数会让军衔 15 阶的攻击从 20 掉回 19（升一阶反而变弱）。
 *
 * 先用整数等级取两侧（整数等级一定是曲线设计内的点，单调不减），再按小数部分插值。
 */
function getEquivalentAttributes(eqLevel: number): ReturnType<typeof getRoleLevelAttributes> {
  const lower = Math.floor(eqLevel);
  const ratio = eqLevel - lower;
  const a = getRoleLevelAttributes(lower);
  const b = getRoleLevelAttributes(lower + 1);
  const mix = (x: number, y: number) => x + (y - x) * ratio;
  const mixRange = (x: [number, number], y: [number, number]): [number, number] => [mix(x[0], y[0]), mix(x[1], y[1])];
  return {
    maxHp: mix(a.maxHp, b.maxHp),
    maxMp: mix(a.maxMp, b.maxMp),
    hpRecover: mix(a.hpRecover, b.hpRecover),
    physicalAttack: mixRange(a.physicalAttack, b.physicalAttack),
    magicAttack: mixRange(a.magicAttack, b.magicAttack),
    taoistAttack: mixRange(a.taoistAttack, b.taoistAttack),
    physicalDefense: mixRange(a.physicalDefense, b.physicalDefense),
    magicDefense: mixRange(a.magicDefense, b.magicDefense),
    taoistDefense: mixRange(a.taoistDefense, b.taoistDefense),
  };
}

/** 把一份角色属性整体打 rate 折（区间上下限一起打折） */
function scaleAttributes(
  base: ReturnType<typeof getRoleLevelAttributes>,
  rate: number,
): Record<string, unknown> {
  const scale = (range: [number, number]): [number, number] => [Math.round(range[0] * rate), Math.round(range[1] * rate)];
  return {
    maxHp: Math.round(base.maxHp * rate),
    // 回血与血量同一口径打折（与 title-seed 一致）
    hpRecover: Math.round(base.hpRecover * rate),
    physicalAttack: scale(base.physicalAttack),
    magicAttack: scale(base.magicAttack),
    taoistAttack: scale(base.taoistAttack),
    physicalDefense: scale(base.physicalDefense),
    magicDefense: scale(base.magicDefense),
    taoistDefense: scale(base.taoistDefense),
  };
}

/** 展开一阶军衔：晋升价格 = priceBase × N²；无动画字段（外观是头顶一行红字） */
export function expandRankSeed(tier: RankTierSeed, rank: { label: string; description: string }, level: number) {
  return {
    level,
    label: rank.label,
    tier: tier.tier,
    description: rank.description,
    bindGold: Math.round(RANK_GROWTH.priceBase * level * level),
    attributes: scaleAttributes(getEquivalentAttributes(getEquivalentLevel(level)), RANK_GROWTH.rate * tier.factor),
  };
}

/** 军衔全量展开（level 从 1 连续到 100，大段的 factor 在同段内一致；seedRanks 直接灌库） */
export const RANK_SEEDS: ReturnType<typeof expandRankSeed>[] = (() => {
  const rows: ReturnType<typeof expandRankSeed>[] = [];
  let level = 1;
  for (const tier of RANK_TIER_ROWS) {
    for (const rank of tier.ranks) {
      rows.push(expandRankSeed(tier, rank, level));
      level += 1;
    }
  }
  return rows;
})();

/** 某阶军衔的属性（键 = 阶数 "1".."100"；runtime-overrides 的出厂回落表） */
export const RANK_LEVEL_ATTRIBUTES: Record<string, Record<string, unknown>> = Object.fromEntries(
  RANK_SEEDS.map((row) => [String(row.level), row.attributes]),
);

/** 军衔大段名清单（弹窗分组与 DTO 校验用；顺序即段序） */
export const RANK_TIERS = RANK_TIER_ROWS.map((tier) => tier.tier);
