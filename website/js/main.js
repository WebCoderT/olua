/* ==========================================================
   olua 官网交互：截图画廊数据 / 灯箱 / 导航 / 入场动画 / 复制邮箱
   ========================================================== */

/* ---------- 截图数据（文件名 + 说明，新增截图在这里加一行即可） ---------- */
var SHOTS = [
  { file: "登录.jpg",       title: "登录：账号 / 密码 / 区服，浏览器即开即玩" },
  { file: "选择区服.jpg",   title: "选择区服：各区状态、开服时间与推荐标签" },
  { file: "角色选择.jpg",   title: "角色选择：账号下已有角色与创建入口" },
  { file: "创建角色.jpg",   title: "创建角色：战士 / 法师 / 道士三职业" },
  { file: "过渡场景.jpg",   title: "进图过场：燃烧的城门" },
  { file: "新手村.jpg",     title: "新手村：NPC、怪物与完整主界面" },
  { file: "角色信息.jpg",   title: "角色信息：等级、战力、攻防与装备槽位" },
  { file: "属性点.jpg",     title: "属性点：战斗属性总览与四维加点" },
  { file: "背包.jpg",       title: "背包：品质描边、整理与自动回收入口" },
  { file: "物品掉落.jpg",   title: "物品掉落：品质光柱与地面拾取" },
  { file: "小地图.jpg",     title: "小地图：怪物红点、左键寻路 / 右键传送" },
  { file: "地图传送官.jpg", title: "地图传送官：按等级分组的大陆传送" },
  { file: "战魂.jpg",       title: "战魂：37 阶成长线，逐阶加属性" },
  { file: "称号.jpg",       title: "称号：34 阶称号链，解锁即顶在头顶" },
  { file: "军衔.jpg",       title: "军衔：100 阶军衔，从新兵到元帅" },
  { file: "社交.jpg",       title: "社交：好友、敌人、黑名单与举报" },
  { file: "商城.jpg",       title: "商城：装备与道具分页浏览，买后入背包" },
  { file: "时装.jpg",       title: "时装：只改外观不改数值" }
];

/* ---------- 渲染画廊 ---------- */
(function renderGallery() {
  var grid = document.getElementById("galleryGrid");
  if (!grid) return;
  var html = "";
  SHOTS.forEach(function (shot, index) {
    html +=
      '<figure class="shot reveal" data-index="' + index + '">' +
        '<img src="assets/img/' + shot.file + '" alt="' + shot.title + '" loading="lazy" />' +
        "<figcaption>" + shot.title + "</figcaption>" +
      "</figure>";
  });
  grid.innerHTML = html;
})();

/* ---------- 灯箱（只有带画廊的页面才有这些节点，没有就跳过） ---------- */
(function initLightbox() {
  var box = document.getElementById("lightbox");
  var img = document.getElementById("lbImg");
  var caption = document.getElementById("lbCaption");
  var grid = document.getElementById("galleryGrid");
  if (!box || !img || !caption || !grid) return;
  var current = 0;

  function show(index) {
    current = (index + SHOTS.length) % SHOTS.length;
    var shot = SHOTS[current];
    img.src = "assets/img/" + shot.file;
    img.alt = shot.title;
    caption.textContent = (current + 1) + " / " + SHOTS.length + " · " + shot.title;
  }

  function open(index) {
    show(index);
    box.classList.add("is-open");
    box.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  }

  function close() {
    box.classList.remove("is-open");
    box.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  }

  grid.addEventListener("click", function (event) {
    var shot = event.target.closest(".shot");
    if (shot) open(Number(shot.dataset.index));
  });
  document.getElementById("lbClose").addEventListener("click", close);
  document.getElementById("lbPrev").addEventListener("click", function () { show(current - 1); });
  document.getElementById("lbNext").addEventListener("click", function () { show(current + 1); });
  box.addEventListener("click", function (event) {
    if (event.target === box) close();
  });
  document.addEventListener("keydown", function (event) {
    if (!box.classList.contains("is-open")) return;
    if (event.key === "Escape") close();
    if (event.key === "ArrowLeft") show(current - 1);
    if (event.key === "ArrowRight") show(current + 1);
  });
})();

/* ---------- 导航：滚动状态 + 移动端开关 + 锚点后收起 ---------- */
(function initNav() {
  var nav = document.getElementById("nav");
  var toggle = document.getElementById("navToggle");

  function onScroll() {
    nav.classList.toggle("is-scrolled", window.scrollY > 30);
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  toggle.addEventListener("click", function () {
    nav.classList.toggle("is-open");
  });
  document.querySelectorAll(".nav__links a").forEach(function (link) {
    link.addEventListener("click", function () {
      nav.classList.remove("is-open");
    });
  });
})();

/* ---------- 入场动画（IntersectionObserver，进视口才播一次） ---------- */
(function initReveal() {
  var items = document.querySelectorAll(".reveal");
  if (!("IntersectionObserver" in window)) {
    items.forEach(function (el) { el.classList.add("is-in"); });
    return;
  }
  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-in");
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });
  items.forEach(function (el) { observer.observe(el); });
})();

/* ---------- 复制邮箱（clipboard API + 旧浏览器降级） ---------- */
(function initCopyMail() {
  var button = document.getElementById("copyMail");
  if (!button) return;

  button.addEventListener("click", function () {
    var mail = button.dataset.mail;
    function done() {
      var original = button.textContent;
      button.textContent = "已复制 ✓";
      setTimeout(function () { button.textContent = original; }, 1800);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(mail).then(done);
      return;
    }
    var input = document.createElement("textarea");
    input.value = mail;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    try { document.execCommand("copy"); done(); } catch (error) { /* 忽略 */ }
    document.body.removeChild(input);
  });
})();
