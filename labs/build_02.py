import json
cells = []
def md(s): cells.append({"cell_type": "markdown", "metadata": {}, "source": s.strip("\n")})
def code(s): cells.append({"cell_type": "code", "metadata": {}, "source": s.strip("\n"), "outputs": [], "execution_count": None})

md(r'''
# celld · Notebook 2—Bindings: KV, Queues, D1, and R2

<!-- series-only -->**Companion to the Reading Room articles Part 1, _Durable Objects on Your Own Storage_ (the Field Guide), and Part 2, _Building on celld, step by step_ (the guide), written against celld v0.6.0.**<!-- /series-only --><!-- book-only -->**Written against celld v0.6.0.**<!-- /book-only --> Part 1 § 11 defines the terms it uses. This notebook covers Part 2 Steps 05 and 07 and the KV, Queues, R2, Wrangler-configuration, and "D1 is a cell" subsections of Part 1 § 06: the four cross-cutting services, what each one is underneath, and the two places where `celld dev` behaves differently from a fleet. Each service also has its own page under celld.dev/docs/services, with a worked example.

**How this notebook works** (Notebook 1 has the full explanation): cells define the Worker and any Durable Object classes as real TypeScript; `app.ship({ classes, worker, wrangler, files })` serializes them with `Function.prototype.toString()` into `src/index.js` + `wrangler.jsonc` and waits for celld's hot reload; `app.start()` spawns `celld dev`; `app.json()` / `app.text()` / `app.fetch()` talk to it; `app.logs()` reads the node's output. Shipped code must be self-contained (no closures over other cells), and what celld runs is JavaScript—the types are for you.

Unlike the cells of Notebook 1, **none of these four bindings has an in-kernel fake**: every cell below runs against `celld dev`.
''')

md(r'''
## Setup

Import the helper and name the project. Port 9902 keeps this notebook clear of the other two; the project directory is printed below (`app.dir`, under the root Notebook 1 describes). The helper types Durable Object bindings only, so the second block declares the minimal shapes of the four services this notebook uses. They are enough to type `env` in cells; nothing checks them, and they are not shipped.
''')

code(r'''
import { App, DurableObject, stopAll, sleep, type DurableObjectNamespace } from "./celld_nb.ts";
import { DatabaseSync } from "node:sqlite";

interface KVNamespace {
  get(key: string, type?: "text" | "json" | { cacheTtl?: number }): Promise<unknown>;
  getWithMetadata(key: string, opts?: { cacheTtl?: number }): Promise<unknown>;
  put(key: string, value: string, opts?: { expirationTtl?: number; expiration?: number; metadata?: unknown }): Promise<void>;
  list(opts?: { prefix?: string; limit?: number }): Promise<unknown>;
  delete(key: string): Promise<void>;
}
interface D1Result { success: boolean; results: Record<string, unknown>[]; meta: Record<string, unknown> }
interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  all(): Promise<D1Result>;
  first(column?: string): Promise<unknown>;
  run(): Promise<D1Result>;
  raw(): Promise<unknown[][]>;
}
interface D1Database {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<D1Result[]>;
  exec(sql: string): Promise<{ count: number; duration: number }>;
  dump(): Promise<ArrayBuffer>;
}
interface R2Object {
  key: string; size: number; version: string; etag: string; httpEtag: string; uploaded: Date;
  httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string>;
  checksums: { toJSON(): Record<string, string> };
  text(): Promise<string>; json(): Promise<unknown>;
}
interface R2Bucket {
  put(key: string, body: string, opts?: Record<string, unknown>): Promise<R2Object | null>;
  get(key: string): Promise<R2Object | null>;
  head(key: string): Promise<R2Object | null>;
  list(opts?: { prefix?: string; include?: string[] }): Promise<{ objects: R2Object[]; truncated: boolean }>;
  delete(key: string): Promise<void>;
}
interface QueueMessage { id: string; attempts: number; body: Record<string, unknown>; ack(): void; retry(opts?: { delaySeconds?: number }): void }
interface MessageBatch { queue: string; messages: QueueMessage[]; ackAll(): void; retryAll(): void }
interface Queue { send(body: unknown): Promise<void>; sendBatch(messages: { body: unknown }[]): Promise<void> }

interface Env {
  SESSIONS: KVNamespace;
  DB: D1Database;
  FILES: R2Bucket;
  OUTBOX: Queue;
  PROFILE: DurableObjectNamespace;
}

const app = new App("bindings", 9902);
console.log("project dir:", app.dir);
''')

