import { TiledMapAsset } from "cc";
import { loadingConfig } from "../../configs/loading";
import { tiledGroupNames, tiledObjectClasses, tiledPropertyNames } from "../../configs/map";
import { monsters } from "../../configs/monster";
import { npcs } from "../../configs/npc";
import { ROLE_DEFAULT_CLOTH_OUT } from "../../configs/role";
import { getEquipment } from "../../configs/items";
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
    onProgress?.(0, getText("progress_map"));
    const mapAsset = await loadResourceAsync<TiledMapAsset>(mapSrc, TiledMapAsset);
    const tasks = this.uniqueTasks([...this.getMapAnimationTasks(mapAsset), ...this.getRoleAnimationTasks(role)]);
    await this.runTasks(tasks, onProgress, loadingConfig.mapRatio);
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

  /** 角色身上穿戴的帧动画：衣服（未穿戴时用默认外观）+ 武器（未装备或该武器没有外观时跳过） */
  private static getRoleAnimationTasks(role: Role | null): PreloadTask[] {
    if (!role) return [];
    const clothOut = getEquipment(role.equipments.cloth)?.out || ROLE_DEFAULT_CLOTH_OUT;
    const tasks: PreloadTask[] = [{ dir: clothOut, kind: "role", speedRate: role.speedRate }];
    const weaponOut = getEquipment(role.equipments.weapon)?.out;
    if (weaponOut) tasks.push({ dir: weaponOut, kind: "role", speedRate: role.speedRate });
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
