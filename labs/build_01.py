import json
cells = []
def md(s): cells.append({"cell_type": "markdown", "metadata": {}, "source": s.strip("\n")})
def code(s): cells.append({"cell_type": "code", "metadata": {}, "source": s.strip("\n"), "outputs": [], "execution_count": None})

md(r'''
# celld · Notebook 1—The cell model

<!-- series-only -->**Companion to the Reading Room articles Part 1, _Durable Objects on Your Own Storage_ (the Field Guide), and Part 2, _Building on celld, step by step_ (the guide), written against celld v0.6.0.**<!-- /series-only --><!-- book-only -->**Written against celld v0.6.0.**<!-- /book-only --> Part 1 § 11 defines the terms it uses. This notebook covers Part 1 § 02 and § 07 and Part 2 Steps 02–04: what a cell is, how it is addressed, why one thread per cell makes storage safe, SQL storage, alarms, and the `celld dev` loop.

## How these notebooks work

celld is a *runtime*, not a library: V8 + SQLite serving the Cloudflare Workers and Durable Objects API. A notebook cannot `import` it. Instead this notebook is a **driver** for a real `celld dev` process, and the code you write here is real code:

1. You define Durable Object classes and the Worker in ordinary cells, against a small kernel-side shim for `cloudflare:workers` (`DurableObject`, `fakeCtx()`) from `celld_nb.ts`. That means a cell class can be **run right here in the kernel** against fake storage first.
2. `app.ship({ classes, worker, wrangler })` serializes those same classes with `Function.prototype.toString()` into `src/index.js`, writes `wrangler.jsonc`, and waits for celld's hot reload.
3. `app.start()` spawns `celld dev`; `app.fetch()` / `app.json()` talk to it; `stopAll()` shuts it down.

Two rules follow from the `toString()` trick. A shipped class must be **self-contained**: `toString()` captures the class body, not closures over other cells, so pass shared functions via `helpers`. And the kernel has already stripped TypeScript when it ships, so **what celld runs is JavaScript**. The type annotations in cells are for you, and nothing type-checks them.

**Prerequisites.** A Deno kernel (this one), and `celld` + `esbuild` on the machine. The setup cell finds them on `PATH` or installs both into `~/.cache/celld-nb/tools` (override with `CELLD_BIN` / `CELLD_ESBUILD`; `npm` is needed for the esbuild install). Linux x86-64/ARM64 and Apple Silicon only.
''')

md(r'''
## Setup

Import the helper, locate the tools, and name the project. Each notebook uses its own port so they can run side by side. The project directory is `~/.cache/celld-nb/apps/<name>/` (override the root with `CELLD_NB_HOME`). It is deliberately not beside the notebook: a notebook directory may be a network share, and celld's SQLite state must not live on one. Open it after the first `ship()` to see exactly what celld is bundling.
''')

code(r'''
import { App, DurableObject, fakeCtx, stopAll, sleep, type DurableObjectNamespace } from "./celld_nb.ts";

const app = new App("cells", 9901);
console.log("project dir:", app.dir);
''')

md(r'''
## Part 1—A cell is a Durable Object (Part 1 § 02, Part 2 Step 02)

A **cell** is a Durable Object: a small server with a name and a private SQLite database. You make one per user, per document, per chat room, per agent. It serves HTTP, holds WebSockets, sets alarms, and makes outbound calls.

The Worker (the default export) is the stateless router; the exported class is the cell. `idFromName(name)` is the whole addressing model: the same name maps to the same cell from any node in the fleet, forever.

Below is celld's own counter example, as a cell in this notebook. `this.ctx.storage` is the cell's storage; `get`/`put` are its key-value face. Before shipping anything, run the class **in the kernel** against `fakeCtx()`, which puts a Map behind the key-value face and a real in-memory SQLite behind the SQL face.
''')

code(r'''
interface Env {
  COUNTER: DurableObjectNamespace;
}

class Counter extends DurableObject<Env> {
  async fetch(_request: Request): Promise<Response> {
    const n = ((await this.ctx.storage.get<number>("n")) ?? 0) + 1;
    await this.ctx.storage.put("n", n);
    return Response.json({ n });
  }
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const name = new URL(request.url).searchParams.get("name") ?? "default";
    const id = env.COUNTER.idFromName(name);
    return env.COUNTER.get(id).fetch(request);
  },
};

// The class is real: instantiate it here, in the kernel, with fake storage.
const local = new Counter(fakeCtx("alpha"), {} as Env);
console.log(await (await local.fetch(new Request("http://cell/"))).json());
console.log(await (await local.fetch(new Request("http://cell/"))).json());
''')

