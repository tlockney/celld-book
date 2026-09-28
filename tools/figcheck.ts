/**
 * Figure-label overflow check in headless Chrome: every `<text>` in every figure must sit inside its
 * drawing's viewBox and inside the smallest `<rect>` whose area contains the label's center (the
 * box it is written in, if any), with 2 user units of tolerance. Run it after any font-size change.
 *
 *   deno run -A tools/figcheck.ts [page.html …]   (default: every page in dist/ with a figure)
 */
import { openSession } from "./cdp.ts";

const DIST = new URL("../dist/", import.meta.url).pathname;
let pages = Deno.args;
if (!pages.length) {
  pages = [];
  for await (const e of Deno.readDir(DIST)) {
    if (e.isFile && e.name.endsWith(".html") && (await Deno.readTextFile(DIST + e.name)).includes("<svg")) {
      pages.push(e.name);
    }
  }
  pages.sort();
}

const s = await openSession(8424, 9338);
await s.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });

interface Problem {
  fig: number;
  text: string;
  size: string;
  kind: string;
  over: number;
}

// Measures in each svg's own user units: screen boxes are mapped back through the svg's scale.
const MEASURE = `(async () => {
  await document.fonts.ready;
  const out = [];
  const TOL = 2;
  document.querySelectorAll(".r-fig figure svg, figure svg").forEach((svg, fi) => {
    const vb = svg.viewBox.baseVal;
    if (!vb || !vb.width) return;
    const sr = svg.getBoundingClientRect();
    const k = vb.width / sr.width;
    const toUser = (r) => ({
      l: vb.x + (r.left - sr.left) * k, r: vb.x + (r.right - sr.left) * k,
      t: vb.y + (r.top - sr.top) * k, b: vb.y + (r.bottom - sr.top) * k,
    });
    const rects = [...svg.querySelectorAll("rect")].map((el) => toUser(el.getBoundingClientRect()))
      .filter((r) => (r.r - r.l) < vb.width * 0.95 || (r.b - r.t) < vb.height * 0.95);
    svg.querySelectorAll("text").forEach((t) => {
      const b = toUser(t.getBoundingClientRect());
      if (b.r - b.l <= 0) return;
      const label = t.textContent.trim().slice(0, 48);
      const size = t.getAttribute("font-size") || getComputedStyle(t).fontSize;
      const vbOver = Math.max(vb.x - b.l, b.r - (vb.x + vb.width), vb.y - b.t, b.b - (vb.y + vb.height));
      if (vbOver > TOL) out.push({ fig: fi, text: label, size, kind: "viewBox", over: +vbOver.toFixed(1) });
      const cx = (b.l + b.r) / 2, cy = (b.t + b.b) / 2;
      const box = rects.filter((r) => cx > r.l && cx < r.r && cy > r.t && cy < r.b)
        .sort((a, c) => (a.r - a.l) * (a.b - a.t) - (c.r - c.l) * (c.b - c.t))[0];
      if (!box) return;
      const over = Math.max(box.l - b.l, b.r - box.r, box.t - b.t, b.b - box.b);
      if (over > TOL) out.push({ fig: fi, text: label, size, kind: "box", over: +over.toFixed(1) });
    });
  });
  return JSON.stringify(out);
})()`;

let total = 0;
for (const page of pages) {
  await s.go(page, 400);
  const problems = JSON.parse(String(await s.evaluate(MEASURE))) as Problem[];
  total += problems.length;
  for (const p of problems) {
    console.log(`FAIL ${page} fig ${p.fig + 1}: "${p.text}" (size ${p.size}) overflows its ${p.kind} by ${p.over}`);
  }
}
await s.close();
console.log(
  total ? `${total} label overflow(s) on ${pages.length} page(s)` : `no label overflows on ${pages.length} page(s)`,
);
Deno.exit(total ? 1 : 0);
