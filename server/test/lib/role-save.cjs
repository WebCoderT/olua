/**
 * 玩家存档 PUT 的公共帮手（#820 / B62）
 *
 * 为什么要抽出来：`revision` 自 #820 起是**必填**（不传即 400 / 40000），
 * 而 e2e 里有几十处存档调用原本都是「直接 PUT 一份 data」。
 * 每处自己写「先 GET 拿修订号」既啰嗦、又容易拿错对象（GET 别的角色、用上一次的旧值），
 * 所以收成一个函数：**GET 当前详情 → 取服务端 revision → 带着它 PUT**。
 *
 * 这份实现刻意保持「薄」：
 * - **不吞错误**：返回的就是 PUT 的响应，断言口径由调用方自己写。
 * - **不给默认值**：GET 失败时 `revision` 会是 `undefined`，PUT 就老实返 400 ——
 *   这正是想要的信号（说明准备步骤断了），而不是「悄悄补一个 0 再放行」。
 * - **专测冲突的用例不要用它**：要验 20006 / 400 的调用必须自己构造「过期的 revision」，
 *   这里每次都取最新，永远撞不上。
 */

/**
 * 从响应里取「角色详情」这一层
 *
 * e2e 的 `api()` 有**两种**返回形状，这个帮手要两种都能用：
 * - `{ status, body }` —— 原始信封（`test/e2e.cjs` 那一派，`body` 是 `{code,message,data}`）
 * - `{ status, code, message, data }` —— 拆过信封（角色专项那几个文件，`data` 才是载荷）
 *
 * 所以分两步：先找到信封（有 `body` 就用 `body`，否则响应本身就是信封），
 * 再从信封里取 `data` 那一层。**两步都要**：只做第一步的话，
 * `{status, body}` 那种形态拿到的是 `{code,message,data}`，里面没有 `revision` ——
 * 而 `revision` 取不到的表现是「写接口 400」，看起来像接口坏了，完全看不出是帮手取错了层。
 *
 * 出错响应（`data` 为 null）时返回信封本身：它没有 `revision`，
 * 调用方那次写会老实撞 400 —— 那正是「准备步骤断了」该发出的信号。
 */
function payloadOf(response) {
  if (!response || typeof response !== "object") return null;
  const envelope = response.body && typeof response.body === "object" ? response.body : response;
  if (envelope.data && typeof envelope.data === "object") return envelope.data;
  return envelope;
}

/**
 * 取角色当前的修订号（#820 / B62）
 *
 * 所有「写角色」的接口都要求带基线，测试里几十处调用都要先取一次。
 *
 * @param {(method: string, route: string, options?: object) => Promise<object>} request 已绑定 baseUrl 的请求函数
 * @param {string} roleId
 * @param {string} token
 * @param {string} routePrefix 路由前缀。多数文件的 baseUrl 已经含 `/api`，路由写 `roles/…` 就够；
 *        `e2e-game-config` 的 baseUrl 只有协议+端口、路由自带 `/api` —— 那种传 `"/api"`
 * @returns {Promise<number|undefined>} 取不到就是 undefined（调用方那次写会 400，正是「准备步骤断了」的信号）
 */
async function revOfWith(request, roleId, token, routePrefix = "") {
  // 不传 prefix 时保持 `roles/…`（配合 `${baseUrl}/${route}` 的拼法）；
  // 传了就变成 `/api/roles/…`（配合 `${baseUrl}${route}` 的拼法）
  const route = routePrefix ? `${routePrefix}/roles/${roleId}` : `roles/${roleId}`;
  const detail = payloadOf(await request("GET", route, { token }));
  return detail ? detail.revision : undefined;
}

/**
 * 存档 PUT（全量覆盖）
 *
 * @param {(method: string, route: string, options?: object) => Promise<object>} api
 *        调用方测试文件自己的请求函数（已绑定 baseUrl 的那种，签名 `(method, route, options)`）
 * @param {string} token  Bearer
 * @param {string} roleId 角色 id
 * @param {object} data   要写入的存档文档（全量覆盖）
 * @returns {Promise<object>} PUT 的原始响应（形状与传进来的 `api` 一致）
 */
async function saveRole(api, token, roleId, data) {
  const revision = await revOfWith(api, roleId, token);
  return api("PUT", `roles/${roleId}`, { token, body: { data, revision } });
}

module.exports = { saveRole, revOfWith };
