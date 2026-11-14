import { useCallback, useEffect, useMemo, useState } from "react";
import { combatWeightsApi, formatTime, PERMISSION } from "../api";
import type { CombatWeightsResponse, UpdateCombatWeights } from "../api";
import { Button, Card, Field, Input, Spinner } from "../components/ui";
import { PageHeader } from "../components/PageHeader";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";

/**
 * 战斗力权重（#605）
 *
 * 七项倍率决定「一点属性算多少战力」：战力 = Σ 属性 × 权重（区间属性按**上下限之和**，
 * 生命按单值，每秒回血不计入）。战力又是**地图准入门槛**（`maps.combat`）的刻度 ——
 * 所以这一页改的不是「面板上的一个数字」，而是全服的准入标尺。
 *
 * ## 为什么只有一页七行、没有增删
 * 权重表有哪几项由算法决定（`shared/combat-seed.ts` 的 `COMBAT_WEIGHTS_SEED`），
 * 运营改的是「每一项值多少」。后台能加一行的话，服务端 `computeCombat` 也不认识它 ——
 * 那是「存了但不生效」的假功能，所以干脆不提供。
 *
 * ## 双端同源
 * 保存后服务端**立即**用新倍率算属性（覆盖层重装）；客户端在玩家**下次进游戏拉配置快照**
 * 时拿到同一组数字（`applyCombatWeights`），本地「这件装备是不是更好」的提示跟着变。
 *
 * ## 数字先按字符串收
 * 与运行时参数页同一手法：`Number("")` 是 0、`Number("1.")` 是 1，边输边转会把半截输入
 * 变成 0 存进草稿（输入框自己跳回 0，看起来像卡住）。保存时统一 parse + 校验。
 */
export function CombatWeightsPage() {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [row, setRow] = useState<CombatWeightsResponse | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await combatWeightsApi.get();
      setRow(data);
      setDraft(toDraft(data));
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setField = (key: WeightKey, value: string) => {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  };

  /** 七项全 0 = 所有人战力恒 0 = 所有地图准入失效（服务端也会拒，这里先拦住） */
  const allZero = useMemo(() => {
    if (!draft) return false;
    return WEIGHT_FIELDS.every((field) => Number(draft[field.key]) === 0);
  }, [draft]);

  const save = async () => {
    if (!draft) return;
    const payload = buildPayload(draft);
    if (!payload) return;
    setSaving(true);
    try {
      const data = await combatWeightsApi.update(payload);
      setRow(data);
      setDraft(toDraft(data));
      toastSuccess("战斗力权重已保存（服务端下一笔结算即按新倍率；玩家下次进游戏拉配置后同步）");
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="战斗力权重"
        description={
          <>
            战力 = Σ 属性 × 权重：区间属性（三系攻击 / 三系防御）按<b>上下限之和</b>乘倍率，生命按单值乘，
            每秒回血不计入。战力是地图准入门槛的刻度，改这里等于重新标定全服准入。
            {row ? <span className="ml-1 text-ink-5">上次修改：{formatTime(row.updatedAt)}</span> : null}
          </>
        }
      />

      <Card
        title="七项倍率"
        actions={
          loading ? (
            <Spinner />
          ) : canWrite ? (
            <Button disabled={!draft || saving || allZero} loading={saving} onClick={() => void save()}>
              保存权重
            </Button>
          ) : null
        }
        description={
          canWrite
            ? "允许两位小数（例如物攻 4.5）。改完服务端立即按新倍率算属性；客户端在玩家下次进游戏拉配置快照后生效。"
            : "当前角色没有「修改养成配置」权限，本页只读。"
        }
      >
        {draft ? (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {WEIGHT_FIELDS.map((field) => (
                <Field key={field.key} label={field.label} hint={field.hint}>
                  <Input
                    type="number"
                    min={0}
                    max={1000}
                    step={0.01}
                    value={draft[field.key] ?? ""}
                    disabled={!canWrite}
                    onChange={(event) => setField(field.key, event.target.value)}
                  />
                </Field>
              ))}
            </div>
            {allZero ? (
              <p className="text-xs text-warn">
                七项不能同时为 0：那会让所有角色的战力都变成 0，地图准入门槛全部失效。
              </p>
            ) : null}
          </div>
        ) : null}
      </Card>
    </div>
  );
}

//#region 字段描述（顺序即页面上的顺序）

type WeightKey = "maxHp" | "physicalAttack" | "magicAttack" | "taoistAttack" | "physicalDefense" | "magicDefense" | "taoistDefense";

type Draft = Record<WeightKey, string>;

interface FieldSpec {
  key: WeightKey;
  label: string;
  hint: string;
}

const WEIGHT_FIELDS: FieldSpec[] = [
  { key: "maxHp", label: "生命上限", hint: "每 1 点生命算多少战力（出厂 15）" },
  { key: "physicalAttack", label: "物理攻击", hint: "上下限之和 × 倍率（出厂 5）" },
  { key: "magicAttack", label: "魔法攻击", hint: "上下限之和 × 倍率（出厂 5）" },
  { key: "taoistAttack", label: "道术攻击", hint: "上下限之和 × 倍率（出厂 5）" },
  { key: "physicalDefense", label: "物理防御", hint: "上下限之和 × 倍率（出厂 10）" },
  { key: "magicDefense", label: "魔法防御", hint: "上下限之和 × 倍率（出厂 10）" },
  { key: "taoistDefense", label: "道术防御", hint: "上下限之和 × 倍率（出厂 10）" },
];

//#endregion

//#region 草稿 ↔ 生效值

function toDraft(row: CombatWeightsResponse): Draft {
  return {
    maxHp: String(row.weights.maxHp),
    physicalAttack: String(row.weights.physicalAttack),
    magicAttack: String(row.weights.magicAttack),
    taoistAttack: String(row.weights.taoistAttack),
    physicalDefense: String(row.weights.physicalDefense),
    magicDefense: String(row.weights.magicDefense),
    taoistDefense: String(row.weights.taoistDefense),
  };
}

/**
 * 草稿 → 提交体
 *
 * **逐字段显式列**而不是 `Object.fromEntries`：拼错一个键会被服务端的白名单静默剥掉，
 * 结果就是「保存成功但没生效」—— 那是最难查的一类问题。显式列出来，拼错在类型层就红。
 * 任一字段不是数字（空 / 半截输入）就整份不提交（返回 null，按钮本来就是 disabled 状态）。
 */
function buildPayload(values: Draft): UpdateCombatWeights | null {
  const num = (key: WeightKey): number | null => {
    const raw = values[key];
    const parsed = Number(raw);
    return raw !== undefined && raw.trim() !== "" && Number.isFinite(parsed) ? parsed : null;
  };
  const maxHp = num("maxHp");
  const physicalAttack = num("physicalAttack");
  const magicAttack = num("magicAttack");
  const taoistAttack = num("taoistAttack");
  const physicalDefense = num("physicalDefense");
  const magicDefense = num("magicDefense");
  const taoistDefense = num("taoistDefense");
  if (
    maxHp === null ||
    physicalAttack === null ||
    magicAttack === null ||
    taoistAttack === null ||
    physicalDefense === null ||
    magicDefense === null ||
    taoistDefense === null
  ) {
    return null;
  }
  return { maxHp, physicalAttack, magicAttack, taoistAttack, physicalDefense, magicDefense, taoistDefense };
}

//#endregion
