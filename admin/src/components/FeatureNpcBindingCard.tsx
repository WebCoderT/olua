import { useCallback, useEffect, useState } from "react";
import { npcsApi, PERMISSION } from "../api";
import type { Npc } from "../api";
import { Badge, Button, Card, Field, Select, Spinner } from "./ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";

/** 入口功能键（与服务端 npcs.feature 的取值对齐） */
export type NpcFeature = "title" | "soul" | "rank";

const FEATURE_TEXT: Record<NpcFeature, string> = {
  title: "称号",
  soul: "战魂",
  rank: "军衔",
};

/**
 * 入口 NPC 绑定卡片（#1369）
 *
 * 称号 / 战魂 / 军衔三个配置页各放一张：从 NPC 清单里选一个作为该功能的入口 NPC，
 * 保存走 `adminNpc.update`（PATCH feature）。服务端保证互斥 —— 绑给新 NPC 时，
 * 同功能在别的 NPC 上的旧绑定自动清掉，一个功能同时只挂一个 NPC。
 *
 * 绑完在地图编辑里把这个 NPC 点放到图上，客户端点击它就直接打开对应弹窗
 * （客户端按快照 `npcs.feature` 路由：title → 称号升级 / soul → 战魂 / rank → 军衔升级）。
 */
export function FeatureNpcBindingCard({ feature }: { feature: NpcFeature }) {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [npcs, setNpcs] = useState<Npc[] | null>(null);
  const [picked, setPicked] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      // 服务端分页 size 上限 100（#1374）：按 100 一页循环拉全，
      // 防御 NPC 数量超过一页（当前出厂 21 个，超页时才多发请求）
      const size = 100;
      const all: Npc[] = [];
      let page = await npcsApi.list({ page: 1, size });
      all.push(...page.list);
      while (all.length < page.total && page.list.length > 0) {
        page = await npcsApi.list({ page: page.page + 1, size });
        all.push(...page.list);
      }
      setNpcs(all);
      setPicked(all.find((row) => row.feature === feature)?.id ?? "");
    } catch {
      /* 错误已由请求层统一提示 */
    }
  }, [feature]);

  useEffect(() => {
    void load();
  }, [load]);

  const bound = npcs?.find((row) => row.feature === feature) ?? null;

  const save = async () => {
    if (!npcs) return;
    setSaving(true);
    try {
      await npcsApi.update(picked, { feature: picked === "" ? "" : feature });
      toastSuccess(
        picked === ""
          ? `${FEATURE_TEXT[feature]}入口 NPC 已解绑`
          : `${FEATURE_TEXT[feature]}入口已绑到 ${picked}（原绑定已自动清掉）`,
      );
      await load();
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title={`${FEATURE_TEXT[feature]}入口 NPC`}
      description={
        <>
          玩家点击这个 NPC 直接打开{FEATURE_TEXT[feature]}弹窗；一个功能同时只绑一个 NPC（换绑会自动清掉旧绑定）。
          绑定后在「地图管理」把该 NPC 点放到图上即可生效，改完下次进游戏生效。
        </>
      }
    >
      {!npcs ? (
        <Spinner />
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <Field width="w-72" label="绑定 NPC">
            <Select
              value={picked}
              disabled={!canWrite || saving}
              onChange={(event) => setPicked(event.target.value)}
            >
              <option value="">无绑定</option>
              {npcs.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.id} · {row.label}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            variant="primary"
            loading={saving}
            disabled={!canWrite || saving}
            onClick={() => void save()}
          >
            保存绑定
          </Button>
          <span className="flex items-center gap-1 text-sm">
            当前绑定：
            {bound ? (
              <Badge tone="gold">
                {bound.id} · {bound.label}
              </Badge>
            ) : (
              <Badge tone="muted">无</Badge>
            )}
          </span>
        </div>
      )}
    </Card>
  );
}
