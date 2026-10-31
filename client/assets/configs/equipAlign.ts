/**
 * 装备对齐口径（**唯一实现**：角色内观从这里取几何）
 *
 * ===========================================================================
 * #541：**外观已不再「算」—— 场景里的衣服与武器一律摆绝对位置**
 * ===========================================================================
 * 外观（场景里跟角色走的那套）的几何只认数据：管理端「装备对齐」工作台调好的
 * 8 向绝对位置经服务端 `game-config/equip-align` 每次进图下发（configs/apply-snapshot），
 * 客户端 `RoleAppearance.applyOutTransform` 原样摆上去 —— 曾经的「按身体帧内容 bbox
 * 自动贴握持点」算法（#505）已删除，因为它现场算出来的位置与工作台/服务端数据对不上，
 * 用户无法用工作台表达最终效果。本文件保留的纯函数仅供**内观**（RoleInShowView）
 * 与单测使用。
 *
 * ===========================================================================
 * 内观为什么仍要「算」（历史背景，即原外观算法的出处）
 * ===========================================================================
 * 素材的画布与裁剪留白每件都不一样（武器外观画布 245×234 ~ 570×608，身体 142×112 ~ 480×480），
 * 写死一个 inPosition / outPositions 只能对上一件身体：换一件衣服，武器就飘到脚底或头顶。
 * 内观仍由**运行时读到的帧几何**推导（武器缩放到身体高度的固定倍数、贴握持点），
 * 手调过的武器用 `inManual = true` 走绝对值（#523）。
 *
 * 帧几何一律用**内容 bbox**（`SpriteFrame.rect` + `SpriteFrame.offset`，见
 * GameUiHelper.spriteContentBox）—— 用节点框会随着裁剪留白漂移，正是原来的病根。
 */

/** 对齐口径的比例系数（改这里就同时改了场景与内观，别在调用方另写一份） */
export const EQUIP_ALIGN = {
  /** 握持点横向：相对身体半宽的比例（0.5 = 恰在身体边缘，>0.5 略向外） */
  handSideRatio: 0.52,
  /** 握持点纵向：相对身体高度的比例（0 = 脚底，1 = 头顶），0.52 约在胯部略上 */
  handHeightRatio: 0.52,
  /** 内观里武器的高度 = 身体高度 × 该倍数（展示口径，长短武器统一「规格」） */
  inWeaponHeightRatio: 1.15,
  /** 素材未就绪时的重试间隔（毫秒）：帧是异步落到 Sprite 上的，「就绪」回调里常常还读不到 */
  alignRetryDelayMs: 50,
  /** 重试次数上限（约 1 秒）：素材真的缺帧时就停手，不做无意义的重排 */
  alignRetryTimes: 20,
};

/** 精灵当前帧的内容 bbox（节点本地坐标，y 向上；由 GameUiHelper.spriteContentBox 给出） */
export interface ContentBox {
  /** 内容中心相对节点中心的横向偏移 */
  cx: number;
  /** 内容中心相对节点中心的纵向偏移 */
  cy: number;
  w: number;
  h: number;
}

/**
 * 握持点（宿主坐标）
 * @param body 身体内容 bbox（**已加上衣服节点的位置**，即宿主坐标系下的中心）
 * @param onLeft 武器是否在观众左侧（角色右手持械；面朝下时右手在观众左边）
 */
export function handAnchor(body: ContentBox, onLeft: boolean): { x: number; y: number } {
  const side = onLeft ? -1 : 1;
  return {
    x: body.cx + side * (body.w / 2) * EQUIP_ALIGN.handSideRatio,
    y: body.cy - body.h / 2 + body.h * EQUIP_ALIGN.handHeightRatio,
  };
}

/**
 * 武器节点位置（宿主坐标，内观用）
 *
 * 武器节点被摆到 `手部锚点 − 武器内容中心 × 缩放`，于是**武器的内容中心**正好落在握持点上。
 * 内容中心不等于节点中心（裁剪留白），所以必须减去 `weapon.cx/cy`，否则留白越多偏得越远。
 *
 * @param scale 武器缩放
 */
export function placeWeaponOnHand(body: ContentBox, weapon: ContentBox, scale: number, onLeft: boolean): { x: number; y: number } {
  const hand = handAnchor(body, onLeft);
  return { x: hand.x - weapon.cx * scale, y: hand.y - weapon.cy * scale };
}

/**
 * 内观：武器节点的缩放与位置
 *
 * 缩放让**武器内容高度**等于身体内容高度的固定倍数；位置同样把武器内容中心对到握持点。
 */
export function placeInShowWeapon(body: ContentBox, weapon: ContentBox, onLeft = true): { x: number; y: number; scale: number } {
  const scale = (body.h * EQUIP_ALIGN.inWeaponHeightRatio) / weapon.h;
  const pos = placeWeaponOnHand(body, weapon, scale, onLeft);
  return { x: pos.x, y: pos.y, scale };
}
