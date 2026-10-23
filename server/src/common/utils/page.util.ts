import { PageQueryDto } from "../dto/api-envelope.dto";

/** 分页入参规整（page 从 1 开始，size 限 1~100） */
export function normalizePage(query: PageQueryDto, defaultSize = 20): { page: number; size: number } {
  const page = Math.max(1, Math.floor(Number(query.page ?? 1)) || 1);
  const raw = Math.floor(Number(query.size ?? defaultSize)) || defaultSize;
  const size = Math.min(100, Math.max(1, raw));
  return { page, size };
}
