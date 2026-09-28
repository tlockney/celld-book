import json, sys
cells = []
def md(s): cells.append({"cell_type": "markdown", "metadata": {}, "source": s.strip("\n")})
def code(s): cells.append({"cell_type": "code", "metadata": {}, "source": s.strip("\n"), "outputs": [], "execution_count": None})

md(r'''
# celld · Notebook 3—Processes and lifecycle

<!-- series-only -->**Companion to the Reading Room articles Part 1, _Durable Objects on Your Own Storage_ (the Field Guide), and Part 2, _Building on celld, step by step_ (the guide), written against celld v0.6.0.**<!-- /series-only --><!-- book-only -->**Written against celld v0.6.0.**<!-- /book-only --> Part 1 § 11 defines the terms it uses. This notebook covers Part 1 § 02 "Cell states", § 06 "Runtime API surface", "Workflows", and "Cron, alarms, and WebAssembly", and § 07 "Designing applications around cells", together with Steps 04 and 06 of the guide: JS RPC, hibernatable WebSockets and what a wake actually is, Workflows and the replay rule, cron triggers, and the entity/process distinction that decides which primitive you reach for.

As in Notebook 1, this notebook is a **driver** for a real `celld dev` process. Cells define Durable Object and Workflow classes as executable TypeScript against the kernel-side shims in `celld_nb.ts` (`DurableObject`, `WorkflowEntrypoint`, `fakeCtx()`) and run them in the kernel where that teaches something. Then `app.ship()` serializes them with `Function.prototype.toString()` into `src/index.js` and celld hot-reloads. Shipped classes must be self-contained, and what celld runs is the JavaScript left after the kernel strips the types. This notebook adds one thing Notebook 1 did not need: the Deno kernel has a native `WebSocket` client, so cells here connect to a cell's WebSockets directly.
''')

md(r'''
## Setup

Two start options matter here. `logs: true` passes `--logs`, so the node's INFO lines land in the kernel; those are the lifecycle events this notebook reads with `app.logs()`. `CELLD_IDLE_EVICT_S` is the opt-in from Part 1 § 02; it *"sets how many seconds without work send an idle resident cell to hibernation, and when it is unset only memory pressure or the residency cap removes one."* Two seconds makes hibernation something you can watch.
''')

code(r'''
import { App, DurableObject, WorkflowEntrypoint, fakeCtx, stopAll, sleep, type DurableObjectNamespace, type FakeContext } from "./celld_nb.ts";

const app = new App("processes", 9903);
console.log("project dir:", app.dir);
''')

md(r'''
## Part 1—JS RPC (Part 1 § 06)

Part 1 § 06's runtime table lists JS RPC as **Yes**: a Worker calls methods on a Durable Object stub instead of wrapping every operation in a `Request`. The same line carries three caveats: *"A stub cannot cross an isolate boundary; an `AbortSignal` passes through on the same node but not across a node boundary; retries only when the peer attempt provably did not start."* In short: call methods freely, do not hand a stub to another cell, and design the methods so a retried call is harmless.

`Tally` keeps named counters in key-value storage and exposes three public methods. There is no `fetch()` at all; every public method on the class is callable through the stub. `Tally` is also the notebook's side channel: later Parts have Workflows and the cron handler bump counters in it, so their progress is visible from the kernel.

The class runs in the kernel first, where "RPC" is just calling the methods.
''')

code(r'''
interface Env {
  TALLY: DurableObjectNamespace;
}

class Tally extends DurableObject<Env> {
  async increment(key: string, by = 1): Promise<number> {
    const n = ((await this.ctx.storage.get<number>(key)) ?? 0) + by;
    await this.ctx.storage.put(key, n);
    return n;
  }
  async read(key: string): Promise<number> {
    return (await this.ctx.storage.get<number>(key)) ?? 0;
  }
  async all(): Promise<Record<string, number>> {
    return Object.fromEntries(await this.ctx.storage.list<number>());
  }
}

const tally = new Tally(fakeCtx("kernel"), {} as Env);
console.log(await tally.increment("visits"), await tally.increment("visits"), await tally.increment("errors", 3));
console.log(await tally.all());
''')

md(r'''
The Worker below is the router the whole notebook grows around. Its `/tally/<key>` routes get a stub with `env.TALLY.get(id)` and call `increment` / `read` / `all` on it. No `Request` is constructed, and the return values come back as ordinary promises. Everything else falls through to a generic `/do/<BINDING>/<name>/<path>` passthrough for the cells later Parts add, so the router does not have to change every time.
''')

