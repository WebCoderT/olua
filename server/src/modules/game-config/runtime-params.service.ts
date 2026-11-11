import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { BizCode } from "../../common/constants/biz-code";
import {
  AutoBattleParams,
  DropRuntimeParams,
  GuildRuleParams,
  MonsterAiRuntimeParams,
  MovementGuardParams,
  RUNTIME_PARAM_KEYS,
  RuntimeParams,
} from "../../common/constants/runtime-params";
import { BizException } from "../../common/errors/biz.exception";
import { RuntimeParamsRepository } from "../../database/repositories/runtime-params.repository";
import { RuntimeParamsRow } from "../../database/rows";
import {
  DropRuntimeParamsDto,
  RuntimeParamsDto,
  UpdateMonsterAiParamsDto,
  UpdateMovementGuardParamsDto,
  UpdateRuntimeParamsDto,
} from "./dto/runtime-params.dto";

/**
 * 客户端运行时参数（#605 / #655）
 *
 * 一批原本写死在客户端（`configs/drop.ts` / `configs/autoBattle.ts`）与服务端常量
 * （`common/constants/social.ts` 的帮会长度）里的数值，现在统一住在 `runtime_params`
 * 单行表：管理端可改 → 快照下发 → 客户端覆写。逐项评估的结论是「除界面文案外全部可配」。
 *
 * ## 读法（为什么每次现读库、不缓存）
 * 调用方一个是管理端（改完立刻回读），一个是快照（每次进游戏拉一次），频率都很低；
 * 缓存反而要处理失效，得不偿失。帮会校验每次建帮读一次，量级可忽略。
 *
 * ## #655：不再有「缺键回落出厂值」
 * 以前读的时候与 `config-sync.sql` 的出厂值逐键合并 —— 那份常量是「代码里的第二份
 * 数值」，与库冲突时永远说不清谁是权威。现在库里有什么就是什么；键不全由启动自检
 * （`onApplicationBootstrap`）点名报错，而不是静默补一个默认值（那会让「配漏了」看起来
 * 像「配了」）。
 */
