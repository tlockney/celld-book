/**
 * Render the PWA icons with headless Chrome (DevTools protocol), then derive the smaller sizes
 * with macOS `sips`. Run once when the design changes; the PNGs are committed under assets/.
 *
 *   deno run -A tools/icons.ts
 *
 * "any" icons are full-bleed squares (platforms round the corners themselves). The maskable
 * icon keeps its wordmark inside the 80% safe zone so any mask shape leaves it whole.
 */

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = new URL("../assets/", import.meta.url).pathname;
await Deno.mkdir(OUT, { recursive: true });

const page = (fontPx: number, barW: number) =>
  `<!doctype html><html><head>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Condensed:wght@600&display=block">
<style>
  html, body { margin: 0; width: 512px; height: 512px; background: #1b252e; }
  body { display: grid; place-items: center; }
  .m { display: flex; flex-direction: column; align-items: center; gap: ${Math.round(fontPx * 0.12)}px; }
  .w { font: 600 ${fontPx}px/0.9 "IBM Plex Sans Condensed", sans-serif; color: #f3f5f1; letter-spacing: -0.01em; }
  .b { width: ${barW}px; height: ${Math.round(fontPx * 0.09)}px; background: #8eaeea; border-radius: 2px; }
</style></head><body><div class="m"><div class="w">celld</div><div class="b"></div></div></body></html>`;

const port = 9334;
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
        const t = list.find((x) =>
          typeof x === "object" && x !== null && (x as Record<string, unknown>).type === "page"
        );
        const u = t ? (t as Record<string, unknown>).webSocketDebuggerUrl : undefined;
        if (typeof u === "string") return u;
      }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Chrome DevTools endpoint did not come up");
}

const ws = new WebSocket(await wsUrl());
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 1;
const pending = new Map<number, (v: Record<string, unknown>) => void>();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(String(e.data)) as Record<string, unknown>;
  if (typeof m.id === "number") pending.get(m.id)?.(m);
});
const send = (method: string, params: Record<string, unknown> = {}) => {
  const n = id++;
  ws.send(JSON.stringify({ id: n, method, params }));
  return new Promise<Record<string, unknown>>((r) => pending.set(n, r));
};

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 512, height: 512, deviceScaleFactor: 1, mobile: false });

async function shot(html: string, file: string) {
  const tmp = await Deno.makeTempFile({ suffix: ".html" });
  await Deno.writeTextFile(tmp, html);
  await send("Page.navigate", { url: `file://${tmp}` });
  await new Promise((r) => setTimeout(r, 1500)); // web font
  const res = await send("Page.captureScreenshot", {
    format: "png",
    clip: { x: 0, y: 0, width: 512, height: 512, scale: 1 },
  });
  const data = (res.result as Record<string, unknown>)?.data;
  if (typeof data !== "string") throw new Error("no screenshot");
  await Deno.writeFile(OUT + file, Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
  await Deno.remove(tmp);
  console.log("wrote assets/" + file);
}

await shot(page(170, 250), "icon-512.png");
await shot(page(118, 170), "icon-maskable-512.png");
ws.close();
proc.kill();

const resize = async (from: string, to: string, px: number) => {
  const r = await new Deno.Command("sips", { args: ["-z", String(px), String(px), OUT + from, "--out", OUT + to] })
    .output();
  if (!r.success) throw new Error(`sips failed for ${to}`);
  console.log(`wrote assets/${to}`);
};
await resize("icon-512.png", "icon-192.png", 192);
await resize("icon-maskable-512.png", "icon-maskable-192.png", 192);
await resize("icon-512.png", "apple-touch-icon.png", 180);
await resize("icon-512.png", "favicon-32.png", 32);
