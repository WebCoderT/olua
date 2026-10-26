import { TiledMapAsset } from "cc";
import { loadingConfig } from "../../configs/loading";
import { tiledGroupNames, tiledObjectClasses, tiledPropertyNames } from "../../configs/map";
import { monsters } from "../../configs/monster";
import { npcs } from "../../configs/npc";
import { getRoleDefaultCloth } from "../../configs/role";
import { getTitleLevel } from "../../configs/title";
import { getEquipment } from "../../configs/items";
import { getFashionOut } from "../../configs/fashionClothes";
import { getAssignedBorders } from "../../configs/border";
import { getAssignedDetailBackgrounds } from "../../configs/background";
import { getAssignedLights } from "../../configs/light";
import { getText } from "../../configs/texts";
import { Role } from "../../entities/Role";
import { AnimationKind, SpeedRate } from "../../types/animation";
import AnimationHelper from "../helpers/AnimationHelper";
import { readTiledObjects, readTiledObjectsFrom } from "../utils/map/TiledObjects";
import { loadResourceAsync } from "../utils/resource/ResourceLoader";

/** 一个预加载任务：需要预先加载的帧动画目录 + 用哪张动画表切割 */
interface PreloadTask {
  /** 帧动画目录（resources 下的路径） */
  dir: string;
  /** 动画种类（role/monster 切割片段，frames 只需帧序列） */
  kind: AnimationKind;
  /** 速度倍率（role/monster 切割片段用） */
  speedRate?: SpeedRate;
}

/** 预加载进度回调：ratio 取值 0~1，tip 为当前阶段的说明文字 */
export type PreloadProgress = (ratio: number, tip: string) => void;

/**
 * 预加载管理器（静态类）
 * 进游戏前把"一进图就要用的资源"一次性加载完，避免进图后再逐个节点异步加载造成的卡顿与空档：
 * 1. 地图信息（tmx 与其图集依赖）
 * 2. 地图内所有 NPC 与怪物的帧动画（按对象组里的编号查配置得到资源目录）
 * 3. 当前角色身上穿戴的衣服与武器帧动画
 * 跟进图无关的装饰资源（装备边框图集 / 装备详情背景帧序列）改为**后台**预载，不阻塞进图；
 * 光柱虽也是装饰，但掉落物落场就要显示，保留在关键路径
 * 由过渡场景 Loading 调用（带进度显示）；直接从 Game 场景启动（编辑器里单独跑 Game）时由 Game 兜底调用一次。
 * 同一目录只加载一次，重复调用（Loading 已加载过、Game 又调一次）不会重复加载：
 * 帧序列与动画片段都缓存在 AnimationHelper，第二次调用直接命中缓存立即返回
 */
export default class PreloadManager {
  /**
   * 预加载进入游戏场景所需的全部资源
   * @param mapSrc 当前所在地图资源路径（configs/map 里的 src）
   * @param role 当前在线角色（取其穿戴的衣服/武器外观；无角色时只加载地图部分）
   * @param onProgress 进度回调（可缺省：直接从 Game 场景启动时没有进度界面）
   */
  static async preloadGame(mapSrc: string, role: Role | null, onProgress?: PreloadProgress) {
    const startedAt = Date.now();
    onProgress?.(0, getText("progress_map"));
    // 装备边框图集与详情背景帧序列：都只在进图**之后**的背包/悬停详情里用，跟"能不能进图"无关 ——
    // 移出关键路径后台预载（不 await）：没载完就开背包也只是动画晚一拍出现（载完进 AnimationHelper 缓存），
    // 换来的是进图等待时间直接少掉 40+ 个目录的加载（首进 Game 明显变快）
    void this.preloadBorders();
    void this.preloadDetailBackgrounds();
    const mapAsset = await this.timed("地图信息", startedAt, () => loadResourceAsync<TiledMapAsset>(mapSrc, TiledMapAsset));
    // 装备光柱帧序列：掉落物落场光柱就要在（进图即可能拾取），保留在关键路径；只有 5 个目录、很小
    const lightsStartedAt = Date.now();
    await this.preloadLights();
    console.log(`[PreloadManager] 光柱帧序列完成，耗时 ${Date.now() - lightsStartedAt}ms（自开始预加载起 ${Date.now() - startedAt}ms）`);
    const tasks = this.uniqueTasks([...this.getMapAnimationTasks(mapAsset), ...this.getRoleAnimationTasks(role)]);
    await this.timed(`帧动画 ${tasks.length} 个目录`, startedAt, () => this.runTasks(tasks, onProgress, loadingConfig.mapRatio));
    console.log(`[PreloadManager] 游戏资源预加载全部完成，总耗时 ${Date.now() - startedAt}ms`);
  }

  /** 分阶段耗时日志（量化加载瓶颈：控制台按阶段输出毫秒数，据此调整并发数与关键路径取舍） */
  private static async timed<T>(name: string, startedAt: number, task: () => Promise<T>): Promise<T> {
    const begin = Date.now();
    const result = await task();
    console.log(`[PreloadManager] ${name}完成，耗时 ${Date.now() - begin}ms（自开始预加载起 ${Date.now() - startedAt}ms）`);
    return result;
  }

  //#region 任务收集

