import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SocialRepository } from "../../database/repositories/social.repository";

/**
 * 屏蔽（拉黑）过滤缓存（#398）
 *
 * ## 为什么需要缓存
 * 「这条消息该不该发给他」「他的位置该不该出现在我屏幕上」是**每个收件人**都要判一次的：
 * 世界频道一条消息有 N 个收件人、互见帧 200ms 一拍。逐次查库在这个频率上不可行
 * （4Hz × 同图人数就是每秒几十次 SELECT），所以把 `role_blocks` 整表读进内存，
 * 按 `SOCIAL_BLOCK_CACHE_MS`（默认 2 秒）懒刷新。
 *
 * ## 为什么要整表而不是按人查
 * 每人最多 100 行（`SOCIAL_BLOCK_LIMIT`），整表读一次比「为每个收件人查一次」便宜得多；
 * 而且过滤是**双向判断**（我拉黑了他 / 他拉黑了我），按人要查两遍。
 *
 * ## 单向的语义
 * 只认「观看者拉黑了目标」这一个方向：
 * - 我拉黑他 → 我收不到他的聊天、看不到他的位置；
 * - **他那边照旧看得见我** —— 屏蔽不该变成「你被屏蔽了」的提示，那反而给了骚扰者信号。
 *   唯一的例外是私聊：他发给我会被拒（回一句「不在线」），否则「消息发出去了但永远没人收到」
 *   更让人困惑。
 *
 * ## 生效延迟
 * 最多滞后一个刷新间隔（默认 2 秒）。HTTP 侧写库、实时侧读缓存，两个进程之间没有 IPC ——
 * 用轮询换「不用为拉黑再造一条跨进程通道」，这笔账在拉黑这种低频操作上很划算。
 */
@Injectable()
export class BlockService {
  private readonly logger = new Logger(BlockService.name);

  /** 拉黑者角色 id → 被他拉黑的角色 id 集合 */
  private hidden = new Map<string, Set<string>>();
  /** 上次读库的时刻（0 = 从没读过） */
  private loadedAt = 0;

  constructor(
    private readonly social: SocialRepository,
    private readonly config: ConfigService,
  ) {}

  /**
   * `viewerRoleId` 是否拉黑了 `targetRoleId`
   *
   * 空 roleId（还没选角 / 旧客户端）一律视为没拉黑：宁可多送一帧，
   * 也不要因为一个缺失的字段把某人的整个社交面静音。
   */
  hiddenFor(viewerRoleId: string, targetRoleId: string): boolean {
    if (!viewerRoleId || !targetRoleId) return false;
    this.refreshIfStale();
    const set = this.hidden.get(viewerRoleId);
    return !!set && set.has(targetRoleId);
  }

  /** 两个人之间**任一方**拉黑了对方（私聊用：两个方向都要挡） */
  hiddenEither(aRoleId: string, bRoleId: string): boolean {
    return this.hiddenFor(aRoleId, bRoleId) || this.hiddenFor(bRoleId, aRoleId);
  }

  /** 丢掉缓存（测试与「刚写完立刻要生效」的场合用；正常走定时懒刷新） */
  invalidate(): void {
    this.loadedAt = 0;
  }

  private refreshIfStale(): void {
    const ttl = Math.max(0, Number(this.config.get<number>("socialBlockCacheMs") ?? 2000));
    const now = Date.now();
    // ttl = 0 表示关缓存（每次都读库）：e2e 用它把「拉黑立即生效」钉死，
    // 免得测试里到处 sleep 等缓存过期
    if (ttl > 0 && this.loadedAt !== 0 && now - this.loadedAt < ttl) return;
    try {
      const pairs = this.social.allBlockPairs();
      const next = new Map<string, Set<string>>();
      for (const pair of pairs) {
        const set = next.get(pair.role_id) ?? new Set<string>();
        set.add(pair.blocked_role_id);
        next.set(pair.role_id, set);
      }
      this.hidden = next;
      this.loadedAt = now;
    } catch (error) {
      // 读库失败保留旧缓存（过滤退化成「按上一次的快照」）：屏蔽数据的读取失败不该让
      // 聊天与互见整体停摆 —— 那会把一个数据库抖动放大成「所有人看不见所有人」
      this.logger.warn(`读屏蔽表失败，沿用上一次的过滤快照：${(error as Error).message}`);
      this.loadedAt = now;
    }
  }
}
