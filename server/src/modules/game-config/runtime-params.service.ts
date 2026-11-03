import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { BizCode } from "../../common/constants/biz-code";
import {
  AutoBattleParams,
  DropRuntimeParams,
  GuildRuleParams,
  RUNTIME_PARAM_KEYS,
  RuntimeParams,
} from "../../common/constants/runtime-params";
import { BizException } from "../../common/errors/biz.exception";
import { RuntimeParamsRepository } from "../../database/repositories/runtime-params.repository";
import { RuntimeParamsRow } from "../../database/rows";
import {
  DropRuntimeParamsDto,
  RuntimeParamsDto,
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
      updated_at: Date.now(),
    };
    this.repository.update(row);
    return this.get();
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
