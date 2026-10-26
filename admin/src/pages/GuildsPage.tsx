import { useCallback, useEffect, useState } from "react";
import { formatTime, guildsApi, PERMISSION } from "../api";
import type { AdminGuild, AdminGuildDetail } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Badge, Button, Card, EmptyState, Field, Input, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";

/**
 * 帮会管理（#388）
 *
 * 运营视角看的是**组织关系**：谁建的帮、多少人、成员都是谁。玩家侧的「入帮申请」
 * 是帮主自己的待办，不在这里（管理员只在违规时改名 / 改公告 / 强制解散）。
 *
 * 解散会连删成员表（一群人瞬间没有帮会），所以走二次确认，弹窗里把代价写明白。
 */
export function GuildsPage() {
  const canWrite = hasPermission(PERMISSION.GUILD_WRITE);
  const [guilds, setGuilds] = useState<AdminGuild[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminGuildDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // 编辑表单（只两个字段：名字与公告；提交时不带没改的字段）
  const [name, setName] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [removing, setRemoving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await guildsApi.list();
      setGuilds(list);
      // 选中项已被别人解散：直接清掉右侧面板，别留一份「已经不存在的帮会」
      setSelectedId((current) => (current && list.some((item) => item.id === current) ? current : null));
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openDetail = useCallback(async (id: string) => {
    setSelectedId(id);
    setDetailLoading(true);
    try {
      const data = await guildsApi.detail(id);
      setDetail(data);
      setName(data.name);
      setNotice(data.notice);
    } catch {
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    void openDetail(selectedId);
  }, [selectedId, openDetail]);

  const nameValid = name.trim().length >= 2 && name.trim().length <= 12;
  const dirty = detail !== null && (name.trim() !== detail.name || notice.trim() !== detail.notice);

  const submitSave = async () => {
    if (!detail) return;
    setSaving(true);
    try {
      const patch: { name?: string; notice?: string } = {};
      // 只提交动过的字段：没改名字却把名字发上去，会平白触发一次唯一性校验
      if (name.trim() !== detail.name) patch.name = name.trim();
      if (notice.trim() !== detail.notice) patch.notice = notice.trim();
      const updated = await guildsApi.update(detail.id, patch);
      setDetail(updated);
      setName(updated.name);
      setNotice(updated.notice);
      toastSuccess("帮会信息已保存");
      await load();
    } catch {
      /* 失败请求层已统一提示（重名 50102 等） */
    } finally {
      setSaving(false);
    }
  };

  const submitRemove = async () => {
    if (!detail) return;
    setRemoving(true);
    try {
      await guildsApi.remove(detail.id);
      toastSuccess(`帮会「${detail.name}」已解散`);
      setConfirmOpen(false);
      setSelectedId(null);
      await load();
    } catch {
      /* 失败请求层已统一提示 */
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">帮会管理</h1>
          <p className="mt-1 text-sm text-slate-400">
            玩家自发组织的帮会与被解散处置。玩家侧的入帮申请是帮主自己的待办，这里不介入。
          </p>
        </div>
        <Button variant="outline" onClick={() => void load()} loading={loading}>
          刷新
        </Button>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <Card className="overflow-hidden">
          {loading && guilds === null ? (
            <div className="flex justify-center py-16">
              <Spinner />
            </div>
          ) : guilds && guilds.length > 0 ? (
            <div className="overflow-x-auto">
              <table className={tableClass}>
                <thead className={theadClass}>
                  <tr>
                    <th className={thClass}>帮会</th>
                    <th className={thClass}>帮主</th>
                    <th className={thClass}>人数</th>
                    <th className={thClass}>等级</th>
                    <th className={thClass}>创建时间</th>
                  </tr>
                </thead>
                <tbody>
                  {guilds.map((guild) => (
                    <tr
                      key={guild.id}
                      onClick={() => setSelectedId(guild.id)}
                      className={`cursor-pointer transition hover:bg-slate-800/60 ${
                        selectedId === guild.id ? "bg-slate-800/80" : ""
                      }`}
                    >
                      <td className={tdClass}>
                        <div className="font-medium text-slate-100">{guild.name}</div>
                        <div className="text-xs text-slate-500">{guild.id}</div>
                      </td>
                      <td className={tdClass}>{guild.leaderName || "—"}</td>
                      <td className={tdClass}>{guild.memberCount}</td>
                      <td className={tdClass}>
                        <Badge tone="slate">Lv.{guild.level}</Badge>
                      </td>
                      <td className={tdClass}>{formatTime(guild.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState title="还没有帮会" description="玩家在游戏里创建帮会后会出现在这里。" />
          )}
        </Card>

        <Card className="p-5">
          {!selectedId ? (
            <EmptyState title="选择一个帮会" description="左侧点一行查看成员名单，并可改名 / 改公告 / 解散。" />
          ) : detailLoading && !detail ? (
            <div className="flex justify-center py-16">
              <Spinner />
            </div>
          ) : detail ? (
            <div className="space-y-4">
              <div>
                <div className="text-base font-semibold text-slate-100">{detail.name}</div>
                <div className="mt-1 text-xs text-slate-500">
                  {detail.id} · 帮主 {detail.leaderName || "—"} · {detail.memberCount} 人 · 创建于 {formatTime(detail.createdAt)}
                </div>
              </div>

              <Field label="帮会名（2~12 字，全局唯一）">
                <Input value={name} onChange={(event) => setName(event.target.value)} disabled={!canWrite} maxLength={12} />
              </Field>
              <Field label="公告（0~200 字）">
                <Input value={notice} onChange={(event) => setNotice(event.target.value)} disabled={!canWrite} maxLength={200} />
              </Field>
              {!nameValid ? <p className="text-xs text-rose-400">帮会名需为 2~12 字。</p> : null}

              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void submitSave()} loading={saving} disabled={!canWrite || !dirty || !nameValid}>
                  保存
                </Button>
                <Button variant="danger" onClick={() => setConfirmOpen(true)} disabled={!canWrite}>
                  解散帮会
                </Button>
              </div>

              <div>
                <div className="mb-2 text-sm font-medium text-slate-300">成员（{detail.members.length}）</div>
                <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
                  {detail.members.map((member) => (
                    <div
                      key={member.roleId}
                      className="flex items-center justify-between rounded-lg border border-slate-800 px-3 py-2 text-sm"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-slate-200">{member.name}</div>
                        <div className="text-xs text-slate-500">
                          Lv.{member.level} · {member.roleId}
                        </div>
                      </div>
                      <Badge tone={member.rank === "leader" ? "amber" : member.rank === "vice" ? "indigo" : "slate"}>
                        {member.rankLabel}
                      </Badge>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <EmptyState title="读取失败" description="这个帮会可能刚被解散，刷新列表再看。" />
          )}
        </Card>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title={`解散「${detail?.name ?? ""}」`}
        description="成员关系与待审批申请会一并删除，不可恢复。这一步不走玩家侧流程，玩家不会收到通知。"
        confirmText="确认解散"
        loading={removing}
        onConfirm={() => void submitRemove()}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
