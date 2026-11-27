// Light/dark choice, applied before the page is drawn (loaded without "defer" in <head>, so there is
// no flash of the wrong colours). No choice stored = follow the system setting.
(function () {
  try {
    var t = localStorage.getItem('pmx_theme');
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  } catch (e) { /* storage blocked: follow the system */ }
}());
