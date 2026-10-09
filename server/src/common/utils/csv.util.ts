/**
 * 极简 CSV 构建（导出功能用）
 *
 * 只做两件事：按 RFC 4180 转义、加 UTF-8 BOM。**有意不引依赖** ——
 * 导出的列不多，一个「拼字符串」的函数比一个库更好审，也不用为它承担供应链风险。
 */

/** UTF-8 BOM：Excel 靠它认出这是 UTF-8，否则用 Excel 打开中文全是乱码 */
export const CSV_BOM = "\uFEFF";

/**
 * 会被表格软件当成公式开头的字符（CSV 注入）
 *
 * 导出的字段里有大量**用户可控**的内容（账号名、角色名、封禁原因、路径…）。
 * 一个叫 `=HYPERLINK("http://evil","点我")` 的账号名，导出后一打开就会执行 —— 这是真事。
 */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/** 单个单元格：永远加引号 + 转义内部引号 + 防公式注入 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '""';
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  // 前面加单引号把「像公式的值」钉成文本（表格软件里 `'=1+1` 就是字面量）
  const safe = FORMULA_PREFIX.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

/**
 * 拼一份完整 CSV（含表头与 BOM）
 *
 * 行尾用 CRLF：Excel 对它最不挑，而 LF-only 的老版本会在单元格里显示成一行。
 */
export function buildCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  return `${CSV_BOM}${lines.join("\r\n")}\r\n`;
}

/** 本地时间戳串（`YYYYMMDD-HHmmss`），用于导出文件名 */
export function fileStamp(date: Date, prefix: string): string {
  const pad = (num: number) => String(num).padStart(2, "0");
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${prefix}-${day}-${time}`;
}

/** 本地可读时间（`YYYY-MM-DD HH:mm:ss`；导出给运营看的，不是机器读的） */
export function localDateTime(ms: number): string {
  const date = new Date(ms);
  const pad = (num: number) => String(num).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}
