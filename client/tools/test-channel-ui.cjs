#!/usr/bin/env node
/**
 * 分线 UI 守卫单测（client/tools/test-channel-ui.cjs，issue #1016）
 *
 * 盯的不变量（改换线入口 / 选线弹窗 / world 帧消费之后必须全绿）：
 * A. world 帧的线字段进契约：WorldSnapshot 有 roomId / slot / channel / capacity，RealtimeClient 分发 changeChannelResult
 * B. 换线是纯实时通道操作：通道不在线 / 已有请求在途时**发不出去**（返回 false），调用方提示而不是干等
 * C. 结果落场：dispatchChangeChannelResult 只认在途请求、成功记账（lastChannel）、超时按失败收场
 * D. 小地图标题：channel > 0 才拼「· N 线」，公共线（0）保持纯图名；线号永远是服务端 channel + 1
 * E. 换线入口：maxChannels > 1 才渲染（单线图保持装饰图）；数据读配置快照 + world 帧，开弹窗不拉接口
 * F. 不重进场景：换线全程不出现 SceneManager.loadScene —— 客户端按新 world 帧就地重建（旧实体靠服务端 entityLeave/world 差量清）
 * G. 离开游戏清理：Game.onDestroy 撤掉在途请求并清线状态
 *
 * 表现层依赖 cc（Node / Graphics / Label），沙箱起不来 —— 与排行榜守卫同一取向：
 * 这里做**源码契约断言**，界面行为由真机验证。
 */
const fs = require("fs");
const path = require("path");
const { dialogsSourceFor } = require("./lib/layout-dialogs-src.cjs");
const { PROJECT_ROOT, check, finish } = require("./lib/configs-sandbox.cjs");

const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");

const COMBAT_CHANNEL = "assets/ui/utils/net/CombatChannel.ts";
const REALTIME_CLIENT = "assets/ui/utils/net/RealtimeClient.ts";
const SMALL_MAP = "assets/ui/components/hud/SmallMap.ts";
const CHANNEL_DIALOG = "assets/ui/components/dialogs/ChannelSelectDialog.ts";
const GAME = "assets/ui/Game.ts";
const TEXTS = "assets/configs/texts.ts";
const DIALOGS_LAYOUT = "assets/configs/layout/dialogs";

/** 数一个字符串出现次数 */
const count = (source, needle) => source.split(needle).length - 1;
/** 去掉注释后的源码（断言「没有再调某个东西」时排除注释里的提法） */
const strip = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

