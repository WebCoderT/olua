import { Injectable, OnModuleInit } from "@nestjs/common";
import { BizCode } from "../../common/constants/biz-code";
import { BizException } from "../../common/errors/biz.exception";
import { RuntimeParamsRepository } from "../../database/repositories/runtime-params.repository";
import { RuntimeParamsRow } from "../../database/rows";
import { RUNTIME_PARAMS, RuntimeParams } from "../../shared/runtime-seed";
import {
  DropRuntimeParamsDto,
  RuntimeParamsDto,
  UpdateRuntimeParamsDto,
} from "./dto/runtime-params.dto";

/**
 * 客户端运行时参数（#605）
 *
 * 一批原本写死在客户端（`configs/drop.ts` / `configs/autoBattle.ts`）与服务端常量
 * （`common/constants/social.ts` 的帮会长度）里的数值，这里统一成「出厂值 seed 进单行表 →
 * 管理端可改 → 快照下发 → 客户端覆写」。逐项评估的结论是：**除界面文案外全部可配**。
 *
 * ## 读法（为什么每次现读库、不缓存）
 * 与 `GrowthConfigService` 同一取向：`get()` 每次现查。调用方一个是管理端（改完立刻回读），
 * 一个是快照（每次进游戏拉一次），频率都很低；缓存反而要处理失效，得不偿失。
 * 帮会校验每次建帮读一次，量级可忽略。
 *
 * ## 缺键回落
 * 表里存的是「运营改过的键」，读的时候与出厂值逐键合并 —— 于是新增参数不用给存量库
 * 补列、不用写迁移，老库自然拿到新参数的出厂值。JSON 解析失败同样回落（宁可回出厂值，
 * 也不要让一行坏数据把拾取半径变成 0）。
 */
@Injectable()
export class RuntimeParamsService implements OnModuleInit {
  constructor(private readonly repository: RuntimeParamsRepository) {}

  /** 启动 seed（幂等：行已存在则原样保留，运营改过的值不会被覆盖回去） */
  onModuleInit(): void {
    this.repository.seed({
      id: 1,
      drop_params: JSON.stringify(RUNTIME_PARAMS.drop),
      auto_battle: JSON.stringify(RUNTIME_PARAMS.autoBattle),
      guild_rules: JSON.stringify(RUNTIME_PARAMS.guild),
      updated_at: 0,
    });
  }

  /** 当前生效值（管理端读 + 快照下发用；含 updatedAt） */
  get(): RuntimeParamsDto {
    const row = this.repository.get();
    const effective = this.effective(row);
    const dto = new RuntimeParamsDto();
    dto.drop = effective.drop as DropRuntimeParamsDto;
    dto.autoBattle = effective.autoBattle as unknown as RuntimeParamsDto["autoBattle"];
    dto.guild = effective.guild as unknown as RuntimeParamsDto["guild"];
    dto.updatedAt = row?.updated_at ?? 0;
    return dto;
  }

  /** 当前生效值（纯对象，服务端结算 / 校验用 —— 不经 DTO，省掉一层字段拷贝） */
  params(): RuntimeParams {
    return this.effective(this.repository.get());
  }

  /**
   * 部分更新（组可选、组内字段可选）
   *
   * 先与当前生效值合并，再做跨字段校验，通过才落库 —— 先写后验会把被拒的脏值留在库里，
   * 之后所有合法修改都会跟着挂（成长曲线的分段编辑踩过这个坑）。
   */
  update(dto: UpdateRuntimeParamsDto): RuntimeParamsDto {
    const current = this.effective(this.repository.get());
    // **只合并「有值」的键**：DTO 是 class 实例，target=ES2022 的类字段语义会把没提交的字段
    // 定义成 own property = undefined；直接展开会把现值覆盖成 undefined，`JSON.stringify`
    // 再把这些 undefined 丢掉 —— 结果整组回落到出厂值（e2e 抓到的真 bug：改 A 顺手清空了 B）。
    const next: RuntimeParams = {
      drop: { ...current.drop, ...definedOnly(dto.drop) },
      autoBattle: { ...current.autoBattle, ...definedOnly(dto.autoBattle) },
      guild: { ...current.guild, ...definedOnly(dto.guild) },
    };
    // 跨字段：帮会名最短不能超过最长（DTO 只管单字段上下限，管不了这两个的大小关系）
    if (next.guild.nameMin > next.guild.nameMax) {
      throw new BizException(
        BizCode.PARAM_INVALID,
        `帮会名最短 ${next.guild.nameMin} 字大于最长 ${next.guild.nameMax} 字（最短必须 ≤ 最长）`,
      );
    }
    const row: RuntimeParamsRow = {
      id: 1,
      drop_params: JSON.stringify(next.drop),
      auto_battle: JSON.stringify(next.autoBattle),
      guild_rules: JSON.stringify(next.guild),
      updated_at: Date.now(),
    };
    this.repository.update(row);
    return this.get();
  }

  /** 行 + 出厂值 → 生效值（逐键合并，缺键 / 坏行回落出厂） */
  private effective(row: RuntimeParamsRow | undefined): RuntimeParams {
    return {
      drop: mergeGroup(row?.drop_params, RUNTIME_PARAMS.drop),
      autoBattle: mergeGroup(row?.auto_battle, RUNTIME_PARAMS.autoBattle),
      guild: mergeGroup(row?.guild_rules, RUNTIME_PARAMS.guild),
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

/**
 * 一个分组：出厂值打底，用库里的已知键覆盖
 *
 * **只认出厂值里存在的键**（`Object.keys(defaults)` 决定边界）：库里多出来的键会被丢弃 ——
 * 删掉一个参数后，存量行里的残值不该继续生效，也不该让它出现在快照里。
 * 值不是有限数字 / 布尔时也回落出厂（手工改库、旧版本写的坏数据都能自愈）。
 */
function mergeGroup<T extends object>(text: string | undefined, defaults: T): T {
  const merged = { ...defaults };
  if (!text) return merged;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return merged;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return merged;
  const source = parsed as Record<string, unknown>;
  for (const key of Object.keys(defaults) as Array<keyof T & string>) {
    const value = source[key];
    const fallback = defaults[key];
    if (typeof fallback === "boolean") {
      if (typeof value === "boolean") merged[key] = value as T[keyof T & string];
      continue;
    }
    const numeric = Number(value);
    if (Number.isFinite(numeric)) merged[key] = numeric as T[keyof T & string];
  }
  return merged;
}
