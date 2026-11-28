/**
 * NPC 对话分页（#1337，**纯函数、不 import cc**）
 *
 * 后台 `npcs.dialog` 是最多 2000 字的自由文本，既不假设有换行也不假设有标记；
 * 直接塞进一个 Label 会把 324px 高的底条撑爆，所以按「物理行 + 字符数」双上限切页。
 * 中文按字符计（一个汉字≈一个视觉单位），英文/数字按半宽算也只影响页数，不影响安全。
 */
export interface NpcDialogPageOptions {
  /** 每页最多字符数 */
  maxChars: number;
  /** 每页最多物理行数 */
  maxLines: number;
  /** 空文本兜底 */
  emptyText: string;
}

/** 把一段没有换行的长文本按字符数切块（保住词边界不现实，中文按字切即可） */
export function splitLongLine(text: string, maxChars: number): string[] {
  const limit = maxChars > 0 ? maxChars : 1;
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    parts.push(rest.slice(0, limit));
    rest = rest.slice(limit);
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}

/**
 * 按页聚合：先按原文本的换行断句，再按 maxChars 切块，最后按 maxLines 合页。
 * 连续空行只保留一个段间换行，不浪费版面。
 */
export function paginateDialog(text: string, options: NpcDialogPageOptions): string[] {
  const maxChars = options.maxChars > 0 ? options.maxChars : 1;
  const maxLines = options.maxLines > 0 ? options.maxLines : 1;
  const lines: string[] = [];
  const raw = String(text || "").replace(/\r/g, "");
  const paragraphs = raw.split("\n");
  for (let i = 0; i < paragraphs.length; i++) {
    const paragraph = paragraphs[i].trim();
    if (!paragraph) continue;
    const chunks = splitLongLine(paragraph, maxChars);
    for (let j = 0; j < chunks.length; j++) lines.push(chunks[j]);
  }
  if (lines.length === 0) return [options.emptyText || ""];

  const pages: string[] = [];
  let current: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const wouldExceedChars = current.length > 0 && current.join("\n").length + line.length + 1 > maxChars;
    const wouldExceedLines = current.length >= maxLines;
    if (wouldExceedChars || wouldExceedLines) {
      pages.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) pages.push(current.join("\n"));
  return pages;
}
