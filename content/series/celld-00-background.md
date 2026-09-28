---
title: "Actors, Durable Objects, and Durable Execution"
dek: "The background the celld series assumes: what the Cloudflare Workers platform is, what a Durable Object is and why it was built, where the idea comes from in fifty years of actor systems, and how durable execution turns a crash-prone process into one that finishes. Read this first if Durable Objects are new to you."
kind: "Background Primer"
meta:
  Status: "Background · read first"
  Source: "Cloudflare docs + blog, Orleans, Erlang, Akka, Temporal, Restate, Azure docs"
  Updated: "2026·09·27"
series: "celld"
series_parts:
  - title: "Part 0—Actors, Durable Objects, and durable execution"
  - title: "Part 1—Durable Objects on Your Own Storage"
    href: "celld-durable-objects"
  - title: "Part 2—Building on celld, step by step"
    href: "celld-step-by-step"
  - title: "Notebook 1—The cell model"
    href: "celld-01-cells"
  - title: "Notebook 2—Bindings: KV, Queues, D1, R2"
    href: "celld-02-bindings"
  - title: "Notebook 3—Processes and lifecycle"
    href: "celld-03-processes"
  - title: "Review—Quick reference and self-quiz"
    href: "celld-review"
section_label: "§"
---

## Why this part exists {#why}

celld is a self-hosted runtime for one specific programming model: Cloudflare Workers with Durable Objects at the stateful core. The rest of the series takes that model as given. Part 1 explains how celld implements it, Part 2 builds an application on it, and the notebooks check its behavior against a live node. None of them stop to say what a Durable Object *is*, why anyone would want one, or which older ideas it inherits.

This part fills that gap. It covers four things, in the order they build on each other:

- **The Workers platform** (§ 02): stateless JavaScript in V8 isolates, reached through bindings, deployed with Wrangler.
- **Durable Objects** (§ 03): a named, single-threaded object with its own storage, and the gates that make it safe.
- **The actor model** (§ 04): the fifty-year lineage from Hewitt to Erlang, Akka, and Orleans' virtual actors, of which a Durable Object is one descendant.
- **Durable execution** (§ 05 and § 06): code that survives crashes by replaying a log, and the distinction between an *entity* that lives indefinitely and a *process* that finishes.

§ 07 maps each idea onto celld's own vocabulary. Nothing here is specific to a celld release.

<!-- series-only -->
> [!TIP] Orientation · how to use this series
>
> Read in order: Part 0, then Part 1, then Part 2, with each notebook beside the steps it demonstrates. Notebook 1 goes with Part 2 Steps 02–04, Notebook 2 with Steps 05 and 07, and Notebook 3 with Step 06. The articles are for reading. The notebooks are executed evidence: every output came from a live `celld dev` node, and each page is a frozen export at celld v0.6.0. Each notebook ends with an exercise of TODO stubs and a checker cell. The exported checkers print ✗ by design: they wait for your solution and are not broken output. For reference, Part 1 § 11 is the glossary and Part 1 § 05's release-notes table is the release history.
<!-- /series-only -->

## The Workers platform {#workers}

A Cloudflare Worker is a JavaScript (or WebAssembly) program that answers HTTP requests. It runs on Cloudflare's network rather than on a server you manage, and it keeps no state between requests of its own. Three pieces define the platform: the isolate it runs in, the bindings it reaches the rest of the platform through, and the tool that deploys it.

### Isolates, not containers

Workers run on **V8**, the JavaScript engine in Chromium and Node.js. In V8, an **isolate** is a lightweight sandbox: it gives one program its own variables and its own memory, safe from every other program in the same process. A single Workers runtime process hosts hundreds or thousands of isolates and switches between them with near-zero latency.

That choice is the platform's founding tradeoff. A container or virtual machine pays for an operating system and a language runtime every time an instance starts. Workers pays the runtime's cost once, when the host process starts. Cloudflare's documentation puts an isolate's startup at roughly a hundred times faster than a Node process in a container or VM, and its memory at an order of magnitude less, which is why one machine can run thousands of tenants' code with no per-tenant process.

When a request reaches any Cloudflare location, the machine that receives it runs the Worker's `fetch()` handler in an isolate on that machine. Requests are spread across the network wherever they land. That is exactly right for stateless code, and exactly wrong for anything that must coordinate: two requests for the same chat room can run on different continents.

### Bindings