md(r'''
Now ship it. `wrangler` here is the same `wrangler.jsonc` the guide's Step 02 shows. The binding name `COUNTER` is how the Worker reaches the class through `env`. The `migrations` entry with `new_sqlite_classes` is what gives the class SQLite-backed storage; on celld every cell is SQLite-backed, and this is the declaration that matches Cloudflare's.

`ship()` returns the module it wrote. Read it: it is your cell, minus types, with the real `cloudflare:workers` import on top.
''')

code(r'''
const wrangler = {
  durable_objects: { bindings: [{ name: "COUNTER", class_name: "Counter" }] },
  migrations: [{ tag: "v1", new_sqlite_classes: ["Counter"] }],
};

const module = await app.ship({ classes: [Counter], worker, wrangler });
await app.start({ clean: true });   // --clean: start from an empty local store
console.log(module);
''')

md(r'''
Step 03 of the guide exercises the counter with `curl`. Same thing from here:
''')

code(r'''
console.log(await app.json("/?name=alpha"));
console.log(await app.json("/?name=alpha"));
console.log(await app.json("/?name=beta"));
''')

md(r'''
Two names, two cells, two independent SQLite databases. That is the model working. Compare with the in-kernel run above: the same class, the same answers.

## Part 2—One thread per cell (Part 1 § 02)

The property that makes the model safe without distributed locking, as Part 1 § 02 states it:

> Two requests to the same cell never run at the same instant. A second request can interleave only while the first *awaits*, and storage operations are synchronous, so a storage operation never interleaves at all.

The subtle part is *which* awaits let another request in. Awaiting a storage operation does not (Durable Objects call this the input gate). Awaiting anything else does: an outbound `fetch`, a timer, a WebSocket send. So a read-modify-write that awaits a non-storage promise in the middle is a lost-update bug, exactly as it would be against a shared database.

`Racy` below does that deliberately, with a 100 ms timer standing in for an outbound call. `mode=gated` wraps the same work in `blockConcurrencyWhile()`, which holds the cell's input gate for the duration (30-second limit; a timeout resets the object). Fire ten concurrent requests at each.
''')

code(r'''
class Racy extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const mode = new URL(request.url).searchParams.get("mode") ?? "racy";
    const work = async () => {
      const n = (await this.ctx.storage.get<number>("n")) ?? 0;
      await new Promise((r) => setTimeout(r, 100));   // NOT a storage op: another request may run here
      await this.ctx.storage.put("n", n + 1);
      return n + 1;
    };
    const n = mode === "gated" ? await this.ctx.blockConcurrencyWhile(work) : await work();
    return Response.json({ n });
  }
}

// The Worker now routes by binding name too: /?ns=RACY&name=…
const router = {
  async fetch(request: Request, env: Record<string, DurableObjectNamespace>): Promise<Response> {
    const url = new URL(request.url);
    const ns = env[url.searchParams.get("ns") ?? "COUNTER"];
    if (!ns) return new Response(`no binding ${url.searchParams.get("ns")}`, { status: 404 });
    return ns.get(ns.idFromName(url.searchParams.get("name") ?? "default")).fetch(request);
  },
};

wrangler.durable_objects.bindings.push({ name: "RACY", class_name: "Racy" });
wrangler.migrations.push({ tag: "v2", new_sqlite_classes: ["Racy"] });
await app.ship({ classes: [Counter, Racy], worker: router, wrangler });

const fire = (name: string, mode: string) =>
  Promise.all(Array.from({ length: 10 }, () => app.json<{ n: number }>(`/?ns=RACY&name=${name}&mode=${mode}`)));

console.log("racy  →", (await fire("r", "racy")).map((x) => x.n).join(" "));
console.log("gated →", (await fire("g", "gated")).map((x) => x.n).join(" "));
console.log("counter alpha survived the reload:", await app.json("/?name=alpha"));
''')

md(r'''
Ten racy requests, ten answers of `1`: every request read `0`, yielded at the timer, and wrote `1`. Ten gated requests, the numbers 1–10 in whatever order the responses arrived: each one saw the previous write. Note the third line, too. Adding a class and a migration tag was a hot reload, and `alpha`'s count carried on from Part 1.

The rule that follows: do the read-modify-write between storage operations only, and put outbound work either before the read or after the write. `blockConcurrencyWhile` is the escape hatch, not the default, because it stalls every other request to the cell.

## Part 3—Give the cell real state (Part 2 Step 04)

Every cell also carries a full SQLite database, synchronous from the cell's point of view: `this.ctx.storage.sql.exec(query, ...binds)` returns a cursor with `toArray()` and `one()`. There is no transaction ceremony for ordinary work, because nothing interleaves with a storage operation.

Two production rules from Step 04 show up in the shape of `Ledger`:

- **Keep the constructor trivial.** A cell keeps no memory across state transitions, and the constructor runs again on every wake. So the schema is ensured inside the handler (`CREATE TABLE IF NOT EXISTS` is cheap), and nothing is restored in the constructor.
- **Finish write cursors before you answer.** An unconsumed `RETURNING` cursor at response time is an error on celld. `Ledger` consumes its `RETURNING` with `one()` immediately.

`fakeCtx()`'s SQL face is real SQLite (`node:sqlite`), so run the ledger in the kernel first.
''')