md(r'''
## Part 1—The theme: every service is a cell (Part 2 Step 05, Part 1 § 06 "Wrangler configuration")

Cells cover per-entity state. The four services in this notebook are the *cross-cutting* ones, data shared across entities, and the articles describe each with the same sentence: it is a cell underneath. A KV namespace is a cell. A queue is a cell. A D1 database is "one cell holding one SQLite database". An R2 bucket is a prefix in the fleet bucket. So each inherits what cells have (fencing, replication, durable acknowledgement), and each inherits the cell's limit: **one writer per namespace / queue / database.** Capacity comes from adding more of them, never from growing one.

Bindings are declared in `wrangler.jsonc` and reach the Worker (and any cell) through `env`. celld models a fixed set of top-level keys and, by its fail-loudly rule, stops a deploy on any key it does not model. The accepted keys (Step 02):

> `$schema`, `name`, `main`, `no_bundle`, `compatibility_date`, `compatibility_flags`, `durable_objects`, `migrations`, `assets`, `services`, `triggers`, `vars`, `d1_databases`, `kv_namespaces`, `queues`, `workflows`, `r2_buckets`, `worker_loaders`, `containers`, `define`, and `rules`. `define` and `rules` are passed to the esbuild run, so they cannot combine with `no_bundle`.

Below: the four declarations from the articles in one configuration, a Worker that only reports what `env` holds, and the binding table celld prints at deploy. The queue's `consumers` entry is left out until Part 5, for a reason that Part shows.
''')

code(r'''
const wrangler: Record<string, unknown> = {
  kv_namespaces: [{ binding: "SESSIONS", id: "sessions-prod" }],
  d1_databases: [{ binding: "DB", database_name: "ledger" }],
  r2_buckets: [{ binding: "FILES", bucket_name: "files" }],
  queues: { producers: [{ binding: "OUTBOX", queue: "outbox" }] },
};

const envWorker = {
  async fetch(_request: Request, env: Record<string, unknown>): Promise<Response> {
    const shape: Record<string, string> = {};
    for (const [name, binding] of Object.entries(env)) shape[name] = binding?.constructor?.name ?? typeof binding;
    return Response.json(shape);
  },
};

await app.ship({ worker: envWorker, wrangler });
await app.start({ clean: true, logs: true });   // --logs: the node's INFO lines show each service's cell being born
console.log(app.logs({ grep: /^(Binding|env\.)/ }));
console.log(await app.json("/"));
''')

md(r'''
Four bindings, four resources, and `env` holds one object per binding. Now the fail-loudly rule, on the key the article names. `ship()` would happily write any key, so put `routes` into `wrangler.jsonc` by hand and watch the reload.
''')

code(r'''
app.clearLogs();
const current = JSON.parse(await Deno.readTextFile(`${app.dir}/wrangler.jsonc`));
await Deno.writeTextFile(`${app.dir}/wrangler.jsonc`, JSON.stringify({ ...current, routes: ["example.com/*"] }, null, 2));
await sleep(3000);
console.log(app.logs({ grep: /reload/ }));
console.log("still serving the last good deployment:", (await app.fetch("/")).status);
await app.ship({ worker: envWorker, wrangler });   // put the good configuration back
console.log("restored:", (await app.fetch("/")).status);
''')

md(r'''
The error names the key, the previous deployment keeps serving, and a good `ship()` afterwards reloads normally. Keep the message in mind: the *same* rule applies to binding entries celld does not model, and Part 5 meets a case where it costs more than a failed reload.

## Part 2—KV: a durable store, not a CDN (Part 2 Step 05, Part 1 § 06 "KV")

```jsonc
"kv_namespaces": [{ "binding": "SESSIONS", "id": "sessions-prod" }]
```

The API is Cloudflare's (`put` / `get` / `getWithMetadata` / `list` / `delete`, `expirationTtl` and `expiration`, `metadata`), with celld's storage model behind it. The article's list of what changes in practice:

- **No edge cache.** `cacheTtl` has no effect and `cacheStatus` is `null`. "Reads route to the namespace's cell. Treat KV as a durable store with KV's API, not as a CDN."
- **One writer per namespace.** The `id` accepts Cloudflare's hex form or any stable string; `sessions-prod` is fine.
- Values above 1 MiB go to the fleet bucket; small values live in the cell.

Two readers below: the Worker, through the routes, and a `Profile` cell that reads the same namespace through `this.env` while keeping its own per-entity counter in its own storage. That is the division of labour the article prescribes.
''')