A **binding** is a permission and an API in one object. It lets a Worker use a platform resource (a database, a bucket, another Worker) with no REST call and no credential in the code. The runtime holds the authorization, so the secret never reaches the script. Bindings appear on the `env` object, reached three ways:

- as an argument to a handler: `fetch(request, env, ctx)`;
- as `this.env` on a `WorkerEntrypoint`, `DurableObject`, or `Workflow` class;
- as an import for top-level code: `import { env } from "cloudflare:workers"`.

| Family | Bindings |
|----|----|
| Storage and databases | Workers KV, R2 object storage, D1, Durable Objects, Hyperdrive, Vectorize, static assets |
| Compute and communication | Service bindings (HTTP and RPC via `WorkerEntrypoint`), Queues, Workflows, Dynamic Worker Loaders, dispatchers (Workers for Platforms) |
| Configuration | environment variables, secrets, Secrets Store, version metadata |
| Platform services | Workers AI, Analytics Engine, Browser Run, Images, Stream, rate limiting, mTLS |

celld supplies the bindings Cloudflare builds on Durable Objects (Durable Objects themselves, KV, Queues, D1, R2, Workflows, service bindings, Dynamic Workers, static assets, variables) and not the platform services; Part 1 § 06 draws the exact line.

### Wrangler

**Wrangler** is Cloudflare's command-line tool. A project declares its entry point, bindings, and Durable Object classes in a Wrangler configuration file (`wrangler.jsonc`, `wrangler.json`, or `wrangler.toml`), runs locally with `wrangler dev`, and ships with `wrangler deploy`. The configuration file is the contract between code and platform, which is why celld reads the same file (in its JSON forms; Part 1 § 06 lists the keys).

## Durable Objects {#durable-objects}

A **Durable Object** is the platform's answer to coordination. It gives a piece of state one home, one thread, and its own storage, and it routes every request for that state to that home.

### Why they exist

Before Durable Objects, a Worker had two places to keep state. It could call back to a central database at an origin, giving up the point of running at the edge. Or it could use Workers KV, which is built for read-heavy data and is eventually consistent, with last-write-wins semantics. Neither fits a chat room, a collaborative document, a game lobby, or a rate limiter: workloads that need many clients to agree on one current state, now.

The model arrived in stages, each announced on Cloudflare's blog:

| Date | Milestone |
|----|----|
| 28 September 2020 | Kenton Varda announces Durable Objects in closed beta ("Workers Durable Objects Beta: A New Approach to Stateful Serverless"). |
| 3 August 2021 | "Durable Objects: Easy, Fast, Correct—Choose three" introduces input and output gates. |
| 15 November 2021 | Durable Objects become generally available. |
| 11 May 2022 | Alarms launch ("Durable Objects Alarms—a wake-up call for your applications"). |
| 5 April 2024 | JavaScript-native RPC replaces hand-written HTTP between a Worker and an object's stub. |
| 26 September 2024 | "Zero-latency SQLite storage in every Durable Object" puts a SQLite database inside each object. |

Boris Tane's one-line summary is the most useful starting point: *"A Durable Object is like having a tiny, long-lived server that is guaranteed to be unique for a specific ID."* A Worker spreads a hundred requests across whatever machines receive them; a Durable Object gathers every request for its ID into one place.

### One object per name, one thread

A Durable Object is an instance of a class in your code. Each instance has a globally unique ID, either derived from a name with `idFromName()` or generated by the system. An object with a given ID exists in **one place in the world at a time**. Any Worker, anywhere, that addresses that ID reaches that one instance: it gets a stub from the namespace binding and calls the object's methods over RPC, or forwards a request to its `fetch()`.

Cloudflare places the object near where it is first requested, or where a caller's location hint says. To reach it, the runtime asks an internal directory which machine currently runs that ID and routes the call there. If the machine fails, the object is started on a healthy one and its state is restored from storage. The caller never learns which machine holds the object.

Each object runs on **one thread**, in one isolate. All requests for that object go through that thread, so code can keep values in ordinary JavaScript variables across requests and maintain invariants without locks. This is the property the whole model rests on, and the one celld keeps exactly (Part 1 § 02).

### Storage and the two gates

Each object has private, strongly consistent storage. The original API is a key-value store. The SQLite-backed API embeds a SQLite database in the object's own thread, so a query runs synchronously, with no network round trip and no context switch.

The machinery underneath, which Cloudflare calls the **Storage Relay Service**, is worth knowing because celld rebuilds it on different parts (§ 07):

