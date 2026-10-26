import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiPlayerDoc } from "../../common/decorators/api-doc.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { AuthenticatedUser } from "../../common/interfaces/api-envelope.interface";
import { MySocialDto, SocialTargetDto } from "./dto/social.dto";
import { SocialService } from "./social.service";

/**
 * 客户端 · 社交（#389：好友与敌人）
 *
 * 全部以**令牌里的账号**为准，落到该账号的在线角色上；请求体里的 `roleId` 只是**目标**。
 *
 * 写接口统一返回最新的「我的社交快照」（`MySocialDto`）—— 与帮会同一口径：
 * 客户端一次刷新到位，不会出现「加成功了但列表还是空的」。
 *
 * **关系判定不在这里**：服务端只给原料（我的好友/敌人/帮会 + 对方的 roleId/guildId），
 * 优先级与配色在客户端 `configs/social.ts` 一处（避免为每个观看者算一遍 O(n²)）。
 */
@Controller("social")
export class SocialController {
  constructor(private readonly socialService: SocialService) {}

  @Get("me")
  @ApiPlayerDoc({
    operationId: "social.mine",
    summary: "我的社交快照",
    description:
      "好友（已互为好友）/ 别人加我（待我处理）/ 我加别人（等对方处理）/ 我标的敌人，" +
      "外加我的角色 id 与所在帮会 —— 客户端拿它与互见帧里的 `roleId`/`guildId` 比对，" +
      "算出该给谁上什么颜色的名字。",
  })
  @ApiDataResponse(MySocialDto, { description: "我的社交快照" })
  mine(@CurrentUser() user: AuthenticatedUser): MySocialDto {
    return this.socialService.mine(user.id);
  }

  @Post("friends")
  @HttpCode(HttpStatus.OK)
  @ApiPlayerDoc({
    operationId: "social.addFriend",
    summary: "加好友",
    description:
      "传 `roleId`（精确）或 `name`（手动输入；角色名只在同一账号内唯一，重名返回 50116）。\n\n" +
      "**对方也在等我时直接当同意**，不用再点一次「同意」。失败：50109 找不到人 / 50110 不能加自己 / " +
      "50111 已是好友或已有待处理申请 / 50115 好友数量上限。",
  })
  @ApiDataResponse(MySocialDto, { description: "操作后的我的社交快照" })
  addFriend(@CurrentUser() user: AuthenticatedUser, @Body() dto: SocialTargetDto): MySocialDto {
    return this.socialService.addFriend(user.id, dto);
  }

  @Post("friends/:roleId/accept")
  @HttpCode(HttpStatus.OK)
  @ApiPlayerDoc({
    operationId: "social.acceptFriend",
    summary: "同意好友申请",
    description: "只有「他发起、等我处理」的申请能同意；已处理过的返回 50112。",
  })
  @ApiParam({ name: "roleId", description: "申请人的角色 id" })
  @ApiDataResponse(MySocialDto, { description: "操作后的我的社交快照" })
  acceptFriend(@CurrentUser() user: AuthenticatedUser, @Param("roleId") roleId: string): MySocialDto {
    return this.socialService.acceptFriend(user.id, roleId);
  }

  @Post("friends/:roleId/reject")
  @HttpCode(HttpStatus.OK)
  @ApiPlayerDoc({
    operationId: "social.rejectFriend",
    summary: "拒绝好友申请",
    description: "直接删掉这一对关系，不留记录（被拒的人看不到「你被拒绝了」）。",
  })
  @ApiParam({ name: "roleId", description: "申请人的角色 id" })
  @ApiDataResponse(MySocialDto, { description: "操作后的我的社交快照" })
  rejectFriend(@CurrentUser() user: AuthenticatedUser, @Param("roleId") roleId: string): MySocialDto {
    return this.socialService.rejectFriend(user.id, roleId);
  }

  @Delete("friends/:roleId")
  @ApiPlayerDoc({
    operationId: "social.removeFriend",
    summary: "删除好友 / 撤回申请",
    description:
      "**双向消失**：我这边删掉，他那边也不再是好友（不需要对方同意）。\n\n" +
      "也用于撤回自己发出的申请、或拒绝别人加我 —— 三种情况都只是「删掉这一对关系」，" +
      "所以共用同一个接口；真正没有这段关系时返回 50112。",
  })
  @ApiParam({ name: "roleId", description: "对方的角色 id" })
  @ApiDataResponse(MySocialDto, { description: "操作后的我的社交快照" })
  removeFriend(@CurrentUser() user: AuthenticatedUser, @Param("roleId") roleId: string): MySocialDto {
    return this.socialService.removeFriend(user.id, roleId);
  }

  @Post("enemies")
  @HttpCode(HttpStatus.OK)
  @ApiPlayerDoc({
    operationId: "social.addEnemy",
    summary: "标为敌人",
    description:
      "**单向**：只有我自己看得见（互见时对方名字变红），对方既不知道也不受影响。\n\n" +
      "入参同加好友（`roleId` 或 `name`）。重复标记返回 50113。",
  })
  @ApiDataResponse(MySocialDto, { description: "操作后的我的社交快照" })
  addEnemy(@CurrentUser() user: AuthenticatedUser, @Body() dto: SocialTargetDto): MySocialDto {
    return this.socialService.addEnemy(user.id, dto);
  }

  @Delete("enemies/:roleId")
  @ApiPlayerDoc({
    operationId: "social.removeEnemy",
    summary: "解除敌人",
    description: "解除我自己标的敌人；本来就没标返回 50114。",
  })
  @ApiParam({ name: "roleId", description: "对方的角色 id" })
  @ApiDataResponse(MySocialDto, { description: "操作后的我的社交快照" })
  removeEnemy(@CurrentUser() user: AuthenticatedUser, @Param("roleId") roleId: string): MySocialDto {
    return this.socialService.removeEnemy(user.id, roleId);
  }
}