code(r'''
class Profile extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const token = new URL(request.url).searchParams.get("token") ?? "";
    const session = await this.env.SESSIONS.get(`session:${token}`, "json");   // shared data: the namespace
    const visits = ((await this.ctx.storage.get<number>("visits")) ?? 0) + 1;  // per-entity data: this cell
    await this.ctx.storage.put("visits", visits);
    return Response.json({ cell: this.ctx.id.name, session, visits });
  }
}

const kvWorker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const q = (name: string) => url.searchParams.get(name);
    const key = q("key") ?? "";
    try {
      switch (url.pathname) {
        case "/put": {
          const opts: { expirationTtl?: number; metadata?: unknown } = {};
          if (q("ttl")) opts.expirationTtl = Number(q("ttl"));
          if (q("meta")) opts.metadata = JSON.parse(q("meta") ?? "null");
          await env.SESSIONS.put(key, q("value") ?? "", opts);
          return Response.json({ put: key, ...opts });
        }
        case "/get":
          return Response.json(await env.SESSIONS.getWithMetadata(key, { cacheTtl: 3600 }));   // cacheTtl: no effect
        case "/list":
          return Response.json(await env.SESSIONS.list({ prefix: q("prefix") ?? "" }));
        case "/delete":
          await env.SESSIONS.delete(key);
          return Response.json({ deleted: key });
        case "/profile":
          return env.PROFILE.get(env.PROFILE.idFromName(q("name") ?? "anon")).fetch(request);
      }
      return new Response("not found", { status: 404 });
    } catch (e) {
      return Response.json({ error: String(e) }, { status: 500 });
    }
  },
};

wrangler.durable_objects = { bindings: [{ name: "PROFILE", class_name: "Profile" }] };
wrangler.migrations = [{ tag: "v1", new_sqlite_classes: ["Profile"] }];
await app.ship({ classes: [Profile], worker: kvWorker, wrangler });

const claims = encodeURIComponent(JSON.stringify({ user: "ada", role: "admin" }));
console.log(await app.json(`/put?key=session:abc&value=${claims}&ttl=3600&meta=${encodeURIComponent('{"ua":"notebook"}')}`));
console.log(await app.json("/put?key=session:def&value=plain&ttl=3600"));
console.log(await app.json("/put?key=flag:beta&value=on"));
console.log("get     →", await app.json("/get?key=session:abc"));
console.log("list    →", await app.json("/list?prefix=session:"));
console.log("cell    →", await app.json("/profile?name=ada&token=abc"));
console.log("cell    →", await app.json("/profile?name=ada&token=nope"));
console.log("delete  →", await app.json("/delete?key=flag:beta"), await app.json("/get?key=flag:beta"));
console.log("ttl<60  →", await app.json("/put?key=short&value=x&ttl=5"));
console.log(app.logs({ grep: /cell_isolate_startup_timing.*__KvNamespace/, last: 1 }).replace(/^.*scope=/, "the namespace's cell: scope=").replace(/ node=.*$/, ""));
''')

md(r'''
Observations, against the article:

- `getWithMetadata` with `cacheTtl: 3600` answers with `cacheStatus: null`, and so does `list`: the documented "no edge cache".
- `list` reports each key's absolute `expiration` (unix seconds) and its `metadata`; the key with no TTL has neither.
- The `Profile` cell reads the namespace through `this.env.SESSIONS` exactly as the Worker does, and its `visits` counter is its own: a second call with a bad token still increments it. Shared data in the namespace, per-entity data in the cell.
- A TTL under a minute is refused with a named error, `KV_ERROR: expirationTtl is at least 60 seconds`. That is Cloudflare's floor, enforced loudly.
- The last line is celld's own log: the namespace is a cell with a scope of `__KvNamespace:<hash>`, started on first use. That is the "one writer per namespace" rule made visible.

## Part 3—D1: a database that is a cell (Part 2 Step 07, Part 1 § 06 "D1 is a cell")

```jsonc
"d1_databases": [{ "binding": "DB", "database_name": "ledger" }]
```

"A D1 database on celld is one cell holding one SQLite database", with fencing, replication, and durable acknowledgement included. One database, one writer; more capacity is more databases. The article draws the line for *what goes where* sharply: per-entity data belongs in the entity's cell (Notebook 1's `Ledger` kept each account's entries in the account's own SQLite); D1 is for the genuinely shared tables. Result caps are 100,000 rows or 32 MiB per binding result.

Migrations are Wrangler's: `NNNN_description.sql` files in `migrations/`, applied in numeric order, one transaction per file. The docs give exactly one way to apply them: `celld d1 migrations apply ledger --bucket …` against a fleet. They do not apply on a `celld dev` deploy. The cell below ships the file, and the table is not there after the deploy; the node logs nothing about migrations, and the `d1_migrations` bookkeeping table never appears. `celld d1` needs a running fleet (it finds a node through the bucket's node leases), so it cannot be pointed at the local store either. celld's own `examples/d1` sidesteps the question by running `CREATE TABLE IF NOT EXISTS` from the Worker. The workaround here is honest about what it is: an admin route that runs SQL through `env.DB.exec()`, fed the *same* migration file, the local equivalent of `celld d1 execute ledger --file`. On a fleet, use the real command.
''')

