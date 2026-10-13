import { ApiProperty } from "@nestjs/swagger";
import { RoleRow, RoleWithAccountRow } from "../../../database/rows";
import { compareRoleAttributes } from "../../combat/role-attribute-comparison";
import { decodeStoredRoleData } from "../role-data.util";

/** 角色概要（列表接口用：不含 data，体量小；画选角列表只需要这几项） */
export class RoleSummaryDto {
  @ApiProperty({ description: "角色 id" })
  id: string;

  @ApiProperty({ description: "所属账号 id" })
  accountId: string;

  @ApiProperty({ description: "角色名" })
  name: string;

  @ApiProperty({ description: "职业：1 战士 / 2 魔法师 / 3 道士 / 4 全职业" })
  occupation: string;

  @ApiProperty({ description: "性别：1 男 / 2 女 / 3 全性别" })
  sex: string;

  @ApiProperty({ description: "等级" })
  level: number;

  @ApiProperty({ description: "是否当前选中（在线）角色" })
  online: boolean;

  /**
   * 修订号（乐观锁）
   *
   * 客户端保存进度时把它读到的值带回来（`SaveRoleDto.revision`），
   * 对不上说明角色在别处（管理端）被改过 → 服务端拒收并让客户端先拉最新数据。
   */
  @ApiProperty({ description: "修订号（每次落库 +1；客户端保存进度时带上它做乐观锁）" })
  revision: number;

  @ApiProperty({ description: "创建时间（毫秒）" })
  createdAt: number;

  @ApiProperty({ description: "最近更新时间（毫秒）" })
  updatedAt: number;

  static from(row: RoleRow, onlineRoleId: string | null): RoleSummaryDto {
    const dto = new RoleSummaryDto();
    dto.id = row.id;
    dto.accountId = row.account_id;
    dto.name = row.name;
    dto.occupation = row.occupation;
    dto.sex = row.sex;
    dto.level = row.level;
    dto.online = onlineRoleId === row.id;
    dto.revision = row.revision;
    dto.createdAt = row.created_at;
    dto.updatedAt = row.updated_at;
    return dto;
  }
}

/** 角色完整信息（详情 / 创建 / 保存 / 选中 的返回；data 是客户端 entities/Role 的完整快照） */
export class RoleDto extends RoleSummaryDto {
  @ApiProperty({
    description: "角色完整数据（客户端 entities/Role 的 JSON 快照，服务端按不透明文档存取；管理端只编辑其中的常用字段）",
    type: "object",
    additionalProperties: true,
  })
  data: Record<string, unknown>;

  static from(row: RoleRow, onlineRoleId: string | null): RoleDto {
    const dto = new RoleDto();
    Object.assign(dto, RoleSummaryDto.from(row, onlineRoleId));
    dto.data = decodeStoredRoleData(row.data);
    return dto;
  }
}

/** 管理端列表里的角色（额外带所属账号名） */export class AdminRoleDto extends RoleDto {
  @ApiProperty({ description: "所属账号名", type: "string", nullable: true })
  accountName: string | null;

  static fromRow(row: RoleWithAccountRow, onlineRoleId: string | null): AdminRoleDto {
    const dto = new AdminRoleDto();
    Object.assign(dto, RoleDto.from(row, onlineRoleId));
    dto.accountName = row.account_name;
    return dto;
  }
}

/** 服务端重算出的那八项战斗属性 + 战斗力 */
export class RoleDerivedAttributesDto {
  @ApiProperty({ description: "最大生命值" })
  maxHp: number;

  @ApiProperty({ description: "每秒生命回复（点/秒）" })
  hpRecover: number;

  @ApiProperty({ description: "最大魔法值（只跟等级走，装备不影响）" })
  maxMp: number;

  @ApiProperty({ description: "物理攻击 [下限, 上限]", type: [Number] })
  physicalAttack: [number, number];

  @ApiProperty({ description: "魔法攻击 [下限, 上限]", type: [Number] })
  magicAttack: [number, number];

  @ApiProperty({ description: "道术攻击 [下限, 上限]", type: [Number] })
  taoistAttack: [number, number];

  @ApiProperty({ description: "物理防御 [下限, 上限]", type: [Number] })
  physicalDefense: [number, number];

  @ApiProperty({ description: "魔法防御 [下限, 上限]", type: [Number] })
  magicDefense: [number, number];

  @ApiProperty({ description: "道术防御 [下限, 上限]", type: [Number] })
  taoistDefense: [number, number];