code(r'''
const worker = {
  async fetch(request: Request, env: Record<string, DurableObjectNamespace>): Promise<Response> {
    const url = new URL(request.url);
    const [, head, ...rest] = url.pathname.split("/");
    if (head === "tally") {
      const tally = env.TALLY.get(env.TALLY.idFromName("main"));     // a stub: methods, not fetch()
      const key = rest[0];
      if (!key) return Response.json(await tally.all());
      if (request.method === "POST") return Response.json({ [key]: await tally.increment(key) });
      return Response.json({ [key]: await tally.read(key) });
    }
    if (head === "do") {
      const [binding, name, ...path] = rest;
      const ns = env[binding];
      if (!ns) return new Response(`no binding ${binding}`, { status: 404 });
      const cellUrl = new URL(`http://cell/${path.join("/")}${url.search}`);
      return ns.get(ns.idFromName(name)).fetch(new Request(cellUrl, request));
    }
    return new Response("GET|POST /tally/<key> · GET /tally · /do/<BINDING>/<name>/<path>", { status: 404 });
  },
};

const wrangler = {
  durable_objects: { bindings: [{ name: "TALLY", class_name: "Tally" }] },
  migrations: [{ tag: "v1", new_sqlite_classes: ["Tally"] }],
};

await app.ship({ classes: [Tally], worker, wrangler });
await app.start({ clean: true, logs: true, env: { CELLD_IDLE_EVICT_S: "2" } });

console.log(await app.json("/tally/visits", { method: "POST" }));
console.log(await app.json("/tally/visits", { method: "POST" }));
console.log(await app.json("/tally/errors", { method: "POST" }));
console.log(await app.json("/tally"));
''')

md(r'''
Same class, same answers as the in-kernel run. Notice what `wrangler.jsonc` does not say: nothing declares `Tally` an RPC class. Any public method on a `DurableObject` subclass is reachable through the stub; `fetch()` is just the method a `Request` is routed to.

## Part 2—WebSockets and hibernation (Step 04, Part 1 § 02 "Cell states", § 07 "A working cell")

Part 1 § 07 calls the hibernating chat room *"the whole application shape"*, and Step 04 shows it with SQL state added. The key line is `this.ctx.acceptWebSocket(server)`. Accepting the socket through the hibernation API rather than `addEventListener` is what *"lets celld evict an idle room from memory while every client stays connected. A thousand quiet rooms cost almost nothing; a message wakes the one room it addresses."*

`ChatRoom` is the article's class with two additions that make the lifecycle visible:

- A `console.log` in the constructor. celld forwards a cell's console output into the node log as `cell_console` INFO lines, so `app.logs()` shows every time the constructor runs.
- `#firstEvent`, an in-memory flag that starts `true` in every new instance. The first handler to run on a fresh instance bumps a `wakes` counter in storage. Memory holds nothing across a wake, so `wakes` counts exactly how many times celld has constructed this room, and it does so without any work in the constructor, which Step 04 says to keep trivial.

The kernel has no `WebSocketPair`, so the upgrade path cannot run here, but `webSocketMessage` can: give `fakeCtx()` a `getWebSockets()` that returns fake peers and watch the broadcast and the SQL log.
''')

code(r'''
interface WsContext extends FakeContext {
  acceptWebSocket(ws: WebSocket): void;
  getWebSockets(): WebSocket[];
}

class ChatRoom extends DurableObject<Env> {
  #firstEvent = true;

  constructor(ctx: FakeContext, env: Env) {
    super(ctx, env);
    console.log(`ChatRoom constructor (${ctx.id.name ?? ctx.id})`);   // shows up in app.logs() as cell_console
  }

  async #onEvent(): Promise<void> {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS log (at INTEGER, body TEXT)");
    if (!this.#firstEvent) return;
    this.#firstEvent = false;
    await this.ctx.storage.put("wakes", ((await this.ctx.storage.get<number>("wakes")) ?? 0) + 1);
  }

  async fetch(request: Request): Promise<Response> {
    await this.#onEvent();
    const ctx = this.ctx as unknown as WsContext;
    if (new URL(request.url).pathname === "/ws") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      ctx.acceptWebSocket(server);                 // hibernatable — the room can sleep
      return new Response(null, { status: 101, webSocket: client });
    }
    return Response.json({
      sockets: ctx.getWebSockets().length,
      wakes: await this.ctx.storage.get<number>("wakes"),
      log: this.ctx.storage.sql.exec<{ body: string }>("SELECT body FROM log ORDER BY at").toArray().map((r) => r.body),
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.#onEvent();
    this.ctx.storage.sql.exec("INSERT INTO log (at, body) VALUES (?, ?)", Date.now(), String(message));
    for (const peer of (this.ctx as unknown as WsContext).getWebSockets()) {
      if (peer !== ws) peer.send(message);          // one room, no message bus
    }
  }

  async alarm(): Promise<void> {
    // prune history older than a day, then reschedule
    this.ctx.storage.sql.exec("DELETE FROM log WHERE at < ?", Date.now() - 86_400_000);
    await this.ctx.storage.setAlarm(Date.now() + 3_600_000);
  }
}

// In the kernel: fake peers, real SQL.
const received: string[] = [];
const peer = (name: string) => ({ send: (m: string | ArrayBuffer) => received.push(`${name} ← ${m}`) }) as unknown as WebSocket;
const [a, b, c] = [peer("a"), peer("b"), peer("c")];
const roomCtx = Object.assign(fakeCtx("lobby"), { acceptWebSocket() {}, getWebSockets: () => [a, b, c] });
const room = new ChatRoom(roomCtx, {} as Env);
await room.webSocketMessage(a, "hello from a");
await room.webSocketMessage(c, "hi from c");
console.log(received);
console.log(await (await room.fetch(new Request("http://cell/"))).json());
''')