code(r'''
const initSql = `CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY,
  account TEXT NOT NULL,
  amount INTEGER NOT NULL,
  at INTEGER NOT NULL
);
`;

const d1Worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      switch (`${request.method} ${url.pathname}`) {
        case "POST /admin/sql":   // local stand-in for `celld d1 execute --file`
          return Response.json(await env.DB.exec(await request.text()));
        case "GET /tables": {
          const { results } = await env.DB.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\'").all();
          return Response.json(results.map((r) => r.name));
        }
        case "POST /entries": {
          const { account, amount } = await request.json() as { account: string; amount: number };
          const r = await env.DB.prepare("INSERT INTO entries (account, amount, at) VALUES (?, ?, ?)").bind(account, amount, Date.now()).run();
          return Response.json(r.meta);
        }
        case "GET /balance":
          return Response.json(await env.DB
            .prepare("SELECT account, SUM(amount) AS balance FROM entries WHERE account = ? GROUP BY account")
            .bind(url.searchParams.get("account")).first());
        case "GET /summary": {
          const [count, byAccount] = await env.DB.batch([
            env.DB.prepare("SELECT COUNT(*) AS n FROM entries"),
            env.DB.prepare("SELECT account, SUM(amount) AS balance FROM entries GROUP BY account ORDER BY account"),
          ]);
          return Response.json({ count: count.results[0], byAccount: byAccount.results });
        }
        case "GET /dump":
          return Response.json({ bytes: (await env.DB.dump()).byteLength });
      }
      return new Response("not found", { status: 404 });
    } catch (e) {
      return Response.json({ error: String(e) }, { status: 500 });
    }
  },
};

await app.ship({ classes: [Profile], worker: d1Worker, wrangler, files: { "migrations/0001_init.sql": initSql } });
console.log("tables after deploy:", await app.json("/tables"));
console.log("log lines mentioning migrations:", JSON.stringify(app.logs({ grep: /migrat/i })));

// Apply the same file through the Worker — the local stand-in for `celld d1 execute ledger --file migrations/0001_init.sql`.
console.log("exec →", await app.json("/admin/sql", { method: "POST", body: await Deno.readTextFile(`${app.dir}/migrations/0001_init.sql`) }));
console.log("tables now:", await app.json("/tables"));
''')

md(r'''
With the table in place, the prepared-statement API from the article: `prepare().bind().run()` for writes, `.first()` for one row, `.all()` for many, and `batch()` for several statements in one round trip.
''')

code(r'''
const entry = (account: string, amount: number) =>
  app.json("/entries", { method: "POST", body: JSON.stringify({ account, amount }) });

console.log("run   →", await entry("ada", 120));
await entry("ada", -45);
await entry("bob", 30);
console.log("first →", await app.json("/balance?account=ada"));
console.log("batch →", await app.json("/summary"));
console.log("dump  →", await app.json("/dump"));
console.log("bad   →", await app.json("/admin/sql", { method: "POST", body: "SELECT * FROM nowhere;" }));
''')

md(r'''
`run()`'s `meta` says who served the query: `served_by: "celld"`, `served_by_primary: true`, `served_by_region: "local"`, with `rows_written`, `last_row_id` and `size_after`. It is the same shape Cloudflare returns, filled in by the cell. `batch()` returns one result per statement. `dump()` is one of the listed gaps (with Time Travel and the D1 REST API), and celld says so in its own words: *"dump() is not implemented in celld; the database is a SQLite file in your own bucket."* Errors carry SQLite's message behind a named prefix: `D1_ERROR:` from a prepared statement, `D1_EXEC_ERROR:` from `exec()`.

## Part 4—R2: the fleet bucket wearing the R2 API (Part 2 Step 07, Part 1 § 06 "R2")

```jsonc
"r2_buckets": [{ "binding": "FILES", "bucket_name": "files" }]
```

"An R2 binding stores its objects in the fleet bucket under `r2/<bucket_name>/`, which is the fleet bucket earning its name." So unlike KV, D1, and Queues, an R2 binding is *not* a cell: it is the object store itself, which is why the article recommends it for step results and artifacts that outgrow the 1 MiB Workflow caps. The gaps are `ssecKey` and `jurisdiction`, conditional writes on streamed bodies above 8 MiB, and multipart uploads that cannot resume on another node.

The article records one documented difference: "An object's `version` equals its content ETag, so identical content produces the same version." The cell below tests exactly that by writing the same bytes under two keys.
''')

