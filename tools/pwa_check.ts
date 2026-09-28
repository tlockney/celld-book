/**
 * PWA check against the built site, in headless Chrome over the DevTools protocol:
 *   1. serve dist/ on 127.0.0.1 (a secure context), load the cover;
 *   2. read Chrome's own view of the manifest and its installability errors;
 *   3. wait for the service worker to activate and count what it cached;
 *   4. STOP the server, then load pages this browser never visited: only the cache can serve them;
 *   5. load a page that does not exist: the offline fallback should serve the cover.
 *
 *   deno run -A tools/pwa_check.ts
 */

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DIST = new URL("../dist/", import.meta.url).pathname;
const PORT = 8421;
const BASE = `http://127.0.0.1:${PORT}/`;

let server: Deno.ChildProcess | null = new Deno.Command(Deno.execPath(), {
  args: ["run", "-A", "jsr:@std/http@1/file-server", DIST, "--port", String(PORT), "--host", "127.0.0.1"],
  stdout: "null",
  stderr: "null",
}).spawn();
for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(BASE)).ok) break;
  } catch { /* starting */ }
  await new Promise((r) => setTimeout(r, 200));
}

const profile = await Deno.makeTempDir();
const chrome = new Deno.Command(CHROME, {
  args: [
    "--headless=new",
    "--disable-gpu",
    "--remote-debugging-port=9335",
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  stdout: "null",
  stderr: "null",
}).spawn();

async function wsUrl(): Promise<string> {
  for (let i = 0; i < 50; i++) {
    try {
      const list: unknown = await (await fetch("http://127.0.0.1:9335/json")).json();
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
const result = (r: Record<string, unknown>) => (r.result ?? {}) as Record<string, unknown>;
const evaluate = async (expression: string): Promise<unknown> => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return (result(r).result as Record<string, unknown> | undefined)?.value;
};
const go = async (path: string) => {
  await send("Page.navigate", { url: BASE + path });
  await new Promise((r) => setTimeout(r, 1200));
};

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

await send("Page.enable");
await go("index.html");

const man = result(await send("Page.getAppManifest"));
const errs = (man.errors as unknown[] | undefined) ?? [];
check(
  "manifest found and parsed",
  typeof man.url === "string" && String(man.url).endsWith("manifest.webmanifest") && errs.length === 0,
  errs.length ? JSON.stringify(errs) : String(man.url),
);

const ready = await evaluate(`navigator.serviceWorker.ready.then((r) => r.active ? r.active.state : "none")`);
check("service worker activated", ready === "activated", String(ready));
await go("index.html"); // now controlled
const controlled = await evaluate(`!!navigator.serviceWorker.controller`);
check("page is controlled by the service worker", controlled === true);
const cached = await evaluate(
  `caches.keys().then(async (ks) => { const k = ks.find((x) => x.startsWith("celld-book-") && x !== "celld-book-fonts"); return k ? (await (await caches.open(k)).keys()).length : 0; })`,
);
check("precache populated", typeof cached === "number" && cached >= 28, `${cached} entries`);

const inst = result(await send("Page.getInstallabilityErrors"));
const ie = (inst.installabilityErrors as { errorId?: string }[] | undefined) ?? [];
check("Chrome reports no installability errors", ie.length === 0, ie.map((e) => e.errorId).join(", "));

// Offline: stop the server; everything must now come from the cache.
server.kill();
await server.status;
server = null;
let serverGone = false;
try {
  await fetch(BASE, { signal: AbortSignal.timeout(1000) });
} catch {
  serverGone = true;
}
check("server stopped (offline from here)", serverGone);

for (const page of ["glossary.html", "lab-2.html", "bibliography.html", "colophon.html"]) {
  await go(page);
  const title = await evaluate(`document.querySelector("h1")?.textContent ?? ""`);
  check(`offline: ${page} served from cache`, typeof title === "string" && title.length > 0, String(title));
}
await go("no-such-page.html");
const fallback = await evaluate(`document.querySelector(".cover h1")?.textContent ?? ""`);
check("offline: unknown page falls back to the cover", fallback === "celld", String(fallback));

ws.close();
chrome.kill();
await chrome.status;
await Deno.remove(profile, { recursive: true }).catch(() => {});
console.log(failures ? `${failures} check(s) failed` : "all PWA checks passed");
Deno.exit(failures ? 1 : 0);