md(r'''
Ship it, then open two real WebSocket clients from the kernel to the same room, send from one, and receive on the other. The room reports its `getWebSockets()` count over the passthrough route.
''')

code(r'''
wrangler.durable_objects.bindings.push({ name: "ROOM", class_name: "ChatRoom" });
wrangler.migrations.push({ tag: "v2", new_sqlite_classes: ["ChatRoom"] });
await app.ship({ classes: [Tally, ChatRoom], worker, wrangler });

const connect = (name: string) => {
  const ws = new WebSocket(`ws://127.0.0.1:${app.port}/do/ROOM/lobby/ws`);
  ws.onmessage = (e) => console.log(`${name} received:`, e.data);
  ws.onclose = (e) => console.log(`${name} closed (code ${e.code})`);
  return new Promise<WebSocket>((resolve) => ws.onopen = () => resolve(ws));
};
const [alice, bob] = await Promise.all([connect("bob"), connect("alice")].reverse());

alice.send("hello from alice");
await sleep(200);
bob.send("hi alice");
await sleep(200);
console.log(await app.json("/do/ROOM/lobby/"));
''')

md(r'''
Two sockets, one wake, both messages in the SQL log, and each message delivered to the other peer only. In the state diagram's terms the room is now *resident*: in memory, idle between messages.

### Hibernation, observed

Part 1 § 02's lifecycle diagram labels the hibernated state *"evicted, but still placed"*: *"WS clients stay connected"* and the cell *"stays on its node"*. On the next message, *"the constructor runs again"*. With `CELLD_IDLE_EVICT_S=2` the eviction should happen a few seconds after the last message. Clear the log, wait, and look for what celld actually writes. Then send a message through the still-open socket and look again.
''')

code(r'''
const tidy = (line: string) => line
  .replace(/^\S+Z\s+INFO\s+/, "")                                   // timestamp + level
  .replace(/(ChatRoom|Tally)[:.]?[0-9a-f]{64}/g, "$1:…")               // the cell's 64-hex id
  .replace(/ (node|region|runtime_version|failure_phase)=\S+/g, "");   // node identity noise
const show = (grep: RegExp) => console.log(app.logs({ grep }).split("\n").filter(Boolean).map(tidy).join("\n"));

app.clearLogs();
await sleep(5000);
console.log("── while idle:");
show(/ChatRoom/);
console.log("\nsockets still open on the client side:", alice.readyState === WebSocket.OPEN, bob.readyState === WebSocket.OPEN);

console.log("\n── after a message to the hibernated room:");
app.clearLogs();
alice.send("anyone awake?");
await sleep(400);
show(/ChatRoom|cell_console/);
console.log("\nroom:", await app.json("/do/ROOM/lobby/"));
''')

md(r'''
Read the two blocks against the diagram. While idle, celld published an *"authoritative handoff snapshot"* of the room's SQLite and passed a *"final durability barrier"* (`eviction_durability_barrier`): state made durable, memory freed. Both client sockets stayed open. Then one message did what the article says it does. The room came back (`cell_isolate_startup_timing` with `fresh=false`, restored from the eviction snapshot it had just written), the constructor's `console.log` appeared again, `wakes` went from 1 to 2, and the room still held both sockets: bob received the message with no reconnect.

That is the whole economics of the model in one screen, and the reason for three rules from Step 04 and § 07:

- **Keep the constructor trivial.** *"It runs on every wake, including each message to a hibernated cell. Restore from `storage` in the handler, not the constructor."* `ChatRoom` restores nothing in its constructor; `#onEvent` does the work, lazily.
- **Batch WebSocket messages.** *"Each frame costs a context switch; pack many small logical messages into one frame with an envelope format. Fewer, larger messages beat many small ones."*
- **Outbound WebSockets do not survive a move.** *"An outbound socket keeps the cell resident and dies when the cell changes nodes. Keep connection intent in storage and re-dial after activation."* Inbound hibernatable sockets are the exception, as you just saw, but only across hibernation, not across a change of owner: *"a transport cannot move to a new owner, so reconnect with a stable operation ID."*

One thing the articles do not mention that you will hit in the dev loop: a **hot reload is a change of deployment, not a hibernation**. If sockets are open when you `ship()`, celld drains the old deployment for up to 25 s (`celld preserve drain reached its 25000ms deadline … websockets=2`) and then closes them with an abnormal close. So close the clients before shipping again.
''')