code(r'''
const r2Worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const key = url.searchParams.get("key") ?? "";
    const describe = (o: R2Object | null) => o && {
      key: o.key, size: o.size, version: o.version, etag: o.etag, httpEtag: o.httpEtag,
      checksums: o.checksums.toJSON(), contentType: o.httpMetadata?.contentType, customMetadata: o.customMetadata,
    };
    try {
      switch (`${request.method} ${url.pathname}`) {
        case "PUT /object":
          return Response.json(describe(await env.FILES.put(key, await request.text(), {
            httpMetadata: { contentType: request.headers.get("content-type") ?? "application/octet-stream" },
            customMetadata: { by: "notebook" },
          })));
        case "GET /object": {
          const o = await env.FILES.get(key);
          if (!o) return new Response("no such object", { status: 404 });
          return new Response(await o.text(), { headers: { etag: o.httpEtag, "content-type": o.httpMetadata?.contentType ?? "application/octet-stream" } });
        }
        case "GET /head":
          return Response.json(describe(await env.FILES.head(key)));
        case "GET /list": {
          const l = await env.FILES.list({ prefix: url.searchParams.get("prefix") ?? "", include: ["httpMetadata", "customMetadata"] });
          return Response.json({ truncated: l.truncated, objects: l.objects.map(describe) });
        }
        case "DELETE /object":
          await env.FILES.delete(key);
          return Response.json({ deleted: key });
      }
      return new Response("not found", { status: 404 });
    } catch (e) {
      return Response.json({ error: String(e) }, { status: 500 });
    }
  },
};
await app.ship({ classes: [Profile], worker: r2Worker, wrangler });

const put = (key: string, body: string) =>
  app.json(`/object?key=${key}`, { method: "PUT", body, headers: { "content-type": "application/json" } });
console.log("a →", await put("reports/a.json", '{"total":1}'));
console.log("b →", await put("reports/b.json", '{"total":1}'));   // the same bytes as a
console.log("c →", await put("reports/c.json", '{"total":2}'));
console.log("get  →", await app.text("/object?key=reports/a.json"));
console.log("head →", await app.json("/head?key=reports/c.json"));
console.log("list →", (await app.json<{ objects: { key: string; version: string }[] }>("/list?prefix=reports/")).objects.map((o) => `${o.key} @ ${o.version}`));
console.log("delete →", await app.json("/object?key=reports/c.json", { method: "DELETE" }), "→", await app.text("/object?key=reports/c.json"));
''')

md(r'''
`a` and `b` hold identical bytes: their `checksums.md5` agree, but their `version` / `etag` do **not**. On the local store each write gets the next number from a store-wide counter. So the docs' "identical content produces the same version" is not what `celld dev` does, as Part 1 § 06 and Part 2 Step 07 now note. The claim is about the fleet bucket, where an S3-style ETag of a single-part upload *is* the content hash; the local store is not S3, and it hands out its own ETags. Do not build on `version` equality for de-duplication unless you have checked it on the store you deploy to; `checksums.md5` is the content hash on both.

The `r2/<bucket_name>/` layout is checkable. `celld dev`'s local store, which stands in for the fleet bucket, is `<project>/.celld/dev/objects.sqlite3`, an `objects(key, body, etag, …)` table. Read it from the kernel (read-only, while the node is running):
''')

code(r'''
const store = new DatabaseSync(`${app.dir}/.celld/dev/objects.sqlite3`, { readOnly: true });
console.table(store.prepare("SELECT key, etag, length(body) AS bytes FROM objects WHERE key LIKE 'r2/%' ORDER BY key").all().map((r) => ({ ...r })));
store.close();
''')

