---
title: "Building on celld"
dek: "A working, step-by-step guide: scaffold a Wrangler project, develop against `celld dev`, grow the application through Durable Objects, KV, Queues, Workflows, D1, and R2, and take the result to a fleet running on a bucket you own. Written against celld v0.6.0 (released 2026·09·26), the per-service pages at celld.dev/docs/services, and the examples in `denoland/celld`."
kind: "Engineering How-To"
meta:
  Status: "How-to · v0.6.0"
  Source: "celld.dev docs + denoland/celld"
  Updated: "2026·09·27 · first written 2026·08·31 for v0.4.0"
series: "celld"
series_parts:
  - title: "Part 0—Actors, Durable Objects, and durable execution"
    href: "celld-00-background"
  - title: "Part 1—Durable Objects on Your Own Storage"
    href: "celld-durable-objects"
  - title: "Part 2—Building on celld, step by step"
  - title: "Notebook 1—The cell model"
    href: "celld-01-cells"
  - title: "Notebook 2—Bindings: KV, Queues, D1, R2"
    href: "celld-02-bindings"
  - title: "Notebook 3—Processes and lifecycle"
    href: "celld-03-processes"
  - title: "Review—Quick reference and self-quiz"
    href: "celld-review"
section_label: "Step"
---

## Before you start {#before-you-start}

celld runs Cloudflare's Workers and Durable Objects programming model on machines you control, with an S3-compatible bucket as the only coordinator. The unit you build with is the **cell**: in Cloudflare terms, a Durable Object. A cell is a small named server with its own private SQLite database and one thread. It serves HTTP, holds WebSockets, sets alarms, and calls out. You make one cell per user, per document, per chat room, per agent. Cells share no database, so the application is sharded from the start. Because the JavaScript API is the Workers API, the same code runs on Cloudflare or on your fleet.

This guide takes you from an empty directory to a running fleet. The [companion overview](celld-durable-objects) (Part 1) explains the architecture, the guarantees, and the tradeoffs in depth; this guide points there when it needs that depth. A few terms recur throughout. A **node** is one celld process. A **fleet** is the set of nodes sharing one **fleet bucket**. Each cell has exactly one **owner** node at a time, recorded in an **ownership record** in the bucket that names the owner and carries a fencing **epoch**. Each node keeps a **node lease** in the bucket, renewed while the node lives. Locally, `celld dev` replaces the bucket with a **local store**.

You need three things on the development machine:

- **A supported platform.** Prebuilt binaries cover Linux x86-64, Linux ARM64, and Apple Silicon. Windows is not supported.
- **esbuild on `PATH`.** celld bundles Worker code with it. Install it with `npm i -g esbuild` or `brew install esbuild`, or point `CELLD_ESBUILD` at the binary. An asset-only project does not need it.
- **No cloud account yet.** `celld dev` runs the whole system against the local store. You need a real bucket only when you stand up a fleet in Step 08.

Install the binary, and pin the release you tested:

```bash
# install (the installer downloads a signed binary to ~/.local/bin)
curl -fsSL https://celld.dev/install.sh | sh

# pin an exact release — rerunning with an older tag is the rollback
# (for the binary only; a v0.5.x or v0.6.x fleet's bucket cannot be served by a pre-v0.5.0 node — see Step 10)
CELLD_VERSION=v0.6.0 sh -c "$(curl -fsSL https://celld.dev/install.sh)"

# optionally verify the GitHub Actions build attestation
gh attestation verify ~/.local/bin/celld --repo denoland/celld
```

> [!CAUTION] Caveat · beta software
>
> celld v0.6.0 is a beta, and its docs say so plainly: single-tenant, trusted operator, security fixes land on the latest release only, and some version transitions are full-stop upgrades (Step 10). The engineering discipline behind it is unusually rigorous (TLA+, deterministic simulation, differential conformance against workerd), but treat it as a well-proven beta: pin releases and read the compatibility page again before every bump. <!-- series-only -->Part 1 § 05 records the history of each release.<!-- /series-only --><!-- book-only -->[Appendix C](release-notes.html) records the history of each release.<!-- /book-only --> Part 1 § 11 is a glossary of the terms the series uses, and Part 0 explains the Durable Objects model and the ideas behind it.

## Scaffold the project {#scaffold}

A celld application *is* a Wrangler project. There is no celld-specific project format. `celld dev` and `celld deploy` read `wrangler.jsonc` (or `wrangler.json`; **not** `wrangler.toml`) and accept the same layout Cloudflare's tooling does. Start with three files:

```
my-app/
├── wrangler.jsonc
├── src/
│   └── index.ts
├── .dev.vars           # local-only secrets for celld dev — gitignore it
└── .gitignore          # add .celld/ and .dev.vars here
```

The minimal configuration declares the Worker entry point and one Durable Object class:

```json
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "my-app",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-18",
  "durable_objects": {
    "bindings": [{ "name": "COUNTER", "class_name": "Counter" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Counter"] }]
}
```

Two details matter here. The `migrations` entry with `new_sqlite_classes` is what gives the class SQLite-backed storage. On celld every cell is SQLite-backed, and this is the declaration that matches Cloudflare's. The binding name `COUNTER` is how the Worker reaches the class through `env`.

> [!TIP] Fail-loudly · configuration
>
> celld stops a deploy with a named error on any top-level key it does not model (`routes`, for example). The accepted keys are `$schema`, `name`, `main`, `no_bundle`, `compatibility_date`, `compatibility_flags`, `durable_objects`, `migrations`, `assets`, `services`, `triggers`, `vars`, `d1_databases`, `kv_namespaces`, `queues`, `workflows`, `r2_buckets`, `worker_loaders`, `containers`, `define`, and `rules`. `define` and `rules` are passed to the esbuild run, so they cannot combine with `no_bundle`, and a rule's `type` must be `Text`, `Data`, or `CompiledWasm`. The `name` must be 1–63 lowercase ASCII letters, digits, or internal hyphens. If the deploy succeeds, everything you declared is modeled; a silent gap is, by celld's own scope rule, a bug. One rule applies to the code rather than the config: as in workerd, every export of the main module must be a handler object or a class, so an `export const VERSION = "1.2"` beside your Worker makes it fail to start.

