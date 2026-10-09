/**
 * 邮件模板（**唯一来源**：模板是数据，不是代码）
 *
 * 三条硬规矩：
 * 1. 模板的标题与正文**只写在这里**，业务代码里不许出现邮件正文字符串 ——
 *    改一句文案不该动 TypeScript；
 * 2. 渲染是**纯函数**（`renderMail`），因此可以直接单测 / 直接推理，不依赖任何 Nest 装配；
 * 3. 必填变量**缺失就拒发**（见 `missingVariables`），绝不留空 ——
 *    「亲爱的 ，你被封禁了」这种信发出去比不发更糟。
 */

/** 邮件模板 */
export interface MailTemplate {
  /** 模板标识（入队时存进 `mail_queue.template_key`） */
  key: string;
  /** 模板中文名（管理端下拉框用它） */
  name: string;
  /** 模板用途说明（管理端提示运营这封信该填什么） */
  hint: string;
  /**
   * 必填变量名（渲染时缺一个就拒发）
   *
   * 声明在这里而不是从正文里扫 `{{}}` 反推：反推会把「注释里提到的变量」也算进去，
   * 而且模板改一个字就悄悄改了接口契约。
   */
  variables: string[];
  /** 标题模板（`{{变量名}}` 为占位符） */
  subject: string;
  /** 正文模板（纯文本，换行用 \n） */
  body: string;
}

/** 自定义模板：标题与正文由运营在发信时直接填写（变量为空） */
export const MAIL_TEMPLATE_CUSTOM = "custom";

/** 全部模板（顺序即管理端下拉框的展示顺序） */
export const MAIL_TEMPLATES: MailTemplate[] = [
  {
    key: "welcome",
    name: "欢迎邮件",
    hint: "新玩家注册后的欢迎信",
    variables: ["username"],
    subject: "欢迎来到 olua，{{username}}",
    body:
      "{{username}} 你好：\n\n" +
      "欢迎加入 olua。你的账号已经可以正常登录，如果登录遇到问题，回复这封邮件即可。\n\n" +
      "—— olua 运营团队",
  },
  {
    key: "banNotice",
    name: "封禁通知",
    hint: "告知玩家账号被封禁的原因与解除时间（不会自动解封，仅作通知）",
    variables: ["username", "reason", "until"],
    subject: "关于账号 {{username}} 的封禁通知",
    body:
      "{{username}} 你好：\n\n" +
      "你的账号因「{{reason}}」被封禁。\n" +
      "解除时间：{{until}}（填「永久」表示不自动解除）。\n\n" +
      "如果认为这是误判，请回复这封邮件说明情况。\n\n" +
      "—— olua 运营团队",
  },
  {
    key: "maintenance",
    name: "停机维护",
    hint: "提前通知玩家维护窗口，减少维护时的客诉",
    variables: ["startTime", "duration"],
    subject: "olua 停机维护通知",
    body:
      "亲爱的玩家：\n\n" +
      "我们计划在 {{startTime}} 进行一次停机维护，预计持续 {{duration}}。\n" +
      "维护期间无法登录，请提前下线以免丢失进度。\n\n" +
      "—— olua 运营团队",
  },
  {
    key: MAIL_TEMPLATE_CUSTOM,
    name: "自定义",
    hint: "标题与正文由你直接填写，不使用模板",
    variables: [],
    subject: "",
    body: "",
  },
];

/** 按 key 取模板（不存在返回 undefined，由调用方决定报哪个业务码） */
export function findMailTemplate(key: string): MailTemplate | undefined {
  return MAIL_TEMPLATES.find((item) => item.key === key);
}

/** 模板 key 是否合法（DTO 的 @IsIn 与文档 inline enum 共用） */
export const MAIL_TEMPLATE_KEYS: string[] = MAIL_TEMPLATES.map((item) => item.key);

/** 取模板必填变量里**没给值**的那些（顺序与声明一致，便于直接展示给运营） */
export function missingVariables(template: MailTemplate, variables: Record<string, string>): string[] {
  return template.variables.filter((name) => !String(variables[name] ?? "").trim());
}

/**
 * 渲染一封邮件
 *
 * 自定义模板走另一条路：标题与正文由调用方给（`custom`），不做占位符替换 ——
 * 运营自己写的正文里出现 `{{}}` 是字面内容，不该被当成占位符吃掉。
 */
export function renderMail(
  template: MailTemplate,
  variables: Record<string, string>,
  custom?: { subject?: string; body?: string },
): { subject: string; body: string } {
  if (template.key === MAIL_TEMPLATE_CUSTOM) {
    return { subject: custom?.subject ?? "", body: custom?.body ?? "" };
  }
  return { subject: substitute(template.subject, variables), body: substitute(template.body, variables) };
}

/** 占位符 `{{name}}` → 变量值（未声明的占位符替换为空串，不至于把 `{{}}` 原文发出去） */
function substitute(text: string, variables: Record<string, string>): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, name: string) => String(variables[name] ?? ""));
}