md(r'''
Two objects under `r2/files/…`, `c.json` gone, and the `etag` column is the same counter the binding reported as `version`. The R2 binding is a thin API over the store's own rows.

## Part 5—Queues: one writer, one consumer, four days (Part 2 Step 05, Part 1 § 06 "Queues")

```jsonc
"queues": {
  "producers": [{ "binding": "OUTBOX", "queue": "outbox" }],
  "consumers": [{ "queue": "outbox", "max_batch_size": 32 }]
}
```

Producer side: `env.OUTBOX.send(body)` and `sendBatch([{ body }, …])` from the Worker or a cell. Consumer side: a `queue(batch, env)` handler that `ack()`s or `retry()`s each message; a retried message becomes visible again after `delaySeconds` from `retry()` or `retryAll()`, defaulting to the consumer's `retry_delay` (celld adds no exponential backoff; compute one from `message.attempts` if you want it), and the queue keeps messages for four days. The constraints, all fail-loudly: one writer per queue (scale with more queues; past 256 concurrent producer calls the broker refuses with `cell overload: admission refused`), retention of four days and not configurable, no pull consumers or Queues HTTP API, and one consumer script per queue (a deployment in which two scripts consume one queue fails).

The consumer script may also export `fetch()`. The queues service page walks a producer, a consumer with retries, and a dead-letter queue, and celld's `examples/queues` exports `fetch` and `queue` from one script. The cell below uses that shape, a `queue()` handler on the same default export as `fetch()`, with a batch size of 5 and a 1-second batch timeout so the batching is visible, and one poison message that asks for a retry on its first attempt. The consumer records each batch in KV so the HTTP side can show it.
''')

code(r'''
const queueWorker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/send": {
        const n = Number(url.searchParams.get("n") ?? 1);
        await env.OUTBOX.send({ kind: "email", to: "ada@example.com", poison: url.searchParams.get("poison") === "1" });
        if (n > 1) await env.OUTBOX.sendBatch(Array.from({ length: n - 1 }, (_, i) => ({ body: { kind: "email", to: `user${i}@example.com` } })));
        return Response.json({ sent: n });
      }
      case "/delivered":
        return Response.json((await env.SESSIONS.get("outbox:batches", "json")) ?? []);
    }
    return new Response("not found", { status: 404 });
  },

  async queue(batch: MessageBatch, env: Env): Promise<void> {
    const log = ((await env.SESSIONS.get("outbox:batches", "json")) ?? []) as unknown[];
    log.push({ queue: batch.queue, size: batch.messages.length,
      messages: batch.messages.map((m) => `${m.body.to} (attempt ${m.attempts}${m.body.poison ? ", poison" : ""})`) });
    await env.SESSIONS.put("outbox:batches", JSON.stringify(log));
    for (const msg of batch.messages) {
      if (msg.body.poison && msg.attempts < 2) { msg.retry({ delaySeconds: 1 }); continue; }   // redelivered after delaySeconds
      msg.ack();
    }
  },
};

wrangler.queues = {
  producers: [{ binding: "OUTBOX", queue: "outbox" }],
  consumers: [{ queue: "outbox", max_batch_size: 5, max_batch_timeout: 1 }],
};
app.clearLogs();
await app.ship({ classes: [Profile], worker: queueWorker, wrangler });
console.log(app.logs({ grep: /^env\.OUTBOX/, last: 1 }));

console.log(await app.json("/send?n=7&poison=1"));
// With a consumer attached, every reload is a full restart and the port blinks for a few seconds — poll, don't sleep.
let batches: unknown[] = [];
for (let i = 0; i < 60 && batches.length < 3; i++) {
  await sleep(500);
  batches = await app.json<unknown[]>("/delivered").catch(() => batches);
}
for (const b of batches) console.log(JSON.stringify(b));
console.log("restarts during this cell:", app.logs({ grep: /restarting the application/ }).split("\n").filter(Boolean).length);
console.log(app.logs({ grep: /cell_isolate_startup_timing.*__Queue/, last: 1 }).replace(/^.*scope=/, "the queue's cell: scope=").replace(/ node=.*$/, ""));
''')

md(r'''
It works. Attaching a consumer changes celld's reload path: from then on every reload is a full restart of the node, a few seconds during which the port is closed, hence the polling loop. Seven messages arrive as a batch of 5 and a batch of 2 (`max_batch_size`, with `max_batch_timeout` closing the short one). The poison message, retried with `delaySeconds: 1`, comes back in a third batch of its own; the restart cell below counts all three. Every message was handled by the same script that serves HTTP, the documented shape. The consumer is attached to *this* script: celld's binary carries the message "queue consumer declares `script_name`; celld attaches it to the current script", so a `script_name` pointing elsewhere is ignored rather than honored, and there is no second entry point to attach it to. Keeping ingress and consumption separable is sound design, not a rule.

The queue itself is a cell, like the namespace: it appears as a `__Queue` cell in the local store, as the end of this Part shows.

Now the fail-loudly side. The consumer is declared; remove the handler and leave the declaration, which is the mistake the article's warning is really about. Write `src/index.js` by hand, as in Part 1:
''')

