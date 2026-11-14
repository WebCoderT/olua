import type { ReactNode } from "react";
import { Link } from "react-router-dom";

/**
 * 页头：全站唯一实现（标题 / 说明 / 右侧操作 / 返回）
 *
 * 为什么要它：三十个页面原来各写一遍
 * `<div><h1 className="text-lg …"/><p className="mt-1 text-xs …"/></div>`，
 * 抄着抄着就漂了 —— `text-xl` 一档、`text-ink-1` 一档、说明 `mt-1` 与 `mt-0.5` 混着用，
 * 换页面时「字在跳」。统一在这里产出的好处是：改字号只改一处，而且**新页面没有别的写法可选**。
 *
 * 三条约定（见技能 `.workbuddy/skills/olua-admin-ui`）：
 * 1. 标题只有一档 —— 衬线 + 字距（`font-display`），列表页与详情页之间不该有字号差；
 * 2. 说明写「为什么 / 边界」，不写「这里能改什么」（后者界面自己会说），且控制在两行内；
 * 3. 右侧只放页面级动作（查询 / 新建 / 刷新），**不放危险操作**（删除归行内或底部条）。
 *
 * 视觉（legend）：标题下的金暗色发丝线是全站唯一的「页面开始」信号，
 * 有它之后内容区不必再加分隔块 —— 这也是设计稿里 `.head` 的做法。
 */
export function PageHeader({
  title,
  description,
  actions,
  back,
}: {
  /** 标题主体：可以塞 `Badge`（在线）/ 修订号这类紧贴标题的信息 */
  title: ReactNode;
  /** 一行说明：这页为什么长这样、有什么坑 */
  description?: ReactNode;
  /** 右侧动作区，自动换行 */
  actions?: ReactNode;
  /** 详情页的返回入口（列表页不传） */
  back?: { to: string; label?: string };
}) {
  return (
    <div className="flex flex-col gap-2 pb-3">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          {back ? (
            <Link
              to={back.to}
              className="mb-1 inline-flex items-center gap-1 font-mono text-[10.5px] tracking-[.12em] text-ink-4 transition-colors hover:text-gold"
            >
              <span aria-hidden="true">←</span>
              {back.label ?? "返回"}
            </Link>
          ) : null}
          <h1 className="flex min-w-0 flex-wrap items-center gap-2 font-display text-[22px] font-bold leading-tight tracking-[.10em] text-ink-1">
            {title}
          </h1>
          {description ? <p className="mt-1 text-xs leading-relaxed text-ink-4">{description}</p> : null}
        </div>
        {/* `ml-auto`：说明很长时动作区会换到第二行，换行后仍贴右，不会孤零零飘在左边 */}
        {actions ? <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      <hr className="legend-rule" />
    </div>
  );
}
