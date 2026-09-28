import { Camera, EventTouch, Input, input, geometry, PhysicsSystem } from "cc";
import Monsters from "./Monsters";

const ScreenClick = {
  /** 相机 */
  camera: null as Camera | null,
  /** 初始化屏幕点击 */
  init(camera: Camera) {
    /** 相机 */
    ScreenClick.camera = camera;
    // 监听屏幕点击
    input.on(Input.EventType.TOUCH_END, ScreenClick.checkClickTarget, this);
  },
  /** 判断点击目标 */
  checkClickTarget(event: EventTouch) {
    const clickedNode = Monsters.checkWhichMonterBeClicked(event.getUILocation());
    if (clickedNode) return;
  },
};

export default ScreenClick;
