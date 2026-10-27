#!/usr/bin/env node
/**
 * 聊天单测（client/tools/test-chat.cjs，issue #395）
 *
 * 盯的不变量（改 ChatStore / 聊天协议 / 聊天服务端纪律后必须全绿）：
 * A. 消息仓（**跑真类**）：回显即成功（自己的消息不计未读）、未读按频道累计与清除、
 *    每频道 50 条封顶、私聊会话双向过滤、会话对象最近优先且去重
 * B. 协议两端同形：服务端 RealtimeChatEntry 与客户端 ChatEntry 字段一致，
 *    CHAT_CHANNELS 三频道两端一致
 * C. 服务端转发纪律：世界频道复用互见观看者（不做全服连接索引）、帮会准入每次查库、
 *    私聊离线整条拒绝、回显即成功（客户端不在发送时本地追加）
 * D. 客户端消费纪律：CombatChannel.onChat 只喂 ChatStore（单一落点）、
 *    弹窗开着挂起气泡、切场景 ChatStore/ChatBubbles 都 reset
 *
 * ChatStore 刻意不 import cc（见它的类注释），沙箱直接编译真源码跑断言。
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");

const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");
/** PROJECT_ROOT 是 client/ 目录，服务端与根目录下的文件要往上走一层 */
const readRepo = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, "..", rel), "utf8");

const SERVER_PROTOCOL = "server/src/modules/realtime/realtime.protocol.ts";
const SERVER_CHAT = "server/src/modules/realtime/chat.service.ts";
const SERVER_REALTIME = "server/src/modules/realtime/realtime.service.ts";
const CLIENT_CHANNEL = "assets/ui/utils/net/CombatChannel.ts";
const CLIENT_STORE = "assets/ui/core/ChatStore.ts";
const CLIENT_BUBBLES = "assets/ui/core/ChatBubbles.ts";
const CLIENT_DIALOG = "assets/ui/components/dialogs/ChatDialog.ts";
const CLIENT_GAME = "assets/ui/Game.ts";

/** 从一段源码里抽出某个 interface 的字段名（两空格缩进 + 可选 ?；注释行不匹配） */
function fieldNames(source, interfaceName) {
  const block = new RegExp(`export interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`).exec(source);
  if (!block) return null;
  return Array.from(block[1].matchAll(/^ {2}(\w+)\??:/gm)).map((match) => match[1]);
}

/** 从源码里抽出某个 const 数组的字符串字面量（频道清单这类一行数组） */
function stringArray(source, constName) {
  const block = new RegExp(`export const ${constName} = \\[([^\\]]*)\\]`).exec(source);
  if (!block) return null;
  return Array.from(block[1].matchAll(/"(\w+)"/g)).map((match) => match[1]);
}

let failures = 0;
const guard = (fn) => {
  try {
    fn();
  } catch (error) {
    failures += 1;
    console.log(`  [!!] 单测抛异常：${error && error.stack ? error.stack.split("\n")[0] : error}`);
  }
};