The entry point, in the shape of celld's own `counter` example. The default export is the Worker; the exported class is the cell:

```ts
import { DurableObject } from "cloudflare:workers";

export interface Env {
  COUNTER: DurableObjectNamespace;
}

export class Counter extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const n = ((await this.ctx.storage.get<number>("n")) ?? 0) + 1;
    await this.ctx.storage.put("n", n);
    return Response.json({ n });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const name = new URL(request.url).searchParams.get("name") ?? "default";
    const id = env.COUNTER.idFromName(name);
    return env.COUNTER.get(id).fetch(request);
  },
};
```

`idFromName` is the whole addressing model: the same name maps to the same cell from any node in the fleet, forever. The Worker is the stateless router; the cell is where state lives. TypeScript types come from `@cloudflare/workers-types` (`npm i -D @cloudflare/workers-types`). esbuild strips them at bundle time, so the deploy does not type-check; run `tsc --noEmit` yourself if you want the check.

## Run it locally with celld dev {#local-dev}

From the project directory:

```bash
celld dev                  # Worker listener on http://127.0.0.1:9876
celld dev --port 3000      # pick the port
celld dev --host 0.0.0.0   # expose the Worker listener; internal stays loopback
celld dev --logs           # show the node's info/warning logs too
celld dev --clean          # wipe .celld/dev first — a fresh local store
celld dev --watch-ignore "docs/**"   # extra watcher ignores (repeatable)
celld dev --no-watch       # no automatic builds or restarts (not with --watch-ignore)
```

`celld dev` opens the local store (a SQLite-backed object store), deploys the application, and starts one node. No Docker, no cloud bucket, no configuration. It also reads a `.dev.vars` file beside the Wrangler config, exactly as `wrangler dev` does: one `NAME=value` per line (quotes stripped, no other dotenv features). Those values override same-named `vars`, reload on change, and are never carried to a fleet by `celld deploy`. Then exercise it:

```bash
$ curl "http://127.0.0.1:9876/?name=alpha"
{"n":1}
$ curl "http://127.0.0.1:9876/?name=alpha"
{"n":2}
$ curl "http://127.0.0.1:9876/?name=beta"
{"n":1}
```

Two names, two cells, two independent SQLite databases. That is the model working.

<figure class="topology">
<svg aria-labelledby="fdev-t fdev-d" role="img" viewbox="0 0 880 208" xmlns="http://www.w3.org/2000/svg">
<title id="fdev-t">The celld dev loop</title>
<desc id="fdev-d">Editing a source file triggers the watcher, which builds a new deployment beside the running one and adopts it in place. Durable state persists in the .celld/dev local store across rebuilds and normal shutdowns. A failed build leaves the current application serving.</desc>
<defs>
<marker id="fdeva" markerheight="7" markerwidth="7" orient="auto-start-reverse" refx="9" refy="5" viewbox="0 0 10 10">
<path d="M 0 0 L 10 5 L 0 10 z" style="fill:var(--ink-3, #7b8791)"></path>
</marker>
<marker id="fdevc" markerheight="7" markerwidth="7" orient="auto-start-reverse" refx="9" refy="5" viewbox="0 0 10 10">
<path d="M 0 0 L 10 5 L 0 10 z" style="fill:var(--cobalt, #2a56a0)"></path>
</marker>
</defs>
<rect height="60" rx="4" stroke-width="1.2" width="180" x="24" y="40" style="fill:var(--plate, #e6ebeb);stroke:var(--ink-2, #4a5763)"></rect>
<text class="m" font-size="10" font-weight="600" text-anchor="middle" x="114" y="66" style="fill:var(--ink, #1b252e)">edit src/ or config</text>
<text class="m" font-size="8.5" text-anchor="middle" x="114" y="84" style="fill:var(--ink-2, #4a5763)">watcher sees the change</text>
<rect height="60" rx="4" stroke-width="1.2" width="180" x="254" y="40" style="fill:var(--plate, #e6ebeb);stroke:var(--ink-2, #4a5763)"></rect>
<text class="m" font-size="10" font-weight="600" text-anchor="middle" x="344" y="66" style="fill:var(--ink, #1b252e)">build new deployment</text>
<text class="m" font-size="8.5" text-anchor="middle" x="344" y="84" style="fill:var(--ink-2, #4a5763)">beside the running one</text>
<rect height="60" rx="4" stroke-width="1.4" width="180" x="484" y="40" style="fill:var(--plate, #e6ebeb);stroke:var(--cobalt, #2a56a0)"></rect>
<text class="m" font-size="10" font-weight="600" text-anchor="middle" x="574" y="66" style="fill:var(--cobalt, #2a56a0)">adopt in place</text>
<text class="m" font-size="8.5" text-anchor="middle" x="574" y="84" style="fill:var(--ink-2, #4a5763)">new requests switch over</text>
<rect height="60" rx="4" stroke-dasharray="5 3" stroke-width="1.1" width="152" x="704" y="40" style="fill:var(--paper-2, #ebeee9);stroke:var(--ink-3, #7b8791)"></rect>
<text class="m" font-size="9.5" text-anchor="middle" x="780" y="66" style="fill:var(--ink-2, #4a5763)">failed build?</text>
<text class="m" font-size="8.5" text-anchor="middle" x="780" y="84" style="fill:var(--ink-2, #4a5763)">current app keeps serving</text>
<path d="M 208 70 L 250 70" fill="none" marker-end="url(#fdeva)" stroke-width="1.4" style="stroke:var(--ink-3, #7b8791)"></path>
<path d="M 438 70 L 480 70" fill="none" marker-end="url(#fdeva)" stroke-width="1.4" style="stroke:var(--ink-3, #7b8791)"></path>
<rect height="44" rx="4" stroke-width="1.3" width="410" x="254" y="140" style="fill:var(--paper-2, #ebeee9);stroke:var(--cobalt, #2a56a0)"></rect>
<text class="m" font-size="9.5" text-anchor="middle" x="459" y="158" style="fill:var(--ink, #1b252e)">.celld/dev—the local object store</text>
<text class="f" font-size="11.5" text-anchor="middle" x="459" y="173" style="fill:var(--ink-2, #4a5763)">durable state survives every rebuild and a normal shutdown</text>
<path d="M 574 104 L 574 136" fill="none" marker-end="url(#fdevc)" stroke-dasharray="4 3" stroke-width="1.3" style="stroke:var(--cobalt, #2a56a0)"></path>
</svg>
<figcaption>The dev loop is the production deployment mechanism in miniature: a new deployment is built beside the old and adopted in place, and cell state is untouched. What you rehearse locally is what Step 09 does to a fleet.</figcaption>
</figure>