@Injectable()
export class RuntimeParamsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RuntimeParamsService.name);

  constructor(private readonly repository: RuntimeParamsRepository) {}

  /** 启动自检：三个分组的键必须齐全（缺了就报出来，不补默认值） */
  onApplicationBootstrap(): void {
    const row = this.repository.get();
    if (!row) {
      this.logger.error("runtime_params 没有行（id = 1）—— 掉落 / 自动战斗 / 帮会门槛全部无值。跑 make config-import");
      return;
    }
    const parsed = this.parseAll(row);
    for (const group of Object.keys(RUNTIME_PARAM_KEYS) as Array<keyof RuntimeParams>) {
      const values = parsed[group] as unknown as Record<string, unknown>;
      const missing = RUNTIME_PARAM_KEYS[group].filter((key) => values[key] === undefined);
      if (missing.length > 0) {
        this.logger.error(`runtime_params.${group} 缺这些键：${missing.join(", ")}（客户端会拿到 undefined）`);
      }
    }
  }

  /** 当前生效值（管理端读 + 快照下发用；含 updatedAt） */
  get(): RuntimeParamsDto {
    const row = this.repository.get();
    const effective = this.parseAll(row);
    const dto = new RuntimeParamsDto();
    dto.drop = effective.drop as unknown as DropRuntimeParamsDto;
    dto.autoBattle = effective.autoBattle as unknown as RuntimeParamsDto["autoBattle"];
    dto.guild = effective.guild as unknown as RuntimeParamsDto["guild"];
    dto.updatedAt = row?.updated_at ?? 0;
    return dto;
  }

  /** 当前生效值（纯对象，服务端结算 / 校验用 —— 不经 DTO，省掉一层字段拷贝） */
  params(): RuntimeParams {
    return this.parseAll(this.repository.get());
  }

  /**
   * 部分更新（组可选、组内字段可选）
   *
   * 先与当前生效值合并，再做跨字段校验，通过才落库 —— 先写后验会把被拒的脏值留在库里，
   * 之后所有合法修改都会跟着挂。
   */
  update(dto: UpdateRuntimeParamsDto): RuntimeParamsDto {
    const current = this.parseAll(this.repository.get());
    // **只合并「有值」的键**：DTO 是 class 实例，target=ES2022 的类字段语义会把没提交的字段
    // 定义成 own property = undefined；直接展开会把现值覆盖成 undefined，`JSON.stringify`
    // 再把这些 undefined 丢掉 —— 结果整组丢键（e2e 抓到的真 bug：改 A 顺手清空了 B）。
    const next: RuntimeParams = {
      drop: { ...current.drop, ...definedOnly(dto.drop) } as DropRuntimeParams,
      autoBattle: { ...current.autoBattle, ...definedOnly(dto.autoBattle) } as AutoBattleParams,
      guild: { ...current.guild, ...definedOnly(dto.guild) } as GuildRuleParams,
    };
    // 跨字段：帮会名最短不能超过最长（DTO 只管单字段上下限，管不了这两个的大小关系）
    if (next.guild.nameMin > next.guild.nameMax) {
      throw new BizException(
        BizCode.PARAM_INVALID,
        `帮会名最短 ${next.guild.nameMin} 字大于最长 ${next.guild.nameMax} 字（最短必须 ≤ 最长）`,
      );
    }
    const existing = this.repository.get();
    const row: RuntimeParamsRow = {
      id: 1,
      drop_params: JSON.stringify(next.drop),
      auto_battle: JSON.stringify(next.autoBattle),
      guild_rules: JSON.stringify(next.guild),
      // 怪物 AI 不在这套 DTO 里（它归怪物域，没有管理端页面）—— 原样保留，
      // 否则「改掉落参数」会顺手把这一列写成 '{}'（`update` 是整行 UPDATE）
      monster_ai: existing?.monster_ai ?? "{}",
      // 位移校验同上（#811）：它有自己的两条接口，改三组参数不该动它
      movement: existing?.movement ?? "{}",
      updated_at: Date.now(),
    };
    this.repository.update(row);
    return this.get();
  }

  /**
   * 怪物 AI 参数（`monster_ai` 列；#853 / #854 起有管理端入口）
   *
   * 返回原样 JSON（不补默认值）：缺键由 AI 服务自己 warn 并用最小可用值兜住 ——
   * 这里补一份默认值就成了「代码里的第二份出厂值」，与那一列的权威定值打架。
   */
  monsterAi(): MonsterAiRuntimeParams {
    return parseGroup(this.repository.get()?.monster_ai) as unknown as MonsterAiRuntimeParams;
  }

  /**
   * 更新怪物 AI 参数（部分更新；与三组共用一行的 `update` 分开）
   *
   * 合并规则与 `update` 一样用 `definedOnly`：DTO 实例没提交的字段是 `undefined`，
   * 直接展开会把现值清掉。落库时**另外三列必须原样写回** —— `update` 是整行 UPDATE。
   */
  updateMonsterAi(dto: UpdateMonsterAiParamsDto): MonsterAiRuntimeParams {
    const existing = this.repository.get();
    const current = parseGroup(existing?.monster_ai);
    const patch = definedOnly(dto);
    const next = { ...current, ...patch } as Record<string, unknown>;

    // 跨字段：区间两端、牵引半径与普攻距离的大小关系（DTO 只管单字段上下限）
    assertRange(next.idleMoveInterval, "待机游走间隔");
    assertRange(next.idleMoveDuration, "待机游走时长");
    const attackRange = Number(next.attackRange);
    const leashRange = Number(next.leashRange);
    if (Number.isFinite(attackRange) && Number.isFinite(leashRange) && leashRange <= attackRange) {
      throw new BizException(
        BizCode.PARAM_INVALID,
        `牵引半径 ${leashRange}px 必须大于普攻距离 ${attackRange}px（否则怪刚看见人就脱战）`,
      );
    }

    const row: RuntimeParamsRow = {
      id: 1,
      // 三列原样保留：这一行的形状由 config-sync.sql 定义，改 AI 参数不该顺手重写别组
      drop_params: existing?.drop_params ?? "{}",
      auto_battle: existing?.auto_battle ?? "{}",
      guild_rules: existing?.guild_rules ?? "{}",
      monster_ai: JSON.stringify(next),
      // 位移校验那一列原样写回（同一条整行 UPDATE 的纪律）
      movement: existing?.movement ?? "{}",
      updated_at: Date.now(),
    };
    this.repository.update(row);
    return this.monsterAi();
  }

  /**
   * 位移校验参数（`movement` 列，#811）
   *
   * 与 `monsterAi()` 同一取向：**原样返回**（缺键不补），兜底由消费方
   * `MovementGuardService` 做 —— 这里补一份等于「代码里的第二份出厂值」。
   */
  movement(): MovementGuardParams {
    return parseGroup(this.repository.get()?.movement) as unknown as MovementGuardParams;
  }

  /**
   * 更新位移校验参数（部分更新；与三组、与怪物 AI 都分开）
   *
   * 合并用 `definedOnly`（DTO 实例没提交的字段是 `undefined`），落库时**其余五列原样写回**。
   * 档位拼错由 DTO 的 `@IsIn` 直接挡住（不会静默落一个不认识的档位进库）。
   */
  updateMovement(dto: UpdateMovementGuardParamsDto): MovementGuardParams {
    const existing = this.repository.get();
    const current = parseGroup(existing?.movement);
    const next = { ...current, ...definedOnly(dto) } as Record<string, unknown>;
    // 跨字段：容差不能小于 1（比上限还严 = 正常移动全被拒），抖动非负 —— DTO 已管单字段，这里防手改库
    const tolerance = Number(next.tolerance);
    if (Number.isFinite(tolerance) && tolerance < 1) {
      throw new BizException(BizCode.PARAM_INVALID, `容差倍率 ${tolerance} 小于 1：比速度上限还严，正常移动会被整片误判`);
    }
    const row: RuntimeParamsRow = {
      id: 1,
      drop_params: existing?.drop_params ?? "{}",
      auto_battle: existing?.auto_battle ?? "{}",
      guild_rules: existing?.guild_rules ?? "{}",
      monster_ai: existing?.monster_ai ?? "{}",
      movement: JSON.stringify(next),
      updated_at: Date.now(),
    };
    this.repository.update(row);
    return this.movement();
  }

  /** 三列 JSON → 生效值（坏 JSON 当空对象；缺键就是缺键，不补默认值） */
  private parseAll(row: RuntimeParamsRow | undefined): RuntimeParams {
    return {
      drop: parseGroup(row?.drop_params) as unknown as DropRuntimeParams,
      autoBattle: parseGroup(row?.auto_battle) as unknown as AutoBattleParams,
      guild: parseGroup(row?.guild_rules) as unknown as GuildRuleParams,
    };
  }
}

/** 去掉值为 undefined 的键（见 `update` 里的说明：DTO 实例的空字段会覆盖现值） */
function definedOnly<T extends object>(value: T | undefined): Partial<T> {
  const out: Partial<T> = {};
  if (!value) return out;
  for (const key of Object.keys(value) as Array<keyof T>) {
    if (value[key] !== undefined) out[key] = value[key];
  }
  return out;
}

/** 区间类参数必须是「两个有限数字且 min ≤ max」（怪物 AI 的两组区间用它） */
function assertRange(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length < 2) {
    throw new BizException(BizCode.PARAM_INVALID, `${label}必须是「[最小, 最大]」两个数`);
  }
  const min = Number(value[0]);
  const max = Number(value[1]);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max < min) {
    throw new BizException(BizCode.PARAM_INVALID, `${label}的区间不合法（最小 ${min} / 最大 ${max}）`);
  }
}

/** 解析一列 JSON 对象（坏数据 / 空列 → 空对象） */
function parseGroup(text: string | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