- SQLite runs in write-ahead-log mode, and a virtual-file-system hook captures each commit's WAL frames.
- The frames stream to **five follower machines in five different data centers**. When **three of the five** have them, the commit counts as durable.
- Every 10 seconds or 16 MB, the frames are batched and uploaded to object storage, and the followers drop their copies. If the object's machine dies first, the followers upload on its behalf.
- Object storage keeps the change log and periodic snapshots for 30 days, so an object can be restored to any point in that window.

D1, Cloudflare's SQL database product, is built on the same foundation: each database is a SQLite-backed Durable Object, and read replicas are further objects fed from the primary's WAL.

A single thread is not enough on its own, because JavaScript is asynchronous. Every `await` yields, and another request can start while the first one waits. The 2021 post introduced two mechanisms that close the gap without explicit transactions:

- **Input gate.** While a storage operation is in flight, the runtime delivers no new event (no new request, no WebSocket message) to the object. A read followed by a write cannot be interleaved by another request's read-modify-write.
- **Output gate.** Code does not have to wait for a write to reach disk. It continues immediately, and the runtime holds every outgoing message (the response, an outbound `fetch()`) until the write is confirmed durable (with SQLite storage, until three followers hold it). If the write fails, the held messages are replaced by errors and the object restarts. No one outside the object can ever see a success for a write that was not persisted.

celld keeps the output gate by name and defines it against its own durability proofs (Part 1 § 04). It gets the input gate's effect a different way: storage calls are synchronous, so a storage operation never interleaves at all (Part 1 § 02).

### Hibernation and alarms

An object that is doing nothing should cost nothing. The **WebSocket Hibernation API** lets an object that serves WebSockets be evicted from memory while its clients stay connected at the edge. When a message arrives, the runtime re-creates the object (running its constructor again) and calls `webSocketMessage()`. In-memory variables do not survive; per-connection state can ride along with `ws.serializeAttachment()` (up to 16 KB) and come back through `ws.deserializeAttachment()`. Protocol-level ping and pong are answered at the edge without waking the object.

An **alarm** is the object's own timer. `this.ctx.storage.setAlarm(time)` schedules a wake-up; at that time the runtime calls the object's `alarm()` method. An object has one alarm at a time. Alarms run at least once: a throwing handler is retried with exponential backoff, starting at a 2-second delay, up to 6 retries. Alarms are the building block for background work, queues, and workflow engines.

> [!WARNING] Five things newcomers get wrong
>
> - **One thread does not remove all interleaving.** The input gate covers storage. A non-storage `await` (an outbound `fetch()`, say) still lets another request run in the gap.
> - **You do not need to `await` a write for safety.** The output gate already holds the response until the write is durable.
> - **An object scales out, not up.** One object is one thread on one machine. Heavy traffic is spread across many objects, never pushed through one.
> - **Durable Objects do not replace a global store.** They are for fine-grained units that need strong consistency and a single point of coordination: one per document, user, or cart. Broadly read, rarely changed data belongs in KV.
> - **Class fields do not persist.** Hibernation and eviction discard memory. Anything that must survive goes into storage or a WebSocket attachment.

> [!TIP] Rules of thumb · from Cloudflare's "Rules of Durable Objects"
>
> - **Model the atom of coordination.** One object per chat room, document, user, or match: the smallest unit whose state must agree with itself.
> - **Avoid global singletons.** One object handles roughly 500–1,000 requests per second. A single global counter or rate limiter becomes the bottleneck.
> - **Use parents and children.** A parent object keeps the directory of its children, not their data, so work on different children runs in parallel.
> - **Use `blockConcurrencyWhile()` sparingly.** It suits one-time setup such as a schema migration in the constructor. Held across slow I/O, it stalls every request to the object.
> - **Make alarms idempotent.** A retried `alarm()` can run more than once, so check state before acting.

## The actor model {#actors}

A Durable Object is a new implementation of an old idea. The idea is the **actor**: a unit of computation with private state that interacts with the world only by exchanging messages. Knowing the lineage explains both the model's strengths and the specific choices Durable Objects made.

### Hewitt, 1973

Carl Hewitt, with Peter Bishop and Richard Steiger, introduced the actor model in **1973** as a mathematical model of concurrent computation. An actor is the fundamental unit. In response to a message, an actor can do three things, concurrently:

1. send a finite number of messages to other actors;
2. create a finite number of new actors;
3. designate the behavior to use for the next message it receives.

