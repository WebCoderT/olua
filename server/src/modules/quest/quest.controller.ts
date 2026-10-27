import { Body, Controller, Get, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiPlayerDoc } from "../../common/decorators/api-doc.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { AuthenticatedUser } from "../../common/interfaces/api-envelope.interface";
import {
  MyQuestsDto,
  NpcTalkDto,
  NpcTalkResultDto,
  QuestIdDto,
  QuestSubmitResultDto,
} from "./dto/quest-state.dto";
import { QuestService } from "./quest.service";

/**
 * 客户端 · 任务（#396）
 *
 * 全部以**令牌里的账号**为准，落到该账号的在线角色上。**结算权威在服务端**：
 * 这里只有「接 / 交 / 对话 / 查」四个动作，没有任何「上报进度」的口子 ——
 * kill 由 realtime 击杀结算推进、talk 由 npc-talk 推进、collect 交付时查背包。
 */
@Controller("quests")
export class QuestController {
  constructor(private readonly questService: QuestService) {}

  @Get("me")
  @ApiPlayerDoc({
    operationId: "quest.mine",
    summary: "我的任务快照",
    description:
      "当前角色的全部进度行（accepted / ready / claimed）。**可接任务不在内**：" +
      "客户端按配置快照（quests）与 claimed 行自己算「哪些能接」（等级 / 前置链都是纯读计算）。",
  })
  @ApiDataResponse(MyQuestsDto, { description: "我的任务快照" })
  mine(@CurrentUser() user: AuthenticatedUser): MyQuestsDto {
    return this.questService.mine(user.id);
  }

  @Post("accept")
  @HttpCode(HttpStatus.OK)
  @ApiPlayerDoc({
    operationId: "quest.accept",
    summary: "接取任务",
    description:
      "等级（20016）与主线链前置（20015）在服务端复核；重复接取（含已完成的主线）返回 20015。" +
      "接取成功返回最新快照。",
  })
  @ApiDataResponse(MyQuestsDto, { description: "接取后的任务快照" })
  accept(@CurrentUser() user: AuthenticatedUser, @Body() dto: QuestIdDto): MyQuestsDto {
    return this.questService.accept(user.id, dto.questId);
  }

  @Post("submit")
  @HttpCode(HttpStatus.OK)
  @ApiPlayerDoc({
    operationId: "quest.submit",
    summary: "交付任务并领奖",
    description:
      "kill/talk 要先到 ready（进度满）；collect 直接查背包 —— 材料不足 20017、" +
      "奖励物品放不下背包 20012（进度行保持原状，补齐后可再来）。" +
      "发奖（金币 / 经验 / 物品）与扣材料**一次落库**；日常（daily）领奖后删行可重接，" +
      "主线（main）保留 claimed 行作链门控。返回最新快照与奖励结算。",
  })
  @ApiDataResponse(QuestSubmitResultDto, { description: "交付结果（快照 + 奖励结算）" })
  submit(@CurrentUser() user: AuthenticatedUser, @Body() dto: QuestIdDto): QuestSubmitResultDto {
    return this.questService.submit(user.id, dto.questId);
  }

  @Post("npc-talk")
  @HttpCode(HttpStatus.OK)
  @ApiPlayerDoc({
    operationId: "quest.npcTalk",
    summary: "与 NPC 对话",
    description:
      "talk 型目标的进度入口：推进进行中的对话任务（到量转 ready）；同时带回该 NPC 名下" +
      "全部任务的状态（含可接但未接的 `available`）与管理端配置的对话文案。" +
      "NPC 不存在返回 50020。",
  })
  @ApiDataResponse(NpcTalkResultDto, { description: "对话结果（文案 + 任务状态）" })
  npcTalk(@CurrentUser() user: AuthenticatedUser, @Body() dto: NpcTalkDto): NpcTalkResultDto {
    return this.questService.npcTalk(user.id, dto.npcId);
  }
}