code(r'''
alice.close();
bob.close();
await sleep(300);
''')

md(r'''
## Part 3—Workflows (Step 06, Part 1 § 06 "Workflows")

*"Cells model entities: named things whose state persists indefinitely. Workflows are the process primitive built on top of them: a sequence of steps that ends, with each step's result stored durably so the sequence survives crashes and restarts."* A workflow extends `WorkflowEntrypoint` and does its work in `run(event, step)`. `step.do(name, fn)` runs a callback and stores its result; `step.sleep(name, duration)` waits durably.

`ReportBuilder` is Step 06's example with the outbound `fetch` replaced by a computation on the params, so the notebook does not depend on the network, plus one addition: every stage bumps a counter in the `Tally` cell from Part 1 through its stub. The stages are the top of `run()`, each step's callback, and the code *outside* steps before and after the sleep. That trace is how the next cells make the replay rule visible.

First, in the kernel. `WorkflowStep` is not in `celld_nb.ts`, so a minimal fake is defined here: `do` runs the callback, `sleep` returns. The in-kernel `env` hands the workflow a real in-kernel `Tally` in place of the stub. The methods are the same, so the workflow cannot tell.
''')

code(r'''
interface WorkflowEvent<P> { payload: P; instanceId: string; timestamp: Date }
interface WorkflowStep {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, duration: string | number): Promise<void>;
}
interface WorkflowInstance { id: string; status(): Promise<{ status: string; output?: unknown; error?: unknown }>; restart(): Promise<void> }
interface WorkflowBinding { create(opts?: { id?: string; params?: unknown }): Promise<WorkflowInstance>; get(id: string): Promise<WorkflowInstance> }
interface ReportParams { text: string }
interface WorkflowEnv extends Env { REPORTS: WorkflowBinding }

class ReportBuilder extends WorkflowEntrypoint<WorkflowEnv> {
  async run(event: WorkflowEvent<ReportParams>, step: WorkflowStep) {
    const tally = this.env.TALLY.get(this.env.TALLY.idFromName("main"));
    await tally.increment("wf:top of run()");                         // outside any step
    const summary = await step.do("summarize", async () => {
      await tally.increment("wf:step summarize");
      const words = event.payload.text.split(/\s+/).filter(Boolean);
      return { words: words.length, longest: words.reduce((a, b) => (b.length > a.length ? b : a), "") };
    });
    await tally.increment("wf:before sleep");                         // outside any step
    await step.sleep("cool off", "4 seconds");
    await tally.increment("wf:after sleep");                          // outside any step
    return await step.do("store summary", async () => {
      await tally.increment("wf:step store");                          // step.do callbacks are the only safe home for side effects
      return { ...summary, storedAt: Date.now() };
    });
  }
}

// A WorkflowStep for the kernel: no durability, just run the callbacks.
const fakeStep = (): WorkflowStep => ({
  async do(name, fn) { console.log(`  step.do "${name}"`); return await fn(); },
  async sleep(name, duration) { console.log(`  step.sleep "${name}" (${duration}) — skipped in the kernel`); },
});

const kernelTally = new Tally(fakeCtx("main"), {} as Env);
const kernelEnv = { TALLY: { idFromName: (n: string) => n, newUniqueId: () => "x", get: () => kernelTally } } as unknown as WorkflowEnv;
const report = new ReportBuilder(null, kernelEnv);
console.log(await report.run({ payload: { text: "the quick brown fox jumps over the lazy dog" }, instanceId: "k1", timestamp: new Date() }, fakeStep()));
console.log(await kernelTally.all());
''')

md(r'''
Now on celld. The configuration is Step 06's `workflows` entry: `binding` is the name on `env`, `class_name` the export, `name` the workflow's fleet-wide identity. The router gains Step 06's two routes, `/create` → `env.REPORTS.create({ params })` and `/status?id=`, plus `/restart?id=` for later. Poll the status from the kernel until the instance completes.
''')

