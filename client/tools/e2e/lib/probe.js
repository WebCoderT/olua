/**
 * Cocos 页面内探针
 *
 * 通过 page.addInitScript 在**页面任何脚本之前**注入，因此能抢到最早的
 * onerror / unhandledrejection，也能在引擎跑起来之后惰性取到 cc。
 *
 * 设计原则：这个文件是**浏览器里跑的代码**，不能 require 任何东西。
 * 所有能力挂在 window.__cocosProbe 上，由 Node 侧通过 page.evaluate 调用。
 *
 * 为什么不用 DOM 选择器点按钮：Cocos 整屏只有一个 canvas，按钮在 canvas 里画出来，
 * DOM 里不存在。要「真的点中那个按钮」，只能从引擎拿节点的世界坐标，再换算成
 * canvas 的 CSS 像素坐标去点。
 */
(() => {
  if (window.__cocosProbe) return;

  const probe = {};
  window.__cocosProbe = probe;

  probe.consoleErrors = [];
  probe.consoleWarns = [];
  probe.pageErrors = [];
  probe.rejections = [];
  probe.logs = [];
  probe.__cc = null;

  const fmt = (value, depth = 0) => {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (typeof value === "string") return value;
    if (value === null || value === undefined) return String(value);
    if (typeof value !== "object") return String(value);
    if (depth > 2) return "[object]";
    if (Array.isArray(value)) return `[${value.slice(0, 8).map((v) => fmt(v, depth + 1)).join(", ")}]`;
    try {
      const keys = Object.keys(value).slice(0, 10);
      return `{${keys.map((k) => `${k}: ${fmt(value[k], depth + 1)}`).join(", ")}}`;
    } catch {
      return "[object]";
    }
  };

  //#region 错误采集（必须最早挂）

  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  console.error = (...args) => {
    probe.consoleErrors.push(args.map((a) => fmt(a)).join(" "));
    origError(...args);
  };
  console.warn = (...args) => {
    probe.consoleWarns.push(args.map((a) => fmt(a)).join(" "));
    origWarn(...args);
  };

  window.addEventListener(
    "error",
    (event) => {
      probe.pageErrors.push({
        message: event.message || fmt(event.error) || "unknown error",
        source: event.filename || "",
        line: event.lineno || 0,
        col: event.colno || 0,
        stack: event.error && event.error.stack ? String(event.error.stack).slice(0, 1200) : "",
      });
    },
    true
  );

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    probe.rejections.push({
      message: reason && reason.message ? String(reason.message) : fmt(reason),
      stack: reason && reason.stack ? String(reason.stack).slice(0, 1200) : "",
    });
  });

  // WebGL 上下文丢失是「玩一会儿黑屏」的典型原因，单独记一笔
  probe.webglContextLost = [];
  window.addEventListener(
    "webglcontextlost",
    (event) => {
      probe.webglContextLost.push({ at: Date.now(), message: "WebGL context lost" });
    },
    true
  );

  //#endregion

  //#region 引擎拿取

  /** 引擎是 SystemJS 模块，没有全局 cc；按顺序尝试，拿到就缓存 */
  probe.getCc = async () => {
    if (probe.__cc) return probe.__cc;
    const candidates = [window.cc, window.__cc, window.CC];
    for (const c of candidates) {
      if (c && c.director && c.view) {
        probe.__cc = c;
        return c;
      }
    }
    if (window.System && typeof window.System.import === "function") {
      for (const spec of ["cc", "cc/env"]) {
        try {
          const mod = await window.System.import(spec);
          if (mod && mod.director) {
            probe.__cc = mod;
            return mod;
          }
        } catch {
          // 换下一个候选
        }
      }
    }
    throw new Error("拿不到 cc 引擎对象（System.import('cc') 失败）");
  };

  /**
   * 组件类名。正式构建（debug:false）会把类名压成单字母，constructor.name 只剩 "e"，
   * 只有引擎自己的 js.getClassName 还能拿到 "Button" / "Label" 这种真名。
   */
  probe.className = (comp) => {
    if (!comp) return "?";
    try {
      const cc = probe.__cc;
      if (cc && cc.js && typeof cc.js.getClassName === "function") {
        const name = cc.js.getClassName(comp);
        if (name) return name;
      }
    } catch {
      // 落到下面的兜底
    }
    const ctor = comp.constructor;
    return (ctor && (ctor.__classname__ || ctor.name)) || "?";
  };

  /** 等首场景启动。返回耗时，超时返回 -1 */
  probe.waitReady = async (timeoutMs = 45000) => {
    const t0 = performance.now();
    for (;;) {
      try {
        const cc = await probe.getCc();
        const scene = cc.director && cc.director.getScene();
        if (scene) return Math.round(performance.now() - t0);
      } catch {
        // 引擎还没注册好
      }
      if (performance.now() - t0 > timeoutMs) return -1;
      await new Promise((r) => setTimeout(r, 120));
    }
  };

  probe.currentScene = async () => {
    const cc = await probe.getCc();
    const scene = cc.director.getScene();
    return scene ? scene.name : null;
  };

  //#endregion

  //#region 坐标换算（整个世界都在这里）

  /**
   * 采集换算所需的全部原始数值。
   * 第一次接通时先看这个，比猜 API 语义靠谱。
   */
  probe.viewportInfo = async () => {
    const cc = await probe.getCc();
    const canvas = document.getElementById("GameCanvas") || document.querySelector("canvas");
    const rect = canvas.getBoundingClientRect();
    const vp = cc.view.getViewportRect();
    return {
      devicePixelRatio: window.devicePixelRatio || 1,
      canvas: {
        cssWidth: rect.width,
        cssHeight: rect.height,
        cssLeft: rect.left,
        cssTop: rect.top,
        pixelWidth: canvas.width,
        pixelHeight: canvas.height,
      },
      view: {
        scaleX: cc.view.getScaleX(),
        scaleY: cc.view.getScaleY(),
        viewport: { x: vp.x, y: vp.y, width: vp.width, height: vp.height },
        visibleSize: cc.view.getVisibleSize(),
        designSize: cc.view.getDesignResolutionSize(),
      },
    };
  };

  /**
   * 世界坐标（设计像素，原点在左下）→ 页面 CSS 像素（原点在左上）
   *
   * viewport 给的是 canvas **物理像素**里的位置，所以要除以 dpr 换成 CSS 像素；
   * getScaleX/Y() 同理已经乘过 dpr，除回来才是「设计像素 → CSS 像素」的系数。
   */
  probe.worldToClient = async (wx, wy) => {
    const cc = await probe.getCc();
    const canvas = document.getElementById("GameCanvas") || document.querySelector("canvas");
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const vp = cc.view.getViewportRect();
    const sx = cc.view.getScaleX() / dpr;
    const sy = cc.view.getScaleY() / dpr;
    return {
      x: rect.left + vp.x / dpr + wx * sx,
      y: rect.top + rect.height - vp.y / dpr - wy * sy,
    };
  };

  /** 节点的世界包围盒 → 页面 CSS 矩形 */
  probe.nodeClientRect = async (node) => {
    const cc = await probe.getCc();
    const ut = node.getComponent(cc.UITransform);
    const wp = node.getWorldPosition();
    if (!ut) {
      const p = await probe.worldToClient(wp.x, wp.y);
      return { x: p.x, y: p.y, width: 0, height: 0, center: { x: p.x, y: p.y } };
    }
    const bb = ut.getBoundingBoxToWorld();
    const bottomLeft = await probe.worldToClient(bb.x, bb.y);
    const topRight = await probe.worldToClient(bb.x + bb.width, bb.y + bb.height);
    return {
      x: bottomLeft.x,
      y: topRight.y,
      width: topRight.x - bottomLeft.x,
      height: bottomLeft.y - topRight.y,
      center: { x: (bottomLeft.x + topRight.x) / 2, y: (bottomLeft.y + topRight.y) / 2 },
      world: { x: bb.x, y: bb.y, width: bb.width, height: bb.height },
    };
  };

  //#endregion

  //#region 节点查找与场景树

  /** 按名字找（返回全部同名节点） */
  probe.findAll = async (name) => {
    const cc = await probe.getCc();
    const scene = cc.director.getScene();
    const hits = [];
    const walk = (node) => {
      if (node.name === name) hits.push(node);
      for (const child of node.children) walk(child);
    };
    if (scene) walk(scene);
    return hits;
  };

  /** 按路径找，例如 "Canvas/UIRoot/BagDialog" */
  probe.findByPath = async (nodePath) => {
    const cc = await probe.getCc();
    const scene = cc.director.getScene();
    if (!scene) return null;
    const parts = nodePath.split("/").filter(Boolean);
    if (parts.length && parts[0] === scene.name) parts.shift();
    let cursor = scene;
    for (const part of parts) {
      const next = cursor.children.find((c) => c.name === part);
      if (!next) return null;
      cursor = next;
    }
    return cursor;
  };

  /**
   * 导出场景树。默认只到 8 层、跳过不可见子树，避免几万个节点把内存和报告撑爆。
   */
  probe.dumpTree = async (options = {}) => {
    const cc = await probe.getCc();
    const scene = cc.director.getScene();
    if (!scene) return null;
    const maxDepth = options.maxDepth ?? 8;
    const includeInactive = options.includeInactive ?? false;
    const withRect = options.withRect ?? true;
    let count = 0;

    const walk = (node, depth) => {
      count += 1;
      const ut = node.getComponent(cc.UITransform);
      const item = {
        name: node.name,
        depth,
        active: node.active,
        activeInHierarchy: node.activeInHierarchy,
      };
      if (ut) {
        const size = ut.contentSize;
        item.size = { width: Math.round(size.width), height: Math.round(size.height) };
        item.anchor = { x: ut.anchorPoint.x, y: ut.anchorPoint.y };
        if (withRect) {
          const bb = ut.getBoundingBoxToWorld();
          item.worldRect = {
            x: Math.round(bb.x),
            y: Math.round(bb.y),
            width: Math.round(bb.width),
            height: Math.round(bb.height),
          };
        }
      }
      const comps = node.components || [];
      if (comps.length) {
        item.components = comps.map((c) => probe.className(c)).filter(Boolean);
      }
      if (depth < maxDepth) {
        const kids = node.children || [];
        const visibleKids = includeInactive ? kids : kids.filter((c) => c.activeInHierarchy);
        item.children = visibleKids.map((c) => walk(c, depth + 1));
      }
      return item;
    };

    const tree = walk(scene, 0);
    return { scene: scene.name, nodeCount: count, tree };
  };

  //#endregion

  //#region 可见性与遮挡（这类问题只有在真引擎里跑才看得见）

  /**
   * 点会不会真的落到这个节点上？
   *
   * 思路：取目标节点的中心点，收集所有包含该点、且 activeInHierarchy 的 UITransform 节点，
   * 按「层级前置顺序」排序（Cocos 的渲染顺序 ≈ 兄弟节点后出现的在上层，跨层级按深度优先），
   * 排在最上面的那个如果不是目标本身或它的祖先/后代，就是被遮挡了。
   *
   * 这是近似判断（不处理 mask / 自定义材质裁剪），但足以抓住「按钮被半透明遮罩挡住」
   * 「弹窗关了但节点还是 active 挡住底层」这类最常见的坑。
   */
  probe.hitTestAt = async (clientX, clientY) => {
    const cc = await probe.getCc();
    const scene = cc.director.getScene();
    const canvas = document.getElementById("GameCanvas") || document.querySelector("canvas");
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const vp = cc.view.getViewportRect();
    const sx = cc.view.getScaleX() / dpr;
    const sy = cc.view.getScaleY() / dpr;

    // 页面坐标 → 世界坐标
    const wx = (clientX - rect.left - vp.x / dpr) / sx;
    const wy = (rect.height - (clientY - rect.top) - vp.y / dpr) / sy;

    const stack = [];
    const walk = (node, order) => {
      if (!node.activeInHierarchy) return;
      const ut = node.getComponent(cc.UITransform);
      if (ut) {
        const bb = ut.getBoundingBoxToWorld();
        const inside = wx >= bb.x && wx <= bb.x + bb.width && wy >= bb.y && wy <= bb.y + bb.height;
        if (inside && bb.width > 1 && bb.height > 1) {
          stack.push({
            name: node.name,
            depth: order.depth,
            siblingIndex: order.index,
            rect: { x: bb.x, y: bb.y, width: bb.width, height: bb.height },
            hasBlockInput: ut.node.getComponent(cc.BlockInputEvents) != null,
            hasButton: node.components.some((c) => probe.className(c) === "Button"),
          });
        }
      }
      node.children.forEach((child, index) => walk(child, { depth: order.depth + 1, index }));
    };
    walk(scene, { depth: 0, index: 0 });

    // 后出现的兄弟在上层 → 深度优先 + 兄弟下标排序即渲染序
    stack.sort((a, b) => (a.depth - b.depth) || (a.siblingIndex - b.siblingIndex));
    return { world: { x: wx, y: wy }, candidates: stack };
  };

  /**
   * 检查一个节点在当前画面里的「健康度」：
   * 激活、在可见区内、尺寸非零、坐标不是 NaN、中心点没被别的东西挡住。
   */
  probe.inspectNode = async (node) => {
    const cc = await probe.getCc();
    const issues = [];
    if (!node.activeInHierarchy) issues.push("节点未激活（activeInHierarchy = false）");
    const ut = node.getComponent(cc.UITransform);
    if (!ut) {
      issues.push("没有 UITransform（不参与布局与命中）");
      return { name: node.name, issues };
    }
    const size = ut.contentSize;
    if (!(size.width > 0) || !(size.height > 0)) {
      issues.push(`尺寸为零 (${size.width} x ${size.height})`);
    }
    const wp = node.getWorldPosition();
    if (!Number.isFinite(wp.x) || !Number.isFinite(wp.y)) {
      issues.push(`世界坐标为 NaN / Infinity (${wp.x}, ${wp.y})`);
    }
    const rectInfo = await probe.nodeClientRect(node);
    const vpInfo = await probe.viewportInfo();
    const view = {
      left: vpInfo.canvas.cssLeft,
      top: vpInfo.canvas.cssTop,
      right: vpInfo.canvas.cssLeft + vpInfo.canvas.cssWidth,
      bottom: vpInfo.canvas.cssTop + vpInfo.canvas.cssHeight,
    };
    const outside =
      rectInfo.x + rectInfo.width < view.left ||
      rectInfo.x > view.right ||
      rectInfo.y + rectInfo.height < view.top ||
      rectInfo.y > view.bottom;
    if (outside) issues.push("整个节点在可见区之外");

    const hit = await probe.hitTestAt(rectInfo.center.x, rectInfo.center.y);
    const top = hit.candidates[hit.candidates.length - 1];
    if (top && top.name !== node.name && !node.getComponentsInChildren(cc.UITransform).some((u) => u.node.name === top.name)) {
      issues.push(`中心点被上层节点挡住：${top.name}`);
    }
    return {
      name: node.name,
      active: node.activeInHierarchy,
      size: { width: size.width, height: size.height },
      clientRect: rectInfo,
      topmostAtCenter: top ? top.name : null,
      issues,
    };
  };

  //#endregion

  //#region 画面辅助

  /** 在页面上盖一个红框，用来肉眼确认「我以为点的位置」和「实际点的位置」是不是同一个 */
  probe.markRect = (rect, label = "", color = "#ff2d55") => {
    const id = "probe-mark-" + Math.random().toString(36).slice(2, 8);
    const el = document.createElement("div");
    el.id = id;
    el.style.cssText = [
      "position:absolute",
      `left:${rect.x}px`,
      `top:${rect.y}px`,
      `width:${rect.width}px`,
      `height:${rect.height}px`,
      `border:2px solid ${color}`,
      "box-sizing:border-box",
      "pointer-events:none",
      "z-index:2147483647",
    ].join(";");
    if (label) {
      const tag = document.createElement("span");
      tag.textContent = label;
      tag.style.cssText = `position:absolute;left:0;top:-18px;background:${color};color:#fff;font:11px/16px monospace;padding:0 4px;white-space:nowrap`;
      el.appendChild(tag);
    }
    document.body.appendChild(el);
    return id;
  };

  probe.clearMarks = () => {
    document.querySelectorAll('[id^="probe-mark-"]').forEach((el) => el.remove());
  };

  //#endregion

  probe.snapshotErrors = () => ({
    consoleErrors: probe.consoleErrors.slice(),
    consoleWarns: probe.consoleWarns.slice(),
    pageErrors: probe.pageErrors.slice(),
    rejections: probe.rejections.slice(),
    webglContextLost: probe.webglContextLost.slice(),
  });
})();