[Notebook 1 Part 5](celld-01-cells) runs this loop live: new code adopted over old state, then a syntax error that fails the rebuild while the last good deployment keeps serving.

The rules of the loop:

- **State lives in `.celld/dev`** under the project. It survives a normal shutdown; `celld dev --clean` resets it. A configuration change is *not* migrated into stored state, so a renamed class or binding against an old store can fail confusingly. Clean and start again. Add `.celld/` and `.dev.vars` to `.gitignore`.
- **The watcher ignores** `.celld`, `.wrangler`, `.git`, `node_modules`, and `target`, plus any `--watch-ignore` globs. It does not follow sources outside the project directory, and it treats a read as no change, so a tool that only reads the project never triggers a build. `--no-watch` disables automatic builds entirely.
- **The local store is dev-only.** Fleet nodes and operator subcommands require a qualified cloud bucket; the local store is not selectable for them.
- **The internal (operator) listener stays on loopback** even with `--host 0.0.0.0`, so another machine can reach your app but not the operator API.

## Give the cell real state {#stateful-cell}

The counter used the key-value face of cell storage. Every cell also carries a full SQLite database, synchronous from the cell's point of view: a storage operation never interleaves with another request, so there is no transaction ceremony for ordinary work. A chat room shows all three capabilities at once: SQL state, hibernatable WebSockets, and a durable alarm.

```ts
import { DurableObject } from "cloudflare:workers";

export class ChatRoom extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server); // hibernatable — the room can sleep
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS log (at INTEGER, body TEXT)",
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO log (at, body) VALUES (?, ?)",
      Date.now(),
      String(message),
    );
    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== ws) peer.send(message); // one room, no message bus
    }
  }

  async alarm() {
    // prune history older than a day, then reschedule
    this.ctx.storage.sql.exec(
      "DELETE FROM log WHERE at < ?",
      Date.now() - 86_400_000,
    );
    await this.ctx.storage.setAlarm(Date.now() + 3_600_000);
  }
}
```

A cell is in one of three states. It is **resident** while it is in memory on its owner, **hibernated** when celld has evicted it from memory while its hibernatable WebSocket clients stay connected and it stays on its node, and **inactive** when no node holds it and it is only an object in the bucket. The rules that make this shape work in production follow from those states:

- **Keep the constructor trivial.** A cell keeps no memory across state transitions. The constructor runs again on every wake, including every message to a hibernated room. Restore from storage inside the handler, never in the constructor.
- **Hibernation is the economics.** `acceptWebSocket()` (rather than the addEventListener API) lets celld evict an idle room from memory while every client stays connected. A thousand quiet rooms cost almost nothing; a message wakes the one room it addresses.
- **Alarms are durable and covered by the acknowledgement gate.** [Notebook 1 Part 4](celld-01-cells) shows an alarm set by a request firing on schedule and clearing its pending time. When a handler sets an alarm, celld does not send the successful response until a durable wake entry covers it, so a node loss after the response cannot lose the alarm. A failed `alarm()` is retried with backoff.
- **Batch WebSocket messages.** Every frame costs a context switch through the cell's one thread. Pack small logical messages into one frame with an envelope format. The reverse case works too: the **output gate** (the mechanism that holds a cell's outbound effects until the writes they depend on are durable) holds each outbound frame only for its own proof, so a `webSocketMessage()` handler that sends a frame and then awaits delivers it while still running. You can stream an answer through one handler.
- **Outbound WebSockets do not survive a move.** An outbound socket keeps the cell resident and dies when the cell changes nodes. Keep connection *intent* in storage and re-dial after activation.
- **Finish write cursors before you answer.** Outside an explicit transaction, a SQL write cursor (an unconsumed `RETURNING`, say) must complete before a response, an outbound effect, or `storage.sync()`; celld rejects the output with an error otherwise. A transaction or `blockConcurrencyWhile()` has a 30-second limit, and a timeout resets the object. Pending I/O after a handler returns stays alive without `ctx.waitUntil()`.

> [!WARNING] Warn · heap and text limits
>
> Each isolate defaults to a 128 MB V8 heap (`CELLD_V8_HEAP_LIMIT_MB`), and `acceptWebSocket()` throws once the heap passes 90%. A room that accepts more sockets than it can carry would serve none of them. Separately, store arbitrary bytes in a `BLOB`, not a `TEXT` column: invalid UTF-8 in `TEXT` decodes with the replacement character U+FFFD, as in workerd. It does not fail loudly; it silently reads back different bytes.

## Add KV and Queues {#kv-queues}