An actor's state is private, and actors communicate only by asynchronous messages. No actor reaches into another's memory, so there is nothing to lock.

David Khourshid's everyday version: an actor is a coworker you message on Slack. They read the message when they are ready, may do some work or update their to-do list, and may message you or others back. *"You never reach over and edit their work directly (hopefully), and you don't know what they're thinking unless they tell you."* Every actor has three parts: a **mailbox** of incoming messages, **private state** nothing else can change, and a **behavior**, which he writes as *state + message → next state (+ effects)*. That last form is why state machines fit actors so naturally, and his explanation for why the model keeps being reinvented, most recently for AI agents that hold their own context and message each other: *"We keep reinventing it because it keeps being right."*

### Erlang and "let it crash"

Joe Armstrong, Robert Virding, and Mike Williams built **Erlang** at Ericsson in **1986** to program telephone exchanges; it was released as open source in December 1998. An Erlang program is a large number of very lightweight processes on the BEAM virtual machine. Processes share no memory, collect their own garbage, and communicate by asynchronous, location-transparent messages delivered to mailboxes.

Erlang's contribution to fault tolerance is **let it crash**. A process does not defend against every unexpected error. It fails cleanly, and a separate process restarts it from a known state. **OTP** organizes this into **supervision trees**: supervisor processes own worker processes, are notified when one dies, and apply a restart strategy, so a fault is contained without taking the node down.

### Akka

**Akka** brought the Erlang model to the JVM, for Java and Scala. An actor processes messages from its mailbox one at a time, replacing shared-memory threading with sequential message handling. Every actor is supervised by its parent, as in OTP, and the model extends across a cluster.

### Orleans and the virtual actor

Classic actors have a lifecycle the programmer must manage. Someone creates the actor, holds its address, and handles its disappearance when its host dies. Microsoft Research's Orleans removed that burden. The paper "Orleans: Distributed Virtual Actors for Programmability and Scalability" (Bernstein, Bykov, Geller, Kliot, and Thelin; technical report MSR-TR-2014-41, **March 2014**) introduced the **virtual actor**, which Orleans calls a **grain**:

- **Perpetual existence.** A grain exists logically at all times. It is never explicitly created or destroyed, and a server crash does not end its identity.
- **Automatic activation.** The runtime loads a grain into memory when a message arrives for it, and deactivates it when it is idle.
- **Location transparency.** A caller addresses a grain by identity and never needs to know which server (a **silo**) is hosting it.

A grain's durable state lives in an external storage provider, such as a SQL database, Cosmos DB, or Redis.

### Where Durable Objects sit

A Durable Object is a virtual actor. It has a global identity, it is created implicitly on first use and evicted when idle, it runs one message at a time, and callers reach it through a stub without knowing where it lives. Four things set it apart:

| | Classic actor (Erlang, Akka) | Virtual actor (Orleans grain) | Durable Object |
|----|----|----|----|
| Lifecycle | created and stopped explicitly; gone if its host dies | perpetual; activated and deactivated by the runtime | perpetual; created on first use, hibernated or evicted when idle |
| Addressing | a process or network address | a logical identity | a globally unique ID or name |
| Durable state | the programmer's problem | an external storage provider | **colocated** storage in the same thread (key-value or SQLite) |
| Concurrency | one message at a time | one message at a time | one thread, plus **input and output gates** around storage and output |
| Host | a VM or JVM cluster | .NET silos | V8 isolates on Cloudflare's network, with hibernating WebSockets |

The colocated storage and the gates are the decisive differences. An Orleans grain must call out to its database, and that call is where latency and consistency bugs come from. A Durable Object's database is in its own thread, and the output gate makes durability invisible to the programmer. celld keeps both properties and changes only where the object runs and where its storage is replicated (§ 07).

## Durable execution {#durable-execution}

Actors solve *where state lives and who may change it*. A second family of systems solves a different problem: *how a multi-step process finishes even when the machine running it does not*. That property is **durable execution**.

### The idea

An ordinary process keeps its progress in memory; when it crashes, the progress is gone. A durable execution engine records each step's outcome in a persistent log. When the process dies, a new process picks the execution up, and the code continues as if the crash never happened, with its local variables and its position restored. A durable execution can last a fraction of a second or wait for months.

The mechanism, in nearly every engine, is **replay**. The engine runs the code again from the start. Each time the code reaches a step that already completed, the engine returns the recorded result instead of running the step. When the code reaches the first step with no record, it is back where it crashed, and real execution resumes.

