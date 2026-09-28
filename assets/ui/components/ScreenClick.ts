import { Camera, EventTouch, Input, input, geometry, PhysicsSystem } from "cc";
import { Layer } from "../utils/LayerManager";

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
    return;

    const touchPos = event.getUILocation();
    // 屏幕坐标转世界空间射线
    const ray = new geometry.Ray();
    ScreenClick.camera.screenPointToRay(touchPos.x, touchPos.y, ray);
    // 射线检测怪物，只检测Game层
    const hits = PhysicsSystem.instance.raycast(ray, 1000, Layer.GAME);
    console.log(hits);
    /** 
     * 
    if (hits.length > 0) {
      const targetMonster = hits[0].collider.node;
      // 把选中的怪物交给攻击逻辑处理
      this.doAttack(targetMonster);
    }
     */
  },
};

export default ScreenClick;