Cells cover per-entity state. The first two cross-cutting services, both implemented as cells underneath, are Workers KV for shared key-value data and Queues for decoupled work. Both are graded *Yes* on the compatibility page. Each has its own page under [celld.dev/docs/services](https://celld.dev/docs/services/queues/) with a narrative, a worked example, and a short "differences from Cloudflare" list. The differences below are the complete list.

### KV: a durable store, not a CDN

```json
"kv_namespaces": [
  { "binding": "SESSIONS", "id": "sessions-prod" }
]
```

```ts
// in the Worker or any cell
await env.SESSIONS.put(`session:${token}`, JSON.stringify(claims), {
  expirationTtl: 3600,
});
const raw = await env.SESSIONS.get(`session:${token}`);
```

The API is Cloudflare's, with celld's storage model behind it. What changes in practice:

- **No edge cache.** `cacheTtl` has no effect and `cacheStatus` is `null`. Reads route to the namespace's cell. Treat KV as a durable store with KV's API, not as a CDN. [Notebook 2 Part 2](celld-02-bindings) shows `cacheStatus: null` on every read and names the namespace's own cell from the node log.
- **One writer per namespace.** Write capacity scales by adding namespaces, not by writing harder to one. The `id` accepts Cloudflare's hex form or any stable string; `sessions-prod` is fine.
- **Values above 1 MiB** go to the fleet bucket (small values live in the cell). They are stored under the namespace's ownership epoch, so a superseded owner can never delete the current value. Cloudflare's limits apply: keys up to 512 bytes, values up to 25 MiB, metadata up to 1,024 bytes, a minimum TTL of 60 seconds, and 1,000 keys per `list()`. `put()` accepts a `ReadableStream` value and checks the size limit while it reads.
- **Operate from the CLI:** `celld kv get/put/delete/list` plus `bulk` variants that use the Wrangler file format, so `wrangler kv bulk get` output feeds `celld kv bulk put` directly. `celld kv list` pages at 1,000 keys and prints the `--after` cursor on stderr; data goes to stdout, so pipes carry only data. `celld kv bulk get` streams rows instead of holding the namespace in memory. A named output file is swapped in atomically when the export completes, but a failed stdout export leaves a truncated JSON array behind.

### Queues: one writer, one consumer, four days

```json
"queues": {
  "producers": [{ "binding": "OUTBOX", "queue": "outbox" }],
  "consumers": [
    { "queue": "outbox", "max_batch_size": 10, "max_batch_timeout": 5,
      "max_retries": 2, "dead_letter_queue": "outbox-dead-letter" },
    { "queue": "outbox-dead-letter" }
  ]
}
```

```ts
// one script can be both the HTTP ingress and the consumer (the examples/queues shape)
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    await env.OUTBOX.send({ kind: "email", to: "a@example.com", template: "welcome" });
    return new Response("queued", { status: 202 });
  },

  async queue(batch: MessageBatch, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        await deliver(msg.body);
        msg.ack();
      } catch {
        msg.retry({ delaySeconds: 1 }); // after max_retries it moves to the dead-letter queue
      }
    }
  },
};
```

The consumer settings are Cloudflare's. `max_batch_size` defaults to 10 (max 100), `max_batch_timeout` to 5 seconds (max 60), `max_retries` to 3, and `max_concurrency` caps at 250. A batch closes when it fills or when the timeout expires after its oldest ready message. A message is at most 128,000 bytes, a `sendBatch()` at most 100 messages and 256,000 bytes, and `delaySeconds` runs to 86,400. A handler that returns without settling acknowledges everything; one that throws returns the batch to the queue. A retried message becomes visible again after the `delaySeconds` passed to `retry()` or `retryAll()`, or the consumer's `retry_delay` by default. celld adds no exponential backoff; if you want one, compute the delay from `msg.attempts`. When `attempts` passes `max_retries` the message moves to the `dead_letter_queue`, which is an ordinary queue with its own consumer. Without a dead-letter queue, celld deletes the message. On the producer side, `contentType` (`"v8"`, `"json"`, `"text"`, or `"bytes"`) sets a message's encoding, with the `queues_json_messages` compatibility flag choosing the default, and a producer entry's `delivery_delay` sets a default delay for every message of that binding.

celld's Queues carry real constraints, all of the fail-loudly kind:

- **One writer per queue.** Scale with more queues. Within one queue, producer calls share transactions and durability rounds: a broker admits up to 256 concurrent producer calls, commits at most 64 per transaction, and overlaps four proofs. One queue sustained 7,357 sends per second in a 300,000-send soak. Past the admission limit the owner refuses the call with an error the producer can retry. A caught producer error contains `cell overload: admission refused`, so a Worker can pass the same 503 back to its client.
- **One consumer script per queue.** A deployment in which two scripts consume one queue fails. The consumer script may also export `fetch()`: the official `examples/queues` project exports `fetch` and `queue` from one script, as above. [Notebook 2 Part 5](celld-02-bindings) shows a consumer without a `queue()` handler taking the local node down.
- **Retention is four days, not configurable.** Pull consumers, the Queues HTTP API, dashboard controls, R2 event notifications, and Queue event subscriptions are not available.
- **Overload is explicit.** A saturated cell or queue answers 503 with `Retry-After: 1` and `X-Celld-Overload: cell`. Count those as rejected work rather than retrying immediately at a fixed rate.
- **Operate with** `celld queue info/peek/purge/pause/resume/redrive`.

> [!TIP] Note · the consumer is documented end to end
>
> The queues service page walks a producer, a consumer with retries, and a dead-letter queue, and `examples/queues` in `denoland/celld` is the runnable version. The fail-loudly rule applies here as everywhere: a consumer shape celld does not model stops the deploy with a named error.

## Orchestrate with Workflows {#workflows}

Cells model *entities*: named things whose state persists indefinitely. Workflows are the *process* primitive built on top of them: a sequence of steps that ends, with each step's result stored durably so the sequence survives crashes and restarts. Declare the class in the configuration:

```json
"workflows": [
  { "binding": "REPORTS", "name": "report-builder", "class_name": "ReportBuilder" }
]
```

A workflow extends `WorkflowEntrypoint` and does its work in `run()`. This is celld's own example, extended one step:

```ts
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

export class ReportBuilder extends WorkflowEntrypoint {
  async run(event: WorkflowEvent<{ url: string }>, step: WorkflowStep) {
    const fetched = await step.do("fetch source", async () => {
      const response = await fetch(event.payload.url);
      if (!response.ok) throw new Error(`source answered ${response.status}`);
      const text = await response.text();
      return { bytes: text.length, lines: text.split("\n").length };
    });

    await step.sleep("cool off", "30 seconds");

    return await step.do("store summary", async () => {
      // step.do callbacks are the only safe home for side effects
      return { ...fetched, storedAt: Date.now() };
    });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/create") {
      const instance = await env.REPORTS.create({
        params: { url: url.searchParams.get("url") ?? "https://example.com" },
      });
      return Response.json({ id: instance.id });
    }
    const id = url.searchParams.get("id");
    if (url.pathname === "/status" && id) {
      const instance = await env.REPORTS.get(id);
      return Response.json(await instance.status());
    }
    return new Response("Use /create?url=URL or /status?id=ID.", { status: 404 });
  },
};
```

The one rule that decides whether your workflow is correct is the replay rule. A running workflow is stored as its steps. After a crash, `run()` is replayed *from the start*: completed steps return their stored results instantly, and everything *outside* a step runs again. This is also how Cloudflare Workflows behave, which is why the compatibility page does not list it as a difference. The discipline is the same on either platform. [Notebook 3 Part 3](celld-03-processes) counts the re-execution: across one durable sleep, the top of `run()` ran twice while each step ran once.

<figure class="topology">
<svg aria-labelledby="fwf-t fwf-d" role="img" viewbox="0 0 880 260" xmlns="http://www.w3.org/2000/svg">
<title id="fwf-t">Workflow replay after a crash</title>
<desc id="fwf-d">First execution: step one and step two complete and store their results; a crash lands during step three. On replay, run() starts from the top—steps one and two return their stored results without re-running their callbacks, code between steps runs again, and step three's callback runs again. Side effects outside steps, and non-idempotent steps, are therefore bugs.</desc>
<defs>
<marker id="fwfa" markerheight="7" markerwidth="7" orient="auto-start-reverse" refx="9" refy="5" viewbox="0 0 10 10">
<path d="M 0 0 L 10 5 L 0 10 z" style="fill:var(--ink-3, #7b8791)"></path>
</marker>
</defs>
<text class="m" font-size="10" font-weight="600" x="20" y="52" style="fill:var(--ink, #1b252e)">1st run</text>
<rect height="30" rx="3" stroke-width="1.2" width="170" x="120" y="34" style="fill:var(--plate, #e6ebeb);stroke:var(--ink-2, #4a5763)"></rect>
<text class="m" font-size="9" text-anchor="middle" x="205" y="53" style="fill:var(--ink, #1b252e)">step.do "fetch" ✓ stored</text>
<rect height="30" rx="3" stroke-width="1.2" width="170" x="310" y="34" style="fill:var(--plate, #e6ebeb);stroke:var(--ink-2, #4a5763)"></rect>
<text class="m" font-size="9" text-anchor="middle" x="395" y="53" style="fill:var(--ink, #1b252e)">step.sleep ✓ stored</text>
<rect height="30" rx="3" stroke-width="1.4" width="170" x="500" y="34" style="fill:var(--paper-2, #ebeee9);stroke:var(--cobalt, #2a56a0)"></rect>
<text class="m" font-size="9" text-anchor="middle" x="585" y="53" style="fill:var(--cobalt, #2a56a0)">step.do "store" … crash</text>
<path d="M 680 49 L 700 49" fill="none" stroke-width="1.6" style="stroke:var(--cobalt, #2a56a0)"></path>
<text class="m" font-size="10" font-weight="600" x="710" y="53" style="fill:var(--cobalt, #2a56a0)">✕ node lost</text>
<text class="m" font-size="10" font-weight="600" x="20" y="130" style="fill:var(--ink, #1b252e)">replay</text>
<rect height="30" rx="3" stroke-dasharray="5 3" stroke-width="1.1" width="170" x="120" y="112" style="fill:var(--paper-2, #ebeee9);stroke:var(--ink-3, #7b8791)"></rect>
<text class="m" font-size="9" text-anchor="middle" x="205" y="131" style="fill:var(--ink-2, #4a5763)">stored result returned</text>
<rect height="30" rx="3" stroke-dasharray="5 3" stroke-width="1.1" width="170" x="310" y="112" style="fill:var(--paper-2, #ebeee9);stroke:var(--ink-3, #7b8791)"></rect>
<text class="m" font-size="9" text-anchor="middle" x="395" y="131" style="fill:var(--ink-2, #4a5763)">stored result returned</text>
<rect height="30" rx="3" stroke-width="1.3" width="170" x="500" y="112" style="fill:var(--plate, #e6ebeb);stroke:var(--ink-2, #4a5763)"></rect>
<text class="m" font-size="9" text-anchor="middle" x="585" y="131" style="fill:var(--ink, #1b252e)">callback runs again</text>
<path d="M 290 127 L 306 127" fill="none" marker-end="url(#fwfa)" stroke-width="1.3" style="stroke:var(--ink-3, #7b8791)"></path>
<path d="M 480 127 L 496 127" fill="none" marker-end="url(#fwfa)" stroke-width="1.3" style="stroke:var(--ink-3, #7b8791)"></path>
<path d="M 290 49 L 306 49" fill="none" marker-end="url(#fwfa)" stroke-width="1.3" style="stroke:var(--ink-3, #7b8791)"></path>
<path d="M 480 49 L 496 49" fill="none" marker-end="url(#fwfa)" stroke-width="1.3" style="stroke:var(--ink-3, #7b8791)"></path>
<text class="m" font-size="8.5" text-anchor="middle" x="205" y="164" style="fill:var(--cobalt, #2a56a0)">code BETWEEN steps runs again too</text>
<rect height="52" rx="4" stroke-width="1.2" width="840" x="20" y="190" style="fill:var(--plate, #e6ebeb);stroke:var(--cobalt, #2a56a0)"></rect>
<text class="m" font-size="10" text-anchor="middle" x="440" y="211" style="fill:var(--ink, #1b252e)">Everything meaningful goes inside a step, and every step must be idempotent.</text>
<text class="f" font-size="12.5" text-anchor="middle" x="440" y="230" style="fill:var(--ink-2, #4a5763)">A crash after a step's side effect but before its result is stored runs that callback again.</text>
</svg>
<figcaption>Replay is what makes a workflow durable and what makes non-idempotent steps a bug. celld replays <code>run()</code> from the top; stored steps are skipped, everything else re-executes.</figcaption>
</figure>

The celld-specific contract, from the workflows service page:

- **Retention is yours to choose.** A successful or failed instance is kept for 30 days by default. Each duration in the `retention` option can be at most 30 days, and `delete()` removes a completed run.
- **Limits.** A step result, an event payload, and the workflow parameters are each capped at 1 MiB. Work *outside* a step cannot stay pending longer than 60 seconds. Pass references (an R2 key, a D1 row) between steps, not payloads.
- **Defaults worth knowing.** `step.do()` retries 5 times with a 10-second delay and exponential backoff, each attempt capped at 10 minutes, and `NonRetryableError` stops the loop. `waitForEvent()` times out after 24 hours. An instance within an hour of its next alarm stays resident (`CELLD_ALARM_RESIDENT_MS`). A `workflows` entry cannot carry `schedules`, `limits`, or a `script_name` naming another script. The Workflows REST API and `wrangler workflows` commands do not operate against celld; drive instances through the binding.
- **`locationHint` is accepted** with Cloudflare's values, but fleet ownership decides where the cell actually runs.
- **Lifecycle.** The page lists no difference for `pause()`, `resume()`, or `restart()`, which means celld intends to match Cloudflare's documented behavior for them. It also lists no caveat for `create()` called with a terminal instance's ID. If you rely on create-once semantics, verify against your installed release rather than assuming either way.
- **Not available:** rollback, sensitive step results, and `ReadableStream` step results.

## Add D1 and R2 {#d1-r2}

### D1: a database that is a cell

A D1 database on celld is one cell holding one SQLite database, which means it inherits everything cells have: fencing, replication, durable acknowledgement. Declare it, write migrations, apply them:

```json
"d1_databases": [
  { "binding": "DB", "database_name": "ledger" }
]
```

```bash
# migrations are NNNN_description.sql files (.SQL works too),
# applied in numeric order, one transaction per file — exactly Wrangler's rule;
# a custom migrations_dir must be a relative path inside the project
mkdir -p migrations
cat > migrations/0001_init.sql <<'SQL'
CREATE TABLE entries (
  id INTEGER PRIMARY KEY,
  account TEXT NOT NULL,
  amount INTEGER NOT NULL,
  at INTEGER NOT NULL
);
SQL

# against a fleet (the only documented path — celld d1 finds a node through
# the bucket, so it cannot target celld dev's local store, and a dev deploy
# does not apply migrations; run the SQL from the Worker locally, as celld's
# own examples/d1 does with CREATE TABLE IF NOT EXISTS):
celld d1 migrations apply ledger --bucket "$CELLD_BUCKET"
```

```ts
const { results } = await env.DB
  .prepare("SELECT account, SUM(amount) AS balance FROM entries WHERE account = ? GROUP BY account")
  .bind(account)
  .all();
```

- **One database, one writer.** More capacity comes from more databases, never a bigger one. Per-entity data belongs in the entity's cell; D1 is for the genuinely shared tables.
- **Result caps:** 100,000 rows or 32 MiB per binding result.
- **Importing from Cloudflare:** `wrangler d1 export`, then `celld d1 execute ledger --file export.sql`. A migration already recorded in the imported history does not run twice.
- **Not available:** `dump()`, Time Travel, the D1 REST API. `wrangler d1` commands do not operate against celld.
- **Migrations on `celld dev`.** [Notebook 2 Part 3](celld-02-bindings) confirms that a dev deploy with a migration file leaves no tables until the Worker runs the SQL itself.

### R2: your fleet bucket, wearing the R2 API

```json
"r2_buckets": [
  { "binding": "FILES", "bucket_name": "files" }
]
```

```ts
await env.FILES.put(`reports/${id}.json`, JSON.stringify(report));
const obj = await env.FILES.get(`reports/${id}.json`);
if (obj) { const report = await obj.json(); }
```

An R2 binding stores its objects in the fleet bucket under `r2/<bucket_name>/`, which is the fleet bucket earning its name. Use R2 for step results and artifacts that outgrow the 1 MiB Workflow caps. The differences from Cloudflare:

- **No public URL.** celld serves a bucket through the binding only: no public bucket URL, no presigned URL, no S3 endpoint. To publish a file, put a Worker in front of it.
- **Other tools' objects read fine.** An object written by another tool reads through the binding, with its user metadata as `customMetadata` and its headers as `httpMetadata`. Write with `celld r2 put` to get the complete record. `delete(keys)` takes up to 1,000 keys per call.
- **Not available:** `ssecKey` and `jurisdiction`.
- **Size limits.** A conditional write cannot stream a body larger than 8 MiB. Multipart uploads accept no checksum, cannot resume on another node or after a restart, and out-of-order parts buffer at most 256 MiB.
- **Versions.** An object's `version` is its content ETag, so identical content yields the same version on a store that reports no version of its own. `celld dev`'s local store numbers each write instead, so identical bytes get different versions there ([Notebook 2 Part 4](celld-02-bindings)). Never use a version to count writes, and check your store before relying on version equality to de-duplicate; `checksums.md5` is the content hash everywhere.
- **Keys.** Empty key segments count, as on Cloudflare: `a/b`, `/a/b`, `a//b`, and `a/b/` are four objects. A key with non-ASCII or special characters is stored percent-encoded, so `list()` orders it (and applies `startAfter`) by that encoded form. Page with the returned `cursor`, not `startAfter`, if the order matters.

The R2 CLI reads the fleet bucket directly and needs no running node. `celld r2 get|head|put|delete|list` replaces `wrangler r2 object`, takes the `bucket_name` (not the binding name), and preserves the binding's object metadata:

```bash
celld r2 put files reports/2026-09.json --path report.json \
  --content-type application/json --metadata '{"release":"1.2.3"}' \
  --bucket "$CELLD_BUCKET"
celld r2 list files --prefix reports/ --bucket "$CELLD_BUCKET"   # at most 1000 keys
celld r2 get  files reports/2026-09.json --bucket "$CELLD_BUCKET" > report.json
```

## Stand up a fleet {#fleet}

Everything so far ran on the local store. A fleet needs one thing the laptop cannot fake: a bucket that honors conditional writes with read-after-write consistency, because ownership of every cell rests on it. The bucket must also serve exact ranged reads, because a large cell is restored page by page. Qualified: Amazon S3, Cloudflare R2, Google Cloud Storage, Tigris, and Azure Blob Storage. Not qualified: Backblaze B2, Hetzner, DigitalOcean Spaces. MinIO passes the storage test but is not qualified for production. Using R2 as the example:

```bash
# an R2 bucket + an S3 API token scoped to it
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_REGION=auto
export S3_ENDPOINT=https://ACCOUNT_ID.r2.cloudflarestorage.com
export CELLD_BUCKET=s3://my-fleet        # a /prefix lets fleets share a bucket
```

Google Cloud Storage (`gs://`, Application Default Credentials) and Azure Blob (`az://`, where the bucket name is the container, with exactly one credential family) follow the same shape: set `CELLD_BUCKET` and the platform's own credentials.

Each node probes the store at startup: conditional writes that must succeed and fail in the right places, plus a ranged read that must return exactly the requested bytes. A clear contract violation stops the node at once rather than risk two owners for one cell. An ambiguous failure gets three attempts and then a warning. The probe cannot be switched off; `CELLD_STORAGE_PROBE` is rejected at startup.

> [!CAUTION] Caveat · the bucket is the root of authority
>
> The bucket holds the deployments, every cell's state, the ownership records, the node leases, the peer secret, large KV values, and all R2 objects. **Whoever holds the bucket credentials controls the fleet.** Scope credentials to the one bucket and rotate on any suspicion.

A fleet node binds two listeners: the public Worker listener for ingress, and an internal listener for the peer protocol and operator API. The internal plane carries plain HTTP with no content signature. The network is the security boundary, so put it on a private network or an encrypted overlay (WireGuard, Tailscale), and never expose it:

```bash
celld \
  --bucket "$CELLD_BUCKET" \
  --listen 0.0.0.0:8080 \
  --internal-listen 10.0.0.12:8081 \
  --advertise node-a.internal:8081
```

To grow the fleet, start another node against the same bucket with a distinct internal address. There is no join command and no membership list; nodes find each other through the node leases in the bucket. Run under a supervisor with no restart limit. A systemd unit carries all the operational rules at once:

```toml
[Unit]
Description=celld node
After=network-online.target

[Service]
EnvironmentFile=/etc/celld/env
ExecStart=/usr/local/bin/celld --listen 0.0.0.0:8080 \
  --internal-listen 10.0.0.12:8081 --advertise node-a.internal:8081
Restart=always
RestartSec=10          # at least one lease lifetime (CELLD_TTL_MS, 10 s)
TimeoutStopSec=120     # must exceed the stop bound (CELLD_SHUTDOWN_TOTAL_MS, 40 s)
                       # plus the drain-token wait derived from it (3/4 → 30 s)

[Install]
WantedBy=multi-user.target
```

Three of those lines are load-bearing:

- **`Restart=always` with no attempt limit.** A node that loses bucket contact fences itself and exits with code 3. That exit is the design working, and the restart is the recovery. The fence log line names its cause: an expired lease, a missing lease record, or a record another writer replaced.
- **`RestartSec=10`** waits at least one lease lifetime so the old lease expires first.
- **`TimeoutStopSec=120`** exceeds celld's own shutdown bounds, so the graceful handoff (batched, durable, one node at a time across the fleet) finishes before SIGKILL lands. celld derives the drain-token wait and the no-progress interval from `CELLD_SHUTDOWN_TOTAL_MS` alone (3/4 and 5/8 of it). The separate `CELLD_SHUTDOWN_DRAIN_MS` and `CELLD_DRAIN_TOKEN_WAIT_MS` variables are rejected at startup.

Kubernetes users: the same three rules map to a restart policy, a backoff, and `terminationGracePeriodSeconds`, with `/.well-known/celld/health` as the readiness probe. Set a rollout deadline too, because a fresh node whose readiness gate never clears stays unhealthy instead of reporting healthy at the gate's timeout.

Run at least two nodes if write latency matters. With one node every durable write waits for a bucket round trip. With two or more, the owner and its **followers** form an **ensemble**: celld answers on a follower's fsync and uploads afterwards, for the same guarantee at roughly 10× lower write latency.

**The fleet balances itself.** A node that joins takes hibernated cells from the nodes holding the most, and the fleet evens out again after a node leaves. One node samples every lease every five seconds (`CELLD_REBALANCE_INTERVAL_MS`; `0` disables) and writes a shared capacity sample. The most-loaded node per unit of weight (`CELLD_PLACEMENT_WEIGHT`, default the CPU count) hands at most 32 hibernated cells per sample to the peer furthest below its share. Only hibernated cells move, so a fleet without idle eviction balances only the cells that hibernate on their own; set `CELLD_IDLE_EVICT_S` if you want resident-but-idle cells to become eligible. A moved cell's parked WebSockets close with code 1012 so clients reconnect to the new owner. `POST /rebalance/pause` and `/resume` on any node's internal listener stop and restart every move fleet-wide.

## Deploy, operate, observe {#operate}

Deploying to the fleet is one command from the project directory:

```bash
celld deploy . --bucket "$CELLD_BUCKET"
```

It bundles (esbuild), signs with the fleet secret, records a full SHA-256 digest of every JavaScript and WebAssembly module in the manifest, and uploads. A node verifies each module against its digest before it builds the deployment. Nodes poll `deploy/current.json` every 30 seconds and adopt in place, with no restart, exactly as `celld dev` rehearsed: the new deployment is built beside the old, new requests switch in one step, in-flight requests finish where they started, and resident Durable Objects move at safe points (forced after 60 seconds with WebSocket code 1012, matching Cloudflare). `POST /reload` on the internal listener adopts immediately. One consequence deserves respect: during the adoption window a request on one deployment can call a Durable Object on the other, so **adjacent versions must accept each other's calls**.

The operator's toolbox, all reading the bucket, none taking ownership:

```bash
# fleet health: leases, reachability, advertised addresses, versions,
# each node's load sample (owned cells, resident cells, RSS, CPU …),
# and the conditional-write + ranged-read storage test
celld diagnose --bucket "$CELLD_BUCKET"

# list Durable Object instances (Class:ID); reserved __ cells are
# D1 databases, KV namespaces, and Workflows. A class argument scopes
# the storage prefix, so --limit then applies to that class alone
celld cell list --bucket "$CELLD_BUCKET"
celld cell list Counter --limit 50 --bucket "$CELLD_BUCKET"
celld cell list --all --json --bucket "$CELLD_BUCKET" |
  jq -r 'select(.reserved | not) | .scope'

# data services
celld d1 migrations apply ledger --bucket "$CELLD_BUCKET"
celld kv list sessions --all --json --bucket "$CELLD_BUCKET" > keys.ndjson
celld queue info outbox --bucket "$CELLD_BUCKET"
```

During a binary rolling update (where the release allows one; see Step 10), stop one node, wait for its replacement to report healthy *and* for every node to show `restoring=0` in `celld diagnose`, then move on. That lets one restart's cold work finish before the next removes more warm capacity. The first healthy response of a fresh node already waits for the fleet to settle (the readiness gate), so the orchestrator needs no separate fleet-level pause. It does need a rollout deadline, because a node that never settles stays unhealthy rather than passing at the gate's timeout.

For an autoscaler, read the node leases or `GET /state` on the internal listener. Both publish `owned_cells`, `resident_cells`, `host_websockets`, `rss_bytes`, `cpu_percent_x100`, `memory_headroom`, `restoring`, and `capacity_waiting`, plus per-script isolate counts (`live`, `live_empty`, `retiring`, `freed`, with V8 heap bytes) and allocator counters. A `live_empty` count that persists past 30 seconds signals a stuck maintenance pass. A positive `capacity_waiting` is the add-a-node signal; scale down only while every remaining node reports headroom and a small restore backlog. The health path stays a plain boolean. The `/evict/<cell>` operator route waits for the eviction and reports the outcome as JSON: `{"ok":true}`, or a `refused` / `cancelled` / `failed` kind with a reason such as `cell_active` or `alarm_imminent`.

Observability is one variable away, and the sink choice is folded into it. `CELLD_OTEL=1` writes spans as Parquet under `telemetry/` in the fleet bucket: every request, cell event, outbound fetch, and `console.log`, trace-joined and queryable with DuckDB directly, no collector required. `CELLD_OTEL=https://collector.internal:4318` sends the same data over OTLP/HTTP to that base URL instead. The separate `CELLD_OTEL_SINK` variable is rejected at startup.

```sql
CREATE VIEW traces AS SELECT * FROM
  read_parquet('s3://my-fleet/telemetry/traces/*/*/*/*/*/*.parquet');

SELECT name, duration_us, trace_id FROM traces
ORDER BY duration_us DESC LIMIT 20;
```

## Production rules {#production}

The rules that keep a celld application healthy, gathered in one place. Most have appeared above; the rest come from the guarantees and limitations pages.

- **One writer each:** per cell, per D1 database, per KV namespace, per queue. Scale by adding entities, never by growing one.
- **Make remote operations idempotent, with stable operation IDs.** celld never retries a proxied call after body transmission begins (it keeps no replay copy), and it retries only an attempt that provably never started. An ambiguous attempt is yours to retry: same operation ID, handler tolerant of the repeat. The same rule covers WebSocket reconnects, which never move a transport between owners.
- **Keep constructors trivial; batch WebSocket frames; restore state in handlers.**
- **Leave headroom.** Balancing moves only hibernated cells and counts cells by node weight, not by what each cell costs. A fleet at its resident limit still has nowhere to put a lost node's cells.
- **Respect the upgrade cliffs.** Some version transitions must be full stops; others may roll. The complete list:
  - v0.1→v0.2: full stop.
  - v0.2.1→v0.3: may roll. Never downgrade without `node-log close: sealed epoch` in the shutdown log.
  - v0.3→v0.4: full stop.
  - v0.4.0→v0.4.1: may roll, but never start a v0.4.0 binary once the fleet has paged a large cell in. That node can never activate it.
  - **v0.4.1→v0.5.0: full stop.** The procedure from the guarantees page: stop application traffic and deployment writers; stop every old node and its supervisor; wait for every lease to expire; back up the bucket and node data directories; make sure no old binary can restart against the bucket (the format marker cannot stop one from writing); then start v0.5.0 on every node with the same names, addresses, and data directories. Startup migrates the alarm wake format before serving.
  - v0.5.0→v0.5.1: rolls. Stop one node, wait for its replacement to report healthy, continue.
  - **v0.5.1→v0.6.0: full stop under the default `fleet` durability.** A v0.6.0 node needs its followers to answer log-tail requests in a ranged format that v0.5.1 nodes do not speak, so stop every v0.5.1 node before starting v0.6.0. A fleet on `CELLD_DURABILITY=bucket` has no followers and can roll.
  - **Do not roll back by starting an old binary.** The only rollback is restoring the stopped-fleet backup, which loses writes made after it.
  - <!-- series-only -->Part 1 § 05 records what each release changed.<!-- /series-only --><!-- book-only -->[Appendix C](release-notes.html) records what each release changed.<!-- /book-only -->
- **Drop the removed knobs before you upgrade.** celld refuses to start with any of `CELLD_OUTPUT_GATE` (the write gate is always on), `CELLD_STORAGE_PROBE`, `CELLD_SHUTDOWN_DRAIN_MS`, `CELLD_DRAIN_TOKEN_WAIT_MS`, `CELLD_WORKER_LOADER`, `CELLD_MAX_LOADED_WORKERS`, `CELLD_OTEL_SINK`, `CELLD_AI_BINDING`, `CELLD_AI_URL`, or `CELLD_REBALANCE_BATCH_CELLS` in the environment. Grep `/etc/celld/env` first.
- **The security boundary is yours.** TLS terminates in your ingress proxy. The internal listener stays on a private network or an encrypted overlay, and its operator API is mostly unauthenticated. celld does not authenticate your application's users; that is application code, plus `CELLD_MAX_REQUEST_BODY_BYTES` and `CELLD_MAX_CELL_REQUESTS` for limits.
- **One application per fleet, single-tenant.** Hostile multi-tenancy is explicitly out of scope for the beta.
- **Pin the release; keep operator tooling and binary together.** The operator API can change between releases. Re-read the compatibility page before every version bump.
- **Watch the health path.** It is `/.well-known/celld/health`. A fleet coming from v0.3 must update load balancers and probes to it.

> [!TLDR] The through-line of the whole guide: divide the application into named entities from the start, put every side effect inside something durable (a cell's storage, a queue message, a workflow step), and let the bucket, the epochs, and the fail-loudly deploys do what they were built to do.

<!-- series-only -->
------------------------------------------------------------------------

*Sources: the celld.dev documentation at the v0.6.0 tag (main guide, what celld guarantees, Cloudflare compatibility, the per-service pages under `docs/services/`, telemetry, WebAssembly; read 2026·09·26), the v0.4.1 through v0.6.0 release notes, the `denoland/celld` examples (`counter`, `workflow`, `queues`, `facets`, `container`, `sandbox`), and the [companion overview](celld-durable-objects), which covers the cell model, ownership and fencing, durability proofs, and the full compatibility surface, including the additions this guide does not walk through: Dynamic Workers, facets, and containers. celld is a beta; verify behavior against your installed release.*
<!-- /series-only -->