code(r'''
class Ledger extends DurableObject<Env> {
  #ensureSchema() {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL, memo TEXT, at INTEGER NOT NULL)",
    );
  }

  async fetch(request: Request): Promise<Response> {
    this.#ensureSchema();
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/entries") {
      const { amount, memo } = await request.json() as { amount: number; memo?: string };
      const row = this.ctx.storage.sql
        .exec<{ id: number }>("INSERT INTO entries (amount, memo, at) VALUES (?, ?, ?) RETURNING id", amount, memo ?? null, Date.now())
        .one();                                   // consume the write cursor before answering
      return Response.json({ id: row.id });
    }
    if (url.pathname === "/balance") {
      const { balance, count } = this.ctx.storage.sql
        .exec<{ balance: number | null; count: number }>("SELECT SUM(amount) AS balance, COUNT(*) AS count FROM entries")
        .one();
      return Response.json({ balance: balance ?? 0, count });
    }
    if (url.pathname === "/entries") {
      return Response.json(this.ctx.storage.sql.exec("SELECT id, amount, memo, at FROM entries ORDER BY id").toArray());
    }
    return new Response("POST /entries {amount, memo} · GET /balance · GET /entries", { status: 404 });
  }
}

const post = (url: string, body: unknown) =>
  new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

const ledger = new Ledger(fakeCtx("acct-1"), {} as Env);
await ledger.fetch(post("http://cell/entries", { amount: 120, memo: "deposit" }));
await ledger.fetch(post("http://cell/entries", { amount: -45, memo: "coffee" }));
console.log(await (await ledger.fetch(new Request("http://cell/balance"))).json());
console.log(await (await ledger.fetch(new Request("http://cell/entries"))).json());
''')

md(r'''
Ship it and run the same sequence against celld. The query string carries the routing (`ns`, `name`); the path carries the operation.
''')

code(r'''
wrangler.durable_objects.bindings.push({ name: "LEDGER", class_name: "Ledger" });
wrangler.migrations.push({ tag: "v3", new_sqlite_classes: ["Ledger"] });
await app.ship({ classes: [Counter, Racy, Ledger], worker: router, wrangler });

const acct = (path: string, init?: RequestInit) => app.json(`${path}?ns=LEDGER&name=acct-1`, init);
console.log(await acct("/entries", { method: "POST", body: JSON.stringify({ amount: 120, memo: "deposit" }) }));
console.log(await acct("/entries", { method: "POST", body: JSON.stringify({ amount: -45, memo: "coffee" }) }));
console.log(await acct("/balance"));
console.log("a different name is a different database:", await app.json("/balance?ns=LEDGER&name=acct-2"));
''')

md(r'''
## Part 4—Alarms (Part 2 Step 04, Part 1 § 06)

An alarm is a durable wake-up: `setAlarm(when)` in a handler, and celld calls `alarm()` at that time, on whichever node owns the cell then, after a restart, after a move. Two celld guarantees from Step 04 of the guide:

- **Alarms are covered by the acknowledgement gate.** When a handler sets an alarm, celld does not send the successful response until a durable wake entry covers it. A node loss after the response cannot lose the alarm.
- **A failed `alarm()` is retried with backoff.**

`Reminder` schedules itself `in` milliseconds ahead and records each firing in SQL. In the kernel, `fakeCtx()` only *records* alarms (`ctx.alarms`); nothing fires, which is enough to unit-test the scheduling logic. On celld it fires for real.
''')

