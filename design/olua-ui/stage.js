/* 舞台等比适配：窗口多大，1920×1080 的稿子就缩到多大，永不裁切变形 */
(function () {
  var DESIGN_W = 1920, DESIGN_H = 1080;
  function fit() {
    var inner = document.querySelector('.stage-inner');
    if (!inner) return;
    var s = Math.min(window.innerWidth / DESIGN_W, window.innerHeight / DESIGN_H);
    /*
     * 居中**必须自己算坐标**，不能靠父级 grid 的 place-items:center：
     * 1920 宽的盒子在更窄的窗口里溢出，grid 会退化成「起点对齐」（left = 0），
     * 再叠加 transform:scale 就整体右移/下移半个溢出量 —— 一边留长黑边、一边内容被裁掉。
     * 这里改成 absolute + 左上角为原点的缩放：位置 = (窗口 - 缩放后尺寸) / 2，两边永远对称。
     */
    inner.style.position = 'absolute';
    inner.style.transformOrigin = '0 0';
    inner.style.left = (window.innerWidth - DESIGN_W * s) / 2 + 'px';
    inner.style.top = (window.innerHeight - DESIGN_H * s) / 2 + 'px';
    inner.style.transform = 'scale(' + s + ')';
    inner.style.setProperty('--s', s);
  }
  window.addEventListener('resize', fit);
  document.addEventListener('DOMContentLoaded', fit);
  fit();

  /* #state=xxx：给无头截图直达某个状态（页面自己监听 hashchange 时忽略） */
  window.__fitStage = fit;
})();