  @ApiProperty({ description: "战斗力（八项按配置权重加权求和）" })
  combat: number;
}

/** 存档里**客户端上报**的那一份（与服务端重算值对照着看） */
export class RoleReportedAttributesDto {
  @ApiProperty({ description: "存档里客户端上报的战斗力；没有或不是数字就是 null", type: "number", nullable: true })
  combat: number | null;

  @ApiProperty({ description: "存档里客户端上报的最大生命值；没有或不是数字就是 null", type: "number", nullable: true })
  maxHp: number | null;
}

/**
 * 派生字段：服务端重算的战斗属性（**不在库里，每次读的时候现算**）
 *
 * 为什么要跟客户端上报的那份一起给出：服务端算的不一定「对」——
 * 玩家在升级与重算之间存档时，客户端那份才是旧的。这里只把两份摆出来，
 * **判定权交给看的人**，不做自动纠正（详见 combat/role-attribute-comparison 的文件头）。
 */
export class RoleDerivedDto {
  @ApiProperty({
    description: "服务端按存档输入现算的战斗属性；等级不在成长曲线里时为 null（服务端无处可取旧值，静默给 0 会被读成「算过了、结果就是 0」）",
    type: RoleDerivedAttributesDto,
    nullable: true,
  })
  attributes: RoleDerivedAttributesDto | null;

  @ApiProperty({ description: "存档里客户端上报的那份（对照用）", type: RoleReportedAttributesDto })
  reported: RoleReportedAttributesDto;

  @ApiProperty({
    description:
      "两份对不上（口径不一致）。不等于作弊 —— 玩家在升级与重算之间存档也会命中；客户端配置漂移、存档留着旧装备 id 同样会命中。它只表示「这里值得看一眼」",
  })
  mismatch: boolean;

  @ApiProperty({ description: "这次到底比成了没有（false = 服务端算不出来，此时 mismatch 无意义）" })
  comparable: boolean;

  @ApiProperty({ description: "查不到属性的装备 id（客户端删了装备 / 存档留着旧 id 时命中，属性会悄悄少一截）", type: [String] })
  unknownEquipmentIds: string[];

  /**
   * 从「索引列的等级 + 已解码的存档」算派生字段
   *
   * 等级取**索引列**（`roles.level`）而不是存档里的 `data.level`：那一列是服务端维护的、
   * 管理端改动也会同步过去的权威值；存档里的那份是客户端写的。
   */
  static from(level: number, data: Record<string, unknown>): RoleDerivedDto {
    const comparison = compareRoleAttributes(
      {
        level,
        equipments: asEquipmentMap(data.equipments),
        soulOfWar: numberOrUndefined(data.soulOfWar),
        title: numberOrUndefined(data.title),
        rank: numberOrUndefined(data.rank),
      },
      { combat: data.combat, maxHp: data.maxHp },
    );

    const dto = new RoleDerivedDto();
    dto.attributes = comparison.server;
    dto.reported = { combat: comparison.reported.combat, maxHp: comparison.reported.maxHp };
    dto.mismatch = comparison.mismatch;
    dto.comparable = comparison.comparable;
    dto.unknownEquipmentIds = comparison.unknownEquipmentIds;
    return dto;
  }
}

/**
 * 管理端**详情**里的角色（比列表多一组派生字段）
 *
 * 为什么列表不带：列表页不展示战斗力，给它算就是白算；而且列表已经带着完整 `data`，
 * 再加一份重算是让响应无谓变胖（详见 issue #93）。
 */
export class AdminRoleDetailDto extends AdminRoleDto {
  @ApiProperty({ description: "服务端重算的战斗属性（派生字段：不在库里，每次读现算）", type: RoleDerivedDto })
  derived: RoleDerivedDto;

  static fromRow(row: RoleWithAccountRow, onlineRoleId: string | null): AdminRoleDetailDto {
    const dto = new AdminRoleDetailDto();
    Object.assign(dto, AdminRoleDto.fromRow(row, onlineRoleId));
    dto.derived = RoleDerivedDto.from(row.level, decodeStoredRoleData(row.data));
    return dto;
  }
}

//#region 派生字段的取值小工具

/** 存档里的装备表（槽位 → 装备 id）；形状不对就当没穿（与汇总函数的容错一致） */
function asEquipmentMap(value: unknown): Record<string, string | null> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, string | null>;
}

/** 取一个有限数字；不是数字（undefined / 字符串 / NaN）时返回 undefined（交回汇总函数按「未激活」处理） */
function numberOrUndefined(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

//#endregion
