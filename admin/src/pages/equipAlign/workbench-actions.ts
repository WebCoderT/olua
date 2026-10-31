/**
 * 对齐工作台的「保存 / 还原 / 批量保存」流程（#513）
 *
 * 外观（EquipAlignPage）与内观（EquipInAlignPage）两个工作台的这三段流程逐字相同，
 * 差异只有两处：落库 API 不同（各自 store 的 save/reset）与保存生效文案
 * （外观 = 客户端重进游戏；内观 = 客户端重开角色信息弹窗）。收在这里，页面只剩接线。
 *
 * 还原的**顺序不能反**：先删服务端（有记录才删，回到出厂值）、再清本地临时改动 ——
 * 反过来会有一瞬间「本地没了但服务端还在」，刷新页面那件又跳回旧位置。
 */

/** 工作台条目的最小形状（外观 WorkItem / 内观 InItem 都满足） */
interface AlignItemLike {
  id: string;
  label: string;
}

export function makeAlignWorkbenchActions<G, I extends AlignItemLike>({
  pending,
  save,
  reset,
  saved,
  drafts,
  baseOf,
  dropDraft,
  setNotice,
  effectHint,
}: {
  pending: string | null;
  /** 落库（各自 store 的 save；成功返回 true） */
  save: (id: string, geometry: G) => Promise<boolean>;
  /** 删服务端记录（回到出厂值；成功返回 true） */
  reset: (id: string) => Promise<boolean>;
  /** 服务端已保存的对齐（还原时判断「有没有记录可删」） */
  saved: Record<string, unknown>;
  /** 浏览器临时改动 */
  drafts: Record<string, G>;
  /** 条目的清单基准（未改动件的保存值） */
  baseOf: (item: I) => G;
  dropDraft: (id: string) => void;
  setNotice: (text: string) => void;
  /** 保存生效方式的提示尾巴 */
  effectHint: string;
}) {
  /** 保存当前件 —— 主流程的出口：调完按这个，客户端按 effectHint 的动作就能看到 */
  const saveActive = async (item: I, geometry: G) => {
    if (pending) return;
    const ok = await save(item.id, geometry);
    if (!ok) return;
    dropDraft(item.id);
    setNotice(`已保存「${item.label}」—— ${effectHint}`);
  };

  /** 还原本件：先删服务端、再清本地 */
  const resetItem = async (item: I) => {
    if (pending) return;
    if (saved[item.id]) {
      const ok = await reset(item.id);
      if (!ok) return;
    }
    dropDraft(item.id);
    setNotice(`已把「${item.label}」还原成出厂值`);
  };

  /**
   * 保存全部未保存的件（逐条提交）
   *
   * 逐条而不是一个批量接口：一条失败不拖累其它（失败清单要能指名道姓），
   * 而且工作台的真实节奏本来就是「调一件存一件」，批量只是顺手。
   */
  const saveAll = async (items: I[], unsavedIds: string[]) => {
    if (pending || !unsavedIds.length) return;
    let done = 0;
    const failed: string[] = [];
    for (const id of unsavedIds) {
      const item = items.find((entry) => entry.id === id);
      if (!item) continue;
      const ok = await save(id, drafts[id] ?? baseOf(item));
      if (ok) {
        done += 1;
        dropDraft(id);
      } else {
        failed.push(id);
      }
    }
    setNotice(failed.length ? `已保存 ${done} 件，失败 ${failed.length} 件：${failed.join("、")}` : `已保存 ${done} 件`);
  };

  return { saveActive, resetItem, saveAll };
}
