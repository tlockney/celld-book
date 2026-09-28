/**
 * Screenshot every inline SVG figure on the given pages, in a forced light or dark color scheme.
 *
 *   deno run -A tools/figshot.ts OUTDIR light|dark page.html [page.html …]
 *
 * Serves dist/ itself on 127.0.0.1:8422 and drives headless Chrome over the DevTools protocol.
 */

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const [outDir, theme, ...pages] = Deno.args;
if (!outDir || (theme !== "light" && theme !== "dark") || !pages.length) {
  console.error("usage: figshot.ts OUTDIR light|dark page.html …");
  Deno.exit(2);
}
await Deno.mkdir(outDir, { recursive: true });
const DIST = new URL("../dist/", import.meta.url).pathname;
const BASE = "http://127.0.0.1:8422/";

const server = new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", "jsr:@std/http@1/file-server", DIST, "--port", "8422", "--host", "127.0.0.1"],
  stdout: "null",
  stderr: "null",
}).spawn();
for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(BASE)).ok) break;
  } catch { /* starting */ }
  await new Promise((r) => setTimeout(r, 200));
}
const chrome = new Deno.Command(CHROME, {
  args: ["--headless=new", "--disable-gpu", "--remote-debugging-port=9336", "about:blank"],
  stdout: "null",
  stderr: "null",
}).spawn();

async function wsUrl(): Promise<string> {
  for (let i = 0; i < 50; i++) {
    try {
      const list: unknown = await (await fetch("http://127.0.0.1:9336/json")).json();
      if (Array.isArray(list)) {
        const t = list.find((x) =>
          typeof x === "object" && x !== null && (x as Record<string, unknown>).type === "page"
        );
        const u = t ? (t as Record<string, unknown>).webSocketDebuggerUrl : undefined;
        if (typeof u === "string") return u;
      }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("DevTools endpoint did not come up");
}
const ws = new WebSocket(await wsUrl());
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let nextId = 1;
const pending = new Map<number, (v: Record<string, unknown>) => void>();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(String(e.data)) as Record<string, unknown>;
  if (typeof m.id === "number") pending.get(m.id)?.(m);
});
const send = (method: string, params: Record<string, unknown> = {}) => {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise<Record<string, unknown>>((r) => pending.set(id, r));
};
const res = (r: Record<string, unknown>) => (r.result ?? {}) as Record<string, unknown>;

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });

for (const page of pages) {
  await send("Page.navigate", { url: BASE + page });
  await new Promise((r) => setTimeout(r, 1500));
  const r = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `document.querySelector(".bookbar")?.remove();
    JSON.stringify([...document.querySelectorAll(".r-fig figure")].map((f) => {
      f.scrollIntoView(); const b = f.getBoundingClientRect();
      return { x: b.left + scrollX, y: b.top + scrollY, w: b.width, h: b.height };
    }))`,
  });
  const boxes = JSON.parse(String((res(r).result as Record<string, unknown>)?.value ?? "[]")) as {
    x: number;
    y: number;
    w: number;
    h: number;
  }[];
  for (const [i, b] of boxes.entries()) {
    const shot = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: b.x, y: b.y, width: b.w, height: b.h, scale: 1 },
    });
    const data = res(shot).data;
    if (typeof data !== "string") continue;
    const file = `${outDir}/${page.replace(/\W+/g, "_")}-fig${i + 1}-${theme}.png`;
    await Deno.writeFile(file, Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
    console.log(file);
  }
}
ws.close();
chrome.kill();
server.kill();
await Promise.all([chrome.status, server.status]);