Replay imposes two rules on the programmer. Jack Vanlightly's "Demystifying determinism in durable execution" (2025) draws the line precisely:

- **Control flow must be deterministic.** The branches, the loops, and *the arguments passed to each side effect* must come out the same on every replay, or replay drifts onto a different path. A clock read, an unseeded random number, or a direct database query in the control flow can cause it; the result is bugs like charging a customer twice.
- **Side effects do not need to be deterministic, but they must tolerate running twice.** An API call or an email send goes inside a step. The engine records the step's result once it completes and returns the record on replay. A crash *after* the side effect but *before* the record is written runs the step again, so the step must be idempotent.

Stripped down, durable execution is **persistent memoization**. Gunnar Morling showed how little it takes in "Building a durable execution engine with SQLite" (2025): a working engine in under 1,000 lines of Java, with one SQLite table (`execution_log`) recording each step's status, parameters, and return value, a proxy that intercepts step calls to consult and update the log, and virtual threads to park a flow that is sleeping or waiting for a signal. A durable log, an interceptor, and a way to suspend: every engine below is some arrangement of those three parts.

### Five engines

| Engine | How it records progress | How it recovers |
|----|----|----|
| **Temporal** | an append-only event history of every activity, timer, and result | re-executes the workflow code from the beginning, answering completed actions from the history |
| **Restate** | a journal of every step, RPC call, timer, and state update, kept by the Restate server (written in Rust); state lives beside the journal in an embedded key-value store | replays the journal, skipping completed steps |
| **Azure Durable Functions** | event sourcing through the Durable Task framework, with orchestration history in Azure Storage or the Durable Task Scheduler | the orchestrator replays its history to rebuild its state |
| **DBOS** | an in-process library (DBOS Transact, for Python, TypeScript, Go, Java, and Rust) that writes each workflow's status and inputs, then each step's output, to tables in the application's Postgres database | on restart, a background thread finds workflows still `PENDING` and calls each again from the start with its original inputs; completed steps return their recorded outputs |
| **Cloudflare Workflows** | each workflow instance's engine is a SQLite-backed Durable Object; `step.do()` results are stored in its SQLite database | `run()` executes again and each completed `step.do()` returns its stored result; `step.sleep()` and retries wake the engine with Durable Object alarms |

The engines also differ in *where* they run. Temporal is an **external orchestrator**: a separate server cluster, with workers that talk to it over the network. DBOS argues for the opposite, **lightweight durable execution**: an in-process library that checkpoints each step into the application's own database (Postgres, in DBOS's case), with no orchestrator to deploy. Cloudflare Workflows sits between the two. The engine is not a server you run, but each instance is a Durable Object: Morling's three parts, with the log in the object's SQLite and alarms as the way to suspend.

