/**
 * Phone check: emulate a 390×844 phone in headless Chrome over the DevTools protocol, report
 * any element wider than the viewport, and save a screenshot per page.
 *
 *   deno run -A tools/phone.ts OUTDIR page.html [page.html …]
 *
 * (Headless Chrome will not make a *window* narrower than 500px, so `--window-size=390,…` only
 * crops a 500px layout; device-metrics emulation gives a true 390px viewport.)
 */

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const [outDir, ...pages] = Deno.args;
if (!outDir || !pages.length) {
  console.error("usage: phone.ts OUTDIR page.html …");
  Deno.exit(2);
}
await Deno.mkdir(outDir, { recursive: true });

const port = 9333;
const proc = new Deno.Command(CHROME, {
  args: ["--headless=new", "--disable-gpu", `--remote-debugging-port=${port}`, "about:blank"],
  stdout: "null",
  stderr: "null",
}).spawn();

async function wsUrl(): Promise<string> {
  for (let i = 0; i < 50; i++) {
    try {
      const list: unknown = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      if (Array.isArray(list)) {
        const page = list.find((t) =>
          typeof t === "object" && t !== null && (t as Record<string, unknown>).type === "page"
        );
        const url = page ? (page as Record<string, unknown>).webSocketDebuggerUrl : undefined;
        if (typeof url === "string") return url;
      }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Chrome DevTools endpoint did not come up");
}

const ws = new WebSocket(await wsUrl());
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let nextId = 1;
const pending = new Map<number, (v: Record<string, unknown>) => void>();
const events: ((m: Record<string, unknown>) => void)[] = [];
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(String(e.data)) as Record<string, unknown>;
  if (typeof msg.id === "number") pending.get(msg.id)?.(msg);
  else events.forEach((f) => f(msg));
});
function send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((r) => pending.set(id, r));
}
const loaded = () =>
  new Promise<void>((r) => {
    const f = (m: Record<string, unknown>) => {
      if (m.method === "Page.loadEventFired") {
        events.splice(events.indexOf(f), 1);
        r();
      }
    };
    events.push(f);
  });

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

const DIAG = `(() => {
  const vw = document.documentElement.clientWidth;
  const over = [];
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width && r.right > vw + 1 && !el.closest(".table-wrap, .plate, pre, .booktoc, .gloss-pop, svg, .outputs")) {
      over.push(el.tagName.toLowerCase() + "." + [...el.classList].join(".") + " right=" + Math.round(r.right));
    }
  }
  return JSON.stringify({ vw, docW: document.documentElement.scrollWidth, over: over.slice(0, 12) });
})()`;

let bad = 0;
for (const page of pages) {
  const done = loaded();
  await send("Page.navigate", { url: `http://127.0.0.1:8420/${page}` });
  await done;
  await new Promise((r) => setTimeout(r, 400));
  const res = await send("Runtime.evaluate", { expression: DIAG, returnByValue: true });
  const result = (res.result as Record<string, unknown>)?.result as Record<string, unknown> | undefined;
  const info = JSON.parse(String(result?.value ?? "{}")) as { vw: number; docW: number; over: string[] };
  if (Deno.env.get("INTERACT")) {
    const probe = await send("Runtime.evaluate", {
      returnByValue: true,
      awaitPromise: true,
      expression: `(async () => {
        const r = {};
        const btn = document.querySelector(".bb-toc"), toc = document.getElementById("booktoc");
        btn.click(); await new Promise((x) => setTimeout(x, 50));
        r.drawerOpens = !toc.hidden && btn.getAttribute("aria-expanded") === "true";
        r.focusInDrawer = toc.contains(document.activeElement);
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        await new Promise((x) => setTimeout(x, 50));
        r.escapeCloses = toc.hidden && document.activeElement === btn;
        const g = document.querySelector(".gloss");
        if (g) {
          g.dispatchEvent(new MouseEvent("mouseenter")); await new Promise((x) => setTimeout(x, 50));
          const pop = document.querySelector(".gloss-pop"), pr = pop.getBoundingClientRect();
          r.glossTerm = g.dataset.term;
          r.popShows = !pop.hidden && pop.textContent.startsWith(g.dataset.term);
          r.popOnScreen = pr.left >= 0 && pr.right <= document.documentElement.clientWidth;
          g.dispatchEvent(new MouseEvent("mouseleave")); await new Promise((x) => setTimeout(x, 50));
          r.popHidesOnLeave = pop.hidden;
          g.dispatchEvent(new FocusEvent("focus")); await new Promise((x) => setTimeout(x, 50));
          r.popShowsOnFocus = !pop.hidden;
          g.dispatchEvent(new FocusEvent("blur")); await new Promise((x) => setTimeout(x, 50));
          r.popHidesOnBlur = pop.hidden;
          g.click(); await new Promise((x) => setTimeout(x, 50));
          r.tapShows = !pop.hidden;
          document.body.click(); await new Promise((x) => setTimeout(x, 50));
          r.tapElsewhereHides = pop.hidden;
        }
        return JSON.stringify(r);
      })()`,
    });
    const v = ((probe.result as Record<string, unknown>)?.result as Record<string, unknown>)?.value;
    console.log(`    interact ${page}: ${v}`);
  }
  const ok = info.docW <= info.vw && info.over.length === 0;
  if (!ok) bad++;
  console.log(
    `${ok ? "ok " : "BAD"} ${page}: viewport ${info.vw}px, document ${info.docW}px${
      info.over.length ? `\n     ${info.over.join("\n     ")}` : ""
    }`,
  );
  const shot = await send("Page.captureScreenshot", { format: "png" });
  const data = (shot.result as Record<string, unknown>)?.data;
  if (typeof data === "string") {
    await Deno.writeFile(
      `${outDir}/${page.replace(/\W+/g, "_")}-phone.png`,
      Uint8Array.from(atob(data), (c) => c.charCodeAt(0)),
    );
  }
}
ws.close();
proc.kill();
Deno.exit(bad ? 1 : 0);
