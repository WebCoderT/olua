/* ==========================================================
   olua 官网交互：截图画廊数据 / 灯箱 / 导航 / 入场动画 / 复制邮箱
   ========================================================== */

/* ---------- 截图数据（文件名 + 说明，新增截图在这里加一行即可） ---------- */
var SHOTS = [
  { file: "login.jpg",         title: "登录：账号 / 密码 / 区服，浏览器即开即玩" },
  { file: "role-select.jpg",   title: "角色选择与创建：多角色立在石台上，点职业查看信息" },
  { file: "game.jpg",          title: "游戏主界面：战斗、背包与地面掉落光柱" },
  { file: "combat.jpg",        title: "多人同屏战斗与技能特效" },
  { file: "skill.jpg",         title: "技能列表：冷却 / 耗蓝 / 技能说明一栏看清" },
  { file: "skill-warrior.jpg", title: "技能详情：战士「十步一杀」" },
  { file: "skill-mage.jpg",    title: "技能详情：法师「流星火雨」" },
  { file: "bag.jpg",           title: "背包与快捷技能格" },
  { file: "item-tip.jpg",      title: "物品悬浮详情：属性、品质与价格" },
  { file: "equip-detail.jpg",  title: "装备详情：品质边框、背景动画与属性面板" },
  { file: "mall.jpg",          title: "商城：全部装备自动上架，卡片分页浏览" },
  { file: "mall-detail.jpg",   title: "商城商品详情：买前看属性，买后入背包" },
  { file: "title.jpg",         title: "称号系统：34 阶成长线，解锁即顶在头顶" },
  { file: "teleport.jpg",      title: "地图传送官：按等级分组的大陆传送" },
  { file: "small-map.jpg",     title: "小地图预览弹窗：左键寻路 / 右键传送" }
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
