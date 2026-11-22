import { BadRequestException, ValidationPipe } from "@nestjs/common";
import { ValidationError } from "class-validator";

/**
 * 全局 ValidationPipe（`main.ts` 与 `main.realtime.ts` 共用，#1172）
 *
 * **校验失败的消息必须全中文**。class-validator 不带 `message` 的装饰器会落回英文
 * 默认模板（`ttlMs must not be less than 10000`），逐处补 message 不现实 —— 全仓有
 * 两百多处裸 `@Min/@Max`（背包 / 货币 / 药品这些客户端接口也在其中），而且「准确」
 * 的中文很难从字段名反推。所以分两层：
 *
 * - **精确层**：管理端要长期看的 DTO（运行时参数、地图这些）逐字段写中文 message，
 *   带单位带边界（`掉落存活时长至少 10 秒（10000 毫秒）`）；
 * - **兜底层（本文件）**：exceptionFactory 对没有自定义 message 的错误做短语级翻译，
 *   并带上属性路径（`drop.ttlMs：不能小于 10000`），保证出口永远是中文。
 *
 * 兜底只翻译 class-validator 的**英文默认模板**（判定标准：整条消息里没有汉字），
 * 自定义中文 message 原样透传、不加路径前缀 —— 字段语义靠写 message 的人给，
 * 这里不猜。
 */

/** 英文默认模板 → 中文（按序匹配，先长后短；`$1` 保留约束值） */
const TRANSLATIONS: Array<[RegExp, string]> = [
  [/each value in ([^ ]+) must be an integer/g, "每一项必须是整数"],
  [/each value in ([^ ]+)/g, "每一项"],
  [/must not be less than ([^.;]+)/g, "不能小于 $1"],
  [/must not be greater than ([^.;]+)/g, "不能大于 $1"],
  [/must be longer than or equal to ([^.;]+)/g, "长度不能少于 $1"],
  [/must be shorter than or equal to ([^.;]+)/g, "长度不能超过 $1"],
  [/must contain no fewer than ([^.;]+?) elements/g, "至少要包含 $1 个元素"],
  [/must contain no more than ([^.;]+?) elements/g, "最多只能包含 $1 个元素"],
  [/must be one of the following values: ([^.;]+)/g, "必须是以下取值之一：$1"],
  [/must match ([^";]+) regular expression/g, "必须符合格式（$1）"],
  [/ characters/g, " 个字符"],
  [/must be an integer/g, "必须是整数"],
  [/must be a boolean value/g, "必须是布尔值"],
  [/must be a string/g, "必须是字符串"],
  [/must be an array/g, "必须是数组"],
  [/must be a number( conforming to the specified constraints)?/g, "必须是数字"],
  [/must be a ([^.;]+)/g, "必须是 $1"],
];

/** 翻译后仍残留英文模板词 → 不认识的模板，收口成固定中文（不把英文漏出去） */
const TEMPLATE_LEFTOVER = /must |should |cannot |failed |each value/;

/** 消息里已经有汉字 = DTO 自己写了中文 message，原样透传 */
function hasChinese(text: string): boolean {
  return /[\u4e00-\u9fa5]/.test(text);
}

/** 单条英文默认模板 → 中文（带约束值；不认识的模板收口成「取值不合法」） */
export function translateConstraintMessage(raw: string): string {
  if (hasChinese(raw)) return raw;
  let text = raw;
  for (const [pattern, replacement] of TRANSLATIONS) {
    text = text.replace(pattern, replacement);
  }
  // 短语替换会留下模板里原有的空格（「每一项 must be …」→「每一项 必须是…」），收口成单空格
  text = text.replace(/\s+/g, " ").trim();
  if (TEMPLATE_LEFTOVER.test(text)) return "取值不合法";
  return text;
}

/**
 * 递归走错误树拼属性路径（嵌套 DTO 的叶子是 `drop.ttlMs` 这样的完整路径），
 * 一条路径上的多个约束用「、」连。
 */
function flattenErrors(errors: ValidationError[], parentPath: string): string[] {
  const messages: string[] = [];
  for (const error of errors) {
    const path = parentPath ? `${parentPath}.${error.property}` : error.property;
    if (error.constraints) {
      for (const raw of Object.values(error.constraints)) {
        const translated = translateConstraintMessage(raw);
        // 自带中文的 message 字段语义已经写全，不再重复路径前缀
        const message = hasChinese(raw) ? translated : `${path}：${translated}`;
        messages.push(message);
      }
    }
    if (error.children?.length) messages.push(...flattenErrors(error.children, path));
  }
  return messages;
}

/** 管理端 / 实时进程共用的全局入参校验管道 */
export function httpValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
    exceptionFactory: (errors) => {
      const messages = flattenErrors(errors, "");
      throw new BadRequestException(messages.length ? messages : ["取值不合法"]);
    },
  });
}
