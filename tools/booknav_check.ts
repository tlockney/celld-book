/**
 * Phone bottom-bar check in headless Chrome: shown at phone width and hidden on desktop, tucked
 * away on scroll down and back on scroll up, back at the end of the page without covering the last
 * content, Contents opens the drawer and returns focus, and it hides while a figure is zoomed.
 *
 *   deno run -A tools/booknav_check.ts [SHOTDIR]
 */
import { openSession } from "./cdp.ts";

const shots = Deno.args[0];
if (shots) await Deno.mkdir(shots, { recursive: true });
const s = await openSession(8425, 9339);

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const phone = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };
const state = async () =>
  JSON.parse(String(
    await s.evaluate(`JSON.stringify((() => {
  const n = document.querySelector(".booknav");
  const r = n.getBoundingClientRect();
  return { display: getComputedStyle(n).display, away: n.classList.contains("bn-away"),
           top: Math.round(r.top), vh: innerHeight, vis: getComputedStyle(n).visibility };
})())`),
  )) as { display: string; away: boolean; top: number; vh: number; vis: string };

await s.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
await s.go("bucket.html");
check("hidden at desktop width", (await state()).display === "none");

await s.send("Emulation.setDeviceMetricsOverride", phone);
await s.go("bucket.html");
let st = await state();
check(
  "shown at phone width, pinned to the bottom",
  st.display === "grid" && !st.away && st.top < st.vh,
  JSON.stringify(st),
);
const links = String(
  await s.evaluate(
    `[...document.querySelectorAll(".booknav a, .booknav button")].map((e) => e.getAttribute("aria-label") || e.textContent).join(" | ")`,
  ),
);
check("previous, contents, next", /^Previous: .+ \| Contents \| Next: .+$/.test(links), links);

await s.evaluate(`scrollTo(0, 600)`);
await sleep(150);
await s.evaluate(`scrollTo(0, 1400)`);
await sleep(350);
st = await state();
check("tucked away while scrolling down", st.away && st.top >= st.vh - 1, JSON.stringify(st));
if (shots) await s.screenshot(`${shots}/booknav-away.png`);

await s.evaluate(`scrollTo(0, 1100)`);
await sleep(350);
st = await state();
check("back on scroll up", !st.away && st.top < st.vh, JSON.stringify(st));
if (shots) await s.screenshot(`${shots}/booknav-shown.png`);

await s.evaluate(`scrollTo(0, document.documentElement.scrollHeight)`);
await sleep(350);
st = await state();
const clear = await s.evaluate(`(() => {
  const nav = document.querySelector(".booknav").getBoundingClientRect();
  // Measure the page's last visible text, not a box: a footer's bottom padding may sit under the bar.
  const walk = document.createTreeWalker(document.querySelector(".art"), NodeFilter.SHOW_TEXT);
  let lastText = null;
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (n.textContent.trim() && n.parentElement.getClientRects().length) lastText = n;
  }
  const range = document.createRange();
  range.selectNodeContents(lastText);
  const last = range.getBoundingClientRect();
  return JSON.stringify({ text: lastText.textContent.trim().slice(0, 40), textBottom: Math.round(last.bottom), navTop: Math.round(nav.top) });
})()`);
const c = JSON.parse(String(clear)) as { text: string; textBottom: number; navTop: number };
check(
  "shown at the end of the page, not covering the last content",
  !st.away && c.textBottom <= c.navTop,
  JSON.stringify(c),
);
if (shots) await s.screenshot(`${shots}/booknav-end.png`);

const drawer = await s.evaluate(`(async () => {
  const b = document.querySelector(".bn-toc");
  b.focus(); b.click();
  await new Promise((r) => setTimeout(r, 100));
  const opened = !document.getElementById("booktoc").hidden && b.getAttribute("aria-expanded") === "true";
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  await new Promise((r) => setTimeout(r, 100));
  return JSON.stringify({ opened, closed: document.getElementById("booktoc").hidden, focus: document.activeElement === b });
})()`);
const d = JSON.parse(String(drawer)) as Record<string, boolean>;
check(
  "Contents opens the drawer; Escape closes it and returns focus",
  d.opened && d.closed && d.focus,
  JSON.stringify(d),
);

await s.go("bucket.html");
const zoomHidden = await s.evaluate(`(async () => {
  document.querySelector("figure.edzoom-able svg").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 150));
  return getComputedStyle(document.querySelector(".booknav")).visibility;
})()`);
check("hidden while a figure is zoomed", zoomHidden === "hidden", String(zoomHidden));

await s.close();
console.log(failures ? `${failures} check(s) failed` : "all bottom-bar checks passed");
Deno.exit(failures ? 1 : 0);
