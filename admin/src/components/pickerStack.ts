import { useEffect } from "react";

/**
 * 叠在编辑弹窗之上的选择器计数（Esc / 遮罩放行的唯一判据）
 *
 * 为什么需要它：`ImagePicker`（挑素材文件）与 `EntityPicker`（挑游戏数据行）都复用 `Modal`，
 * 而 `Modal` 的行为之一是「Esc 关闭」。两个 `Modal` 各自往 window 上挂一个监听，编辑弹窗先注册、
 * 先收到 —— 不拦一下就是「关掉选择器顺带把编辑弹窗也关了」，改了一半的内容全丢。
 *
 * 判据是「现在有没有选择器开着」，而不是某个页面自己记的布尔：一个弹窗里可能有三个图标字段
 * （装备的图标 / 内观 / 外观），谁都不该去维护「这三个里哪个开着」。计数放在模块级，
 * 挂载 ++ / 卸载 --，选择器自己登记，调用方只问 `anyPickerOpen()`。
 *
 * 用 Hook 而不是让调用方手动加减：选择器可能是**条件渲染**的（`{open ? <ImagePicker/> : null}`），
 * 也可能是**常挂但 `open=false`** 的；只有 `useEffect(open)` 这一种写法能同时覆盖两种情况，
 * 且卸载路径一定走到（React 保证 cleanup）。
 */
let openCount = 0;

/** 选择器挂上 / 卸下时自动加减（传 `open`，`false` 时不计数） */
export function usePickerStackEntry(open: boolean): void {
  useEffect(() => {
    if (!open) return;
    openCount += 1;
    return () => {
      openCount -= 1;
    };
  }, [open]);
}

/**
 * 有没有选择器开着 —— 给编辑弹窗的 `onClose` 用
 *
 * 用法只有一行：`onClose={() => { if (!anyPickerOpen()) onCancel(); }}`。
 * 别忘了**遮罩点击**走的也是这个 `onClose`（`Modal` 把两者接在一起），所以拦一处就够。
 */
export function anyPickerOpen(): boolean {
  return openCount > 0;
}
