/**
 * Figure-zoom check in headless Chrome: marking, open on click, zoom controls, Escape and focus
 * return, keyboard open, caption links left alone; saves overlay screenshots in both themes.
 *
 *   deno run -A tools/zoom_check.ts [SHOTDIR]
 */
import { openSession } from "./cdp.ts";

const shots = Deno.args[0];
if (shots) await Deno.mkdir(shots, { recursive: true });
const s = await openSession(8423, 9337);
await s.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const wait = (ms = 120) => `await new Promise((r) => setTimeout(r, ${ms}));`;

await s.go("bucket.html");
const marked = await s.evaluate(
  `JSON.stringify({ figures: document.querySelectorAll(".r-fig figure").length, marked: document.querySelectorAll("figure.edzoom-able[tabindex='0']").length })`,
);
const m = JSON.parse(String(marked)) as { figures: number; marked: number };
check("every figure is marked zoomable and focusable", m.figures > 0 && m.figures === m.marked, JSON.stringify(m));

const flow = await s.evaluate(`(async () => {
  const r = {};
  const fig = document.querySelector("figure.edzoom-able");
  const ov = () => document.querySelector(".edzoom-overlay");
  fig.querySelector("svg").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  ${wait()}
  r.opensOnClick = ov().classList.contains("open") && !!ov().querySelector(".edzoom-content svg");
  r.pctStart = document.querySelector(".edzoom-pct").textContent;
  document.querySelector('.edzoom-controls [data-z="in"]').click();
  ${wait()}
  r.pctAfterPlus = document.querySelector(".edzoom-pct").textContent;
  r.pageScrollLocked = document.documentElement.style.overflow === "hidden";
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  ${wait()}
  r.escapeCloses = !ov().classList.contains("open");
  r.focusReturns = document.activeElement === fig;
  fig.focus();
  fig.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  ${wait()}
  r.enterOpens = ov().classList.contains("open");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  ${wait()}
  return JSON.stringify(r);
})()`);
const f = JSON.parse(String(flow)) as Record<string, unknown>;
check("click on a diagram opens the zoom", f.opensOnClick === true);
check(
  "opens at 100%, + zooms to 130%",
  f.pctStart === "100%" && f.pctAfterPlus === "130%",
  `${f.pctStart} → ${f.pctAfterPlus}`,
);
check("page scroll is locked while open", f.pageScrollLocked === true);
check("Escape closes and returns focus to the figure", f.escapeCloses === true && f.focusReturns === true);
check("Enter on a focused figure opens it", f.enterOpens === true);

await s.go("building.html");
const link = await s.evaluate(`(async () => {
  const a = [...document.querySelectorAll("figure.edzoom-able figcaption a")][0];
  if (!a) return "no caption link";
  addEventListener("click", (e) => { if (e.target.closest("a")) e.preventDefault(); }, { capture: true });
  a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  ${wait()}
  return document.querySelector(".edzoom-overlay").classList.contains("open") ? "opened" : "left alone";
})()`);
check("a caption link inside a figure does not open the zoom", link === "left alone", String(link));

if (shots) {
  for (const theme of ["light", "dark"]) {
    await s.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
    await s.go("bucket.html");
    await s.evaluate(`(async () => {
      document.querySelector("figure.edzoom-able svg").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      ${wait(300)}
      document.querySelector('.edzoom-controls [data-z="in"]').click();
    })()`);
    await new Promise((r) => setTimeout(r, 400));
    await s.screenshot(`${shots}/zoom-${theme}.png`);
    console.log(`     saved ${shots}/zoom-${theme}.png`);
  }
}

await s.close();
console.log(failures ? `${failures} check(s) failed` : "all zoom checks passed");
Deno.exit(failures ? 1 : 0);