code(r'''
const workflowRouter = {
  async fetch(request: Request, env: WorkflowEnv & Record<string, DurableObjectNamespace>): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/create") {
      const instance = await env.REPORTS.create({ params: { text: url.searchParams.get("text") ?? "" } });
      return Response.json({ id: instance.id });
    }
    const id = url.searchParams.get("id");
    if (url.pathname === "/status" && id) return Response.json(await (await env.REPORTS.get(id)).status());
    if (url.pathname === "/restart" && id) {
      const instance = await env.REPORTS.get(id);
      await instance.restart();
      return Response.json(await instance.status());
    }
    // everything else: the Part 1 router (tally + /do passthrough)
    const [, head, ...rest] = url.pathname.split("/");
    if (head === "tally") {
      const tally = env.TALLY.get(env.TALLY.idFromName("main"));
      const key = rest[0];
      if (!key) return Response.json(await tally.all());
      if (request.method === "POST") return Response.json({ [key]: await tally.increment(key) });
      return Response.json({ [key]: await tally.read(key) });
    }
    if (head === "do") {
      const [binding, name, ...path] = rest;
      const ns = env[binding];
      if (!ns) return new Response(`no binding ${binding}`, { status: 404 });
      return ns.get(ns.idFromName(name)).fetch(new Request(new URL(`http://cell/${path.join("/")}${url.search}`), request));
    }
    return new Response("/create?text= · /status?id= · /restart?id= · /tally · /do/…", { status: 404 });
  },
};

Object.assign(wrangler, { workflows: [{ binding: "REPORTS", name: "report-builder", class_name: "ReportBuilder" }] });
const spec = { classes: [Tally, ChatRoom, ReportBuilder], worker: workflowRouter, wrangler };
await app.ship(spec);

type Status = { status: string; output?: unknown };
const watch = async (id: string, maxMs = 15_000) => {
  const seen: string[] = [];
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const s = await app.json<Status>(`/status?id=${id}`);
    if (seen.at(-1) !== s.status) { seen.push(s.status); console.log(`  +${((Date.now() - t0) / 1000).toFixed(1)}s  ${s.status}`); }
    if (s.status === "complete" || s.status === "errored") return s;
    await sleep(250);
  }
  throw new Error(`still ${seen.at(-1)} after ${maxMs} ms`);
};

const stages = async (fn: () => Promise<unknown>) => {
  const before = await app.json<Record<string, number>>("/tally");
  await fn();
  const after = await app.json<Record<string, number>>("/tally");
  // one console.log for the whole table: the kernel can drop trailing lines
  // when a cell ends right after a burst of separate writes
  const rows = Object.keys(after).filter((k) => k.startsWith("wf:")).map((k) => `${k.slice(3).padEnd(19)}${after[k] - (before[k] ?? 0)}`);
  console.log(["", "stage              runs", ...rows].join("\n"));
};

// read the tally baseline *before* /create: the instance starts running at once,
// and the top-of-run increment would otherwise land before the baseline is read
let first = "";
await stages(async () => {
  first = (await app.json<{ id: string }>("/create?text=the+quick+brown+fox+jumps+over+the+lazy+dog")).id;
  console.log("instance", first);
  console.log("output:", (await watch(first)).output);
});
''')

md(r'''
The instance went `running → waiting → complete` and returned its summary, but the trace does not match a single pass through `run()`. The top of `run()` and the code before the sleep ran **twice**; the two steps and the code after the sleep ran once. Nothing crashed. This is the rule that Step 06 says *"decides whether your workflow is correct"*, and celld applied it in the ordinary course of a sleep:

> A running workflow is stored as its steps. After a crash, `run()` is replayed *from the start*: completed steps return their stored results instantly, and everything *outside* a step runs again.

Map the numbers onto the article's diagram. First execution: the top of `run()` runs, `summarize` runs and stores its result, the code before the sleep runs, and `step.sleep` parks the instance. That is the `waiting` state; the instance is not resident while it waits. When the sleep is due, celld continues the instance the only way it can: by replaying `run()` from the top. The top-of-run code runs again, `summarize` returns its stored result without calling its callback (count still 1), the before-sleep code runs again, the sleep is already satisfied, and then the after-sleep code and `store summary` run for the first time. *"Everything meaningful goes inside a step, and every step must be idempotent."* The article frames replay as what happens *after a crash*. On celld it is also what happens after every durable sleep, as this run shows, so a side effect outside a step is not a rare-failure bug but an every-run bug.

The celld-specific contract from the workflows service page, as Step 06 summarizes it:

- **Limits.** A step result, an event payload, and the workflow parameters are each capped at 1 MiB; work outside a step cannot stay pending longer than 60 seconds. *"Pass references (an R2 key, a D1 row) between steps, not payloads."* A `workflows` entry cannot carry `schedules`, `limits`, or a `script_name` naming another script, and the REST API and `wrangler workflows` do not operate against celld.
- **Defaults.** `step.do()` retries 5 times with a 10-second delay and exponential backoff, 10 minutes per attempt, and `NonRetryableError` stops the loop; `waitForEvent()` times out after 24 hours; an instance within an hour of its next alarm stays resident (`CELLD_ALARM_RESIDENT_MS`).
- **Retention.** A successful or failed instance is kept 30 days by default; each duration in the `retention` option can be at most 30 days; completed runs can be deleted manually.
- **Lifecycle.** The page lists no difference for `pause()`, `resume()`, or `restart()`, so celld intends Cloudflare's behavior. `restart()` works here, and it is *not* a replay: it starts the instance over with no stored steps, so `summarize`'s callback runs again. A replay would have returned its stored result.
- **Not available:** rollback, sensitive step results, `ReadableStream` step results. And the article's warning stands: whether `create()` with a terminal instance's ID replaces it or is refused, *"verify against your installed release rather than assuming either way."*
''')

