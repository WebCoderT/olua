import { Controller, Get } from "@nestjs/common";
import { ApiDataResponse } from "../../common/decorators/api-data-response.decorator";
import { ApiPlayerDoc } from "../../common/decorators/api-doc.decorator";
import { ClientConfigService } from "./client-config.service";
import { EquipAlignService } from "./equip-align.service";
import { EquipInAlignService } from "./equip-in-align.service";
import { GameConfigSnapshotDto } from "./dto/client-config.dto";
import { EquipAlignListDto } from "./dto/equip-align.dto";
import { EquipInAlignListDto } from "./dto/equip-in-align.dto";

/**
 * 客户端 · 配置快照
 *
 * 管理端改的运营配置要真实生效：客户端进游戏拉一次这份快照存内存，
 * 本地 configs 的数据读取函数优先用它、缺省回落本地静态数据。
 * 掉落 / 经验 / 升级 / 购买等**行为的权威在服务端接口**，快照只解决「读同源」。
 */
@Controller("game-config")
export class ClientConfigController {
  constructor(
    private readonly clientConfig: ClientConfigService,
    private readonly equipAlign: EquipAlignService,
    private readonly equipInAlign: EquipInAlignService,
  ) {}

  @Get()
  @ApiPlayerDoc({
    operationId: "gameConfig.snapshot",
    summary: "玩家侧配置快照",
    description:
      "管理端可改的全部运营配置一次下发（称号 / 战魂 / 军衔 / 装备 / 药品 / 物品 / 怪物 / NPC / 时装 / " +
      "升级经验 / 成长曲线与标量 / 商城定价 / 掉落表）。\n\n" +
      "形状与管理端列表接口一致（camelCase）。需要玩家令牌（配置属于玩法数据，不开放给未登录请求）。\n\n" +
      "**注意**：装备外观的几何（位置 / 缩放）**不在**这份快照里 —— 它不受" +
      "「只覆写管理端能改的数值字段」这条约束，走下面的 `GET /game-config/equip-align` 单独下发。",
  })
  @ApiDataResponse(GameConfigSnapshotDto, { description: "全部运营配置快照" })
  snapshot(): GameConfigSnapshotDto {
    return this.clientConfig.snapshot();
  }

  /**
   * 装备外观几何（#513）
   *
   * **为什么单开一个接口而不是塞进快照**：快照的纪律是「只覆写管理端能改的数值字段，
   * 资源路径与几何一律不覆写」（见 `configs/apply-snapshot` 的说明）。装备对齐打破的正是后半句，
   * 但只打破这一处、且是显式的一处 —— 塞进快照会让那条注释变成谎话，下一个人读代码时会照它办。
   *
   * 量很小（33 行上下），失败也不致命：拉不到就按客户端配置里的几何画，
   * 玩家的角色不会因为对齐服务挂了而变成一片空白。
   */
  @Get("equip-align")
  @ApiPlayerDoc({
    operationId: "gameConfig.equipAlign",
    summary: "装备外观几何（对齐工作台的产物）",
    description:
      "管理端「装备对齐」工作台保存的全部几何：`id` 形如 `cloth:cloth_1` / `weapon:weapon_1` / `role:1`。\n\n" +
      "**列表里没有的 id = 用客户端配置里的值**，所以客户端是「按 id 对齐、缺省不动」，不是整份替换。\n\n" +
      "`outPositions` 是 8 个方向的外观位移（顺序见客户端 `configs/animation` 的 `directions`，y 向上为正）；" +
      "`outManual=true` 表示它是绝对位置，false / 缺省表示运行时按身体帧自动算、`outPositions` 只当微调（只对武器有意义）。\n\n" +
      "需要玩家令牌（与快照同口径：配置属于玩法数据）。",
  })
  @ApiDataResponse(EquipAlignListDto, { description: "全部已保存的对齐几何" })
  equipAlignList(): EquipAlignListDto {
    return this.equipAlign.list();
  }

  /**
   * 装备**内观**几何（#523）
   *
   * 与外观几何分开下发，理由同上一条：两者是两组数据（8 向 vs 单帧），混在一个接口里
   * 会让「只想改内观」也重新拉一遍 8 向数组。量更小（31 行），同样失败不致命。
   */
  @Get("equip-in-align")
  @ApiPlayerDoc({
    operationId: "gameConfig.equipInAlign",
    summary: "装备内观几何（内观对齐工作台的产物）",
    description:
      "管理端「内观对齐」工作台保存的全部几何：`id` 形如 `cloth:cloth_1` / `weapon:weapon_1`。\n\n" +
      "**列表里没有的 id = 用客户端配置里的值**，客户端是「按 id 对齐、缺省不动」。\n\n" +
      "`inPosition` 是弹窗坐标系里的一个点（原点 = 弹窗中心，y 向上）；`inScaleX` / `inScaleY` 是两轴缩放；" +
      "`inManual=true` 表示武器的位置与缩放用这份绝对值，false / 缺省表示客户端仍按「当前衣服的内容 bbox」自动算" +
      "（衣服不看这个字段：它一直是绝对位置）。\n\n" +
      "需要玩家令牌（与快照同口径）。",
  })
  @ApiDataResponse(EquipInAlignListDto, { description: "全部已保存的内观几何" })
  equipInAlignList(): EquipInAlignListDto {
    return this.equipInAlign.list();
  }
}