try {
  const outDir = prepare("olua-chat", ["ui/core/ChatStore.ts"]);
  const ChatStore = require(path.join(outDir, "ui/core/ChatStore.js")).default;

  //#region A. 消息仓（跑真类）

  console.log("\n— A. 消息仓：回显即成功 / 未读 / 封顶 / 会话 —");

  guard(() => {
    ChatStore.reset();
    ChatStore.setSelf("account_me");
    const mine = { channel: "world", text: "我自己说的", ts: 1, from: { accountId: "account_me", roleId: "r_me", username: "我", guildName: "" } };
    ChatStore.applyEntry(mine);
    check(ChatStore.unreadOf("world") === 0, "自己的回显不计未读（回显即成功，不是新消息）");
    check(ChatStore.list("world").length === 1, "自己的消息也上屏（回显要进列表，不然自己看不见自己说过话）");

    const other = { channel: "world", text: "你好", ts: 2, from: { accountId: "account_x", roleId: "r_x", username: "路人", guildName: "" } };
    ChatStore.applyEntry(other);
    check(ChatStore.unreadOf("world") === 1, "别人的消息未读 +1");
    ChatStore.markRead("world");
    check(ChatStore.unreadOf("world") === 0, "markRead 清零");
    check(ChatStore.list("world").length === 2, "已读不清列表（消息还在，只是不亮角标）");

    const unknown = { channel: "world", text: "坏帧", ts: 3, from: null };
    ChatStore.applyEntry(unknown);
    check(ChatStore.list("world").length === 2, "缺 from 的坏帧直接丢弃（不进列表）");
  });

  guard(() => {
    ChatStore.reset();
    ChatStore.setSelf("me");
    for (let i = 0; i < 60; i++) {
      ChatStore.applyEntry({ channel: "guild", text: `m${i}`, ts: i, from: { accountId: "a", roleId: "r", username: "u", guildName: "" } });
    }
    const list = ChatStore.list("guild");
    check(list.length === 50, "每频道 50 条封顶（超限从头丢）");
    check(list[0].text === "m10" && list[49].text === "m59", "丢的是最旧的（尾端最新）");
  });

  guard(() => {
    ChatStore.reset();
    ChatStore.setSelf("me");
    // B 发来一条（B 是 from）、我回一条（B 在 to）——会话要把两侧都算上
    ChatStore.applyEntry({ channel: "private", text: "在吗", ts: 1, from: { accountId: "acc_b", roleId: "r_b", username: "乙", guildName: "" } });
    ChatStore.applyEntry({ channel: "private", text: "在的", ts: 2, from: { accountId: "me", roleId: "r_me", username: "我", guildName: "" }, to: { accountId: "acc_b", roleId: "r_b", username: "乙" } });
    const conversation = ChatStore.conversationWith("r_b");
    check(conversation.length === 2, "私聊会话双向过滤（from 或 to 是这个人就算）");
    ChatStore.applyEntry({ channel: "private", text: "第三个", ts: 3, from: { accountId: "acc_c", roleId: "r_c", username: "丙", guildName: "" } });
    check(ChatStore.conversationWith("r_b").length === 2, "别人的私聊不进这个会话");

    const peers = ChatStore.privatePeers();
    check(peers.length === 2, "会话对象从消息里聚出来（不单独存储）");
    check(peers[0].roleId === "r_c" && peers[1].roleId === "r_b", "最近聊过的排前面（倒序扫描天然得到）");
    check(!peers.some((peer) => peer.roleId === "r_me"), "自己不出现在会话对象里（我发的消息取 to 侧）");
    check(peers.every((peer) => peer.username), "对象带名字（选人列表直接显示，不用再查）");
  });

  guard(() => {
    ChatStore.reset();
    let fired = 0;
    const off = ChatStore.onChange(() => (fired += 1));
    ChatStore.applyEntry({ channel: "world", text: "x", ts: 1, from: { accountId: "a", roleId: "r", username: "u", guildName: "" } });
    check(fired === 1, "onChange 在新消息时触发（气泡 / 角标靠它刷新）");
    off();
    ChatStore.applyEntry({ channel: "world", text: "y", ts: 2, from: { accountId: "a", roleId: "r", username: "u", guildName: "" } });
    check(fired === 1, "退订后不再触发（订阅函数成对给）");
    ChatStore.reset();
    check(ChatStore.list("world").length === 0 && ChatStore.unreadOf("world") === 0, "reset 清空（切场景不留旧消息）");
  });

  //#endregion

  //#region B. 协议两端同形

  console.log("\n— B. 协议两端同形（聊天帧字段与频道清单） —");

  const serverProtocol = readRepo(SERVER_PROTOCOL);
  const clientChannel = read(CLIENT_CHANNEL);

  guard(() => {
    const serverChannels = stringArray(serverProtocol, "CHAT_CHANNELS");
    const clientChannels = stringArray(clientChannel, "CHAT_CHANNELS");
    check(
      JSON.stringify(serverChannels) === JSON.stringify(clientChannels) && serverChannels.join(",") === "world,guild,private",
      "CHAT_CHANNELS 两端一致（world / guild / private）",
      JSON.stringify(serverChannels),
    );
  });

  guard(() => {
    const serverEntry = fieldNames(serverProtocol, "RealtimeChatEntry");
    const clientEntry = fieldNames(clientChannel, "ChatEntry");
    check(
      JSON.stringify(serverEntry) === JSON.stringify(clientEntry),
      "聊天帧字段两端同形（channel / text / ts / from / to）",
      `${JSON.stringify(serverEntry)} vs ${JSON.stringify(clientEntry)}`,
    );
    // from / to 的嵌套字段用函数式接口名对不上 fieldNames，直接比对源码片段
    const serverFrom = /from: \{([\s\S]*?)\};/.exec(serverProtocol)[1].matchAll(/(\w+):/g);
    const clientFrom = /from: \{([\s\S]*?)\};/.exec(clientChannel)[1].matchAll(/(\w+):/g);
    const serverFromFields = [...serverFrom].map((m) => m[1]).filter((f) => f !== "channel" && f !== "text");
    const clientFromFields = [...clientFrom].map((m) => m[1]).filter((f) => f !== "channel" && f !== "text");
    check(
      JSON.stringify(serverFromFields) === JSON.stringify(clientFromFields),
      "from 的字段两端同形（accountId / roleId / username / guildName）",
      `${JSON.stringify(serverFromFields)} vs ${JSON.stringify(clientFromFields)}`,
    );
  });

  //#endregion

  //#region C. 服务端转发纪律

  console.log("\n— C. 服务端纪律：观看者复用 / 准入查库 / 离线拒绝 / 回显 —");

  const serverChat = readRepo(SERVER_CHAT);
  const serverRealtime = readRepo(SERVER_REALTIME);

  check(/viewersOf\(identity\.zoneId, identity\.mapId\)/.test(serverChat), "世界频道复用互见的观看者集合（不为聊天另建全服连接索引）");
  check(/guildOfRole\(identity\.roleId\)/.test(serverChat) && !/identity\.guildId/.test(serverChat.split("sayGuild")[1] || ""), "帮会准入每次查库（不用在场的懒刷新缓存）");
  check(/isConnected\(target\.account_id\)/.test(serverChat), "私聊收件人不在线整条拒绝（不制造发出去但没人收到的消息）");
  check(/对方不在线/.test(serverChat), "离线拒绝有明确文案（玩家得知道为什么没发出去）");
  check(/sanitize\(request\.text\)/.test(serverChat) && /text\.replace\(/.test(serverChat), "正文净化在服务端（trim + 折叠空白；敏感词 hook 占位）");
  check(/allowSend\(accountId\)/.test(serverChat) && /sentAt/.test(serverChat), "限频在服务端（滑窗计数；客户端校验只是省往返）");
  check(/chat\.dropAccount/.test(serverRealtime), "断线清理限频窗口（重连是新会话，不背旧窗口）");
  check(/type: "chat", data: entry/.test(serverRealtime) || /RealtimeChatBroadcast = \{ type: "chat", data: entry \}/.test(serverRealtime), "投递出口按观看者列表发同一帧（含发送者自己的回显）");

  //#endregion

  //#region D. 客户端消费纪律

  console.log("\n— D. 客户端纪律：单一落点 / 气泡挂起 / 切场景清理 —");

  const clientStore = read(CLIENT_STORE);
  const clientBubbles = read(CLIENT_BUBBLES);
  const clientDialog = read(CLIENT_DIALOG);
  const clientGame = read(CLIENT_GAME);

  check(/import type \{ ChatChannel, ChatEntry \}/.test(clientStore), "ChatStore 只 type-import 协议（不 import cc，单测能直接跑真类）");
  check(/applyEntry/.test(clientGame) && /ChatStore\.setSelf/.test(clientGame), "组合根把 chat 帧只喂 ChatStore（单一落点，气泡/面板各自订阅）");
  check(/ChatStore\.reset\(\)/.test(clientGame) && /ChatBubbles\.reset\(\)/.test(clientGame), "切场景消息仓与气泡一起清（不跨会话持久）");
  check(/setSuppressed\(true\)/.test(clientDialog) && /setSuppressed\(false\)/.test(clientDialog), "弹窗开合挂起 / 恢复气泡（同一条消息不两头出现）");
  check(/markRead\(tab\)/.test(clientDialog), "切页即已读（页签角标只在关着的时候累计）");
  check(/sendChat\(this\.tab, text, toRoleId\)/.test(clientDialog), "发送走 CombatChannel（连接不在 OPEN 态返回 false，输入保留）");
  check(!/channel === "world" && this\.appendLocal|本地追加/.test(clientDialog), "发送侧不做本地追加（回显才是成功，双写必然出现幽灵消息）");
  check(/relationOfAccount/.test(clientDialog), "消息名字颜色读 OtherPlayerManager 的关系缓存（判定唯一入口仍是 resolveRelation）");
  check(/privatePeers\(\)/.test(clientDialog) && /nearby\(\)/.test(clientDialog), "私聊候选 = 聊过的 + 附近的人（两个天然来源）");

  //#endregion
} catch (error) {
  fail(error);
}

if (failures > 0) {
  console.log(`\n❌ 聊天单测：${failures} 组失败`);
  process.exit(1);
}
finish("✅ 聊天单测全绿");
