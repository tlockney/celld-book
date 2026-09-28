/**
 * celld_nb.ts — the small runtime the celld learning notebooks share.
 *
 * celld is a runtime binary, not a library, so a notebook cannot import it.
 * Instead each notebook is a *driver*:
 *
 *   1. Cells define Durable Object / Workflow classes as ordinary, executable
 *      TypeScript against the kernel-side shims below (`DurableObject`,
 *      `WorkflowEntrypoint`, `fakeCtx()`), so the same class can be exercised
 *      in the kernel without celld at all.
 *   2. `app.ship({...})` serializes those classes with `Function.prototype
 *      .toString()` into `src/index.js`, writes `wrangler.jsonc`, and — if
 *      `celld dev` is already running — waits for the hot reload.
 *   3. `app.start()` spawns `celld dev`; `app.fetch()` talks to it;
 *      `app.stop()` shuts it down.
 *
 * The kernel has already stripped TypeScript types when `toString()` runs,
 * so what ships is JavaScript. A shipped class must be self-contained:
 * `toString()` captures the class body, not closures over other cells.
 * Pass shared functions through `helpers` and they are shipped verbatim.
 */

import { DatabaseSync } from "node:sqlite";

// ─────────────────────────────────────────────────────────────────────────────
// Kernel-side shims for "cloudflare:workers"
// ─────────────────────────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
export type AnyEnv = any;

/** Kernel stand-in for cloudflare:workers' DurableObject: same constructor shape. */
export class DurableObject<Env = AnyEnv> {
  constructor(public ctx: FakeContext, public env: Env) {}
}

/** Kernel stand-in for cloudflare:workers' WorkflowEntrypoint. */
export class WorkflowEntrypoint<Env = AnyEnv> {
  constructor(public ctx: unknown, public env: Env) {}
}

/** Minimal shape of a Durable Object stub, enough to type `env` in cells. */
export interface DurableObjectStub {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
  // deno-lint-ignore no-explicit-any
  [rpcMethod: string]: any;
}

/** Minimal shape of a Durable Object namespace binding, enough to type `env` in cells. */
export interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  newUniqueId(): unknown;
  get(id: unknown): DurableObjectStub;
}

export interface SqlCursor<Row = Record<string, unknown>> {
  toArray(): Row[];
  one(): Row;
  readonly rowsRead: number;
  readonly rowsWritten: number;
}

export interface FakeStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(opts?: { prefix?: string }): Promise<Map<string, T>>;
  deleteAll(): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(at: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
  sql: { exec<Row = Record<string, unknown>>(query: string, ...binds: unknown[]): SqlCursor<Row> };
}

export interface FakeContext {
  storage: FakeStorage;
  id: { name?: string; toString(): string };
  waitUntil(p: Promise<unknown>): void;
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
  /** Alarm timestamps recorded by setAlarm(), for assertions in the kernel. */
  readonly alarms: number[];
}

/**
 * A fake DurableObjectState for running a cell class inside the kernel.
 * The key-value face is a Map; the SQL face is a real in-memory SQLite
 * (node:sqlite), so `ctx.storage.sql.exec` behaves like the real thing.
 */