code(r'''
class Reminder extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS firings (at INTEGER NOT NULL, note TEXT)");
    const url = new URL(request.url);
    if (url.pathname === "/remind") {
      const inMs = Number(url.searchParams.get("in") ?? 1000);
      await this.ctx.storage.put("note", url.searchParams.get("note") ?? "ping");
      await this.ctx.storage.setAlarm(Date.now() + inMs);
      return Response.json({ scheduledFor: await this.ctx.storage.getAlarm() });
    }
    return Response.json({
      pending: await this.ctx.storage.getAlarm(),
      firings: this.ctx.storage.sql.exec("SELECT at, note FROM firings ORDER BY at").toArray(),
    });
  }

  async alarm(): Promise<void> {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS firings (at INTEGER NOT NULL, note TEXT)");
    const note = await this.ctx.storage.get<string>("note");
    this.ctx.storage.sql.exec("INSERT INTO firings (at, note) VALUES (?, ?)", Date.now(), note ?? null);
  }
}

// In the kernel: the alarm is recorded, not fired — call alarm() by hand to test its body.
const ctx = fakeCtx("r1");
const reminder = new Reminder(ctx, {} as Env);
await reminder.fetch(new Request("http://cell/remind?in=500&note=kettle"));
console.log("recorded alarms:", ctx.alarms.length, "→ pending:", await ctx.storage.getAlarm());
await reminder.alarm();
console.log(await (await reminder.fetch(new Request("http://cell/"))).json());
''')

code(r'''
wrangler.durable_objects.bindings.push({ name: "REMINDER", class_name: "Reminder" });
wrangler.migrations.push({ tag: "v4", new_sqlite_classes: ["Reminder"] });
await app.ship({ classes: [Counter, Racy, Ledger, Reminder], worker: router, wrangler });

const rem = (path: string) => app.json<{ pending: number | null; firings: unknown[] }>(`${path}${path.includes("?") ? "&" : "?"}ns=REMINDER&name=r1`);
console.log(await rem("/remind?in=1500&note=kettle"));
console.log("right away:", await rem("/"));
await sleep(2500);
console.log("2.5 s later:", await rem("/"));
''')

md(r'''
`pending` is the alarm's timestamp while it is scheduled and `null` after it fires; the firing itself is a row that survived the wake. Nothing in memory did. `alarm()` re-creates the table because, on a hibernated or moved cell, it may be the first code that runs after the constructor.

## Part 5—The `celld dev` loop (Part 2 Step 03)

You have already used the loop four times without looking at it. Editing a source file triggers the watcher, which builds a new deployment *beside* the running one and adopts it in place. Durable state in `.celld/dev` persists across rebuilds and normal shutdowns. A failed build leaves the current application serving. The dev loop is the production deployment mechanism in miniature.

Two demonstrations. First, redeclare `Counter` with a `step` parameter and re-ship: `alpha` continues from its old count under the new code. Second, write a broken `src/index.js` by hand and watch what celld does.
''')

code(r'''
class Counter extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const step = Number(new URL(request.url).searchParams.get("step") ?? 1);
    const n = ((await this.ctx.storage.get<number>("n")) ?? 0) + step;
    await this.ctx.storage.put("n", n);
    return Response.json({ n, step });
  }
}
await app.ship({ classes: [Counter, Racy, Ledger, Reminder], worker: router, wrangler });
console.log("alpha, new code, old state:", await app.json("/?name=alpha&step=10"));

// Now break the build on purpose. ship() would refuse; write the file directly.
app.clearLogs();
await Deno.writeTextFile(`${app.dir}/src/index.js`, "export default { fetch( { this is not JavaScript");
await sleep(4000);
console.log(app.logs({ grep: /ERROR|error|change detected/ }));
console.log("still serving the last good build:", await app.json("/?name=alpha&step=0"));

// …and put it back.
await app.ship({ classes: [Counter, Racy, Ledger, Reminder], worker: router, wrangler });
console.log("restored:", await app.json("/?name=alpha&step=0"));
''')

md(r'''
The rules of the loop, from Step 03:

- State lives in `.celld/dev` under the project, and `--clean` resets it.
- A configuration change is *not* migrated into stored state, so a renamed class or binding against an old store can fail confusingly. Clean and start again.
- The watcher ignores `.celld`, `.wrangler`, `.git`, `node_modules`, and `target`.

### Exercise—a rate limiter cell

One cell per API key is the canonical Durable Object rate limiter: the cell *is* the partition, so there is no shared counter to contend on. Implement `RateLimiter` as a token bucket:

- `capacity` tokens (default 3), refilled at `refillPerSec` (default 1). Both read from the query string so the checker can vary them.
- `GET /` takes one token: respond `200 {"ok":true,"tokens":<remaining>}` or `429 {"ok":false,"retryInMs":<ms until the next token>}`.
- Keep `tokens` and `lastRefill` in storage (`get`/`put` or SQL, your choice). **No timers**: compute the refill from elapsed time on each request. That is what lets the cell hibernate for free between calls.
- Respect Part 2: no non-storage `await` between reading and writing the bucket.

The checker runs your class in the kernel with `fakeCtx()`, then ships it and runs the same sequence on celld.

**Hints**, from a nudge to a near-solution. Try the exercise first, then read only as far as you need.

1. **Concept.** A token bucket needs no timer. On each request, work out how many tokens the time since `lastRefill` has earned, add them (capped at `capacity`), and only then decide.
2. **Data shape.** One stored value is enough: `{ tokens, lastRefill }` under a single key with `this.ctx.storage.get` and `put`, defaulting to `{ tokens: capacity, lastRefill: Date.now() }` on first use. Tokens can be fractional; spend one only when `tokens >= 1`.
3. **Sketch.** `tokens = min(capacity, tokens + refillPerSec × elapsedSeconds)`, then `lastRefill = now`. With a token to spend, subtract one, store, and answer 200 with the whole tokens left. Without one, store and answer 429 with `retryInMs` = the time the missing fraction of a token takes at `refillPerSec`. Every `await` on that path is a storage call.

Full worked solutions are intentionally not included. The checker cell is the verification: every line turns from ✗ to ✓ once the implementation is right.
''')