code(r'''
app.clearLogs();
await Deno.writeTextFile(`${app.dir}/src/index.js`, "export default { fetch() { return new Response('ingress only'); } };\n");
await sleep(4000);
console.log(app.logs({ grep: /restarting|Error|Caused|queue consumer|exited/ }));
console.log("node reachable?", await app.fetch("/delivered").then((r) => r.status, (e) => String(e).split("\n")[0]));
''')

md(r'''
This one does not end as a failed reload. Because the consumer attachment changed, celld took the *restart* path ("restarting the application", an exact-generation reload), the new Worker failed to load with the named error `queue consumer has no queue handler`, and the local node **exited**. Nothing is serving on the port any more. That is the strongest form of fail-loudly: a consumer shape celld does not model never runs silently, but on `celld dev` it also takes the node down with it, and a `ship()` at this point would wait for a reload that never comes. Recovery is a stop, a good ship, and a start, without `--clean`, so the store is kept.
''')

code(r'''
await app.stop();
await app.ship({ classes: [Profile], worker: queueWorker, wrangler });
await app.start({ logs: true });
console.log("delivery log survived the restart:", (await app.json<unknown[]>("/delivered")).length, "batches");

const store2 = new DatabaseSync(`${app.dir}/.celld/dev/objects.sqlite3`, { readOnly: true });
console.log("cell kinds in the local store:",
  store2.prepare("SELECT DISTINCT substr(key, 7, instr(substr(key, 7), ':') - 1) AS kind FROM objects WHERE key LIKE 'cells/%'").all().map((r) => r.kind));
store2.close();
''')

md(r'''
The last line is the theme of this notebook, read straight off the store: alongside the `Profile` cells sit `__KvNamespace`, `__D1Database`, and `__Queue` cells, one per namespace, database, and queue, and the R2 objects are the `r2/` rows from Part 4. Every cross-cutting service is a cell (or the bucket itself) underneath.

### Exercise—a session store

Sessions are the article's own KV example (`session:${token}` with `expirationTtl: 3600`), and an audit trail is a genuinely shared table: D1's job, not a per-user cell's. Complete `sessionWorker`:

- `POST /login?user=<name>`: mint a token (`crypto.randomUUID()`), write `session:<token>` → `{ "user": <name> }` to `SESSIONS` with a **one-hour TTL**, insert a row `(user, event = 'login', at)` into the `audit` table, and answer `{ "token": … }`.
- `GET /whoami`: read the `x-session` header, look the token up in `SESSIONS`; answer `{ "user": … }`, or `401` when there is no such session.
- `GET /audit`: the `audit` rows, oldest first, as `[{ user, event, at }, …]`.

The `/admin/sql` route is already written (the checker uses it to apply `migrations/0002_audit.sql`, the way Part 3 did), and so is the error wrapper. `sessionWorker` has no `queue()` handler, so the checker first drops the consumer declaration from Part 5; shipping without doing that would take the node down, as Part 5 showed. There is no in-kernel fake for KV or D1, so the checker runs on celld only; it prints ✗ until the TODOs are filled in.

**Hints**, from a nudge to a near-solution. Try the exercise first, then read only as far as you need.

1. **Concept.** Two stores, two jobs. A session is per-token, short-lived state: KV with a TTL. The audit trail is one shared table: D1. `/login` writes both; `/whoami` reads only KV.
2. **API.** `env.SESSIONS.put(key, JSON.stringify({ user }), { expirationTtl: 3600 })` writes a session, and `env.SESSIONS.get(key, "json")` returns the object or `null`. `env.DB.prepare(sql).bind(…).run()` inserts a row; `.all()` returns `{ results }`.
3. **Sketch.** `/login`: mint the token, write the session, insert `(user, 'login', Date.now())` into `audit`, answer `{ token }`. `/whoami`: a found session answers `{ user }`, a missing one answers 401. `/audit`: answer the `results` of the `ORDER BY id` query as they come back.

Full worked solutions are intentionally not included. The checker cell is the verification: every line turns from ✗ to ✓ once the implementation is right.
''')

