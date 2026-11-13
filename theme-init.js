// Runs before first paint (blocking <script> in <head>) so the panel never
// flashes the wrong theme. External file because the CSP forbids inline scripts.
(function () {
  let pref = "system";
  try {
    pref = localStorage.getItem("shelf:theme") || "system";
  } catch {
    // Storage blocked: fall back to the system setting.
  }
  const dark =
    pref === "dark" || (pref !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
})();