code(r'''
await stages(async () => {
  console.log("restart →", await app.json<Status>(`/restart?id=${first}`));
  await watch(first);
});
''')

md(r'''
## Part 4—Cron triggers (Part 1 § 06 "Cron, alarms, and WebAssembly")

*"Cron triggers run the `scheduled` handler on celld's own durable alarms, one minute resolution in UTC, exactly once per occurrence fleet-wide. One handler runs at a time per script; a handler can run late but never early. A thrown handler is retried with backoff (starting at 4 seconds, doubling, abandoned after 6 failures, and only the expression that threw), and `controller.noRetry()` cancels the retry."* And the convention to remember: **day-of-week 1 is Sunday**, the same as Cloudflare and opposite to most cron dialects.

Declare `triggers.crons` and add a `scheduled(controller, env, ctx)` handler to the Worker. This one records each firing in `Tally` under a key carrying the scheduled minute, an RPC call from the cron handler like the one from the workflow. Then the notebook waits for the next minute boundary: up to 65 seconds, once.
''')

code(r'''
interface ScheduledController { cron: string; scheduledTime: number; noRetry(): void }

const cronWorker = {
  fetch: workflowRouter.fetch,
  async scheduled(controller: ScheduledController, env: WorkflowEnv): Promise<void> {
    const tally = env.TALLY.get(env.TALLY.idFromName("main"));
    await tally.increment(`cron ${controller.cron} @ ${new Date(controller.scheduledTime).toISOString()}`);
    await tally.increment("cron firings");
  },
};

Object.assign(wrangler, { triggers: { crons: ["* * * * *"] } });
await app.ship({ classes: [Tally, ChatRoom, ReportBuilder], worker: cronWorker, wrangler });

const shipped = Date.now();
console.log("shipped at", new Date(shipped).toISOString(), "— next minute boundary in", 60 - new Date(shipped).getUTCSeconds(), "s");
app.clearLogs();
let fired: Record<string, number> = {};
while (Date.now() - shipped < 70_000) {
  fired = await app.json<Record<string, number>>("/tally");
  if (fired["cron firings"]) break;
  await sleep(2000);
  if ((Date.now() - shipped) % 10_000 < 2000) console.log(`  …${((Date.now() - shipped) / 1000).toFixed(0)} s, not yet`);
}
console.log(`after ${((Date.now() - shipped) / 1000).toFixed(0)} s:`, Object.fromEntries(Object.entries(fired).filter(([k]) => k.startsWith("cron"))));
console.log("node log lines mentioning cron or scheduled:", app.logs({ grep: /cron|scheduled/i }).split("\n").filter(Boolean).length);
''')

