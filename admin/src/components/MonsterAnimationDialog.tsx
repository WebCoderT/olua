import { useState } from "react";
import type { AdminMonster } from "../api";
import { monsterOut } from "../api";
import { FrameAnimation } from "./FrameAnimation";
import { Modal } from "./Modal";
import { Badge, Button, Field } from "./ui";

/**
 * 怪物动画预览弹窗（#1241）
 *
 * **每个动作 × 每个方向**都手动可选拨放：动作 5 个（素材目录名即 key）、方向 8 个
 * （图集帧名 `d<N>_<帧>` 的 N，与客户端 `configs/animation.directions` 同序）。
 * 缺素材的组合照常可选、画「无图」占位 —— 客户端对缺段的处理是「回退成待机」，
 * 管理端把空档直白地亮出来，正好提示运营这段素材没进包。
 *
 * 帧率与客户端**完全一致**（`AnimationHelper.getFrameTime` 同语义）：
 * `presentation.speedRate` 的键被动画名（`<动作>_<方向>`，如 `stand_up`）包含即命中、
 * 后者覆盖前者，缺省 1 秒/帧。运营调 speedRate 时，这里的节奏就是游戏里的节奏。
 */

/** 动作清单：key = 素材目录名（monster/out/<key>/<动作>/<动作>.plist），与客户端 ACTION 值一致 */
const ACTIONS = [
  { key: "stand", label: "站立" },
  { key: "walk", label: "行走" },
  // #1247 由 run 改名 attack：怪物没有奔跑，这段素材画面是攻击动作
  { key: "attack", label: "攻击" },
  { key: "injured", label: "受击" },
  { key: "die", label: "死亡" },
] as const;

type ActionKey = (typeof ACTIONS)[number]["key"];

/** 图集帧名 d<N> 的 N ↔ 中文标签（下标即 N）；`DIR_VALUE` 与客户端 DIRECTION 枚举值同形，拼动画名用 */
const DIRECTIONS = [
  { label: "上", value: "up" },
  { label: "右上", value: "right_up" },
  { label: "右", value: "right" },
  { label: "右下", value: "right_down" },
  { label: "下", value: "down" },
  { label: "左下", value: "left_down" },
  { label: "左", value: "left" },
  { label: "左上", value: "left_up" },
] as const;

/** 每帧秒数：speedRate 键被动画名包含即命中（同名键后者覆盖），缺省 1 —— 与客户端 getFrameTime 逐句对齐 */
function frameSecondsOf(speedRate: Record<string, number>, actionKey: ActionKey, dirIndex: number): number {
  const name = `${actionKey}_${DIRECTIONS[dirIndex].value}`;
  let time = 1;
  for (const rate in speedRate) {
    if (name.includes(rate)) time = speedRate[rate];
  }
  return time;
}

export function MonsterAnimationDialog({ monster, onClose }: { monster: AdminMonster | null; onClose: () => void }) {
  const [action, setAction] = useState<ActionKey>("stand");
  const [dirIndex, setDirIndex] = useState(0);
  if (!monster) return null;
  const out = monsterOut(monster.id);
  const speedRate = monster.presentation?.speedRate ?? {};
  const frameSeconds = frameSecondsOf(speedRate, action, dirIndex);
  const dirLabel = DIRECTIONS[dirIndex].label;
  const actionLabel = ACTIONS.find((item) => item.key === action)?.label ?? action;

  return (
    <Modal
      open
      size="lg"
      title={
        <>
          动画预览 · {monster.label}
          <Badge tone="muted">{monster.id}</Badge>
        </>
      }
      hint={`${actionLabel} · 朝${dirLabel}（d${dirIndex}）· 每帧 ${frameSeconds} 秒`}
      onClose={onClose}
      footer={
        <Button variant="outline" onClick={onClose}>
          关闭
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="动作" inline>
          <div className="flex flex-wrap gap-1.5">
            {ACTIONS.map((item) => (
              <Button
                key={item.key}
                variant={item.key === action ? "primary" : "outline"}
                className="px-2.5 py-1 text-xs"
                onClick={() => setAction(item.key)}
              >
                {item.label}
              </Button>
            ))}
          </div>
        </Field>
        <Field label="方向" inline>
          <div className="flex flex-wrap gap-1.5">
            {DIRECTIONS.map((item, index) => (
              <Button
                key={item.value}
                variant={index === dirIndex ? "primary" : "outline"}
                className="px-2.5 py-1 text-xs"
                onClick={() => setDirIndex(index)}
              >
                {item.label}
              </Button>
            ))}
          </div>
        </Field>
        <div className="flex justify-center py-2">
          {out ? (
            <FrameAnimation
              key={`${monster.id}/${action}/${dirIndex}`}
              atlas={`${out}/${action}`}
              framePrefix={`d${dirIndex}`}
              frameMs={frameSeconds * 1000}
              size={280}
              alt={`${monster.label} ${actionLabel} 朝${dirLabel}`}
            />
          ) : (
            <span className="text-sm text-ink-5">这只怪没有表现行（presentation），先在编辑里保存一次生成外观目录</span>
          )}
        </div>
        <p className="text-xs text-ink-5">
          帧率与客户端一致：按该怪 speedRate 取每帧秒数（动作名命中才生效），未配置即客户端默认 1 秒/帧；点击画布可放大。
          显示「无图」= 素材包缺这一段（客户端会静默回退成待机，不会报错）。
        </p>
      </div>
    </Modal>
  );
}
