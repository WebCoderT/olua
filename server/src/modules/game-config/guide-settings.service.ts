import { Injectable, OnModuleInit } from "@nestjs/common";
import { BizCode } from "../../common/constants/biz-code";
import { BizException } from "../../common/errors/biz.exception";
import { GuideSettingsRepository } from "../../database/repositories/guide-settings.repository";
import { GuideSettingsRow } from "../../database/rows";
import { GUIDE_EVENTS, GUIDE_SPOTS, GUIDE_STEP_SEEDS, GUIDE_STEP_MAX, GuideStepSeed } from "../../shared/guide-seed";
import { GuideStepDto, GuideStepsDto, UpdateGuideStepsDto } from "./dto/guide.dto";

/**
 * 新手引导步骤（#605）
 *
 * 引导的**推进逻辑**在客户端（`ui/utils/guide/guide-progress` 是一组纯函数，存档里只存
 * 「走到第几步」），服务端完全不管玩家走到哪。这里只管一件事：**步骤表本身是运营内容**，
 * 该能改 —— 顺序、文案、高亮哪里、什么事件推进。
 *
 * ## 读法
 * `steps()` 每次现读库（与 `RuntimeParamsService` / `CombatWeightsService` 同一取向）：
 * 调用方只有快照（进游戏一次）与管理端（改完回读），频率极低，缓存反而要处理失效。
 *
 * ## 坏数据自愈
 * 存的是 JSON 数组，可能被手改坏。逐行校验（`id` / `title` / `desc` 非空、`spot` / `trigger`
 * 在白名单内），**坏行丢掉、好行留下**；一行都留不下或者 JSON 解析不出来时回落出厂表。
 * 宁可少一步引导，也不要让一行脏数据把玩家挡在 Loading 界面外。
 *
 * ## 保存 = 整份替换
 * 校验放在写库之前（先算结果、再校验、最后落库）：任何一步不合法都不落库 —— 半份步骤表
 * 比整份旧表更难排查（顺序断了、触发事件接不上，玩家会卡在某一步）。
 */
@Injectable()
export class GuideSettingsService implements OnModuleInit {
  constructor(private readonly repository: GuideSettingsRepository) {}

  /** 启动 seed（幂等：行已存在则保留运营改过的整份步骤表） */
  onModuleInit(): void {
    this.repository.seed({
      id: 1,
      steps: JSON.stringify(GUIDE_STEP_SEEDS),
      updated_at: 0,
    });
  }

  /** 当前步骤表（管理端读 + 快照下发用；含 updatedAt） */
  get(): GuideStepsDto {
    const dto = new GuideStepsDto();
    dto.steps = this.steps() as unknown as GuideStepDto[];
    dto.updatedAt = Number(this.repository.get()?.updated_at) || 0;
    return dto;
  }

  /** 当前步骤表（纯数组：配置快照用，不经 DTO） */
  steps(): GuideStepSeed[] {
    return this.effective(this.repository.get());
  }

  /** 整份替换（校验不过 → 40000，且不落库） */
  update(dto: UpdateGuideStepsDto): GuideStepsDto {
    const steps = dto.steps ?? [];
    if (steps.length === 0) {
      throw new BizException(BizCode.PARAM_INVALID, "引导步骤至少要有一步（想关掉引导请用「全部走完」的进度，而不是清空配置）");
    }
    if (steps.length > GUIDE_STEP_MAX) {
      throw new BizException(BizCode.PARAM_INVALID, `引导步骤最多 ${GUIDE_STEP_MAX} 步（当前 ${steps.length} 步）`);
    }
    const seen = new Set<string>();
    for (const [index, step] of steps.entries()) {
      // DTO 已经卡过取值域与长度，这里只补两件它管不了的事：id 唯一、枚举值真的在白名单里
      // （白名单校验在 DTO 上，逐行报「第几步错了」比 nest 的数组报错更好定位）
      if (seen.has(step.id)) {
        throw new BizException(BizCode.PARAM_INVALID, `第 ${index + 1} 步的标识「${step.id}」重复了（标识要唯一）`);
      }
      seen.add(step.id);
      if (!(GUIDE_SPOTS as readonly string[]).includes(step.spot)) {
        throw new BizException(BizCode.PARAM_INVALID, `第 ${index + 1} 步的高亮位「${step.spot}」不在客户端支持的范围内`);
      }
      if (!(GUIDE_EVENTS as readonly string[]).includes(step.trigger)) {
        throw new BizException(BizCode.PARAM_INVALID, `第 ${index + 1} 步的推进事件「${step.trigger}」不在客户端支持的范围内`);
      }
    }
    const row: GuideSettingsRow = {
      id: 1,
      steps: JSON.stringify(steps.map(toSeed)),
      updated_at: Date.now(),
    };
    this.repository.update(row);
    return this.get();
  }

  /** 行 → 生效步骤表（坏行丢弃、整份坏掉回落出厂） */
  private effective(row: GuideSettingsRow | undefined): GuideStepSeed[] {
    if (!row) return GUIDE_STEP_SEEDS.map(toSeed);
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.steps);
    } catch {
      return GUIDE_STEP_SEEDS.map(toSeed);
    }
    if (!Array.isArray(parsed)) return GUIDE_STEP_SEEDS.map(toSeed);
    const steps = parsed.filter(isValidStep).map(toSeed);
    return steps.length > 0 ? steps : GUIDE_STEP_SEEDS.map(toSeed);
  }
}

/** 一步是否可用（库里可能被手改坏：缺字段 / 枚举值不认识 / 文案空） */
function isValidStep(input: unknown): input is GuideStepSeed {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const step = input as Record<string, unknown>;
  if (typeof step.id !== "string" || !step.id.trim()) return false;
  if (typeof step.title !== "string" || !step.title.trim()) return false;
  if (typeof step.desc !== "string" || !step.desc.trim()) return false;
  if (!(GUIDE_SPOTS as readonly string[]).includes(step.spot as string)) return false;
  return (GUIDE_EVENTS as readonly string[]).includes(step.trigger as string);
}

/**
 * 只取五个字段（多出来的键不往下传：形状由 seed 定义）
 *
 * 入参用「字段类型放宽」的写法：调用它的两处一个来自 DTO（`spot` 是 `string`）、
 * 一个来自库里的 JSON（`unknown` 已过白名单校验）—— 双方都只保证「有这五个值」，
 * 字面量联合类型在这里没有额外价值。
 */
function toSeed(step: { id: string; title: string; desc: string; spot: string; trigger: string }): GuideStepSeed {
  return {
    id: step.id,
    title: step.title,
    desc: step.desc,
    spot: step.spot as GuideStepSeed["spot"],
    trigger: step.trigger as GuideStepSeed["trigger"],
  };
}