try {
  const combat = read(COMBAT_CHANNEL);
  const realtime = strip(read(REALTIME_CLIENT));
  const smallMap = strip(read(SMALL_MAP));
  const dialog = read(CHANNEL_DIALOG);
  const game = strip(read(GAME));
  const texts = read(TEXTS);
  const dialogsLayout = dialogsSourceFor(path.join(PROJECT_ROOT, DIALOGS_LAYOUT));

  console.log("\n— A. world 帧的线字段进契约 —");
  check(/roomId\?: string/.test(combat) && /slot\?: string/.test(combat), "WorldSnapshot 带 roomId / slot（#1000 服务端已发，客户端接住）");
  check(/channel\?: number/.test(combat) && /capacity\?: number/.test(combat), "WorldSnapshot 带 channel / capacity");
  check(/dispatchChangeChannelResult/.test(realtime) && /"changeChannelResult"/.test(realtime), "RealtimeClient 分发 changeChannelResult 帧");

  console.log("\n— B. 换线的发送纪律 —");
  check(/if \(!this\.active\) return false;/.test(combat), "通道不在线时不发（返回 false，调用方提示而不是干等）");
  check(/if \(this\.pendingChangeChannel\) return false;/.test(combat), "已有请求在途时不发（一次只换一条）");
  check(/type: "changeChannel", data: \{ channel \}/.test(combat), "上行就是 changeChannel + 目标线号");
  check(/timedOut: true/.test(combat) && /换线判定超时/.test(combat), "超时按失败收场（timedOut），弹窗不会永远转圈");
  check(/static cancelChangeChannel/.test(combat) && /clearTimeout\(pending\.timer\)/.test(combat), "有撤掉在途请求的出口（场景销毁用）");

  console.log("\n— C. 结果落场 —");
  check(/if \(!pending\) \{/.test(strip(combat)) && /收到没有对应请求的换线结果/.test(combat), "迟到的应答不落场（只认在途请求）");
  check(/if \(result\.ok\) this\.lastChannel = result\.channel;/.test(combat), "成功先记账（弹窗关窗要立刻用上正确的线号）");
  check(/static get currentChannel/.test(combat) && /return this\.lastChannel;/.test(combat), "显示层读 currentChannel（线归服务端定，客户端不自己推算）");
  check(/static resetChannel\(\): void \{\s*\n\s*this\.lastChannel = 0;/.test(combat), "resetChannel 清线状态（离开游戏用）");

  console.log("\n— D. 小地图标题带线号 —");
  check(/map_channel_suffix/.test(smallMap), "线号副文字走文案 key（不在组件里写死「· N 线」）");
  check(
    /const suffix = channel > 0 \? getText\("map_channel_suffix", \{ channel: channel \+ 1 \}\) : ""/.test(smallMap),
    "channel > 0 才显示副文字，公共线为空（稿 .map-head 的 span）",
  );
  check(/getText\("map_channel_suffix", \{ channel: channel \+ 1 \}\)/.test(smallMap), "玩家视角线号 = 服务端 channel + 1");

  console.log("\n— E. 换线入口的渲染条件 —");
  check(/config\.maxChannels > 1/.test(smallMap), "maxChannels > 1 才算交互入口（单线图保持装饰图）");
  check(/maps\.get\(role\.onMap\)/.test(smallMap), "线数读配置快照的 maps（#812 已下发，开弹窗不拉接口）");
  check(/CombatChannel\.currentChannel/.test(smallMap), "当前线读 world 帧带回的 channel");
  check(
    /if \(key === "channel"\) bindPointerAction\(button, \(\) => this\.openChannelSelect\(\), this\)/.test(smallMap),
    "「线路」入口是 rail 里的描边图标（稿 .map-rail 的 7 颗之一）",
  );
  check(/channelDialog\.open\(config\.maxChannels, CombatChannel\.currentChannel\)/.test(read(SMALL_MAP)), "弹窗拿到线数与当前线");
  check(/channel_select_title/.test(texts) && /channelSelectLayout/.test(dialogsLayout), "弹窗标题文案与布局配置都已登记");

  console.log("\n— F. 不重进场景 —");
  check(!/SceneManager/.test(smallMap) && !/loadScene/.test(smallMap), "SmallMap 不碰 SceneManager（换线不换图）");
  check(!/SceneManager/.test(strip(dialog)) && !/loadScene/.test(strip(dialog)), "选线弹窗不碰 SceneManager（重建靠 world 帧，旧实体靠服务端清）");
  check(/requestChangeChannel\(channel, \(result\) => this\.applyResult\(channel, result\)\)/.test(dialog), "弹窗发换线并等应答（服务端总是回帧）");
  check(/channel === this\.currentChannel/.test(dialog), "点自己所在的线本地挡下（不浪费一次往返）");
  check(/result\.suggestChannel \+ 1/.test(dialog), "满员提示带上服务端指的空线（线号 +1 转玩家视角）");
  check(/for \(let channel = 0; channel < maxChannels; channel \+= 1\)/.test(dialog), "列全部线（0..maxChannels-1）");

  console.log("\n— G. 离开游戏清理 —");
  check(/cancelChangeChannel\(\)/.test(game) && /resetChannel\(\)/.test(game), "Game.onDestroy 撤请求 + 清线状态（新会话标题不带旧线后缀）");

  finish("分线 UI 守卫全部通过");
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
}