md(r'''
The key names the minute it was scheduled for, exactly on the boundary, and it fired once. celld's node log says little or nothing about it (the count above is 2 in this run and was 0 on another machine): a cron firing is an ordinary durable alarm on an internal cell, and the `--logs` output records lifecycle, not handler invocations. If you want cron firings visible, record them yourself, as the handler here does.

## Part 5—Entities, not processes (Part 1 § 07)

Two primitives have now run in this notebook, and the article's framing is the test for which one a problem wants:

> A cell models an **entity**: a named unit with state that persists indefinitely, such as a concert, a user, or a document. A durable-execution engine (Temporal, Restate, Azure Durable Functions) models a **process**: a sequence of steps that ends, such as an order pipeline. celld's Workflows implementation is the process primitive built on the entity primitive, and its replay semantics (see § 06) are exactly the tradeoff that primitive carries: steps must be idempotent, because a crash re-runs them. Pick the shape that matches the problem rather than the tool you have.

Look back at what each one did here. `ChatRoom` has no end: it accumulates a log, holds connections, wakes on demand, and is addressed by name forever. `ReportBuilder` has an end and a result: `create()` returned an ID, the instance walked through states, and `status()` finally carried its output. Its progress lived in stored steps, not in a handler's memory. That is why the durable sleep could not lose it, and also why the code between steps ran twice.

The three workloads § 07 says the entity model fits (real-time applications, agents, sharded web applications) are all entities. The one that is neither obviously a process nor a chat room is the **agent**: *"Each AI agent is one cell holding memory, schedule, and inbox in its own SQLite; an idle agent hibernates to the bucket, so a large agent fleet costs almost nothing between events."* An agent is a long-lived entity that drives itself through short bursts of process, and the durable alarm is what lets it do that without a Workflow and without staying resident. That is the exercise.

### Exercise—a self-driving agent cell

Implement `Agent`: an inbox in SQL, fed by `POST /enqueue {"task": …}`, and an `alarm()` that processes **one** task per firing and then reschedules itself while the inbox is non-empty. The cell hibernates between firings; nothing lives in memory; the constructor stays trivial.

- `POST /enqueue` inserts the task into `inbox` and, **only if no alarm is pending** (`getAlarm()` is `null`), schedules one `delayMs` ahead. Three enqueues in a row must schedule exactly one alarm.
- `alarm()` takes the oldest `inbox` row, moves it to `done` with a timestamp, and, if `inbox` still has rows, calls `setAlarm(Date.now() + delayMs)`. If the inbox is empty it sets nothing, and the cell goes quiet.
- `GET /` reports `{ inbox, done, alarm }` (task lists and `getAlarm()`); it is written for you.

The checker runs the class in the kernel (where `fakeCtx()` records alarms and you call `alarm()` by hand), then ships it and lets celld's alarms drive it. Alarms are durable and covered by the acknowledgement gate (Step 04; the rule itself is Part 1 § 04), so on a fleet this loop survives a node loss between firings.

**Hints**, from a nudge to a near-solution. Try the exercise first, then read only as far as you need.

1. **Concept.** The alarm is the loop. `/enqueue` only starts it; each `alarm()` does one unit of work and decides whether there is a next one. Checking for a pending alarm is what keeps three enqueues from scheduling three alarms.
2. **API.** `await this.ctx.storage.getAlarm()` returns a timestamp or `null`. `this.ctx.storage.sql.exec(sql, …bindings)` runs a statement; `.toArray()[0]` reads the first row, and `.one().n` reads a `COUNT(*) AS n`.
3. **Sketch.** `/enqueue`: insert the task, then set an alarm `Agent.delayMs` ahead only if `getAlarm()` is `null`. `alarm()`: select the oldest `inbox` row (return if there is none), insert it into `done` with `Date.now()`, delete it from `inbox`, count what is left, and set the next alarm only if that count is above zero.

Full worked solutions are intentionally not included. The checker cell is the verification: every line turns from ✗ to ✓ once the implementation is right.
''')

code(r'''
class Agent extends DurableObject<Env> {
  static delayMs = 300;

  #schema() {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS inbox (id INTEGER PRIMARY KEY, task TEXT NOT NULL)");
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS done (id INTEGER PRIMARY KEY, task TEXT NOT NULL, at INTEGER NOT NULL)");
  }

  async fetch(request: Request): Promise<Response> {
    this.#schema();
    if (request.method === "POST" && new URL(request.url).pathname === "/enqueue") {
      const { task } = await request.json() as { task: string };
      // TODO: insert `task` into inbox; if getAlarm() is null, setAlarm(Date.now() + Agent.delayMs)
      return new Response("not implemented", { status: 501 });
    }
    return Response.json({
      inbox: this.ctx.storage.sql.exec<{ task: string }>("SELECT task FROM inbox ORDER BY id").toArray().map((r) => r.task),
      done: this.ctx.storage.sql.exec<{ task: string }>("SELECT task FROM done ORDER BY id").toArray().map((r) => r.task),
      alarm: await this.ctx.storage.getAlarm(),
    });
  }

  async alarm(): Promise<void> {
    this.#schema();
    // TODO: move the oldest inbox row to done (with at = Date.now());
    //       if inbox is still non-empty, setAlarm(Date.now() + Agent.delayMs)
  }
}
''')

if "--solution" in sys.argv:
    cells[-1]["source"] = cells[-1]["source"].replace(
        '''      // TODO: insert `task` into inbox; if getAlarm() is null, setAlarm(Date.now() + Agent.delayMs)
      return new Response("not implemented", { status: 501 });''',
        '''      this.ctx.storage.sql.exec("INSERT INTO inbox (task) VALUES (?)", task);
      if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + Agent.delayMs);
      return Response.json({ queued: this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM inbox").one().n });''',
    ).replace(
        '''    // TODO: move the oldest inbox row to done (with at = Date.now());
    //       if inbox is still non-empty, setAlarm(Date.now() + Agent.delayMs)''',
        '''    const next = this.ctx.storage.sql.exec<{ id: number; task: string }>("SELECT id, task FROM inbox ORDER BY id LIMIT 1").toArray()[0];
    if (!next) return;
    this.ctx.storage.sql.exec("INSERT INTO done (task, at) VALUES (?, ?)", next.task, Date.now());
    this.ctx.storage.sql.exec("DELETE FROM inbox WHERE id = ?", next.id);
    const left = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM inbox").one().n;
    if (left > 0) await this.ctx.storage.setAlarm(Date.now() + Agent.delayMs);''',
    )