  /** 地图内需要预加载的帧动画：NPC 外观（整包循环）+ 怪物外观（按怪物动画表切割） */
  private static getMapAnimationTasks(mapAsset: TiledMapAsset): PreloadTask[] {
    const xml = mapAsset?.tmxXmlStr ?? "";
    if (!xml) {
      console.warn("[PreloadManager] 地图资源里没有 TMX 原文，无法预加载地图内的帧动画");
      return [];
    }
    const tasks: PreloadTask[] = [];
    // NPC：对象类为 npc 的点位才有外观，复活点只是坐标（与 MapObjectSpawner 同一套读法）
    readTiledObjectsFrom(xml, tiledGroupNames.npc, tiledGroupNames.legacyObjects)
      .filter((object) => object.objectClass === tiledObjectClasses.npc)
      .forEach((object) => {
        const npc = npcs.get(`${object.properties[tiledPropertyNames.id] ?? ""}`);
        if (npc?.src) tasks.push({ dir: npc.src, kind: "frames" });
      });
    // 怪物：monster 对象组的 id 属性即怪物编号（与 MonsterAreaSpawner 同一套读法）
    readTiledObjects(xml, tiledGroupNames.monster).forEach((object) => {
      const monster = monsters.get(`${object.properties[tiledPropertyNames.id] ?? ""}`);
      if (monster?.out) tasks.push({ dir: monster.out, kind: "monster", speedRate: monster.speedRate });
    });
    return tasks;
  }

  /** 角色身上穿戴的帧动画：衣服（未穿戴时用**该性别的**默认外观）+ 武器（未装备或该武器没有外观时跳过） */
  private static getRoleAnimationTasks(role: Role | null): PreloadTask[] {
    if (!role) return [];
    // 与时装穿戴同口径：时装 > 装备衣服 > 性别默认外观（否则穿时装进图第一帧是旧衣服）
    const clothOut = getFashionOut(role.fashionCloth) || getEquipment(role.equipments.cloth)?.out || getRoleDefaultCloth(role.sex).out;
    const tasks: PreloadTask[] = [{ dir: clothOut, kind: "role", speedRate: role.speedRate }];
    const weaponOut = getEquipment(role.equipments.weapon)?.out;
    if (weaponOut) tasks.push({ dir: weaponOut, kind: "role", speedRate: role.speedRate });
    // 称号名牌动画（已激活时头顶常显，进图即出现；未激活跳过）
    const title = getTitleLevel(role.title);
    if (title) tasks.push({ dir: title.animation, kind: "frames" });
    return tasks;
  }

  /** 去掉重复与空目录（同一套外观被多个点位引用时只加载一次） */
  private static uniqueTasks(tasks: PreloadTask[]) {
    const loaded = new Set<string>();
    return tasks.filter((task) => {
      const key = `${task.kind}|${task.dir}`;
      if (!task.dir || loaded.has(key)) return false;
      loaded.add(key);
      return true;
    });
  }

  /** 预加载装备边框图集（configs/border 的前后缀映射表用到的全部边框；帧进 AnimationHelper 缓存，重复调用只加载一次）。后台预载，不阻塞进图 */
  private static async preloadBorders() {
    const assigned = getAssignedBorders();
    await Promise.all(assigned.map((resource) => AnimationHelper.loadFramesFromAtlas(resource.atlas)));
    console.log(`[PreloadManager] 装备边框预加载完成（${assigned.length} 张图集）：${assigned.map((resource) => resource.key).join("、")}`);
  }

  /** 预加载装备详情背景帧序列目录（configs/background 的前后缀映射表用到的全部背景；帧进 AnimationHelper 缓存，重复调用只加载一次）。后台预载，不阻塞进图 */
  private static async preloadDetailBackgrounds() {
    const assigned = getAssignedDetailBackgrounds();
    await Promise.all(assigned.map((resource) => AnimationHelper.loadFrames(resource.dir)));
    console.log(`[PreloadManager] 装备详情背景预加载完成（${assigned.length} 个目录）：${assigned.map((resource) => resource.key).join("、")}`);
  }

  /** 预加载装备光柱图集（configs/light 前缀表用到的全部光柱；帧进 AnimationHelper 缓存，重复调用只加载一次） */
  private static async preloadLights() {
    const assigned = getAssignedLights();
    await Promise.all(assigned.map((resource) => AnimationHelper.loadFramesFromAtlas(resource.atlas)));
    console.log(`[PreloadManager] 装备光柱预加载完成（${assigned.length} 张图集）：${assigned.map((resource) => resource.key).join("、")}`);
  }

  //#endregion

  /**
   * 并发预加载全部任务（并发数见 configs/loading）
   * 进度从 progressStart 走到 1（progressStart 之前留给地图信息）
   */
  private static async runTasks(tasks: PreloadTask[], onProgress: PreloadProgress | undefined, progressStart: number) {
    const total = tasks.length;
    if (!total) {
      onProgress?.(1, getText("progress_none"));
      return;
    }
    const queue = tasks.slice();
    let finished = 0;
    const worker = async () => {
      for (let task = queue.shift(); task; task = queue.shift()) {
        await AnimationHelper.prepare(task.dir, task.kind, task.speedRate);
        finished++;
        onProgress?.(progressStart + (1 - progressStart) * (finished / total), getText("progress_frames", { done: finished, total }));
      }
    };
    await Promise.all(Array.from({ length: Math.min(loadingConfig.animationConcurrency, total) }, worker));
    console.log(`[PreloadManager] 帧动画预加载完成（${total} 个目录）：${tasks.map((task) => task.dir).join("、")}`);
  }
}
