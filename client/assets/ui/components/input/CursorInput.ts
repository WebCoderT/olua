import { EventMouse, Input, input } from "cc";
import CursorManager from "../../core/CursorManager";
import { getHitScreenPoint } from "../../utils/input/Pointer";

/**
 * 鼠标指针输入
 * 只做一件事：把鼠标位置上报给 CursorManager（判定与写入样式由它负责）
 * 样式判定放在每帧一次（Game.update 调 CursorManager.tick），高回报率鼠标移动时不会重复做命中检测
 */
export default class CursorInput {
  /** 初始化：监听全局鼠标移动 */
  init() {
    input.on(Input.EventType.MOUSE_MOVE, this.trackPointer, this);
  }

  /** 销毁（场景卸载时由 Game 调用），移除全局监听避免重进场景后残留 */
  destroy() {
    input.off(Input.EventType.MOUSE_MOVE, this.trackPointer, this);
  }

  /** 记录鼠标位置（屏幕坐标，与命中检测使用同一坐标系，见 utils/input/Pointer.getHitScreenPoint） */
  private trackPointer(event: EventMouse) {
    CursorManager.setLocation(getHitScreenPoint(event));
  }
}
