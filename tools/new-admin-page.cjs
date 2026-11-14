#!/usr/bin/env node
/**
 * 管理端页面脚手架 —— 让新页面从「已经合规」的代码开始（#946 阶段四）
 *
 * 生成的骨架自带：
 * - `PageHeader`（守点规则 require-page-header / no-handwritten-header）
 * - `FilterBar` + `Field`（no-handwritten-field-label）
 * - 三态（loading / empty / 数据），表格走 ui.tsx 的 tableClass 四件套
 * - 服务端分页（Pagination）
 * - 文件级 `__UI_CAPTURE__` 状态清单（截图工具按状态出图，供人眼审 —— 纪律：显示效果不写断言）
 *
 * 颜色、圆角、字号全部来自组件内部 —— 页面 className 里只写布局类，
 * 这是守点脚本 `no-legacy-palette` / `no-raw-color` 的要求。
 *
 * 用法：
 *   npm run new:page -- ItemQuest            （生成 ItemQuestPage.tsx，标题取名字）
 *   npm run new:page -- ItemQuest 物品任务页  （显式给中文标题）
 *
 * 生成后还差三步（脚本会提醒）：在 api/ 里补接口与类型、在 App.tsx 挂路由、
 * 在 Layout.tsx 的 NAV 里挂导航（记得带 permission）。
 */
const fs = require("node:fs");
const path = require("node:path");

const PAGES_DIR = path.resolve(__dirname, "../admin/src/pages");

const [rawName, rawTitle] = process.argv.slice(2);

if (!rawName || !/^[A-Z][A-Za-z0-9]*$/.test(rawName)) {
  console.error("用法：npm run new:page -- <PascalName> [中文标题]\n  例：npm run new:page -- ItemQuest 物品任务");
  process.exit(1);
}

const component = `${rawName}Page`;
const file = path.join(PAGES_DIR, `${component}.tsx`);
if (fs.existsSync(file)) {
  console.error(`✗ ${path.relative(process.cwd(), file)} 已存在，不动它`);
  process.exit(1);
}

/** 资源名 → 中文（用于标题与文案的默认值） */
const title = rawTitle || rawName;

const content = `import { useCallback, useEffect, useState } from "react";
import { PERMISSION } from "../api";
import { Badge, Button, Card, EmptyState, Field, Input, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { FilterBar } from "../components/FilterBar";
import { Pagination } from "../components/Pagination";
import { PageHeader } from "../components/PageHeader";
import { hasPermission } from "../store/session";

/**
 * ${title}（TODO：这页管什么、有什么坑，两三行说清楚）
 *
 * ${"```"}
 * __UI_CAPTURE__（截图清单 —— 截图工具按 id 逐状态出图，供人眼审；纪律：显示效果不写断言）
 *   loading      初始加载：骨架 / Spinner 可见
 *   empty        空数据：EmptyState 文案完整
 *   filled       有数据：表格行、徽章、分页齐全
 *   filtered     按关键字过滤后的结果
 * ${"```"}
 */

/** TODO：换成真实行类型（放 api/ 的 models 里，别在页面里定义数据形状） */
interface ${rawName}Row {
  id: number;
  name: string;
  updatedAt: string;
}

export function ${component}() {
  const canWrite = hasPermission(PERMISSION./* TODO: 写权限点 */ZONE_WRITE);

  const [rows, setRows] = useState<${rawName}Row[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [keyword, setKeyword] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // TODO：接真实接口 —— 服务端分页只上报 page / size（/keyword），返回 { items, total }
      // const result = await ${rawName.toLowerCase()}Api.list({ page, size, keyword: keyword || undefined });
      // setRows(result.items); setTotal(result.total);
      setRows([]);
      setTotal(0);
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, [page, size, keyword]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-4">
      <PageHeader
        title="${title}"
        description="TODO：一句话说明这页的口径（谁能看、数据从哪来、有什么坑）"
        actions={
          canWrite ? (
            <Button
              onClick={() => {
                /* TODO：新建走 Modal（ConfirmDialog 只管确认），别用 window.confirm */
              }}
            >
              新建
            </Button>
          ) : null
        }
      />

      <FilterBar onSearch={() => setPage(1)} onReset={() => setKeyword("")} loading={loading}>
        <Field label="关键字" width="w-56">
          <Input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="名称" />
        </Field>
      </FilterBar>

      <Card title="${title}" actions={loading ? <Spinner /> : null} description={canWrite ? undefined : "当前角色没有写权限，页面只读。"}>
        {loading && rows === null ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : rows !== null && rows.length === 0 ? (
          <EmptyState title="还没有数据" description="TODO：空态文案 —— 说明这里会显示什么、第一条数据从哪来" />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className={tableClass}>
                <thead className={theadClass}>
                  <tr>
                    <th className={thClass}>名称</th>
                    <th className={thClass}>更新时间</th>
                    <th className={\`\${thClass} text-right\`}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {(rows ?? []).map((row) => (
                    <tr key={row.id} className="transition hover:bg-surface-4/30">
                      <td className={\`\${tdClass} font-medium text-ink-1\`}>{row.name}</td>
                      <td className={\`\${tdClass} legend-num text-ink-4\`}>{row.updatedAt}</td>
                      <td className={\`\${tdClass} text-right\`}>
                        {canWrite ? (
                          <Button variant="ghost" className="px-2 py-1 text-xs">
                            编辑
                          </Button>
                        ) : (
                          <Badge tone="slate">只读</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={page}
              size={size}
              total={total}
              onChange={setPage}
              onSizeChange={(next) => {
                setSize(next);
                setPage(1);
              }}
            />
          </>
        )}
      </Card>
    </div>
  );
}
`;

fs.writeFileSync(file, content);
console.log(`✓ 已生成 ${path.relative(process.cwd(), file)}`);
console.log("  还差三步：");
console.log("  1. api/ 里补接口与行类型（数据形状不放页面里）");
console.log("  2. App.tsx 挂路由（详情页记得带 back）");
console.log("  3. Layout.tsx 的 NAV 挂导航（带 permission，服务端会独立校验）");
console.log("  完成后跑：node tools/audit-admin-ui.cjs");
