/* ==========================================================
   olua 官网交互：截图画廊数据 / 灯箱 / 导航 / 入场动画 / 复制邮箱
   ========================================================== */

/* ---------- 截图数据（文件名 + 说明，新增截图在这里加一行即可） ---------- */
var SHOTS = [
  { file: "login.jpg",         title: "登录" },
  { file: "role_selector.jpg", title: "角色选择与创建" },
  { file: "game.jpg",          title: "游戏主界面（角色信息 / 背包 / 技能弹窗）" },
  { file: "skill.jpg",         title: "技能列表" },
  { file: "monster.jpg",       title: "怪物与战斗" },
  { file: "drop-light.jpg",    title: "装备掉落光柱（按前缀品质播放，普通→超神 5 档）" },
  { file: "small-map.jpg",     title: "小地图预览弹窗（左键寻路 / 右键传送）" },
  { file: "war-soul.jpg",      title: "战魂系统（37 阶成长线）" },
  { file: "border_bg.jpg",     title: "装备品质边框与详情背景动画" },
  { file: "mall.jpg",          title: "商城（全部装备上架，卡片网格分页）" }
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

/* ---------- 灯箱 ---------- */
(function initLightbox() {
  var box = document.getElementById("lightbox");
  var img = document.getElementById("lbImg");
  var caption = document.getElementById("lbCaption");
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

  document.getElementById("galleryGrid").addEventListener("click", function (event) {
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
