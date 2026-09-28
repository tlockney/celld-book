// Bench sheet, notebook layer: view toggles, per-cell folding, long-cell
// clamp. Loaded after bench.js. The page reads completely without it.
(() => {
  const nb = document.getElementById("nb");
  if (!nb) return;
  const KEY = "bench-sheet:" + (document.title || location.pathname);
  const CLAMP_LINES = 30;

  const load = () => {
    try {
      return JSON.parse(localStorage.getItem(KEY) || "{}");
    } catch {
      return {};
    }
  };
  const save = (s) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch { /* storage unavailable */ }
  };

  const state = Object.assign({ foldCode: nb.classList.contains("fold-code"), hideOut: false }, load());
  const buttons = nb.querySelectorAll(".toolbar [data-toggle]");
  const apply = () => {
    nb.classList.toggle("fold-code", state.foldCode);
    nb.classList.toggle("hide-out", state.hideOut);
    buttons.forEach((b) => b.setAttribute("aria-pressed", String(!!state[b.dataset.toggle])));
  };
  buttons.forEach((b) =>
    b.addEventListener("click", () => {
      state[b.dataset.toggle] = !state[b.dataset.toggle];
      if (b.dataset.toggle === "foldCode") {
        nb.querySelectorAll(".cell-code.open, .cell-code.shut").forEach((c) => c.classList.remove("open", "shut"));
      }
      apply();
      save(state);
    })
  );
  apply();

  // A cell's count button (or its folded summary) flips that cell against the global setting.
  const flip = (cell) => cell.classList.toggle(nb.classList.contains("fold-code") ? "open" : "shut");
  nb.querySelectorAll(".cell-code").forEach((cell) => {
    cell.querySelector(".count")?.addEventListener("click", () => flip(cell));
    cell.querySelector(".src-sum")?.addEventListener("click", () => flip(cell));
  });

  // Clamp long inputs with a way back out.
  nb.querySelectorAll(".src[data-lines]").forEach((pre) => {
    const n = Number(pre.dataset.lines);
    if (n <= CLAMP_LINES) return;
    pre.classList.add("clamped");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "unclamp";
    btn.textContent = `Show all ${n} lines`;
    btn.addEventListener("click", () => {
      const clamped = pre.classList.toggle("clamped");
      btn.textContent = clamped ? `Show all ${n} lines` : "Collapse";
    });
    pre.after(btn);
  });
})();
