/**
 * Figure-zoom check in headless Chrome: marking, open on click, zoom controls, Escape and focus
 * return, the corner zoom button (faint at rest, full on hover, opens the zoom, takes focus back),
 * caption links left alone; saves overlay screenshots in both themes.
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
  `JSON.stringify({ figures: document.querySelectorAll(".r-fig figure").length, marked: document.querySelectorAll("figure.edzoom-able > button.edzoom-btn[aria-label='Zoom figure']").length })`,
);
const m = JSON.parse(String(marked)) as { figures: number; marked: number };
check(
  "every figure is marked zoomable and has a zoom button",
  m.figures > 0 && m.figures === m.marked,
  JSON.stringify(m),
);

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
  const btn = fig.querySelector(".edzoom-btn");
  btn.focus();
  btn.click();
  ${wait()}
  r.buttonOpens = ov().classList.contains("open");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  ${wait()}
  r.focusReturns = document.activeElement === btn;
  btn.blur();
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
check("Escape closes the zoom", f.escapeCloses === true);
check("the zoom button opens the zoom and gets focus back on close", f.buttonOpens === true && f.focusReturns === true);

// Check 8: the button is visible (faintly) at rest and fully on a real pointer hover.
const opacity = async () =>
  Number(await s.evaluate(`getComputedStyle(document.querySelector("figure.edzoom-able .edzoom-btn")).opacity`));
await s.evaluate(`document.querySelector("figure.edzoom-able").scrollIntoView({ block: "center" })`);
await new Promise((r) => setTimeout(r, 250));
const rest = await opacity();
const box = JSON.parse(String(
  await s.evaluate(`(() => {
  const r = document.querySelector("figure.edzoom-able svg").getBoundingClientRect();
  return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
})()`),
)) as { x: number; y: number };
await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
await new Promise((r) => setTimeout(r, 300));
const hover = await opacity();
check(
  "zoom button is visible at rest and full on hover",
  rest > 0.3 && rest < 1 && hover === 1,
  `rest ${rest}, hover ${hover}`,
);
await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 });

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
