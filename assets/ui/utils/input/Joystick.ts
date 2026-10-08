import { Vec2 } from "cc";
import { joystickMove } from "../../../configs/role";
import { joystickLayout } from "../../../configs/hudLayout";
import { getDirectionByVector, getVectorByDirection } from "../battle/BattleMath";

/**
 * 操作摇杆的判定（纯函数模块）
 *
 * 只负责「算」：把「手柄相对底座中心的位移」夹进可拖半径、并解释成移动意图；
 * 事件监听与手柄节点位移由 components/input/RoleJoystickInput 负责，两者共用这里的口径
 * （与 utils/battle/BattleMath 分工一致：算与编排分开，纯函数可直接单测）。
 *
 * 手感三段（阈值见 configs/role.joystickMove，都是**占可拖半径的比例**）：
 *   拖动幅度 < deadZone        → 原地（返回 null）
 *   deadZone ~ runThreshold    → 走路
 *   ≥ runThreshold             → 跑动
 * 方向取「位移向量」的八方向量化结果（与键盘/鼠标操控、角色八方向动画同一口径，不是另写一套）。
 */

/** 摇杆的一次有效输入：八方向单位向量 + 是否跑动 */
export interface JoystickMoveState {
  /** 移动方向（八方向之一的单位向量） */
  direction: Vec2;
  /** 是否跑动（拖动幅度达到 runThreshold） */
  run: boolean;
}

/**
 * 把拖动位移夹进可拖半径内（手柄不许拖出底座）
 * 返回**新向量**，不改入参（调用方常直接拿事件里的向量，改它会污染事件对象）
 */
export function clampJoystickOffset(offset: Vec2): Vec2 {
  const radius = joystickLayout.radius;
  const length = offset.length();
  if (length <= radius || length <= 0) return new Vec2(offset.x, offset.y);
  const scale = radius / length;
  return new Vec2(offset.x * scale, offset.y * scale);
}

/**
 * 拖动位移 -> 移动意图（死区内返回 null = 不定方向、不移动）
 * 走/跑的判定用**归一化后的拖动幅度**（位移长度 ÷ 可拖半径），所以窗口尺寸与缩放都不影响手感
 */
export function resolveJoystickMove(offset: Vec2): JoystickMoveState | null {
  const radius = joystickLayout.radius;
  if (radius <= 0) return null;
  const ratio = offset.length() / radius;
  if (ratio < joystickMove.deadZone) return null;
  return { direction: getVectorByDirection(getDirectionByVector(offset)), run: ratio >= joystickMove.runThreshold };
}
