import type { ReactNode } from "react";
import { Button, Card, Spinner } from "./ui";

/**
 * 筛选条：**一横排若干条件块 + 右侧动作**，条件块内部是上下结构
 *
 * ## 结构（2026-11-01 用户口径）
 * 每个条件 = 一个 `Field`（标签在上、控件在下），若干块横向排成一行，
 * 右侧 `ml-auto` 放「新建 / 查询 / 重置」。**不是**「标签和输入框同一行」——
 * 那种写法下标签会吃掉控件宽度，输入框反而更窄，且标签一长就整条换行。
 *
 * 判据：1440 宽下角色管理页 6 个条件 + 查询/重置排成一行（不再折行）。
 *
 * ## 宽度受控
 * `Input` / `Select` 自带 `w-full`，所以宽度只能由**外层块**给：`<Field width="w-48">`。
 * 短枚举 `w-20`~`w-24`、文本搜索 `w-40`~`w-56`。别在控件上写 `w-*`（同属性冲突）。
 *
 * ## 用法
 * ```tsx
 * <FilterBar loading={loading} onSearch={submitSearch} onReset={reset}
 *   extra={<Button onClick={openCreate}>新建</Button>}>
 *   <Field label="角色名 / id" width="w-48">
 *     <Input value={q} onChange={…} aria-label="角色名或 id" />
 *   </Field>
 *   <Field label="在线" width="w-24"><Select …>…</Select></Field>
 * </FilterBar>
 * ```
 */
export function FilterBar({
  children,
  onSearch,
  onReset,
  loading = false,
  extra,
  hint,
  searchText = "查询",
}: {
  /** 筛选条件块（`Field`），宽度给 `Field width`，不要给控件 */
  children: ReactNode;
  onSearch?: () => void;
  onReset?: () => void;
  loading?: boolean;
  /** 右侧额外动作（新建 / 导出…），排在「查询」左边 */
  extra?: ReactNode;
  /** 筛选条下方的一行说明（如「当前只显示某账号的角色」） */
  hint?: ReactNode;
  searchText?: string;
}) {
  return (
    <Card>
      <div className="flex flex-wrap items-end gap-2">
        {children}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {extra}
          {onSearch ? (
            <Button onClick={onSearch} loading={loading}>
              {searchText}
            </Button>
          ) : null}
          {onReset ? (
            <Button variant="outline" onClick={onReset} disabled={loading}>
              重置
            </Button>
          ) : null}
          {!onSearch && !onReset && loading ? <Spinner /> : null}
        </div>
      </div>
      {hint ? <p className="mt-2 text-xs text-slate-500">{hint}</p> : null}
    </Card>
  );
}
