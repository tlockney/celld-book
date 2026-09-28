// Bench sheet, shared runtime: outline scrollspy and copy buttons on code
// plates. The page reads completely without it.
(() => {
  // Copy buttons. Clipboard writes can be refused (sandboxed viewers, older
  // app views); fall back to selecting the code so the reader can copy it.
  document.querySelectorAll("pre.src, pre.md-code").forEach((pre) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy";
    btn.textContent = "Copy";
    btn.addEventListener("click", async () => {
      const code = pre.querySelector("code") || pre;
      try {
        await navigator.clipboard.writeText(code.innerText);
        btn.textContent = "Copied";
      } catch {
        const range = document.createRange();
        range.selectNodeContents(code);
        const sel = getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        btn.textContent = "Selected";
      }
      setTimeout(() => (btn.textContent = "Copy"), 1600);
    });
    const wrap = document.createElement("div");
    wrap.className = "plate";
    pre.before(wrap);
    wrap.append(pre, btn);
  });

  // Outline scrollspy.
  const links = [...document.querySelectorAll(".outline a")];
  if (links.length && "IntersectionObserver" in window) {
    const byId = new Map(links.map((a) => [a.getAttribute("href").slice(1), a]));
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        links.forEach((a) => a.classList.remove("active"));
        byId.get(e.target.id)?.classList.add("active");
      }
    }, { rootMargin: "0px 0px -70% 0px" });
    byId.forEach((_, id) => {
      const h = document.getElementById(id);
      if (h) io.observe(h);
    });
  }
})();