code(r'''
class RateLimiter extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const capacity = Number(url.searchParams.get("capacity") ?? 3);
    const refillPerSec = Number(url.searchParams.get("refillPerSec") ?? 1);
    // TODO: read {tokens, lastRefill} from storage (default: full bucket, now),
    //       add refillPerSec * elapsedSeconds (capped at capacity), then
    //       either spend one token and answer 200, or answer 429 with retryInMs.
    return new Response("not implemented", { status: 501 });
  }
}
''')

code(r'''
// ── checker ────────────────────────────────────────────────────────────────
const burst = async (call: (q: string) => Promise<Response>, n: number) => {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(String((await call("capacity=3&refillPerSec=2")).status));
  return out.join(" ");
};

const rl = new RateLimiter(fakeCtx("key-1"), {} as Env);
const inKernel = await burst((q) => rl.fetch(new Request(`http://cell/?${q}`)), 5);
console.log("kernel:", inKernel, inKernel === "200 200 200 429 429" ? "✓" : "✗ expected 200 200 200 429 429");
await sleep(1100);
const after = (await rl.fetch(new Request("http://cell/?capacity=3&refillPerSec=2"))).status;
console.log("after 1.1 s at 2 tokens/s:", after, after === 200 ? "✓" : "✗ expected 200 (refilled)");

wrangler.durable_objects.bindings.push({ name: "LIMITER", class_name: "RateLimiter" });
wrangler.migrations.push({ tag: "v5", new_sqlite_classes: ["RateLimiter"] });
await app.ship({ classes: [Counter, Racy, Ledger, Reminder, RateLimiter], worker: router, wrangler });
const onCelld = await burst((q) => app.fetch(`/?ns=LIMITER&name=key-1&${q}`), 5);
console.log("celld: ", onCelld, onCelld === "200 200 200 429 429" ? "✓" : "✗");
console.log("another key is another bucket:", (await app.fetch("/?ns=LIMITER&name=key-2&capacity=3&refillPerSec=2")).status);
''')

md(r'''
## Clean up

Stop the node. State stays in the project's `.celld/dev`; the next `app.start()` without `clean: true` resumes it.
''')

code(r'''
await stopAll();
''')

md(r'''
## Where next

That is the cell model from Part 1 § 02 and § 07 and Steps 02–04 of the guide: a named object with one thread and its own SQLite, addressed by `idFromName`, safe to mutate because storage never interleaves, with durable alarms and a dev loop that keeps state across deploys.

- **Notebook 2—Bindings** adds the cross-cutting services (Steps 05 and 07): KV, Queues, D1, and R2, all cells underneath.
- **Notebook 3—Processes and lifecycle** covers Workflows (Step 06), WebSockets and hibernation, cron triggers, RPC, and reading celld's lifecycle events.

What these notebooks deliberately leave to the articles: fleets, buckets, ownership and fencing (Part 1 § 03–05, Steps 08–10). Those are operational, and `celld dev`'s local store is not a fleet.

**Maintenance.** This export is frozen at celld v0.6.0, executed 2026·09·26. Re-execute it on each new celld release and note what changed: upstream moves fast, with five releases (v0.4.0 through v0.6.0) between 2026·08·28 and 2026·09·26.
''')

nb = {"cells": cells, "metadata": {"kernelspec": {"name": "deno", "display_name": "Deno", "language": "typescript"},
      "language_info": {"name": "typescript"}}, "nbformat": 4, "nbformat_minor": 5}
json.dump(nb, open("celld-01-cells.ipynb", "w"), indent=1)
print(len(cells), "cells")