Vendors claim more than crash-proofing for the model. Alex Poliakov (DBOS) lists observability (every step's inputs and outputs are already recorded), forking (re-running a failed workflow from a chosen step on fixed code), and workflows that run for months across restarts and deployments.

Cloudflare announced Workflows in open beta on **24 October 2024** ("Build durable applications on Cloudflare Workers: you write the Workflows, we take care of the rest"). It is the case this series cares about most, because it is built out of Durable Objects: the process primitive is implemented on top of the entity primitive. celld's Workflows implementation follows the same design (Part 1 § 06, "Workflows"; Notebook 3).

## Entities and processes {#entities-processes}

Put § 04 and § 05 side by side and two kinds of stateful thing appear:

- An **entity** is a named unit whose state persists indefinitely: a user, a room, a document, a device. It has no natural end. It handles one operation at a time, forever.
- A **process** is a sequence of steps that starts, runs, and **finishes**: an order pipeline, a signup flow, a nightly import.

Azure Durable Functions draws the line most explicitly. Alongside orchestrations it offers **Durable Entities** (added in Durable Functions 2.0), its version of a virtual actor:

| | Durable Entity | Orchestration |
|----|----|----|
| Purpose | explicit, long-lived state (a counter, a cart, a session) | a sequence of tasks that runs to completion |
| State | held explicitly and changed by operation handlers | implicit in the code's control flow and its history |
| Lifecycle | created on first use, unloaded when idle, persists indefinitely | started by a trigger, finishes when done |
| Execution | operations processed serially, one at a time | replays history to drive its activities |
| Identity | an entity ID: an entity name plus an entity key | an instance ID |

Azure also shows the price of separating them. An entity can *signal* another entity (one-way, no reply), but only an orchestration can *call* one and wait for the answer, and only an orchestration can coordinate several entities at once. Compared with an Orleans grain, a Durable Entity favors durability over latency: it persists its state on every operation.

The Durable Objects platform has both shapes, and builds one from the other. A Durable Object is the entity. Workflows is the process, and each workflow instance runs on a Durable Object. The practical rule follows directly: **model the thing that persists as an object, model the thing that finishes as a workflow**, and do not force one shape into the other. Part 1 § 07 ("Entities, not processes") applies this rule to application design.

## Where celld fits {#where-celld-fits}

celld keeps the programming model in § 02 to § 06 and replaces what sits underneath it. The code, the bindings, and the Wrangler configuration are Cloudflare's. The placement layer, the storage layer, and the failure domain become your machines and one bucket you own.

| In this part | In celld | Where the series covers it |
|----|----|----|
| a Durable Object instance | a **cell** | Part 1 § 02 |
| Cloudflare picks a data center | an **owner** node claims the cell's **ownership record** in the bucket | Part 1 § 03, § 04 |
| Storage Relay Service: WAL frames to five followers, durable at three, batched to object storage | SQLite replicated as **LTX segments** to the **fleet bucket**; acknowledged on a **fleet proof** (one or two followers, *every* follower must fsync) or, on a single node, a **bucket proof** | Part 1 § 03 |
| the internal directory that locates an object | the cell's **ownership record** in the bucket; no directory service | Part 1 § 03, § 04 |
| D1 as SQLite-backed Durable Objects | D1 as a cell | Part 1 § 06 |
| output gate | **output gate**, holding output until a durability proof covers it | Part 1 § 04 |
| input gate | synchronous storage calls: a storage operation never interleaves | Part 1 § 02 |
| hibernation and eviction | **resident**, **hibernated**, and **inactive** cells | Part 1 § 02; Notebook 3 |
| alarms | durable alarms, which also drive cron and Workflows | Part 1 § 06; Notebook 1 |
| Workflows (replay over `step.do()`) | Workflows on cells, with the same replay discipline | Part 1 § 06; Part 2 Step 06; Notebook 3 |
| `wrangler dev` / `wrangler deploy` | `celld dev` / `celld deploy`, reading the same `wrangler.jsonc` | Part 2 Steps 02–03, 09 |

From here, read Part 1 for how celld makes these guarantees on commodity machines, Part 2 to build something, and the notebooks to watch it happen. Part 1 § 11 defines every term the series uses.

<!-- series-only -->
------------------------------------------------------------------------

*Sources: Cloudflare Workers docs ("How Workers works", "Bindings"); Cloudflare Durable Objects docs ("What are Durable Objects?", "Use WebSockets", "Alarms"); Cloudflare blog posts on Durable Objects (beta, 2020·09·28; gates, 2021·08·03; general availability, 2021·11·15; alarms, 2022·05·11; JavaScript-native RPC, 2024·04·05; SQLite storage, 2024·09·26), on D1 read replication, and the "Rules of Durable Objects" docs; "How Durable Objects and D1 Work" (Josh Howard, video); Boris Tane, "What even are Cloudflare Durable Objects?"; David Khourshid on the actor model (X); Cloudflare Workflows docs and the open-beta announcement, 2024·10·24; Wikipedia, "Actor model" and "Erlang (programming language)"; Akka, "How the Actor Model Meets the Needs of Modern, Distributed Systems"; Bernstein et al., "Orleans: Distributed Virtual Actors for Programmability and Scalability", MSR-TR-2014-41, 2014; Microsoft Learn, "Orleans overview", "Durable Functions overview", and "Durable entities"; Temporal, "The definitive guide to Durable Execution"; Restate, "Key concepts"; Jack Vanlightly, "Demystifying determinism in durable execution" (2025·11·24); Gunnar Morling, "Building a durable execution engine with SQLite" (2025·11·20); Peter Kraft and Qian Li, "Why Durable Execution Should Be Lightweight" (DBOS, 2025·01·12), and DBOS, "What's the Use Case for Durable Execution?" (2025·05·26); Alex Poliakov, "The Superpowers of Durable Execution" (2025·11·06); John Bellaud, "The Imperative of Durable Execution in App Dev: Unveiling Temporal's Framework" (TechFabric, 2024·10·23). Researched 2026·09·27. Platform details change; check the vendors' current documentation before relying on a limit.*
<!-- /series-only -->
