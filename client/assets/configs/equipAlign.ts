/**
 * 装备对齐口径（**唯一实现**：场景外观与角色内观都从这里取几何）
 *
 * ===========================================================================
 * 为什么要「算」而不是「配」
 * ===========================================================================
 * 素材的画布与裁剪留白每件都不一样（武器外观画布 245×234 ~ 570×608，身体 142×112 ~ 480×480），
 * 所以写死一个 inPosition / outPositions 只能对上一件身体：换一件衣服，武器就飘到脚底或头顶；
 * 换一把武器，内观里的位置又对不上。历史配置正是这么攒出来的 —— 20 把武器 20 组互不相干的手调数字。
 *
 * 这里改成由**运行时读到的帧几何**推导：
 *   - 外观：武器内容 bbox 的中心落到「当前身体内容 bbox 的握持点」（右侧或左侧由朝向决定）
 *   - 内观：武器缩放到身体高度的固定倍数，同样贴到握持点
 * 于是任何身体尺寸、任何武器都自动对齐；新增素材不需要再手调数字（配置里的 outPositions
 * 退化为逐件微调，默认 0）。
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
 * 外观：武器节点位置（宿主坐标）
 *
 * 武器节点被摆到 `手部锚点 − 武器内容中心 × 缩放`，于是**武器的内容中心**正好落在握持点上。
 * 内容中心不等于节点中心（裁剪留白），所以必须减去 `weapon.cx/cy`，否则留白越多偏得越远。
 *
 * @param scale 武器缩放（outScale）
 * @param nudge 逐件微调（配置里的 outPositions，默认 0）
 */
export function placeWeaponOnHand(body: ContentBox, weapon: ContentBox, scale: number, nudge: { x: number; y: number }, onLeft: boolean): { x: number; y: number } {
  const hand = handAnchor(body, onLeft);
  return { x: hand.x - weapon.cx * scale + nudge.x, y: hand.y - weapon.cy * scale + nudge.y };
}

/**
 * 内观：武器节点的缩放与位置
 *
 * 缩放让**武器内容高度**等于身体内容高度的固定倍数；位置同样把武器内容中心对到握持点。
 */
export function placeInShowWeapon(body: ContentBox, weapon: ContentBox, onLeft = true): { x: number; y: number; scale: number } {
  const scale = (body.h * EQUIP_ALIGN.inWeaponHeightRatio) / weapon.h;
  const pos = placeWeaponOnHand(body, weapon, scale, { x: 0, y: 0 }, onLeft);
  return { x: pos.x, y: pos.y, scale };
}
