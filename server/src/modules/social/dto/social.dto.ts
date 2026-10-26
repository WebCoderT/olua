import { ApiProperty } from "@nestjs/swagger";
import { IsOptional, IsString, Length } from "class-validator";
import { RoleEnemyWithRoleRow, RoleFriendWithRoleRow } from "../../../database/rows";

/** 角色名长度上限（按名加好友/敌人的入参长度；与客户端存档的角色名长度同一档） */
const NAME_MAX = 20;

/**
 * 我这边的一条社交关系（好友 / 敌人都用这一个形状）
 *
 * 为什么三种列表共用一个 DTO：客户端在「好友」「敌人」「附近」三页上画的是同一种行
 * （名字 + 等级 + 操作按钮），字段拆成三套只会让客户端写三份渲染。
 * 差异留给调用方看 `list` 属于哪个字段。
 */
export class SocialEntryDto {
  @ApiProperty({ description: "对方角色 id", example: "role_b2" })
  roleId: string;

  @ApiProperty({ description: "对方角色名", example: "乙二" })
  name: string;

  @ApiProperty({ description: "对方等级", example: 12 })
  level: number;

  @ApiProperty({ description: "对方职业（客户端用它显示职业图标）", example: "1" })
  occupation: string;

  @ApiProperty({
    description: "关系状态：accepted 已互为好友 / pendingIncoming 别人加我（待我处理）/ pendingOutgoing 我加了别人（等对方处理）",
    example: "accepted",
  })
  status: string;

  @ApiProperty({ description: "建立时间（毫秒；待处理的是发起时间）", example: 1760000000000 })
  createdAt: number;
}

/**
 * 我的社交快照（`GET /social/me` 与所有写接口的返回值）
 *
 * 一次给全：好友 / 别人加我 / 我加别人 / 敌人。写接口返回它而不是空，
 * 客户端就不必「操作成功后再拉一次」—— 少一次往返，也不会出现半旧半新的界面。
 *
 * **`myRoleId` 与 `guildId` 是给客户端算关系用的**：互见帧里带的是对方的
 * `roleId` / `guildId`，客户端拿这份快照比一下就知道该给谁上什么颜色
 * （判定放客户端的理由见 client/assets/configs/social.ts 的注释）。
 */
export class MySocialDto {
  @ApiProperty({ description: "我的角色 id", example: "role_a1" })
  myRoleId: string;

  @ApiProperty({ description: "我所在帮会 id（空串 = 没有帮会）", example: "g_1760000000000_ab12" })
  guildId: string;

  @ApiProperty({ description: "我所在帮会名（空串 = 没有帮会）", example: "听雨阁" })
  guildName: string;

  @ApiProperty({ description: "好友（已互为好友）", type: [SocialEntryDto] })
  friends: SocialEntryDto[];

  @ApiProperty({ description: "别人加我、等我处理", type: [SocialEntryDto] })
  incoming: SocialEntryDto[];

  @ApiProperty({ description: "我加别人、等对方处理", type: [SocialEntryDto] })
  outgoing: SocialEntryDto[];

  @ApiProperty({ description: "我标的敌人（单向，对方不知道）", type: [SocialEntryDto] })
  enemies: SocialEntryDto[];

  static fromFriend(row: RoleFriendWithRoleRow, status: string): SocialEntryDto {
    const dto = new SocialEntryDto();
    dto.roleId = row.friend_id;
    dto.name = row.friend_name;
    dto.level = row.friend_level;
    dto.occupation = row.friend_occupation;
    dto.status = status;
    dto.createdAt = row.created_at;
    return dto;
  }

  static fromEnemy(row: RoleEnemyWithRoleRow): SocialEntryDto {
    const dto = new SocialEntryDto();
    dto.roleId = row.enemy_id;
    dto.name = row.enemy_name;
    dto.level = row.enemy_level;
    dto.occupation = row.enemy_occupation;
    dto.status = "enemy";
    dto.createdAt = row.created_at;
    return dto;
  }
}

/**
 * 加好友 / 标敌人的入参
 *
 * **按角色名而不是角色 id**：id 只有服务端与两端存档知道，玩家在游戏里看到的是名字；
 * 也顺手避开了「id 枚举」的探测面（拿不到 id 就没法批量扫人）。
 */
export class SocialTargetDto {
  @ApiProperty({
    description: "对方角色 id（「附近」与帮会成员列表用这个：精确且不受重名影响）",
    example: "role_b2",
    required: false,
  })
  @IsOptional()
  @IsString()
  roleId?: string;

  @ApiProperty({
    description: "对方角色名（手动输入时用；角色名只在同一账号内唯一，重名会返回 50116）",
    example: "乙二",
    required: false,
  })
  @IsOptional()
  @IsString()
  @Length(1, NAME_MAX)
  name?: string;
}
