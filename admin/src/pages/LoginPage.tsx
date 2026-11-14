import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, authApi } from "../api";
import type { ZoneOption } from "../api";
import { APP_TITLE } from "../api/config";
import { readZoneId, saveSession, saveZoneId } from "../store/session";
import "./login-legend.css";

/**
 * 管理端登录页 —— 视觉与 `design/legend-login/index.html` 一一对应
 *
 * 与设计稿的内容差异（用户 2026-11-14 拍板「视觉全留、假内容换真」）：
 * 1. 顶栏去掉「区服 + 在线人数」，保留状态点与标题 —— 登录前拿不到在线人数；
 * 2. 「登录区服」下拉**保留并落地**（#960）：数据来自 `GET /admin/auth/zones`（公开接口），
 *    未选区不能登录 —— 管理端一次只在一个区里干活，这个区是每个请求的上下文；
 * 3. 「忘记密码」改为提示联系超管、「申请权限」指向 /register（系统里没有这两个页面）。
 *
 * 视觉部分是**刻意绕过 PageHeader / Card 那套后台版式**的：登录页是独立视觉语言（衬线大标题、
 * 全屏舞台、金线双框），与后台的密集列表语言不共用组件。这是 olua-admin-ui 白名单里的例外。
 */

const REMEMBER_KEY = "olua-admin-username";

/** 火星：模块级生成一次固定轨迹，避免每次渲染重排 */
const EMBERS = Array.from({ length: 26 }, (_, i) => {
  const seed = (n: number) => (((Math.sin(i * 12.9898 + n) * 43758.5453) % 1) + 1) % 1;
  return {
    key: i,
    left: seed(2) * 100,
    size: seed(1) * 2 + 1,
    drift: seed(3) * 90 - 30,
    duration: 11 + seed(4) * 13,
    delay: -seed(5) * 22,
    opacity: 0.3 + seed(6) * 0.5,
  };
});