code(r'''
const auditSql = "CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, user TEXT NOT NULL, event TEXT NOT NULL, at INTEGER NOT NULL);\n";

const sessionWorker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      switch (`${request.method} ${url.pathname}`) {
        case "POST /admin/sql":
          return Response.json(await env.DB.exec(await request.text()));
        case "POST /login": {
          const user = url.searchParams.get("user") ?? "";
          // TODO: token = crypto.randomUUID(); SESSIONS.put(`session:${token}`, …, { expirationTtl: 3600 });
          //       DB.prepare("INSERT INTO audit …").bind(user, "login", Date.now()).run(); answer { token }
          return new Response("not implemented", { status: 501 });
        }
        case "GET /whoami": {
          const token = request.headers.get("x-session") ?? "";
          // TODO: SESSIONS.get(`session:${token}`, "json") → { user } or 401
          return new Response("not implemented", { status: 501 });
        }
        case "GET /audit":
          // TODO: DB.prepare("SELECT user, event, at FROM audit ORDER BY id").all() → results
          return new Response("not implemented", { status: 501 });
      }
      return new Response("not found", { status: 404 });
    } catch (e) {
      return Response.json({ error: String(e) }, { status: 500 });
    }
  },
};
''')

code(r'''
// ── checker (celld only: these bindings have no kernel-side fake) ──────────
wrangler.queues = { producers: [{ binding: "OUTBOX", queue: "outbox" }] };   // no queue() handler here → no consumer (Part 5)
await app.ship({ classes: [Profile], worker: sessionWorker, wrangler, files: { "migrations/0002_audit.sql": auditSql } });
await app.json("/admin/sql", { method: "POST", body: await Deno.readTextFile(`${app.dir}/migrations/0002_audit.sql`) });

const check = (label: string, ok: boolean, detail: unknown) => console.log(ok ? "✓" : "✗", label, ok ? "" : `— got ${JSON.stringify(detail)}`);

const login = await app.fetch("/login?user=ada", { method: "POST" });
const { token } = (await login.json().catch(() => ({}))) as { token?: string };
check("POST /login answers 200 with a token", login.status === 200 && typeof token === "string" && token.length > 0, login.status);

const who = await app.fetch("/whoami", { headers: { "x-session": token ?? "" } });
const whoBody = await who.json().catch(() => null) as { user?: string } | null;
check("GET /whoami resolves the token to ada", who.status === 200 && whoBody?.user === "ada", [who.status, whoBody]);

const bad = await app.fetch("/whoami", { headers: { "x-session": "not-a-token" } });
check("GET /whoami with an unknown token is 401", bad.status === 401, bad.status);

const audit = await app.fetch("/audit");
const rows = (await audit.json().catch(() => [])) as { user: string; event: string; at: number }[];
check("GET /audit has ada's login row", audit.status === 200 && rows.some((r) => r.user === "ada" && r.event === "login" && typeof r.at === "number"), [audit.status, rows]);
''')

md(r'''
## Clean up

Stop the node. State stays in the project directory's `.celld/dev`; the next `app.start()` without `clean: true` resumes it, with the sessions, the ledger, the objects, and the queue's four-day backlog included.
''')

code(r'''
await stopAll();
''')

md(r'''
## Where next

That is Steps 05 and 07 of the guide and the matching subsections of Part 1 § 06: four services with Cloudflare's APIs, each a cell (or the bucket) underneath, one writer each, declared in a configuration celld validates loudly. Two places where `celld dev` behaves differently from a fleet, both observed above, both documented in the articles, and worth re-checking on the release you deploy, and one documented shape confirmed above:

- **D1 migrations do not apply on `celld dev`'s deploy.** Apply the file yourself locally; use `celld d1 migrations apply` on a fleet.
- **R2 `version` on the local store is a write counter, not a content hash.** `checksums.md5` is the content hash everywhere.
- **A `queue()` handler beside `fetch()` is the documented shape**, and a declared consumer without a handler takes the node down.

- **Notebook 1—The cell model** is the foundation: cells, addressing, one thread per cell, SQL storage, alarms, the dev loop.
- **Notebook 3—Processes and lifecycle** covers Workflows (Step 06), WebSockets and hibernation, cron triggers, RPC, and reading celld's lifecycle events.

Left to the articles: the fleet bucket that makes R2 "earn its name", queue overload (`503`, `Retry-After: 1`, `X-Celld-Overload: cell`), the `celld kv` / `celld queue` / `celld d1` operator commands. All of these need a fleet, and `celld dev`'s local store is not one.

**Maintenance.** This export is frozen at celld v0.6.0, executed 2026·09·26. Re-execute it on each new celld release and note what changed: upstream moves fast, with five releases (v0.4.0 through v0.6.0) between 2026·08·28 and 2026·09·26.
''')

nb = {"cells": cells, "metadata": {"kernelspec": {"name": "deno", "display_name": "Deno", "language": "typescript"},
      "language_info": {"name": "typescript"}}, "nbformat": 4, "nbformat_minor": 5}
json.dump(nb, open("celld-02-bindings.ipynb", "w"), indent=1)
print(len(cells), "cells")
