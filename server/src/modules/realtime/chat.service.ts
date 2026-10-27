import { Injectable, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { GuildRepository } from "../../database/repositories/guild.repository";
import { RoleRepository } from "../../database/repositories/role.repository";
import { WorldService } from "../world/world.service";
import { PlayerPresenceService } from "./player-presence.service";
import type { RealtimeChatEntry, RealtimeChatMessage } from "./realtime.protocol";

/** 说话人的身份快照（presence.identityOf 的返回形状；只读） */
interface SpeakerIdentity {
  zoneId: number;
  mapId: string;
  roleId: string;
  guildId: string;
  guildName: string;
  username: string;
}

/**
 * 聊天服务（#395：世界 / 帮会 / 私聊三种频道的转发与限流）
 *
 * ## 权威边界
 * 聊天是**转发**不是存储：服务端不留历史（连内存都不留，见 issue #395 的取舍），
 * 只对每一条消息做四件事——身份核实、正文净化、限频、按频道选收件人。客户端的校验
 * （长度、频道名）只是省一次往返，**全部以这里为准**。
 *
 * ## 三个频道的口径
 * - `world`：广播给**同图观看者**（复用互见的观看者集合 `world.viewersOf`）。不做区服级
 *   全服广播——那需要维护「账号 → 区」的连接索引，首版规模用不上（issue #395 的口径决定）；
 * - `guild`：转发给帮会全部在线成员。帮会身份**每次查库**（`guildOfRole` / `members`），
 *   不用在场的懒刷新缓存——准入判断错一次（刚退帮的人还能喊一嗓子）比一次 DB 读贵得多，
 *   而聊天本来就是限频之后的低频操作；
 * - `private`：定向发给 `toRoleId` 对应的账号，**仅在线可达、不落库**（离线转 mail 是
 *   后续刀）。收件人不在线时整条拒绝（含发送者回显）——「发出去了但对面永远收不到」
 *   比「发不出去」更伤体验。
 *
 * ## 回显
 * 发送者自己也会收到这条帧（与收件人同形）：客户端只在收到帧时把消息上屏，
 * **不在发送时本地追加** —— 顺序、成功与否、帮会名都以服务端回的为准，两端不会各说各话。
 */
@Injectable()
export class ChatService implements OnApplicationShutdown {
  /** 限频滑窗内每账号的发送时刻（dropAccount / shutdown 时清掉） */
  private readonly sentAt = new Map<string, number[]>();

  /** 投递出口：按账号列表发同一帧（RealtimeService 接到自己的连接表上） */
  onDeliver: ((accountIds: string[], entry: RealtimeChatEntry) => void) | null = null;

  /** 拒绝出口：给发送者回一条 error 帧（低频操作，值得明确告知而不是悄悄丢弃） */
  onReject: ((accountId: string, message: string) => void) | null = null;

  /**
   * 连接在不在（私聊的「对方在线吗」判据；RealtimeService 接到自己的连接表上）
   *
   * ChatService 刻意不持有连接表：那是通道的私产，这里只要一个布尔答案。
   */
  isConnected: ((accountId: string) => boolean) | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly presence: PlayerPresenceService,
    private readonly world: WorldService,
    private readonly guilds: GuildRepository,
    private readonly roles: RoleRepository,
  ) {}

  onApplicationShutdown(): void {
    this.sentAt.clear();
  }

  /** 连接断开 / 被踢时限频窗口一并清掉（重连是新会话，不该背旧窗口） */
  dropAccount(accountId: string): void {
    this.sentAt.delete(accountId);
  }

  /** 处理一条来自客户端的聊天消息（已过 JSON 解析；内容合法性全部在这里判） */
  say(accountId: string, request: RealtimeChatMessage["data"]): void {
    const identity = this.presence.identityOf(accountId);
    if (!identity || !identity.roleId) {
      this.reject(accountId, "还没进入世界，无法发言");
      return;
    }

    const text = this.sanitize(request.text);
    if (!text) {
      this.reject(accountId, "消息不能为空");
      return;
    }
    if (text.length > this.maxLength()) {
      this.reject(accountId, `消息最长 ${this.maxLength()} 字`);
      return;
    }
    if (!this.allowSend(accountId)) {
      this.reject(accountId, "发言太频繁，稍后再试");
      return;
    }

    switch (request.channel) {
      case "world":
        this.sayWorld(accountId, identity, text);
        return;
      case "guild":
        this.sayGuild(accountId, identity, text);
        return;
      case "private":
        this.sayPrivate(accountId, identity, text, request.toRoleId ?? "");
        return;
      default:
        this.reject(accountId, "不认识的频道");
    }
  }

  //#region 三个频道

  /** 世界频道：同图观看者（发送者也在观看者集合里，天然带回显） */
  private sayWorld(accountId: string, identity: SpeakerIdentity, text: string): void {
    this.deliver([...this.world.viewersOf(identity.zoneId, identity.mapId)], accountId, identity, {
      channel: "world",
      text,
      from: { guildName: identity.guildName },
    });
  }

  /** 帮会频道：帮会全部在线成员（成员身份以库为准；帮会名用库里现查的，不用缓存值） */
  private sayGuild(accountId: string, identity: SpeakerIdentity, text: string): void {
    const guild = this.guilds.guildOfRole(identity.roleId);
    if (!guild) {
      this.reject(accountId, "你还没有帮会，帮会频道不可用");
      return;
    }
    const roleIds = this.guilds.members(guild.id).map((member) => member.role_id);
    const accountIds = this.roles.findManyByIds(roleIds).map((role) => role.account_id);
    this.deliver(accountIds, accountId, identity, {
      channel: "guild",
      text,
      from: { guildName: guild.name },
    });
  }

  /** 私聊：定向发给收件人 + 给发送者回显；收件人不在线整条拒绝 */
  private sayPrivate(accountId: string, identity: SpeakerIdentity, text: string, toRoleId: string): void {
    if (!toRoleId) {
      this.reject(accountId, "缺少私聊对象");
      return;
    }
    const target = this.roles.findById(toRoleId);
    if (!target) {
      this.reject(accountId, "查无此人");
      return;
    }
    if (target.id === identity.roleId) {
      this.reject(accountId, "不能私聊自己");
      return;
    }
    // 仅在线可达（issue #395 的口径）：收件人不在线整条拒绝（含发送者回显）——
    // 「发出去了但对面永远收不到」比「发不出去」更伤体验；离线转 mail 是后续刀
    if (!this.isConnected || !this.isConnected(target.account_id)) {
      this.reject(accountId, "对方不在线，消息没有送达");
      return;
    }
    this.deliver([target.account_id, accountId], accountId, identity, {
      channel: "private",
      text,
      from: { guildName: identity.guildName },
      to: { accountId: target.account_id, roleId: target.id, username: target.name },
    });
  }

  //#endregion

  //#region 内部

  /**
   * 投递一帧（组好完整的 entry 交给出口；接收方是否真的连着由 RealtimeService 判）
   *
   * 接收方列表里必须包含发送者自己（世界 / 帮会天然如此；私聊显式带上）——
   * 客户端只在收到帧时上屏，回显就是「服务端确认过的成功」。
   */
  private deliver(
    accountIds: string[],
    senderAccountId: string,
    identity: SpeakerIdentity,
    partial: Pick<RealtimeChatEntry, "channel" | "text"> & {
      from: Pick<RealtimeChatEntry["from"], "guildName">;
      to?: RealtimeChatEntry["to"];
    },
  ): void {
    if (!this.onDeliver) return;
    this.onDeliver(accountIds, {
      ...partial,
      ts: Date.now(),
      from: {
        accountId: senderAccountId,
        roleId: identity.roleId,
        username: identity.username,
        guildName: partial.from.guildName,
      },
    });
  }

  /** 正文净化：去首尾空白 + 折叠连续空白；敏感词过滤在此占位（首版无词表） */
  private sanitize(text: unknown): string {
    if (typeof text !== "string") return "";
    // 敏感词 hook：未来在这里替换 / 拒绝词表命中（词表进配置或管理端，另开刀）
    return text.replace(/\s+/g, " ").trim();
  }

  /** 滑窗限频：窗口内的发送次数达到上限就拒绝（通过校验的消息才计数） */
  private allowSend(accountId: string): boolean {
    const now = Date.now();
    const windowMs = this.rateWindowMs();
    const timestamps = (this.sentAt.get(accountId) ?? []).filter((ts) => now - ts < windowMs);
    if (timestamps.length >= this.rateLimit()) {
      this.sentAt.set(accountId, timestamps);
      return false;
    }
    timestamps.push(now);
    this.sentAt.set(accountId, timestamps);
    return true;
  }

  private reject(accountId: string, message: string): void {
    if (this.onReject) this.onReject(accountId, message);
  }

  private maxLength(): number {
    return Math.max(1, Number(this.config.get<number>("chatMaxLength") ?? 120));
  }

  private rateLimit(): number {
    return Math.max(1, Number(this.config.get<number>("chatRateLimit") ?? 5));
  }

  private rateWindowMs(): number {
    return Math.max(1000, Number(this.config.get<number>("chatRateWindowMs") ?? 10_000));
  }

  //#endregion
}