export function fakeCtx(name = "kernel"): FakeContext {
  const kv = new Map<string, unknown>();
  const db = new DatabaseSync(":memory:");
  let alarm: number | null = null;
  const alarms: number[] = [];
  const cursor = <Row>(rows: Row[], written: number): SqlCursor<Row> => ({
    toArray: () => rows,
    one: () => {
      if (rows.length !== 1) throw new Error(`expected exactly one row, got ${rows.length}`);
      return rows[0];
    },
    rowsRead: rows.length,
    rowsWritten: written,
  });
  const storage: FakeStorage = {
    get: async <T>(key: string) => kv.get(key) as T | undefined,
    put: async (key, value) => { kv.set(key, value); },
    delete: async (key) => kv.delete(key),
    list: async <T>(opts?: { prefix?: string }) => {
      const out = new Map<string, T>();
      for (const [k, v] of [...kv.entries()].sort()) {
        if (!opts?.prefix || k.startsWith(opts.prefix)) out.set(k, v as T);
      }
      return out;
    },
    deleteAll: async () => { kv.clear(); },
    getAlarm: async () => alarm,
    setAlarm: async (at) => { alarm = typeof at === "number" ? at : at.getTime(); alarms.push(alarm); },
    deleteAlarm: async () => { alarm = null; },
    sql: {
      exec: <Row>(query: string, ...binds: unknown[]) => {
        const trimmed = query.trim();
        const selects = /^(select|with|pragma)\b/i.test(trimmed) || /\breturning\b/i.test(trimmed);
        if (!selects && binds.length === 0 && trimmed.includes(";")) {
          db.exec(query);
          return cursor<Row>([], 0);
        }
        const stmt = db.prepare(query);
        if (selects) {
          const rows = stmt.all(...(binds as never[])).map((r) => ({ ...r }) as Row);
          return cursor<Row>(rows, 0);
        }
        const info = stmt.run(...(binds as never[]));
        return cursor<Row>([], Number(info.changes));
      },
    },
  };
  return {
    storage,
    id: { name, toString: () => name },
    waitUntil: () => {},
    blockConcurrencyWhile: (fn) => fn(),
    alarms,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tooling: find or install celld + esbuild
// ─────────────────────────────────────────────────────────────────────────────

export const CELLD_VERSION = "v0.6.0";

async function run(cmd: string, args: string[], opts: { env?: Record<string, string>; cwd?: string } = {}) {
  const out = await new Deno.Command(cmd, { args, ...opts, stdout: "piped", stderr: "piped" }).output();
  const dec = new TextDecoder();
  return { ok: out.success, code: out.code, stdout: dec.decode(out.stdout), stderr: dec.decode(out.stderr) };
}

async function which(name: string): Promise<string | undefined> {
  const r = await run("sh", ["-c", `command -v ${name}`]);
  return r.ok ? r.stdout.trim() : undefined;
}

async function exists(path: string): Promise<boolean> {
  try { await Deno.stat(path); return true; } catch { return false; }
}

const home = () => Deno.env.get("HOME") ?? ".";

async function portInUse(port: number): Promise<boolean> {
  try {
    const l = Deno.listen({ hostname: "127.0.0.1", port });
    l.close();
    return false;
  } catch {
    return true;
  }
}

/**
 * Locate celld and esbuild. Search order: CELLD_BIN / CELLD_ESBUILD, PATH,
 * `<nbHome>/tools`, ~/.local. When missing, install into `<nbHome>/tools`.
 */
/**
 * Where tools and project state live: $CELLD_NB_HOME, else ~/.cache/celld-nb.
 * Deliberately NOT beside the notebook — a notebook directory may be a network
 * share (no symlinks, and SQLite state must not live there).
 */
export function nbHome(): string {
  return Deno.env.get("CELLD_NB_HOME") ?? `${home()}/.cache/celld-nb`;
}

export async function ensureTools(): Promise<{ celld: string; esbuild: string }> {
  const tools = `${nbHome()}/tools`;
  const candidates = async (envVar: string, name: string, ...paths: string[]) => {
    const fromEnv = Deno.env.get(envVar);
    if (fromEnv) return fromEnv;
    const onPath = await which(name);
    if (onPath) return onPath;
    for (const p of paths) if (await exists(p)) return p;
    return undefined;
  };
  let celld = await candidates("CELLD_BIN", "celld", `${tools}/bin/celld`, `${home()}/.local/bin/celld`);
  if (!celld) {
    console.log(`celld not found — installing ${CELLD_VERSION} into ${tools} (https://celld.dev/install.sh)`);
    const r = await run("sh", ["-c", "curl -fsSL https://celld.dev/install.sh | sh"], {
      env: { ...Deno.env.toObject(), CELLD_VERSION, CELLD_INSTALL_ROOT: tools },
    });
    if (!r.ok) throw new Error(`celld install failed:\n${r.stderr}`);
    celld = `${tools}/bin/celld`;
  }
  const prefix = `${tools}/esbuild`;
  let esbuild = await candidates("CELLD_ESBUILD", "esbuild", `${prefix}/node_modules/.bin/esbuild`, `${home()}/.local/lib/celld-nb/node_modules/.bin/esbuild`);
  if (!esbuild) {
    console.log(`esbuild not found — installing into ${prefix} with npm`);
    if (!(await which("npm"))) throw new Error("esbuild is missing and npm is not on PATH; install esbuild and set CELLD_ESBUILD");
    const r = await run("npm", ["install", "--prefix", prefix, "--no-audit", "--no-fund", "esbuild@0.25"]);
    if (!r.ok) throw new Error(`esbuild install failed:\n${r.stderr}`);
    esbuild = `${prefix}/node_modules/.bin/esbuild`;
  }
  const v = await run(celld, ["--version"]);
  console.log(`celld  ${celld}  (${(v.stdout + v.stderr).split("\n").find((l) => /^celld\s+v?\d+\.\d+/.test(l.trim()))?.trim() ?? "?"})`);
  console.log(`esbuild ${esbuild}`);
  return { celld, esbuild };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shipping cell-defined code into a Wrangler project
// ─────────────────────────────────────────────────────────────────────────────

// deno-lint-ignore ban-types
type Fn = Function;

export interface ShipSpec {
  /** Durable Object / Workflow classes defined in cells. Each becomes `export class …`. */
  classes?: Fn[];
  /** The Worker's default export: fetch / queue / scheduled handlers. */
  worker?: Record<string, Fn>;
  /** Plain functions to ship verbatim (they must be self-contained too). */
  helpers?: Fn[];
  /** Merged over the base wrangler.jsonc ({ name, main, compatibility_date }). */
  wrangler?: Record<string, unknown>;
  /** Extra project files, path → contents (e.g. migrations/0001_init.sql). */
  files?: Record<string, string>;
  /** Extra imports from cloudflare:workers beyond what the classes need. */
  imports?: string[];
}

const CF_EXPORTS = ["DurableObject", "WorkflowEntrypoint"];

function workerMember(key: string, fn: Fn): string {
  const src = fn.toString();
  // method shorthand (`async fetch(req) {…}`) ships as-is; arrows/functions get a key
  return new RegExp(`^(async\\s+)?(\\*\\s*)?${key}\\s*\\(`).test(src) ? src : `${key}: ${src}`;
}

/** Render the JavaScript module celld will bundle. Exported for the curious. */
export function renderModule(spec: ShipSpec): string {
  const classes = spec.classes ?? [];
  const helpers = spec.helpers ?? [];
  const bodies = [...classes, ...helpers].map((f) => f.toString()).join("\n");
  const needed = CF_EXPORTS.filter((n) => new RegExp(`\\b${n}\\b`).test(bodies));
  const imports = [...new Set([...needed, ...(spec.imports ?? [])])];
  const parts: string[] = [];
  if (imports.length) parts.push(`import { ${imports.join(", ")} } from "cloudflare:workers";`);
  for (const h of helpers) parts.push(h.toString());
  for (const c of classes) parts.push(`export ${c.toString()}`);
  if (spec.worker) {
    const members = Object.entries(spec.worker).map(([k, f]) => "  " + workerMember(k, f));
    parts.push(`export default {\n${members.join(",\n")}\n};`);
  }
  return parts.join("\n\n") + "\n";
}

// ─────────────────────────────────────────────────────────────────────────────
// The celld dev process
// ─────────────────────────────────────────────────────────────────────────────

const running = new Map<number, App>();

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

export interface StartOptions {
  /** Pass --logs so the node's INFO lines (lifecycle events) land in app.logs(). */
  logs?: boolean;
  /** Pass --clean to wipe .celld/dev first. */
  clean?: boolean;
  /** Extra environment for the node (CELLD_IDLE_EVICT_S, …). */
  env?: Record<string, string>;
  /** Seconds to wait for readiness. */
  timeout?: number;
}

export class App {
  readonly dir: string;
  readonly url: string;
  #proc?: Deno.ChildProcess;
  #log = "";
  #mark = 0;
  #tools?: { celld: string; esbuild: string };

  constructor(readonly name: string, readonly port: number, dir?: string) {
    this.dir = dir ?? `${nbHome()}/apps/${name}`;
    this.url = `http://127.0.0.1:${port}`;
  }

  get isRunning(): boolean {
    return this.#proc !== undefined;
  }

  /** Write the project. If celld dev is running, wait for the hot reload. */
  async ship(spec: ShipSpec): Promise<string> {
    const module = renderModule(spec);
    await Deno.mkdir(`${this.dir}/src`, { recursive: true });
    await Deno.mkdir(`${nbHome()}/tools`, { recursive: true });
    const wrangler = { name: this.name, main: "src/index.js", compatibility_date: "2026-08-18", ...(spec.wrangler ?? {}) };
    for (const [path, body] of Object.entries(spec.files ?? {})) {
      const full = `${this.dir}/${path}`;
      await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
      await Deno.writeTextFile(full, body);
    }
    const readyBefore = this.#readyCount();
    this.#mark = this.#log.length;
    await Deno.writeTextFile(`${this.dir}/wrangler.jsonc`, JSON.stringify(wrangler, null, 2) + "\n");
    await Deno.writeTextFile(`${this.dir}/src/index.js`, module);
    if (this.#proc) {
      await this.#waitFor(() => this.#readyCount() > readyBefore, 60, "hot reload");
      console.log(`reloaded ${this.name} (${module.length} bytes)`);
    }
    return module;
  }

  async start(opts: StartOptions = {}): Promise<this> {
    const prev = running.get(this.port);
    if (prev) await prev.stop();
    this.#tools ??= await ensureTools();
    const args = ["dev", "--port", String(this.port)];
    if (opts.logs) args.push("--logs");
    if (opts.clean) args.push("--clean");
    this.#log = "";
    this.#mark = 0;
    if (await portInUse(this.port)) {
      throw new Error(
        `port ${this.port} is already serving — probably a celld dev left over from an earlier kernel. ` +
        `Run stopAll(), or kill it: pkill -f 'celld dev --port ${this.port}'`,
      );
    }
    // Run celld under a shell that holds our stdin open and kills celld when the
    // pipe closes — so a kernel restart or crash never leaves an orphan on the port.
    this.#proc = new Deno.Command("sh", {
      args: ["-c", 'celld="$1"; shift; "$celld" "$@" & pid=$!; while read -r _; do :; done; kill "$pid" 2>/dev/null; wait "$pid"', "celld-nb", this.#tools.celld, ...args],
      cwd: this.dir,
      env: { ...Deno.env.toObject(), CELLD_ESBUILD: this.#tools.esbuild, ...(opts.env ?? {}) },
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    running.set(this.port, this);
    const drain = async (s: ReadableStream<Uint8Array>) => {
      for await (const chunk of s.pipeThrough(new TextDecoderStream())) this.#log += chunk;
    };
    drain(this.#proc.stdout);
    drain(this.#proc.stderr);
    this.#proc.status.then(() => { this.#proc = undefined; running.delete(this.port); });
    await this.#waitFor(() => this.#readyCount() > 0, opts.timeout ?? 90, "startup");
    console.log(`celld dev ready at ${this.url}  (project ${this.dir})`);
    return this;
  }

  async stop(): Promise<void> {
    const p = this.#proc;
    if (!p) return;
    // closing stdin makes the wrapper shell SIGTERM celld and wait for it
    try { await p.stdin.close(); } catch { /* already closed */ }
    const status = await p.status;
    this.#proc = undefined;
    running.delete(this.port);
    console.log(`celld dev stopped (exit ${status.code})`);
  }

  fetch(path: string, init?: RequestInit): Promise<Response> {
    return fetch(this.url + path, init);
  }

  async json<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    const r = await this.fetch(path, init);
    const body = await r.text();
    try { return JSON.parse(body) as T; } catch { throw new Error(`HTTP ${r.status} from ${path}: ${body.slice(0, 300)}`); }
  }

  async text(path: string, init?: RequestInit): Promise<string> {
    return (await this.fetch(path, init)).text();
  }

  /** The node's output so far, colour-stripped; filter with a RegExp, or take the last N lines. */
  logs(opts: { grep?: RegExp; last?: number } = {}): string {
    let lines = strip(this.#log).split("\n");
    if (opts.grep) lines = lines.filter((l) => opts.grep!.test(l));
    if (opts.last) lines = lines.slice(-opts.last);
    return lines.join("\n");
  }

  /** Forget everything in the log so the next logs() call shows only what follows. */
  clearLogs(): void {
    this.#log = "";
  }

  #readyCount(): number {
    return (strip(this.#log).match(/^\s*ready\s+http:\/\//gm) ?? []).length;
  }

  async #waitFor(cond: () => boolean, seconds: number, what: string): Promise<void> {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      if (cond()) return;
      if (!this.#proc || /the local node exited/.test(strip(this.#log).slice(this.#mark))) {
        // the node is gone (the wrapper shell may still be alive) — fail now, not at the deadline
        const tail = this.logs({ last: 30 });
        await this.stop();
        throw new Error(`celld dev exited during ${what}:\n${tail}`);
      }
      if (what === "hot reload" && /^\d+ errors?$/m.test(strip(this.#log).slice(this.#mark))) {
        // esbuild failed; celld leaves the previous deployment serving
        await new Promise((r) => setTimeout(r, 300));
        throw new Error(`build failed; the previous deployment is still serving:\n${strip(this.#log).slice(this.#mark)}`);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`timed out waiting for ${what} after ${seconds}s:\n${this.logs({ last: 30 })}`);
  }
}

/** Stop every celld dev process this kernel started. Run this in the last cell. */
export async function stopAll(): Promise<void> {
  for (const app of [...running.values()]) await app.stop();
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