code(r'''
// ── checker ────────────────────────────────────────────────────────────────
type AgentState = { inbox: string[]; done: string[]; alarm: number | null };
const check = (label: string, ok: boolean, detail = "") => console.log(`${ok ? "✓" : "✗"} ${label}${detail && !ok ? ` — ${detail}` : ""}`);
const enqueueReq = (task: string) => new Request("http://cell/enqueue", { method: "POST", body: JSON.stringify({ task }) });

const agentCtx = fakeCtx("agent-1");
const agent = new Agent(agentCtx, {} as Env);
for (const t of ["read inbox", "draft reply", "file report"]) await agent.fetch(enqueueReq(t));
let st = await (await agent.fetch(new Request("http://cell/"))).json() as AgentState;
check("kernel: three tasks queued", st.inbox.length === 3, JSON.stringify(st));
check("kernel: exactly one alarm scheduled for three enqueues", agentCtx.alarms.length === 1, `alarms recorded: ${agentCtx.alarms.length}`);
for (let i = 1; i <= 3; i++) {
  await agentCtx.storage.deleteAlarm();      // celld clears the alarm before calling alarm(); mimic that
  await agent.alarm();
  st = await (await agent.fetch(new Request("http://cell/"))).json() as AgentState;
  check(`kernel: firing ${i} processed one task`, st.done.length === i && st.inbox.length === 3 - i, JSON.stringify(st));
}
check("kernel: rescheduled while non-empty, then stopped", agentCtx.alarms.length === 3 && st.alarm === null, `alarms recorded: ${agentCtx.alarms.length}, pending: ${st.alarm}`);
check("kernel: FIFO order", st.done.join(",") === "read inbox,draft reply,file report", st.done.join(","));

wrangler.durable_objects.bindings.push({ name: "AGENT", class_name: "Agent" });
wrangler.migrations.push({ tag: "v3", new_sqlite_classes: ["Agent"] });
await app.ship({ classes: [Tally, ChatRoom, ReportBuilder, Agent], worker: cronWorker, wrangler });

const agentUrl = "/do/AGENT/agent-1";
for (const t of ["read inbox", "draft reply", "file report"]) await app.fetch(`${agentUrl}/enqueue`, { method: "POST", body: JSON.stringify({ task: t }) });
const t0 = Date.now();
let live = await app.json<AgentState>(`${agentUrl}/`);
check("celld: queued with one alarm pending", live.inbox.length === 3 && live.alarm !== null, JSON.stringify(live));
while (Date.now() - t0 < 5000 && live.inbox.length > 0) { await sleep(200); live = await app.json<AgentState>(`${agentUrl}/`); }
check(`celld: alarms drained the inbox in ${((Date.now() - t0) / 1000).toFixed(1)} s`, live.inbox.length === 0 && live.done.length === 3 && live.alarm === null, JSON.stringify(live));
''')

md(r'''
## Clean up

Stop the node. State stays in `.celld/dev` under `app.dir`; the next `app.start()` without `clean: true` resumes it, including the workflow instances, which are inside their 30-day retention.
''')

code(r'''
await stopAll();
''')

md(r'''
## Where next

This was the process side of the cell model: RPC as the natural call shape between a Worker and its cells (Part 1 § 06); hibernation watched from the log, with the constructor running again on every wake and hibernatable sockets surviving it (Part 1 § 02, Step 04); Workflows and the replay rule made visible through a durable sleep (Step 06); cron as a durable alarm with minute resolution and Sunday as day 1; and the entity/process distinction that puts an agent on the cell side of the line (Part 1 § 07).

What the three notebooks deliberately leave to the articles is everything about a **fleet**: the bucket as coordinator, ownership and fencing, replication as LTX segments, balancing of hibernated cells, and failover (Part 1 § 03–05 and Steps 08–10 of the guide). Those are operational, and `celld dev`'s local store is a single node. But the lifecycle events in this notebook's log output, and their siblings (`eviction_durability_barrier`, `restore_plan`, `cell_isolate_startup_timing`), are the same ones a fleet node writes when a cell moves. Read those chapters with this notebook's log output beside you.

**Maintenance.** This export is frozen at celld v0.6.0, executed 2026·09·26. Re-execute it on each new celld release and note what changed: upstream moves fast, with five releases (v0.4.0 through v0.6.0) between 2026·08·28 and 2026·09·26.
''')

out = "celld-03-solution.ipynb" if "--solution" in sys.argv else "celld-03-processes.ipynb"
nb = {"cells": cells, "metadata": {"kernelspec": {"name": "deno", "display_name": "Deno", "language": "typescript"},
      "language_info": {"name": "typescript"}}, "nbformat": 4, "nbformat_minor": 5}
json.dump(nb, open(out, "w"), indent=1)
print(len(cells), "cells →", out)
