/**
 * 通用 NPC 对话框布局（#1337）
 *
 * 视觉稿：design/olua-ui/screens/24-npc-dialog.html
 * 面板本体是 **prefab**（client/assets/resources/ui/NpcDialog.prefab），
 * 这里只放运行时代码必须知道的路径、节点名与分页口径 —— 改版式请直接改 prefab，
 * 别回到组件里用代码拼节点。
 */
export const npcDialogLayout = {
  /** resources.load 路径（prefab 与其纯色图随仓库入库，其余 resources 仍不入库） */
  prefabPath: "ui/NpcDialog",
  /** 设计稿尺寸；运行时只按设计分辨率把 prefab 实例贴到屏幕底边，不改它的宽高 */
  size: { width: 1920, height: 324 },
  /** prefab 里的固定层级前缀（组件拼路径用，不在组件里散写资源样式路径字面量） */
  paths: {
    header: "Header/",
    body: "Body/",
    footer: "Footer/",
    actions: "Footer/Actions/",
  },
  /** prefab 节点名：组件靠这些名字取引用，重命名节点要同步这里 */
  nodes: {
    name: "Name",
    meta: "Meta",
    portraitGlyph: "PortraitGlyph",
    hint: "Hint",
    text: "Text",
    page: "PageLabel",
    dots: "Dots",
    keyHint: "KeyHint",
    close: "CloseButton",
    accept: "AcceptButton",
    submit: "SubmitButton",
    next: "NextButton",
  },
  /** 每页最多字符数（正文 20px / 1560 宽，约两到三行） */
  maxChars: 130,
  /** 每页最多物理行数（含手动换行） */
  maxLines: 3,
  /** 进度点最多显示几枚（超过就只亮前几枚，不增加 prefab 节点） */
  maxDots: 6,
};

/** 按钮文案 key（用 getText 取，组件里不写中文） */
export const npcDialogTexts = {
  empty: "npc_dialog_empty",
  intro: "npc_dialog_intro",
  unknownNpc: "npc_dialog_unknown",
  accept: "label_npc_dialog_accept",
  submit: "label_npc_dialog_submit",
  next: "label_npc_dialog_next",
  done: "label_npc_dialog_done",
  meta: "npc_dialog_meta",
  hint: "npc_dialog_hint",
  keyHint: "npc_dialog_key_hint",
  accepted: "npc_dialog_accepted_tip",
  submitted: "npc_dialog_submitted_tip",
};