export function LoginPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState(() => localStorage.getItem(REMEMBER_KEY) ?? "");
  const [password, setPassword] = useState("");
  /** 可选的区（`GET /admin/auth/zones`，只回 id/name/status/sort，不含已合并的区） */
  const [zones, setZones] = useState<ZoneOption[]>([]);
  const [zoneId, setZoneId] = useState<number | null>(null);
  const [errZone, setErrZone] = useState("");
  const [remember, setRemember] = useState(() => Boolean(localStorage.getItem(REMEMBER_KEY)));
  const [showPwd, setShowPwd] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errAccount, setErrAccount] = useState("");
  const [errPassword, setErrPassword] = useState("");
  const [shake, setShake] = useState<"account" | "password" | null>(null);
  const [toast, setToast] = useState("");
  const toastTimer = useRef<number | null>(null);
  const accountRef = useRef<HTMLInputElement>(null);
  const pwdRef = useRef<HTMLInputElement>(null);

  const isStatic = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("static");

  useEffect(() => {
    accountRef.current?.focus();
  }, []);

  /**
   * 拉可选区清单
   *
   * 登录页是**唯一**需要它的地方之一（另一个是顶栏切换器），所以不放进全局缓存：
   * 拉不到就退回「只有 1 区」的形态并提示 —— 区清单拉不到时不该把人挡在门外，
   * 但也不能让人以为「没得选」就那么进去了（服务端照样会因为 zoneId 不合法而拒）。
   */
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const list = await authApi.zones({ silent: true });
        if (!alive) return;
        setZones(list);
        // 默认值优先级：上次在这个浏览器选的区 → 列表里第一个
        const remembered = readZoneId();
        const pick = list.find((zone) => zone.id === remembered) ?? list[0];
        setZoneId(pick ? pick.id : null);
      } catch {
        if (alive) setZones([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(
    () => () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    },
    [],
  );

  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2200);
  };

  const triggerShake = (which: "account" | "password") => {
    setShake(which);
    window.setTimeout(() => setShake(null), 380);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (loading) return;

    if (zoneId === null) {
      setErrZone("请选择登录区服");
      return;
    }
    if (!username.trim()) {
      setErrAccount("请输入管理账号");
      triggerShake("account");
      accountRef.current?.focus();
      return;
    }
    if (!password.trim()) {
      setErrPassword("请输入登录密码");
      triggerShake("password");
      pwdRef.current?.focus();
      return;
    }
    if (password.trim().length < 6) {
      setErrPassword("密码长度不足 6 位");
      triggerShake("password");
      pwdRef.current?.focus();
      return;
    }
    setErrAccount("");
    setErrPassword("");

    setLoading(true);
    try {
      // 静默：登录页自己就地展示错误，不需要全局提示再弹一次
      const result = await authApi.login({ username, password, zoneId }, { silent: true });
      // 先落区再落会话：http 拦截器靠读它给后续请求加 X-Zone-Id
      saveZoneId(zoneId);
      saveSession(result.token, result.admin);
      if (remember) localStorage.setItem(REMEMBER_KEY, username);
      else localStorage.removeItem(REMEMBER_KEY);
      navigate("/", { replace: true });
    } catch (err) {
      // 账号或密码的错误归属在密码字段（设计稿口径）；不区分「账号不存在」以免枚举账号
      setErrPassword(err instanceof ApiError ? err.message : "登录失败，请稍后重试");
      triggerShake("password");
      pwdRef.current?.focus();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={`legend-login${isStatic ? " static" : ""}`}>
      {/* ═══════ 背景层 ═══════ */}
      <div className="stage" aria-hidden="true">
        <div className="sky" />
        <div className="burn" />

        {/* 远山 + 城堡剪影：只做轮廓，靠雾与暗角吃掉细节 */}
        <svg className="ridge" viewBox="0 0 1600 560" preserveAspectRatio="xMidYMax slice">
          <defs>
            <linearGradient id="ll-hill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--ll-ridge-hi)" />
              <stop offset="100%" stopColor="var(--ll-ridge-lo)" />
            </linearGradient>
            <linearGradient id="ll-keep" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--ll-keep-hi)" />
              <stop offset="100%" stopColor="var(--ll-keep-lo)" />
            </linearGradient>
            <pattern id="ll-merlon" width="26" height="14" patternUnits="userSpaceOnUse">
              <rect width="17" height="14" fill="url(#ll-keep)" />
            </pattern>
            <radialGradient id="ll-glow">
              <stop offset="0%" stopColor="var(--fire-hi)" stopOpacity=".85" />
              <stop offset="100%" stopColor="var(--fire-hi)" stopOpacity="0" />
            </radialGradient>
          </defs>

          {/* 最远山脊 */}
          <path
            fill="url(#ll-hill)"
            opacity=".85"
            d="M0 372 L96 338 L172 356 L268 302 L352 336 L438 296 L524 330 L612 288 L700 322 L790 300 L880 332 L968 300 L1058 336 L1146 306 L1236 340 L1324 312 L1414 344 L1504 318 L1600 348 L1600 560 L0 560 Z"
          />

          {/* 城堡群：中央主塔 + 双侧塔 + 长城墙 + 垛口 */}
          <g fill="url(#ll-keep)">
            <rect x="336" y="452" width="928" height="108" />
            <rect x="336" y="444" width="928" height="14" fill="url(#ll-merlon)" />
            <rect x="432" y="398" width="52" height="162" />
            <polygon points="432,398 458,354 484,398" />
            <rect x="1116" y="406" width="52" height="154" />
            <polygon points="1116,406 1142,364 1168,406" />
            <rect x="596" y="418" width="408" height="142" />
            <rect x="596" y="410" width="408" height="14" fill="url(#ll-merlon)" />
            <rect x="662" y="352" width="62" height="208" />
            <polygon points="662,352 693,300 724,352" />
            <rect x="876" y="368" width="56" height="192" />
            <polygon points="876,368 904,322 932,368" />
            <rect x="760" y="308" width="80" height="252" />
            <polygon points="760,308 800,248 840,308" />
          </g>

          {/* 塔尖旗帜 */}
          <g stroke="var(--ll-keep-edge)" strokeWidth="1.6">
            <path d="M800 248 L800 214" />
          </g>
          <path d="M801 216 L826 222 L801 230 Z" fill="var(--ll-flag)" opacity=".85" />

          {/* 窗火：一片暖光点，让「城」在夜里活着 */}
          <g fill="var(--ll-window)">
            <rect x="794" y="326" width="4" height="7" opacity=".95" />
            <rect x="804" y="326" width="4" height="7" opacity=".8" />
            <rect x="784" y="404" width="4" height="6" opacity=".7" />
            <rect x="812" y="404" width="4" height="6" opacity=".7" />
            <rect x="686" y="392" width="4" height="6" opacity=".7" />
            <rect x="700" y="452" width="4" height="6" opacity=".55" />
            <rect x="898" y="404" width="4" height="6" opacity=".7" />
            <rect x="910" y="452" width="4" height="6" opacity=".55" />
            <rect x="452" y="430" width="3" height="6" opacity=".6" />
            <rect x="1136" y="436" width="3" height="6" opacity=".6" />
            <rect x="520" y="470" width="3" height="5" opacity=".45" />
            <rect x="1060" y="470" width="3" height="5" opacity=".45" />
          </g>
          <ellipse cx="800" cy="330" rx="120" ry="86" fill="url(#ll-glow)" opacity=".55" />
          <ellipse cx="458" cy="380" rx="52" ry="44" fill="url(#ll-glow)" opacity=".3" />
          <ellipse cx="1142" cy="386" rx="52" ry="44" fill="url(#ll-glow)" opacity=".3" />

          {/* 近景乱石与倒插的断矛 */}
          <path
            fill="var(--ll-keep-lo)"
            opacity=".95"
            d="M0 486 L78 468 L146 486 L232 462 L318 488 L410 470 L500 492 L1600 492 L1600 560 L0 560 Z"
          />
          <g stroke="var(--ll-keep-lo)" strokeWidth="3" strokeLinecap="round" opacity=".9">
            <path d="M214 500 L246 424" />
            <path d="M244 500 L270 440" />
            <path d="M1188 504 L1224 432" />
            <path d="M1218 502 L1248 448" />
            <path d="M960 508 L986 462" />
          </g>
          <path d="M246 424 L258 418 L250 434 Z" fill="var(--ll-keep-lo)" />
          <path d="M1224 432 L1238 428 L1228 442 Z" fill="var(--ll-keep-lo)" />
        </svg>

        <div className="fog" />
        <div className="torch" />
        <div className="embers">
          {EMBERS.map((e) => (
            <span
              key={e.key}
              className="ember"
              style={
                {
                  left: `${e.left}%`,
                  width: `${e.size}px`,
                  height: `${e.size}px`,
                  animationDuration: `${e.duration}s`,
                  animationDelay: `${e.delay}s`,
                  opacity: e.opacity,
                  "--drift": `${e.drift}px`,
                } as React.CSSProperties
              }
            />
          ))}
        </div>
        <div className="vignette" />
        <div className="grain" />
      </div>

      {/* ═══════ 内容 ═══════ */}
      <div className="shell">
        <header className="topbar">
          <div className="brand">
            {/* 盾形纹章：外金内石，中间一把剑 */}
            <svg className="crest" viewBox="0 0 34 40" fill="none" aria-hidden="true">
              <path
                d="M17 1.5 L32.2 6.6 V20.4 C32.2 29.6 25.6 35.6 17 38.6 C8.4 35.6 1.8 29.6 1.8 20.4 V6.6 Z"
                stroke="var(--gold)"
                strokeWidth="1.2"
                fill="rgba(201,162,77,.06)"
              />
              <path
                d="M17 5.2 L28.6 9 V20.2 C28.6 27.4 23.4 32.2 17 34.7 C10.6 32.2 5.4 27.4 5.4 20.2 V9 Z"
                stroke="rgba(201,162,77,.35)"
                strokeWidth=".8"
              />
              <path d="M17 10.5 V26.5" stroke="var(--gold-hi)" strokeWidth="1.4" />
              <path d="M12.6 15.4 H21.4" stroke="var(--gold)" strokeWidth="1.1" />
              <path d="M17 26.5 L15 29.6 H19 Z" fill="var(--gold)" />
            </svg>
            <div className="brand-txt">
              <b>OLUA</b>
              <span>LEGEND CONSOLE</span>
            </div>
          </div>

          <div className="meta">
            <span className="alive">
              <i className="dot" />
              <span className="srv">管理端</span>
            </span>
            <i className="sep" />
            <span className="mono only-lg">{APP_TITLE}</span>
          </div>
        </header>

        <main className="body">
          {/* 左：宣言 */}
          <section className="hero">
            <p className="eyebrow">Operations Access</p>
            <h1>
              执剑者，
              <br />
              <em>入席。</em>
            </h1>
            <p className="lede">
              这里是 <b>OLUA 传奇</b> 的唯一管理入口 —— 玩家账号、区服状态、公告与版本下发，皆由此门内决断。
              门内所见，即是全服。
            </p>

            <ul className="creed">
              <li style={{ "--i": 0 } as React.CSSProperties}>
                <span className="no">01</span>
                <div>
                  <h3>账号与权限</h3>
                  <p>角色授权、封禁与申诉，操作留痕可追。</p>
                </div>
              </li>
              <li style={{ "--i": 1 } as React.CSSProperties}>
                <span className="no">02</span>
                <div>
                  <h3>区服与在线</h3>
                  <p>分区负载、实时在线与掉线告警。</p>
                </div>
              </li>
              <li style={{ "--i": 2 } as React.CSSProperties}>
                <span className="no">03</span>
                <div>
                  <h3>公告与版本</h3>
                  <p>停机公告、活动配置与客户端版本下发。</p>
                </div>
              </li>
            </ul>
          </section>

          {/* 右：登录闸门 */}
          <section className="gate">
            <span className="corner tl" />
            <span className="corner tr" />
            <span className="corner bl" />
            <span className="corner br" />

            <form className="panel" onSubmit={submit} noValidate>
              <div className="gate-head">
                <h2>账号登录</h2>
                <p>仅限已授权的管理者 · 非法登录将记录 IP</p>
              </div>

              <div className={`field${errZone ? " invalid" : ""}`}>
                <label htmlFor="zone">登录区服</label>
                <select
                  className="ctrl select"
                  id="zone"
                  value={zoneId ?? ""}
                  aria-describedby="errZone"
                  onChange={(e) => {
                    setZoneId(e.target.value ? Number(e.target.value) : null);
                    if (errZone) setErrZone("");
                  }}
                >
                  <option value="">{zones.length === 0 ? "正在读取区服清单…" : "请选择区服"}</option>
                  {zones.map((zone) => (
                    <option key={zone.id} value={zone.id}>
                      {zone.name}
                      {zone.status === "closed" ? "（已关闭，仅供查历史）" : ""}
                    </option>
                  ))}
                </select>
                <p className="err" id="errZone">
                  {errZone}
                </p>
              </div>

              <div className={`field${errAccount ? " invalid" : ""}${shake === "account" ? " shake" : ""}`}>
                <label htmlFor="account">管理账号</label>
                <input
                  ref={accountRef}
                  className="ctrl"
                  id="account"
                  type="text"
                  placeholder="请输入账号"
                  autoComplete="username"
                  spellCheck={false}
                  aria-describedby="errAccount"
                  value={username}
                  onChange={(e) => {
                    setUsername(e.target.value);
                    if (errAccount) setErrAccount("");
                  }}
                />
                <p className="err" id="errAccount">
                  {errAccount}
                </p>
              </div>

              <div className={`field${errPassword ? " invalid" : ""}${shake === "password" ? " shake" : ""}`}>
                <label htmlFor="password">登录密码</label>
                <div className="pwd">
                  <input
                    ref={pwdRef}
                    className="ctrl"
                    id="password"
                    type={showPwd ? "text" : "password"}
                    placeholder="请输入密码"
                    autoComplete="current-password"
                    aria-describedby="errPassword"
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      if (errPassword) setErrPassword("");
                    }}
                  />
                  <button
                    type="button"
                    className="eye"
                    aria-label={showPwd ? "隐藏密码" : "显示密码"}
                    aria-pressed={showPwd}
                    onClick={() => {
                      setShowPwd((v) => !v);
                      pwdRef.current?.focus();
                    }}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z" />
                      <circle cx="12" cy="12" r="2.6" />
                    </svg>
                  </button>
                </div>
                <p className="err" id="errPassword">
                  {errPassword}
                </p>
              </div>

              <div className="row">
                <label className="check">
                  <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                  <span>记住账号</span>
                </label>
                <button type="button" className="link" onClick={() => showToast("请联系超级管理员重置密码")}>
                  忘记密码
                </button>
              </div>

              <button className="enter" type="submit" disabled={loading}>
                {loading ? "正在校验…" : "进入管理端"}
              </button>

              <p className="foot-note">
                账号由超级管理员开通 · <Link to="/register">注册入口</Link>
              </p>
            </form>
          </section>
        </main>

        <footer className="footer">
          <span>© 2026 OLUA GAMES · 保留所有权利</span>
          <span className="mono">LEGEND CONSOLE</span>
        </footer>
      </div>

      <div className={`toast${toast ? " show" : ""}`} role="status" aria-live="polite">
        {toast}
      </div>
    </div>
  );
}
