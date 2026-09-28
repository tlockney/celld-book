/**
 * A tiny DevTools-protocol session for the check tools: serves dist/ on a local port, starts
 * headless Chrome with a throwaway profile, and exposes send / evaluate / navigate / screenshot.
 */

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DIST = new URL("../dist/", import.meta.url).pathname;

export interface Session {
  base: string;
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  evaluate(expression: string): Promise<unknown>;
  go(path: string, settleMs?: number): Promise<void>;
  screenshot(file: string): Promise<void>;
  close(): Promise<void>;
}

export async function openSession(port: number, debugPort: number): Promise<Session> {
  const base = `http://127.0.0.1:${port}/`;
  const server = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "jsr:@std/http@1/file-server", DIST, "--port", String(port), "--host", "127.0.0.1"],
    stdout: "null",
    stderr: "null",
  }).spawn();
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(base)).ok) break;
    } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  const profile = await Deno.makeTempDir();
  const chrome = new Deno.Command(CHROME, {
    args: [
      "--headless=new",
      "--disable-gpu",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    stdout: "null",
    stderr: "null",
  }).spawn();

  let url = "";
  for (let i = 0; i < 50 && !url; i++) {
    try {
      const list: unknown = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
      if (Array.isArray(list)) {
        const t = list.find((x) =>
          typeof x === "object" && x !== null && (x as Record<string, unknown>).type === "page"
        );
        const u = t ? (t as Record<string, unknown>).webSocketDebuggerUrl : undefined;
        if (typeof u === "string") url = u;
      }
    } catch { /* not up yet */ }
    if (!url) await new Promise((r) => setTimeout(r, 200));
  }
  if (!url) throw new Error("DevTools endpoint did not come up");
  const ws = new WebSocket(url);
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
  await send("Page.enable");
  return {
    base,
    send,
    async evaluate(expression) {
      const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      return ((r.result as Record<string, unknown>)?.result as Record<string, unknown> | undefined)?.value;
    },
    async go(path, settleMs = 1200) {
      await send("Page.navigate", { url: base + path });
      await new Promise((r) => setTimeout(r, settleMs));
    },
    async screenshot(file) {
      const r = await send("Page.captureScreenshot", { format: "png" });
      const data = (r.result as Record<string, unknown>)?.data;
      if (typeof data === "string") await Deno.writeFile(file, Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
    },
    async close() {
      ws.close();
      chrome.kill();
      server.kill();
      await Promise.all([chrome.status, server.status]);
      await Deno.remove(profile, { recursive: true }).catch(() => {});
    },
  };
}
