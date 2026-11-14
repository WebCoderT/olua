import { FrameAnimation } from "../FrameAnimation";
import { GameFrame, GameIcon } from "../GameImage";
import type { EntityImage as EntityImageData } from "./catalog";

/**
 * 实体图标：一个组件罩住「单图 / 图集首帧 / 图集动画 / 无图」四种情况
 *
 * 游戏资源分两类（见 `GameImage`）：装备 / 技能 / 物品是单张 PNG，称号 / 战魂 / NPC 是
 * 图集动画（取第一帧画到 canvas）。调用方只拿 `EntityImage`（catalog 给的），
 * 不需要知道自己这一项是哪种 —— 这就是「哪里需要在哪里调用」的那一半。
 *
 * `image.animate`（#749 起，#756 扩到称号 / NPC / 怪物 / 战魂 / 装备）：图集不取首帧，
 * 改用 `FrameAnimation` 循环播 —— 边框光效、详情背景流动、称号飘字、怪物 / 装备的站立
 * 动作，首帧都判断不了「动起来长什么样」。**动画优先于静态图标**：装备 / 怪物两类
 * catalog 同时给 `icon`（图标 PNG）与 `frame`（站立图集），既然开了 animate，
 * 就是要看动起来的那个。
 */
export function EntityImage({
  image,
  alt,
  size = 40,
}: {
  image: EntityImageData;
  alt?: string;
  size?: number;
}) {
  // 卡片里整块是可点选按钮，图标不再套放大查看（嵌套按钮）
  if (image.frame && image.animate)
    return <FrameAnimation atlas={image.frame} alt={alt} size={size} framePrefix={image.framePrefix} zoomable={false} />;
  if (image.icon)
    return <GameIcon path={image.icon} alt={alt} size={size} ext={image.ext ?? "png"} zoomable={false} />;
  if (image.frame) return <GameFrame atlas={image.frame} alt={alt} size={size} zoomable={false} />;
  // 空值画**虚线小方块**，不画「无图」占位：未激活的档位 / 没穿时装本来是正常状态，
  // 一个写着「无图」的方块看起来像资源缺失，运营会去找那个「缺的图」
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size }}
      className="shrink-0 rounded-lg border border-dashed border-line bg-surface-0/40"
    />
  );
}
