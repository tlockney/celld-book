---
title: "celld — Durable Objects on Your Own Storage"
dek: "celld takes Cloudflare's Durable Objects model—a named, single-threaded object with its own SQLite database—and runs it on machines you control, with an S3-compatible bucket as the only coordinator. This is the synthesis of the celld docs and the Cloudflare Workers surface you need to design, deploy, and operate stateful distributed systems on it."
kind: "Engineering Reference"
meta:
  Status: "Field guide · v0.6.0"
  Source: "celld.dev + Cloudflare Workers docs"
  Updated: "2026·09·27 · first written 2026·08·30 for v0.4.0"
series: "celld"
series_parts:
  - title: "Part 0—Actors, Durable Objects, and durable execution"
    href: "celld-00-background"
  - title: "Part 1—Durable Objects on Your Own Storage"
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

## What celld is {#what-celld-is}

celld is a stateful distributed system that runs server-side JavaScript on your machines and keeps all of its shared state in an S3-compatible, Google Cloud Storage, or Azure Blob bucket that you own. It is **V8 + SQLite + LTX**: the Cloudflare Workers runtime with Durable Objects as the stateful core, with the placement layer replaced by an object store. The JavaScript API it exposes is the same API that Workers and Durable Objects supply, so code written for one side generally runs on the other. celld's conformance tests run programs on workerd (the binary Cloudflare operates in production) and on celld, on identical bytes, and require equal output.

The founding idea is worth stating plainly. The Durable Objects model, *a single-threaded object with its own storage, addressed by name*, is one of the best primitives distributed systems has been handed in years. celld does not contest that. It moves placement, state, and operational evidence out of a shared vendor platform and into infrastructure you choose. The docs are explicit that self-hosting is not automatically more reliable; it makes the failure domain explicit and inspectable: your nodes, your bucket provider, and your operational choices.

If Durable Objects, actors, or durable execution are new to you, read Part 0 first: [Actors, Durable Objects, and Durable Execution](celld-00-background) covers the platform and the ideas <!-- series-only -->this guide takes for granted.<!-- /series-only --><!-- book-only -->this part takes for granted.<!-- /book-only -->

<!-- series-only -->This guide describes<!-- /series-only --><!-- book-only -->This book describes<!-- /book-only --> celld v0.6.0 (released 2026·09·26), the first release celld calls a **beta** rather than an alpha. Where behavior changed between releases, the body states the current behavior and <!-- series-only -->§ 05 records the change once, in the release notes next to the upgrade transitions.<!-- /series-only --><!-- book-only -->[Appendix C](release-notes.html) records the change once, next to the upgrade rules.<!-- /book-only -->

> [!TLDR] Durable Objects is a strong programming model. celld keeps the model—a named object, one thread, its own SQLite—while moving the scheduler, the storage, and the failure domain onto your machines and your bucket.

> [!TIP] Scope rule · as of v0.6.0
>
> The compatibility line is: **if Cloudflare builds a function on Durable Objects, celld can carry it.** The compatibility page marks **Workers, Durable Objects, facets, static assets, cron, Dynamic Workers, KV, Queues, D1, Workflows, and R2 all *Yes***, listing only the remaining differences, and marks Containers *Experimental*. Each service has its own page at [celld.dev/docs/services](https://celld.dev/docs/services/queues/), with a narrative, a worked example, and a short differences list. Out of scope is the platform surface that is not a Durable-Object building block: Workers AI (the experimental HTTP adapter was removed), Vectorize, Hyperdrive, Browser Rendering, Email, Python Workers, and BroadcastChannel. A configuration or binding that is not available must fail loudly, at deploy or first use; a silent gap is a bug.

## The cell model {#cell-model}

A **cell** is the Durable Object: a small server with a name and a private SQLite database. You make one cell for each user, each document, each chat room, or each AI agent. A cell serves HTTP, holds WebSocket connections, sets alarms, and makes outbound connections. Two properties make the model safe without distributed locking:

- **One thread per cell.** Two requests to the same cell never run at the same instant. A second request can interleave only while the first *awaits*, and storage operations are synchronous, so a storage operation never interleaves at all. The data in a cell stays consistent by construction. [Notebook 1 Part 2](celld-01-cells) shows it live: with a timer awaited between read and write, ten concurrent increments all return 1; wrapped in `blockConcurrencyWhile()`, they return 1 through 10.
- **No shared database.** Cells share nothing; the application divides into cells from the start. The contention of one shared database never appears, because no shared database exists.

### Cell states

A cell has the same states as a Durable Object:

- **Resident**: in memory. A resident cell is *active* while it does work and *idle* while it waits.
- **Hibernated**: evicted from memory. Its hibernatable WebSocket clients stay connected and it stays on its node.
- **Inactive**: no node holds it. It is only an object in the bucket, at essentially zero cost.

Every cell starts inactive. One 8 GB node holds ~1,000 resident cells, which prices a resident cell at roughly \$0.05/month. Idle eviction is opt-in: `CELLD_IDLE_EVICT_S` sets how many seconds without work send an idle resident cell to hibernation, and when it is unset only memory pressure or the residency cap removes one. That matters for balancing (§ 05), which moves only hibernated cells. [Notebook 3 Part 2](celld-03-processes) watches a chat room hibernate while both of its sockets stay open, then wake on the next message with its constructor running again.

<figure class="topology">
<svg aria-labelledby="f2-t f2-d" role="img" viewbox="0 0 880 336" xmlns="http://www.w3.org/2000/svg">
<title id="f2-t">Cell lifecycle states</title>
<desc id="f2-d">A cell starts inactive—only an object in the bucket. Activation restores it into memory as resident, where it is active while it works and idle while it waits. celld evicts an idle cell to hibernated, which keeps its WebSocket clients connected and keeps it on the same node; a message wakes it back to resident and the constructor runs again. Releasing ownership, or losing the node, returns a cell from either resident or hibernated to inactive.</desc>
<defs>
<marker id="f2a" markerheight="7" markerwidth="7" orient="auto-start-reverse" refx="9" refy="5" viewbox="0 0 10 10">
<path d="M 0 0 L 10 5 L 0 10 z" style="fill:var(--ink-3, #7b8791)"></path>
</marker>
<marker id="f2d" markerheight="7" markerwidth="7" orient="auto-start-reverse" refx="9" refy="5" viewbox="0 0 10 10">
<path d="M 0 0 L 10 5 L 0 10 z" style="fill:var(--cobalt, #2a56a0)"></path>
</marker>
</defs>
<!-- INACTIVE -->
<rect height="120" rx="6" stroke-dasharray="5 3" stroke-width="1.5" width="200" x="14" y="105" style="fill:var(--paper-2, #ebeee9);stroke:var(--cobalt, #2a56a0)"></rect>
<text class="m" font-size="12.5" font-weight="600" text-anchor="middle" x="114" y="133" style="fill:var(--cobalt, #2a56a0)">INACTIVE</text>
<text class="f" font-size="12.5" text-anchor="middle" x="114" y="155" style="fill:var(--ink-2, #4a5763)">only an object in the bucket</text>
<text class="m" font-size="9" text-anchor="middle" x="114" y="177" style="fill:var(--ink-2, #4a5763)">no node holds it</text>
<text class="m" font-size="9" text-anchor="middle" x="114" y="191" style="fill:var(--ink-2, #4a5763)">≈ zero cost</text>
<text class="m" font-size="9" text-anchor="middle" x="114" y="209" style="fill:var(--cobalt, #2a56a0)">every cell starts here</text>
<!-- RESIDENT -->
<rect height="150" rx="6" stroke-width="1.5" width="200" x="340" y="90" style="fill:var(--plate, #e6ebeb);stroke:var(--ink-2, #4a5763)"></rect>
<text class="m" font-size="12.5" font-weight="600" text-anchor="middle" x="440" y="116" style="fill:var(--ink, #1b252e)">RESIDENT</text>
<text class="f" font-size="12.5" text-anchor="middle" x="440" y="136" style="fill:var(--ink-2, #4a5763)">in memory, one thread</text>
<rect height="46" rx="3" width="80" x="356" y="148" style="fill:var(--paper-2, #ebeee9);stroke:var(--ink-3, #7b8791)"></rect>
<text class="m" font-size="9.5" text-anchor="middle" x="396" y="167" style="fill:var(--ink-2, #4a5763)">ACTIVE</text>
<text class="m" font-size="9" text-anchor="middle" x="396" y="182" style="fill:var(--ink-2, #4a5763)">serving work</text>
<rect height="46" rx="3" width="80" x="444" y="148" style="fill:var(--paper-2, #ebeee9);stroke:var(--ink-3, #7b8791)"></rect>
<text class="m" font-size="9.5" text-anchor="middle" x="484" y="167" style="fill:var(--ink-2, #4a5763)">IDLE</text>
<text class="m" font-size="9" text-anchor="middle" x="484" y="182" style="fill:var(--ink-2, #4a5763)">waiting</text>
<text class="m" font-size="9" text-anchor="middle" x="440" y="212" style="fill:var(--ink-2, #4a5763)">~1,000 per 8 GB node</text>
<text class="m" font-size="9" text-anchor="middle" x="440" y="226" style="fill:var(--ink-2, #4a5763)">≈ $0.05/month each</text>
<!-- HIBERNATED -->
<rect height="120" rx="6" stroke-width="1.5" width="200" x="666" y="105" style="fill:var(--plate, #e6ebeb);stroke:var(--ink-2, #4a5763)"></rect>
<text class="m" font-size="12.5" font-weight="600" text-anchor="middle" x="766" y="133" style="fill:var(--ink, #1b252e)">HIBERNATED</text>
<text class="f" font-size="12.5" text-anchor="middle" x="766" y="155" style="fill:var(--ink-2, #4a5763)">evicted, but still placed</text>
<text class="m" font-size="9" text-anchor="middle" x="766" y="177" style="fill:var(--ink-2, #4a5763)">WS clients stay connected</text>
<text class="m" font-size="9" text-anchor="middle" x="766" y="191" style="fill:var(--ink-2, #4a5763)">stays on its node</text>
<text class="m" font-size="9" text-anchor="middle" x="766" y="209" style="fill:var(--ink-2, #4a5763)">the only two differences</text>
<!-- activation -->
<path d="M 218 168 L 336 168" fill="none" marker-end="url(#f2a)" stroke-width="1.5" style="stroke:var(--ink-3, #7b8791)"></path>
<text class="m" font-size="9" text-anchor="middle" x="277" y="140" style="fill:var(--ink-2, #4a5763)">activation</text>
<text class="m" font-size="9" text-anchor="middle" x="277" y="152" style="fill:var(--ink-2, #4a5763)">restore from bucket</text>
<text class="m" font-size="9" text-anchor="middle" x="277" y="188" style="fill:var(--ink-2, #4a5763)">constructor runs</text>
<!-- evict -->
<path d="M 544 142 L 662 142" fill="none" marker-end="url(#f2a)" stroke-width="1.5" style="stroke:var(--ink-3, #7b8791)"></path>
<text class="m" font-size="9" text-anchor="middle" x="603" y="118" style="fill:var(--ink-2, #4a5763)">evict idle</text>
<text class="m" font-size="9" text-anchor="middle" x="603" y="130" style="fill:var(--ink-2, #4a5763)">memory freed</text>
<!-- wake -->
<path d="M 662 196 L 544 196" fill="none" marker-end="url(#f2a)" stroke-width="1.5" style="stroke:var(--ink-3, #7b8791)"></path>
<text class="m" font-size="9" text-anchor="middle" x="603" y="214" style="fill:var(--ink-2, #4a5763)">a message wakes it</text>
<text class="m" font-size="9" text-anchor="middle" x="603" y="226" style="fill:var(--ink-2, #4a5763)">constructor runs again</text>
<!-- release bus -->
<path d="M 766 227 V 278 Q 766 288 756 288 H 128 Q 118 288 118 278 V 233" fill="none" marker-end="url(#f2d)" stroke-dasharray="4 3" stroke-width="1.5" style="stroke:var(--cobalt, #2a56a0)"></path>
<path d="M 440 242 V 288" fill="none" stroke-dasharray="4 3" stroke-width="1.5" style="stroke:var(--cobalt, #2a56a0)"></path>
<text class="m" font-size="9.5" text-anchor="middle" x="440" y="306" style="fill:var(--cobalt, #2a56a0)">ownership released, or the node is lost—from either state the cell is back to an object in the bucket</text>
<text class="f" font-size="12.5" text-anchor="middle" x="440" y="322" style="fill:var(--ink-2, #4a5763)">memory holds nothing across any of these transitions, so the constructor runs again on the next event</text>
</svg>
<figcaption>The cell lifecycle. Only two things separate a hibernated cell from a cold one: its WebSocket clients are still connected, and it is still on its node. Everything else about a wake <em>is</em> a cold start, which is why the constructor has to stay light and state has to be restored inside the handler.</figcaption>
</figure>

Two practical consequences follow. First, **keep the constructor light**. It runs on every wake, including every message to a hibernated cell, so restore state from SQLite storage inside the handler, not in the constructor. Second, **idle cost is near zero**: an agent fleet whose cells hibernate between events costs almost nothing to hold, which is exactly the economics the model is designed for.

> [!WARNING] Design constraint · CELLD_V8_HEAP_LIMIT_MB
>
> Each isolate defaults to a 128 MB V8 heap, matching a Cloudflare Durable Object. celld keeps an isolate that reaches the limit (Cloudflare discards one), and `state.acceptWebSocket()` throws when the heap passes 90%, because a cell that accepts more sockets than it can carry serves none of them. Neither state is permanent; the guard lifts when the heap drains.

## The bucket is the coordinator {#bucket-coordinator}

This is the architectural centerpiece. There is **no membership protocol, no failure detector, and no consensus service**. A **node** is one celld process; a **fleet** is the set of nodes sharing one **fleet bucket**. Ownership of a cell is a record in that bucket, claimed with one atomic write. celld's built-in replicator continuously ships each cell's SQLite state to the bucket as **LTX segments**, Litestream's replica format from Ben Johnson. The loss of a node cannot lose an acknowledged write, because celld does not answer a write until the data survives a failure (**RPO=0**).

<figure class="topology">
<svg aria-labelledby="f1-t f1-d" role="img" viewbox="0 0 880 458" xmlns="http://www.w3.org/2000/svg">
<title id="f1-t">Fleet topology and the ownership path</title>
<desc id="f1-d">Clients reach any celld node. Each node owns a set of resident cells, one SQLite database per cell. A request for chat-1 that lands on node B is proxied over the peer tunnel to node A, the owner, because only the owner may run the cell. Every node replicates its cells to the fleet bucket as LTX segments and reads leases, ownership records, and restores back out of it.</desc>
<defs>
<marker id="f1a" markerheight="7" markerwidth="7" orient="auto-start-reverse" refx="9" refy="5" viewbox="0 0 10 10">
<path d="M 0 0 L 10 5 L 0 10 z" style="fill:var(--ink-3, #7b8791)"></path>
</marker>
<marker id="f1c" markerheight="7" markerwidth="7" orient="auto-start-reverse" refx="9" refy="5" viewbox="0 0 10 10">
<path d="M 0 0 L 10 5 L 0 10 z" style="fill:var(--cobalt, #2a56a0)"></path>
</marker>
</defs>
<rect height="32" rx="5" stroke-width="1.5" width="300" x="290" y="12" style="fill:var(--plate, #e6ebeb);stroke:var(--ink-2, #4a5763)"></rect>
<text class="m" font-size="11.5" text-anchor="middle" x="440" y="33" style="fill:var(--ink, #1b252e)">clients—HTTP · WebSockets</text>
<path d="M 300 46 L 148 106" fill="none" marker-end="url(#f1a)" stroke-width="1.4" style="stroke:var(--ink-3, #7b8791)"></path>
<path d="M 440 46 L 440 106" fill="none" marker-end="url(#f1a)" stroke-width="1.4" style="stroke:var(--ink-3, #7b8791)"></path>
<path d="M 580 46 L 732 106" fill="none" marker-end="url(#f1a)" stroke-width="1.4" style="stroke:var(--ink-3, #7b8791)"></path>
<!-- node A — the owner -->
<rect height="170" rx="6" stroke-width="1.5" width="210" x="30" y="110" style="fill:var(--plate, #e6ebeb);stroke:var(--ink-2, #4a5763)"></rect>
<text class="m" font-size="11.5" font-weight="600" text-anchor="middle" x="135" y="132" style="fill:var(--ink, #1b252e)">celld node A</text>
<rect height="22" rx="3" stroke-width="1.3" width="154" x="58" y="148" style="fill:var(--paper-2, #ebeee9);stroke:var(--cobalt, #2a56a0)"></rect>
<text class="m" font-size="9" x="66" y="163" style="fill:var(--cobalt, #2a56a0)">chat-1 · sqlite</text>
<text class="m" font-size="8.5" text-anchor="end" x="204" y="163" style="fill:var(--cobalt, #2a56a0)">OWNER</text>
<rect height="22" rx="3" width="154" x="58" y="174" style="fill:var(--paper-2, #ebeee9);stroke:var(--rule, #d3d9d4)"></rect>
<text class="m" font-size="9" x="66" y="189" style="fill:var(--ink-2, #4a5763)">user-42 · sqlite</text>
<rect height="22" rx="3" width="154" x="58" y="200" style="fill:var(--paper-2, #ebeee9);stroke:var(--rule, #d3d9d4)"></rect>
<text class="m" font-size="9" x="66" y="215" style="fill:var(--ink-2, #4a5763)">__d1:ledger · sqlite</text>
<text class="m" font-size="9" text-anchor="middle" x="135" y="236" style="fill:var(--ink-2, #4a5763)">… one thread each</text>
<text class="m" font-size="9" text-anchor="middle" x="135" y="254" style="fill:var(--cobalt, #2a56a0)">warm path · zero bucket ops</text>
<text class="m" font-size="9" text-anchor="middle" x="135" y="267" style="fill:var(--cobalt, #2a56a0)">p50 ≈ 1.1 ms</text>
<!-- node B — ingress, not owner -->
<rect height="170" rx="6" stroke-width="1.5" width="210" x="335" y="110" style="fill:var(--plate, #e6ebeb);stroke:var(--ink-2, #4a5763)"></rect>
<text class="m" font-size="11.5" font-weight="600" text-anchor="middle" x="440" y="132" style="fill:var(--ink, #1b252e)">celld node B</text>
<rect height="22" rx="3" stroke-dasharray="4 3" width="154" x="363" y="148" style="fill:var(--paper-2, #ebeee9);stroke:var(--ink-3, #7b8791)"></rect>
<text class="m" font-size="9" x="371" y="163" style="fill:var(--ink-2, #4a5763)">chat-1 → owner: A</text>
<rect height="22" rx="3" width="154" x="363" y="174" style="fill:var(--paper-2, #ebeee9);stroke:var(--rule, #d3d9d4)"></rect>
<text class="m" font-size="9" x="371" y="189" style="fill:var(--ink-2, #4a5763)">room-9 · sqlite</text>
<rect height="22" rx="3" width="154" x="363" y="200" style="fill:var(--paper-2, #ebeee9);stroke:var(--rule, #d3d9d4)"></rect>
<text class="m" font-size="9" x="371" y="215" style="fill:var(--ink-2, #4a5763)">user-7 · sqlite</text>
<text class="m" font-size="9" text-anchor="middle" x="440" y="236" style="fill:var(--ink-2, #4a5763)">… one thread each</text>
<text class="m" font-size="9" text-anchor="middle" x="440" y="254" style="fill:var(--ink-2, #4a5763)">any node can ingress</text>
<text class="m" font-size="9" text-anchor="middle" x="440" y="267" style="fill:var(--ink-2, #4a5763)">a non-owner call is proxied</text>
<!-- node C -->
<rect height="170" rx="6" stroke-width="1.5" width="210" x="640" y="110" style="fill:var(--plate, #e6ebeb);stroke:var(--ink-2, #4a5763)"></rect>
<text class="m" font-size="11.5" font-weight="600" text-anchor="middle" x="745" y="132" style="fill:var(--ink, #1b252e)">celld node C</text>
<rect height="22" rx="3" width="154" x="668" y="148" style="fill:var(--paper-2, #ebeee9);stroke:var(--rule, #d3d9d4)"></rect>
<text class="m" font-size="9" x="676" y="163" style="fill:var(--ink-2, #4a5763)">agent-3 · sqlite</text>
<rect height="22" rx="3" width="154" x="668" y="174" style="fill:var(--paper-2, #ebeee9);stroke:var(--rule, #d3d9d4)"></rect>
<text class="m" font-size="9" x="676" y="189" style="fill:var(--ink-2, #4a5763)">user-88 · sqlite</text>
<rect height="22" rx="3" stroke-dasharray="4 3" width="154" x="668" y="200" style="fill:var(--paper-2, #ebeee9);stroke:var(--rule, #d3d9d4)"></rect>
<text class="m" font-size="9" x="676" y="215" style="fill:var(--ink-2, #4a5763)">free capacity</text>
<text class="m" font-size="9" text-anchor="middle" x="745" y="236" style="fill:var(--ink-2, #4a5763)">… one thread each</text>
<text class="m" font-size="9" text-anchor="middle" x="745" y="254" style="fill:var(--ink-2, #4a5763)">balancing hands it</text>
<text class="m" font-size="9" text-anchor="middle" x="745" y="267" style="fill:var(--ink-2, #4a5763)">hibernated cells from full peers</text>
<!-- peer tunnel B → A -->
<path d="M 331 178 L 246 178" fill="none" marker-end="url(#f1c)" stroke-width="1.6" style="stroke:var(--cobalt, #2a56a0)"></path>
<text class="m" font-size="9" text-anchor="middle" x="288" y="158" style="fill:var(--cobalt, #2a56a0)">peer tunnel</text>
<text class="m" font-size="9" text-anchor="middle" x="288" y="169" style="fill:var(--cobalt, #2a56a0)">to the owner</text>
<text class="m" font-size="8.5" text-anchor="middle" x="288" y="196" style="fill:var(--ink-2, #4a5763)">fetch · RPC · WS</text>
<text class="m" font-size="8.5" text-anchor="middle" x="288" y="207" style="fill:var(--ink-2, #4a5763)">versioned</text>
<text class="m" font-size="8.5" text-anchor="middle" x="594" y="178" style="fill:var(--ink-2, #4a5763)">no join command</text>
<text class="m" font-size="8.5" text-anchor="middle" x="594" y="190" style="fill:var(--ink-2, #4a5763)">no membership list</text>
<!-- replication / restore -->
<path d="M 135 282 L 135 336" fill="none" marker-end="url(#f1a)" stroke-width="1.4" style="stroke:var(--ink-3, #7b8791)"></path>
<path d="M 440 282 L 440 336" fill="none" marker-end="url(#f1a)" stroke-width="1.4" style="stroke:var(--ink-3, #7b8791)"></path>
<path d="M 745 336 L 745 284" fill="none" marker-end="url(#f1a)" stroke-dasharray="4 3" stroke-width="1.4" style="stroke:var(--ink-3, #7b8791)"></path>
<text class="m" font-size="9" x="145" y="302" style="fill:var(--cobalt, #2a56a0)">LTX segments</text>
<text class="m" font-size="9" x="145" y="315" style="fill:var(--ink-2, #4a5763)">continuous · RPO=0</text>
<text class="m" font-size="9" x="450" y="308" style="fill:var(--cobalt, #2a56a0)">every cell, every write</text>
<text class="m" font-size="9" text-anchor="end" x="735" y="302" style="fill:var(--ink-2, #4a5763)">restore on activation</text>
<text class="m" font-size="9" text-anchor="end" x="735" y="315" style="fill:var(--ink-2, #4a5763)">lease discovery</text>
<!-- bucket -->
<rect height="86" rx="6" stroke-width="1.6" width="820" x="30" y="340" style="fill:var(--paper-2, #ebeee9);stroke:var(--cobalt, #2a56a0)"></rect>
<text class="m" font-size="12" font-weight="600" text-anchor="middle" x="440" y="364" style="fill:var(--ink, #1b252e)">S3-compatible bucket—the only coordinator</text>
<rect height="38" rx="3" width="246" x="52" y="378" style="fill:var(--plate, #e6ebeb);stroke:var(--rule, #d3d9d4)"></rect>
<text class="m" font-size="9" x="64" y="394" style="fill:var(--ink-2, #4a5763)">ownership records · node leases</text>
<text class="m" font-size="9" x="64" y="408" style="fill:var(--ink-2, #4a5763)">one conditional write per claim</text>
<rect height="38" rx="3" width="246" x="316" y="378" style="fill:var(--plate, #e6ebeb);stroke:var(--rule, #d3d9d4)"></rect>
<text class="m" font-size="9" x="328" y="394" style="fill:var(--ink-2, #4a5763)">cells/&lt;id&gt;/ltx/e&lt;epoch&gt;/</text>
<text class="m" font-size="9" x="328" y="408" style="fill:var(--ink-2, #4a5763)">LTX segments · inactive cells</text>
<rect height="38" rx="3" width="248" x="580" y="378" style="fill:var(--plate, #e6ebeb);stroke:var(--rule, #d3d9d4)"></rect>
<text class="m" font-size="9" x="592" y="394" style="fill:var(--ink-2, #4a5763)">deploy/ · telemetry/ · r2/ · kv</text>
<text class="m" font-size="9" x="592" y="408" style="fill:var(--ink-2, #4a5763)">large KV values · R2 objects</text>
<text class="m" font-size="10" text-anchor="middle" x="440" y="446" style="fill:var(--ink-2, #4a5763)">no membership protocol · no failure detector · no consensus service—discovery is the leases in the bucket</text>
</svg>
<figcaption>The bucket supplies discovery and authority: nodes find each other through the leases in it, a node acquires a cell with one atomic write, and every cell's state is continuously replicated there as LTX segments. What it does <em>not</em> supply is network reachability. Peers talk over a private network or an encrypted overlay. Note the consequence of one-owner-per-cell: any node can take the request, but only the owner can run the cell, so a call that lands elsewhere is proxied to the owner over the versioned peer tunnel. That hop is why routing a cell's traffic to its owner is worth doing when latency matters.</figcaption>
</figure>

### How RPO=0 is earned: bucket proof vs. fleet proof

The durability mechanism depends on fleet size, and it is explicit.

- **With one node**, every write waits for the bucket. This is the **bucket proof**: one storage round trip, which is the minimum latency for a durable write.
- **With two or more nodes**, the node serving the cell sends each write to another node and answers as soon as that node has the data on its own disk; the bucket upload finishes afterwards. This is the **fleet proof**. The owner and the nodes it sends to form the cell's **ensemble**, and each of those nodes is a **follower**. A node picks one or two followers (never itself), so a fleet of three or more nodes holds *three copies* of an acknowledged write, and the ensemble keeps acknowledging while one follower remains.

`CELLD_DURABILITY` selects the mode (default `fleet`). A single node requests the fleet posture and does not get it, falling back to bucket proof. Run two or more nodes if write latency matters.

<figure class="topology">
<svg aria-labelledby="f1b-t f1b-d" role="img" viewbox="0 0 880 306" xmlns="http://www.w3.org/2000/svg">
<title id="f1b-t">Where the acknowledgement lands, by fleet size</title>
<desc id="f1b-d">Two timelines sharing a start. In a single-node fleet the write is acknowledged only after the bucket upload completes—one full storage round trip. In a fleet of two or more nodes the write is acknowledged as soon as a follower has fsynced it, and the bucket upload finishes afterwards, off the response path.</desc>
<defs>
<marker id="f1ba" markerheight="7" markerwidth="7" orient="auto-start-reverse" refx="9" refy="5" viewbox="0 0 10 10">
<path d="M 0 0 L 10 5 L 0 10 z" style="fill:var(--ink-3, #7b8791)"></path>
</marker>
</defs>
<!-- shared write instant -->
<path d="M 200 44 L 200 178" fill="none" stroke-dasharray="3 3" stroke-width="1.2" style="stroke:var(--ink-3, #7b8791)"></path>
<text class="m" font-size="9" text-anchor="middle" x="200" y="36" style="fill:var(--ink-2, #4a5763)">the write</text>
<!-- lane A: one node -->
<text class="m" font-size="11" font-weight="600" x="20" y="70" style="fill:var(--ink, #1b252e)">ONE NODE</text>
<text class="f" font-size="12.5" x="20" y="87" style="fill:var(--ink-2, #4a5763)">bucket proof</text>
<rect height="30" rx="3" stroke-width="1.3" width="420" x="200" y="58" style="fill:var(--plate, #e6ebeb);stroke:var(--ink-2, #4a5763)"></rect>
<text class="m" font-size="10" text-anchor="middle" x="410" y="77" style="fill:var(--ink, #1b252e)">bucket upload</text>
<path d="M 620 48 L 620 98" fill="none" stroke-width="1.6" style="stroke:var(--cobalt, #2a56a0)"></path>
<circle cx="620" cy="73" r="4.5" style="fill:var(--cobalt, #2a56a0)"></circle>
<text class="m" font-size="10" font-weight="600" text-anchor="middle" x="620" y="41" style="fill:var(--cobalt, #2a56a0)">ack</text>
<text class="m" font-size="9" x="634" y="70" style="fill:var(--ink-2, #4a5763)">one storage round trip —</text>
<text class="m" font-size="9" x="634" y="83" style="fill:var(--ink-2, #4a5763)">the floor for a durable write</text>
<!-- lane B: two or more nodes -->
<text class="m" font-size="11" font-weight="600" x="20" y="140" style="fill:var(--cobalt, #2a56a0)">TWO+ NODES</text>
<text class="f" font-size="12.5" x="20" y="157" style="fill:var(--ink-2, #4a5763)">fleet proof</text>
<rect height="30" rx="3" stroke-width="1.3" width="130" x="200" y="128" style="fill:var(--plate, #e6ebeb);stroke:var(--ink-2, #4a5763)"></rect>
<text class="m" font-size="9.5" text-anchor="middle" x="265" y="147" style="fill:var(--ink, #1b252e)">follower fsync</text>
<rect height="30" rx="3" stroke-dasharray="5 3" stroke-width="1.2" width="370" x="330" y="128" style="fill:var(--paper-2, #ebeee9);stroke:var(--ink-3, #7b8791)"></rect>
<text class="m" font-size="9.5" text-anchor="middle" x="515" y="147" style="fill:var(--ink-2, #4a5763)">bucket upload—off the response path</text>
<path d="M 330 118 L 330 168" fill="none" stroke-width="1.6" style="stroke:var(--cobalt, #2a56a0)"></path>
<circle cx="330" cy="143" r="4.5" style="fill:var(--cobalt, #2a56a0)"></circle>
<text class="m" font-size="10" font-weight="600" text-anchor="middle" x="330" y="111" style="fill:var(--cobalt, #2a56a0)">ack</text>
<text class="m" font-size="9" x="345" y="182" style="fill:var(--cobalt, #2a56a0)">v0.3.0 measured ≈10× lower write latency and 100× fewer Class A bucket operations</text>
<!-- time axis -->
<path d="M 200 206 L 840 206" fill="none" marker-end="url(#f1ba)" stroke-width="1.2" style="stroke:var(--ink-3, #7b8791)"></path>
<text class="m" font-size="9" x="200" y="222" style="fill:var(--ink-2, #4a5763)">time—not to scale</text>
<!-- notes -->
<rect height="56" rx="4" width="840" x="20" y="238" style="fill:var(--plate, #e6ebeb);stroke:var(--rule, #d3d9d4)"></rect>
<text class="m" font-size="9" x="36" y="258" style="fill:var(--ink-2, #4a5763)">the ensemble—the owner picks one or two followers, never itself, so three nodes hold three copies of an acknowledged write,</text>
<text class="m" font-size="9" x="36" y="271" style="fill:var(--ink-2, #4a5763)">and the ensemble keeps acknowledging while one follower remains</text>
<text class="m" font-size="9" x="36" y="287" style="fill:var(--cobalt, #2a56a0)">CELLD_DURABILITY=fleet is the default—a single-node fleet asks for the fleet posture, does not get it, and falls back to bucket proof</text>
</svg>
<figcaption>RPO=0 is earned differently by fleet size, and the whole difference is <em>where the acknowledgement falls</em>. The bucket is the long-term store in both modes; the fleet proof simply takes the upload off the response path.</figcaption>
</figure>

Four properties make this possible, and they are non-negotiable requirements on the store:

- **Conditional create**: creating an ownership record fails when the object already exists.
- **Conditional overwrite**: a compare-and-swap on the prior record fails when the object changed after the read.
- **Read-after-write consistency**: a read after a successful write returns that write.
- **Exact ranged reads**: a `Range` request returns precisely the requested bytes. A large cell is restored *page by page* through a fault-in SQLite VFS that reads each page from the bucket on first use, so a wrong range is a correctness failure, and the startup probe checks it.

| Store | Fleet-qualified? | Conditional-write path |
|----|----|----|
| Amazon S3 | Yes | `If-None-Match: *` / `If-Match` etag CAS |
| Cloudflare R2 | Yes | same headers; celld's release tests run here |
| Google Cloud Storage | Yes | XML API `x-goog-if-generation-match` |
| Tigris | Yes | documented conditional operations |
| Azure Blob Storage | Yes | `If-None-Match: *` / `If-Match` on Put Blob; qualified 2026-08-18 |
| MinIO (community) | Passes test, not qualified | conditional writes work on RELEASE·2025-09-07 or later (#162 pinned one broken release) |
| Backblaze B2 | No | — |
| Hetzner Object Storage | No | — |
| DigitalOcean Spaces | No | — |

> [!CAUTION] Caveat · storage probe
>
> No object store publishes whether it honors conditional writes, so celld asks. Each node runs a probe at startup: conditional writes that must succeed and fail in the right places, plus a ranged read that must return exactly the requested bytes. A clear contract violation (an unsupported operation, wrong bytes, an ignored condition) stops the node at once rather than risk a second owner for a cell. An ambiguous failure gets three attempts and then a warning, since a transient outage can clear. `celld diagnose` runs the same probe on demand, and `--read-only` skips it there. The startup probe cannot be disabled: a node with `CELLD_STORAGE_PROBE` set does not start.

A bucket value can carry a key prefix (`s3://bucket/team-a`), so two fleets can share one bucket. A value without a prefix keeps objects at the bucket root, so an existing fleet never moves its data. The bucket also holds the deployments (with container images under `deploy/images/`), node leases, the shared peer-authentication secret, the fleet capacity sample, the alarm wake entries, large KV values, and all R2 objects: **whoever holds the bucket credentials controls the fleet**.

## Ownership, leases, and fencing {#fencing}

celld makes two claims that a distributed system must actually prove: *one node owns a cell at a time*, and *a write is durable before it is acknowledged*. Both rest on the bucket and on epochs, not on clocks. The docs page [What celld guarantees](https://celld.dev/docs/guarantees) states the two promises up front and shows the mechanism.

### The ownership record and the epoch

Each cell has one **ownership record** in the bucket. It names the **owner** (the node session that may run the cell) and a fencing **epoch**. A node acquires a cell with a conditional write: create when no record exists, compare-and-swap when one does. The bucket accepts only one such write, so two nodes cannot acquire the same cell. Every activation advances the epoch: a takeover advances it, and a local wake advances it too. The replicator writes each cell's SQLite data under an epoch prefix, `cells/<cell>/ltx/e<epoch>/`.

<figure class="topology">
<svg aria-labelledby="f3-t f3-d" role="img" viewbox="0 0 880 386" xmlns="http://www.w3.org/2000/svg">
<title id="f3-t">A takeover, read as a sequence</title>
<desc id="f3-d">Three lanes over time. Node A owns chat-1 at epoch e1 and stops renewing its lease. Node B acquires the cell with one conditional write that advances the ownership record to epoch e2, then restores from the e2 lineage. When node A comes back it writes into the superseded e1 prefix, re-reads the ownership record, finds node B at e2, does not acknowledge the write, and self-fences with exit code 3.</desc>
<defs>
<marker id="f3a" markerheight="7" markerwidth="7" orient="auto-start-reverse" refx="9" refy="5" viewbox="0 0 10 10">
<path d="M 0 0 L 10 5 L 0 10 z" style="fill:var(--ink-3, #7b8791)"></path>
</marker>
<marker id="f3c" markerheight="7" markerwidth="7" orient="auto-start-reverse" refx="9" refy="5" viewbox="0 0 10 10">
<path d="M 0 0 L 10 5 L 0 10 z" style="fill:var(--cobalt, #2a56a0)"></path>
</marker>
</defs>
<!-- lane guides -->
<path d="M 126 76 L 866 76" fill="none" stroke-dasharray="2 4" stroke-width="1" style="stroke:var(--rule, #d3d9d4)"></path>
<path d="M 126 168 L 866 168" fill="none" stroke-dasharray="2 4" stroke-width="1" style="stroke:var(--rule, #d3d9d4)"></path>
<path d="M 126 256 L 866 256" fill="none" stroke-dasharray="2 4" stroke-width="1" style="stroke:var(--rule, #d3d9d4)"></path>
<text class="m" font-size="11" font-weight="600" text-anchor="end" x="110" y="70" style="fill:var(--ink, #1b252e)">node A</text>
<text class="f" font-size="12" text-anchor="end" x="110" y="87" style="fill:var(--ink-2, #4a5763)">the old owner</text>
<text class="m" font-size="11" font-weight="600" text-anchor="end" x="110" y="162" style="fill:var(--cobalt, #2a56a0)">the bucket</text>
<text class="f" font-size="12" text-anchor="end" x="110" y="179" style="fill:var(--ink-2, #4a5763)">the authority</text>
<text class="m" font-size="11" font-weight="600" text-anchor="end" x="110" y="250" style="fill:var(--ink, #1b252e)">node B</text>
<text class="f" font-size="12" text-anchor="end" x="110" y="267" style="fill:var(--ink-2, #4a5763)">the new owner</text>
<!-- lane A -->
<rect height="64" rx="4" stroke-width="1.2" width="160" x="136" y="44" style="fill:var(--plate, #e6ebeb);stroke:var(--ink-2, #4a5763)"></rect>
<text class="m" font-size="9.5" font-weight="600" text-anchor="middle" x="216" y="66" style="fill:var(--ink, #1b252e)">A owns chat-1</text>
<text class="m" font-size="9" text-anchor="middle" x="216" y="82" style="fill:var(--ink-2, #4a5763)">epoch e1 · lease held</text>
<text class="m" font-size="9" text-anchor="middle" x="216" y="96" style="fill:var(--ink-2, #4a5763)">renewed each ~3.3 s</text>
<rect height="64" rx="4" stroke-width="1.2" width="160" x="316" y="44" style="fill:var(--plate, #e6ebeb);stroke:var(--ink-2, #4a5763)"></rect>
<text class="m" font-size="9.5" font-weight="600" text-anchor="middle" x="396" y="66" style="fill:var(--ink, #1b252e)">A stops renewing</text>
<text class="m" font-size="9" text-anchor="middle" x="396" y="82" style="fill:var(--ink-2, #4a5763)">paused, or cut off</text>
<text class="m" font-size="9" text-anchor="middle" x="396" y="96" style="fill:var(--ink-2, #4a5763)">from the bucket</text>
<rect height="76" rx="4" stroke-width="1.4" width="222" x="640" y="36" style="fill:var(--plate, #e6ebeb);stroke:var(--cobalt, #2a56a0)"></rect>
<text class="m" font-size="9.5" font-weight="600" text-anchor="middle" x="751" y="58" style="fill:var(--cobalt, #2a56a0)">A comes back</text>
<text class="m" font-size="9" text-anchor="middle" x="751" y="74" style="fill:var(--ink-2, #4a5763)">PUT → cells/chat-1/ltx/e1/</text>
<text class="m" font-size="9" text-anchor="middle" x="751" y="88" style="fill:var(--ink-2, #4a5763)">re-reads the record → B · e2</text>
<text class="m" font-size="9" text-anchor="middle" x="751" y="102" style="fill:var(--cobalt, #2a56a0)">not acked → SELF-FENCE, exit 3</text>
<!-- lane bucket -->
<rect height="54" rx="4" stroke-dasharray="5 3" stroke-width="1.2" width="160" x="136" y="140" style="fill:var(--paper-2, #ebeee9);stroke:var(--ink-3, #7b8791)"></rect>
<text class="m" font-size="9" text-anchor="middle" x="216" y="162" style="fill:var(--ink-2, #4a5763)">chat-1 → node A · e1</text>
<text class="m" font-size="9" text-anchor="middle" x="216" y="180" style="fill:var(--ink-2, #4a5763)">superseded</text>
<path d="M 300 167 L 396 167" fill="none" marker-end="url(#f3a)" stroke-width="1.5" style="stroke:var(--ink-3, #7b8791)"></path>
<text class="m" font-size="9" text-anchor="middle" x="348" y="187" style="fill:var(--ink-2, #4a5763)">CAS · one winner</text>
<rect height="54" rx="4" stroke-width="1.5" width="170" x="400" y="140" style="fill:var(--paper-2, #ebeee9);stroke:var(--cobalt, #2a56a0)"></rect>
<text class="m" font-size="9" text-anchor="middle" x="485" y="162" style="fill:var(--cobalt, #2a56a0)">chat-1 → node B · e2</text>
<text class="m" font-size="9" text-anchor="middle" x="485" y="180" style="fill:var(--ink-2, #4a5763)">the live record</text>
<rect height="34" rx="3" stroke-dasharray="5 3" stroke-width="1.1" width="250" x="610" y="130" style="fill:var(--paper-2, #ebeee9);stroke:var(--ink-3, #7b8791)"></rect>
<text class="m" font-size="9" x="622" y="145" style="fill:var(--ink-2, #4a5763)">cells/chat-1/ltx/e1/</text>
<text class="m" font-size="8.5" x="622" y="158" style="fill:var(--ink-2, #4a5763)">superseded—a restore never reads it</text>
<rect height="34" rx="3" stroke-width="1.3" width="250" x="610" y="172" style="fill:var(--plate, #e6ebeb);stroke:var(--ink-2, #4a5763)"></rect>
<text class="m" font-size="9" x="622" y="187" style="fill:var(--ink, #1b252e)">cells/chat-1/ltx/e2/</text>
<text class="m" font-size="8.5" x="622" y="200" style="fill:var(--ink-2, #4a5763)">the live lineage</text>
<!-- lane B -->
<rect height="56" rx="4" stroke-width="1.2" width="158" x="406" y="228" style="fill:var(--plate, #e6ebeb);stroke:var(--ink-2, #4a5763)"></rect>
<text class="m" font-size="9.5" font-weight="600" text-anchor="middle" x="485" y="250" style="fill:var(--ink, #1b252e)">B acquires</text>
<text class="m" font-size="9" text-anchor="middle" x="485" y="266" style="fill:var(--ink-2, #4a5763)">conditional write</text>
<text class="m" font-size="9" text-anchor="middle" x="485" y="278" style="fill:var(--ink-2, #4a5763)">epoch e1 → e2</text>
<rect height="56" rx="4" stroke-width="1.2" width="170" x="596" y="228" style="fill:var(--plate, #e6ebeb);stroke:var(--ink-2, #4a5763)"></rect>
<text class="m" font-size="9.5" font-weight="600" text-anchor="middle" x="681" y="250" style="fill:var(--ink, #1b252e)">B restores</text>
<text class="m" font-size="9" text-anchor="middle" x="681" y="266" style="fill:var(--ink-2, #4a5763)">reads the e2 lineage</text>
<text class="m" font-size="9" text-anchor="middle" x="681" y="278" style="fill:var(--ink-2, #4a5763)">then serves chat-1</text>
<!-- cross-lane -->
<path d="M 485 226 L 485 198" fill="none" marker-end="url(#f3a)" stroke-width="1.4" style="stroke:var(--ink-3, #7b8791)"></path>
<path d="M 681 210 L 681 226" fill="none" marker-end="url(#f3a)" stroke-width="1.4" style="stroke:var(--ink-3, #7b8791)"></path>
<path d="M 700 114 L 700 128" fill="none" marker-end="url(#f3c)" stroke-dasharray="4 3" stroke-width="1.4" style="stroke:var(--cobalt, #2a56a0)"></path>
<path d="M 574 150 C 620 150, 618 78, 636 78" fill="none" marker-end="url(#f3c)" stroke-dasharray="4 3" stroke-width="1.4" style="stroke:var(--cobalt, #2a56a0)"></path>
<path d="M 126 302 L 866 302" fill="none" marker-end="url(#f3a)" stroke-width="1.1" style="stroke:var(--ink-3, #7b8791)"></path>
<text class="m" font-size="9" x="126" y="296" style="fill:var(--ink-2, #4a5763)">time</text>
<rect height="54" rx="4" stroke-width="1.2" width="852" x="14" y="320" style="fill:var(--plate, #e6ebeb);stroke:var(--cobalt, #2a56a0)"></rect>
<text class="m" font-size="10" text-anchor="middle" x="440" y="342" style="fill:var(--ink, #1b252e)">The epoch in the object key is the fence, so the data path needs no conditional writes at all.</text>
<text class="f" font-size="12.5" text-anchor="middle" x="440" y="362" style="fill:var(--ink-2, #4a5763)">Only the ownership record is a compare-and-swap; every LTX segment is a plain PUT under its own epoch prefix.</text>
</svg>
<figcaption>Fencing shown as a sequence rather than asserted as a property. The ownership record is the only compare-and-swap in the picture; the data path is plain PUTs, fenced by the epoch in the key. A node that cannot reach the bucket cannot renew its lease or replicate either, so it fences itself rather than serve state it can no longer prove.</figcaption>
</figure>

### The acknowledgement rule (RPO=0)

The **output gate** holds each write response until a durability proof covers it. After a *bucket proof*, celld re-reads the ownership record and acknowledges only if it still names this node at this epoch. A partitioned node can commit locally and replicate into its superseded prefix, but the ownership read reveals the new owner, so the write is not acknowledged. The check reads the record rather than comparing a clock, so a paused process or a skewed clock cannot pass it. A *fleet proof* requires every follower to fsync the write, and a takeover seals the prior node-log session before restoring, so the stale owner cannot complete another fleet proof. The output gate applies one ordering rule across responses, outbound calls, Queue deliveries, and WebSocket sends, and read-only output waits for earlier request or alarm writes to become durable.

### Self-fencing

Each node holds a **node lease** in the bucket with an expiry (`CELLD_TTL_MS`, default 10,000 ms), renewed after one third of the lifetime. A node that cannot reach the bucket cannot renew or replicate, so it must not own cells. When its published expiry passes it **fences itself**: it stops each active cell, fails incomplete requests, logs a line starting `SELF-FENCE:`, and exits with code 3. The fence names its cause with a distinct event:

- `node_lease_watchdog_fence`: the lease expired.
- `node_lease_record_missing_fence`: the record is gone.
- `node_lease_record_mismatch_fence`: another writer replaced it. The node cannot prove who, so it names no author.

A failed renewal retries before the authority expires. `RUST_LOG=celld=info,store=debug` logs every lease read and write with its outcome, at no cost when off. The fenced state is terminal; only a restart returns the node to the fleet. Two requirements follow:

- **Run under a supervisor** (systemd, Docker restart policy, Kubernetes) with no attempt limit, waiting at least one lease lifetime between attempts. A node that cannot acquire a lease at startup retries rather than exiting. A restarting node first recovers its previous session's log before it takes a lease. If a peer is already recovering that log, it waits behind the peer's heartbeat and takes over only when the heartbeat stops, which is what makes a whole-fleet restart recover every acknowledged write.
- **A request is refused before the fence runs.** celld compares the current time against the published expiry on every route, so a node with a lapsed lease refuses the request. The dispatch check keeps one owner per cell even while the fence is in flight.

<figure class="topology">
<svg aria-labelledby="f6-t f6-d" role="img" viewbox="0 0 880 418" xmlns="http://www.w3.org/2000/svg">
<title id="f6-t">Self-fencing, read as a sequence</title>
<desc id="f6-d">Three lanes over time. The node renews its lease in the bucket every 3.3 seconds, a third of the 10,000 millisecond CELLD_TTL_MS. When renewals stop landing, it retries before the expiry; once the published expiry passes, every route refuses requests. The node then fences itself: it stops each active cell, fails incomplete requests, logs SELF-FENCE, and exits with code 3, naming its cause with one of three events: node_lease_watchdog_fence when the lease expired, node_lease_record_missing_fence when the record is gone, and node_lease_record_mismatch_fence when another writer replaced it. A supervisor restarts the node after at least one lease lifetime; it recovers its previous log before taking a new lease.</desc>
<defs>
<marker id="f6a" markerheight="7" markerwidth="7" orient="auto-start-reverse" refx="9" refy="5" viewbox="0 0 10 10">
<path d="M 0 0 L 10 5 L 0 10 z" style="fill:var(--ink-3, #7b8791)"></path>
</marker>
<marker id="f6c" markerheight="7" markerwidth="7" orient="auto-start-reverse" refx="9" refy="5" viewbox="0 0 10 10">
<path d="M 0 0 L 10 5 L 0 10 z" style="fill:var(--cobalt, #2a56a0)"></path>
</marker>
</defs>
<!-- phase headers -->
<text class="m" font-size="8.5" font-weight="600" text-anchor="middle" x="211" y="26" letter-spacing="1.2" style="fill:var(--ink-3, #7b8791)">HEALTHY</text>
<text class="m" font-size="8.5" font-weight="600" text-anchor="middle" x="381" y="26" letter-spacing="1.2" style="fill:var(--ink-3, #7b8791)">LEASE LAPSES</text>
<text class="m" font-size="8.5" font-weight="600" text-anchor="middle" x="576" y="26" letter-spacing="1.2" style="fill:var(--ink-3, #7b8791)">FENCE</text>
<text class="m" font-size="8.5" font-weight="600" text-anchor="middle" x="779" y="26" letter-spacing="1.2" style="fill:var(--ink-3, #7b8791)">RESTART</text>
<!-- lane guides -->
<path d="M 126 76 L 866 76" fill="none" stroke-dasharray="2 4" stroke-width="1" style="stroke:var(--rule, #d3d9d4)"></path>
<path d="M 126 188 L 866 188" fill="none" stroke-dasharray="2 4" stroke-width="1" style="stroke:var(--rule, #d3d9d4)"></path>
<path d="M 126 290 L 866 290" fill="none" stroke-dasharray="2 4" stroke-width="1" style="stroke:var(--rule, #d3d9d4)"></path>
<text class="m" font-size="11" font-weight="600" text-anchor="end" x="110" y="70" style="fill:var(--ink, #1b252e)">the node</text>
<text class="f" font-size="12" text-anchor="end" x="110" y="87" style="fill:var(--ink-2, #4a5763)">the leaseholder</text>
<text class="m" font-size="11" font-weight="600" text-anchor="end" x="110" y="182" style="fill:var(--cobalt, #2a56a0)">the bucket</text>
<text class="f" font-size="12" text-anchor="end" x="110" y="199" style="fill:var(--ink-2, #4a5763)">the lease record</text>
<text class="m" font-size="11" font-weight="600" text-anchor="end" x="110" y="284" style="fill:var(--ink, #1b252e)">requests</text>
<text class="f" font-size="12" text-anchor="end" x="110" y="301" style="fill:var(--ink-2, #4a5763)">every route</text>
<!-- node lane -->
<rect height="72" rx="4" stroke-width="1.2" width="150" x="136" y="40" style="fill:var(--plate, #e6ebeb);stroke:var(--ink-2, #4a5763)"></rect>
<text class="m" font-size="9.5" font-weight="600" text-anchor="middle" x="211" y="64.5" style="fill:var(--ink, #1b252e)">renews its lease</text>
<text class="m" font-size="9" text-anchor="middle" x="211" y="79.5" style="fill:var(--ink-2, #4a5763)">every ~3.3 s, a third</text>
<text class="m" font-size="9" text-anchor="middle" x="211" y="94.5" style="fill:var(--ink-2, #4a5763)">of CELLD_TTL_MS</text>
<rect height="72" rx="4" stroke-width="1.2" width="150" x="306" y="40" style="fill:var(--plate, #e6ebeb);stroke:var(--ink-2, #4a5763)"></rect>
<text class="m" font-size="9.5" font-weight="600" text-anchor="middle" x="381" y="64.5" style="fill:var(--ink, #1b252e)">renewal fails</text>
<text class="m" font-size="9" text-anchor="middle" x="381" y="79.5" style="fill:var(--ink-2, #4a5763)">bucket unreachable</text>
<text class="m" font-size="9" text-anchor="middle" x="381" y="94.5" style="fill:var(--ink-2, #4a5763)">retries before expiry</text>
<rect height="80" rx="4" stroke-width="1.5" width="200" x="476" y="36" style="fill:var(--plate, #e6ebeb);stroke:var(--cobalt, #2a56a0)"></rect>
<text class="m" font-size="9.5" font-weight="600" text-anchor="middle" x="576" y="58.5" style="fill:var(--cobalt, #2a56a0)">fences itself</text>
<text class="m" font-size="9" text-anchor="middle" x="576" y="72.5" style="fill:var(--ink-2, #4a5763)">stops each active cell</text>
<text class="m" font-size="9" text-anchor="middle" x="576" y="86.5" style="fill:var(--ink-2, #4a5763)">fails incomplete requests</text>
<text class="m" font-size="9" text-anchor="middle" x="576" y="100.5" style="fill:var(--ink-2, #4a5763)">logs SELF-FENCE: · exit 3</text>
<rect height="72" rx="4" stroke-width="1.2" width="166" x="696" y="40" style="fill:var(--plate, #e6ebeb);stroke:var(--ink-2, #4a5763)"></rect>
<text class="m" font-size="9.5" font-weight="600" text-anchor="middle" x="779" y="58.5" style="fill:var(--ink, #1b252e)">restarts</text>
<text class="m" font-size="9" text-anchor="middle" x="779" y="72.5" style="fill:var(--ink-2, #4a5763)">supervisor, no attempt cap</text>
<text class="m" font-size="9" text-anchor="middle" x="779" y="86.5" style="fill:var(--ink-2, #4a5763)">waits ≥ one lease lifetime</text>
<text class="m" font-size="9" text-anchor="middle" x="779" y="100.5" style="fill:var(--ink-2, #4a5763)">recovers its log first</text>
<path d="M 290 76 L 302 76" fill="none" marker-end="url(#f6a)" stroke-width="1.4" style="stroke:var(--ink-3, #7b8791)"></path>
<path d="M 460 76 L 472 76" fill="none" marker-end="url(#f6a)" stroke-width="1.4" style="stroke:var(--ink-3, #7b8791)"></path>
<path d="M 680 76 L 692 76" fill="none" marker-end="url(#f6a)" stroke-width="1.4" style="stroke:var(--ink-3, #7b8791)"></path>
<!-- bucket lane -->
<rect height="56" rx="4" stroke-width="1.5" width="150" x="136" y="160" style="fill:var(--paper-2, #ebeee9);stroke:var(--cobalt, #2a56a0)"></rect>
<text class="m" font-size="9" font-weight="600" text-anchor="middle" x="211" y="176.5" style="fill:var(--cobalt, #2a56a0)">lease record</text>
<text class="m" font-size="9" text-anchor="middle" x="211" y="191.5" style="fill:var(--ink-2, #4a5763)">expiry published</text>
<text class="m" font-size="9" text-anchor="middle" x="211" y="206.5" style="fill:var(--ink-2, #4a5763)">TTL 10,000 ms</text>
<rect height="56" rx="4" stroke-dasharray="5 3" stroke-width="1.2" width="150" x="306" y="160" style="fill:var(--paper-2, #ebeee9);stroke:var(--ink-3, #7b8791)"></rect>
<text class="m" font-size="9" font-weight="600" text-anchor="middle" x="381" y="176.5" style="fill:var(--ink, #1b252e)">no renewal lands</text>
<text class="m" font-size="9" text-anchor="middle" x="381" y="191.5" style="fill:var(--ink-2, #4a5763)">the published</text>
<text class="m" font-size="9" text-anchor="middle" x="381" y="206.5" style="fill:var(--ink-2, #4a5763)">expiry passes</text>
<path d="M 211 116 L 211 156" fill="none" marker-start="url(#f6a)" marker-end="url(#f6a)" stroke-width="1.4" style="stroke:var(--ink-3, #7b8791)"></path>
<text class="m" font-size="9" x="218" y="140" style="fill:var(--ink-2, #4a5763)">renew</text>
<rect height="32" rx="3" stroke-width="1.2" width="200" x="476" y="132" style="fill:var(--paper-2, #ebeee9);stroke:var(--cobalt, #2a56a0)"></rect>
<text class="m" font-size="9" text-anchor="middle" x="576" y="145" style="fill:var(--ink-2, #4a5763)">the lease expired</text>
<text class="m" font-size="8.5" text-anchor="middle" x="576" y="158" style="fill:var(--cobalt, #2a56a0)">node_lease_watchdog_fence</text>
<rect height="32" rx="3" stroke-width="1.2" width="200" x="476" y="170" style="fill:var(--paper-2, #ebeee9);stroke:var(--cobalt, #2a56a0)"></rect>
<text class="m" font-size="9" text-anchor="middle" x="576" y="183" style="fill:var(--ink-2, #4a5763)">the record is gone</text>
<text class="m" font-size="8.5" text-anchor="middle" x="576" y="196" style="fill:var(--cobalt, #2a56a0)">node_lease_record_missing_fence</text>
<rect height="32" rx="3" stroke-width="1.2" width="200" x="476" y="208" style="fill:var(--paper-2, #ebeee9);stroke:var(--cobalt, #2a56a0)"></rect>
<text class="m" font-size="9" text-anchor="middle" x="576" y="221" style="fill:var(--ink-2, #4a5763)">another writer replaced it</text>
<text class="m" font-size="8.5" text-anchor="middle" x="576" y="234" style="fill:var(--cobalt, #2a56a0)">node_lease_record_mismatch_fence</text>
<path d="M 576 130 L 576 120" fill="none" marker-end="url(#f6c)" stroke-width="1.4" style="stroke:var(--cobalt, #2a56a0)"></path>
<text class="m" font-size="9" x="692" y="160" style="fill:var(--ink-2, #4a5763)">the fence names</text>
<text class="m" font-size="9" x="692" y="174" style="fill:var(--ink-2, #4a5763)">its cause with</text>
<text class="m" font-size="9" x="692" y="188" style="fill:var(--ink-2, #4a5763)">exactly one event</text>
<text class="m" font-size="9" x="692" y="208" style="fill:var(--ink-3, #7b8791)">a mismatch names</text>
<text class="m" font-size="9" x="692" y="222" style="fill:var(--ink-3, #7b8791)">no author: it cannot</text>
<text class="m" font-size="9" x="692" y="236" style="fill:var(--ink-3, #7b8791)">prove who wrote it</text>
<!-- requests lane -->
<rect height="56" rx="4" stroke-width="1.2" width="150" x="136" y="262" style="fill:var(--plate, #e6ebeb);stroke:var(--ink-2, #4a5763)"></rect>
<text class="m" font-size="9.5" font-weight="600" text-anchor="middle" x="211" y="278.5" style="fill:var(--ink, #1b252e)">served</text>
<text class="m" font-size="9" text-anchor="middle" x="211" y="293.5" style="fill:var(--ink-2, #4a5763)">the route checks the</text>
<text class="m" font-size="9" text-anchor="middle" x="211" y="308.5" style="fill:var(--ink-2, #4a5763)">expiry: still ahead</text>
<rect height="56" rx="4" stroke-width="1.5" width="150" x="306" y="262" style="fill:var(--paper-2, #ebeee9);stroke:var(--cobalt, #2a56a0)"></rect>
<text class="m" font-size="9.5" font-weight="600" text-anchor="middle" x="381" y="278.5" style="fill:var(--cobalt, #2a56a0)">refused</text>
<text class="m" font-size="9" text-anchor="middle" x="381" y="293.5" style="fill:var(--ink-2, #4a5763)">expiry has passed</text>
<text class="m" font-size="9" text-anchor="middle" x="381" y="308.5" style="fill:var(--ink-2, #4a5763)">before the fence runs</text>
<rect height="56" rx="4" stroke-dasharray="5 3" stroke-width="1.2" width="166" x="696" y="262" style="fill:var(--paper-2, #ebeee9);stroke:var(--ink-3, #7b8791)"></rect>
<text class="m" font-size="9.5" font-weight="600" text-anchor="middle" x="779" y="278.5" style="fill:var(--ink, #1b252e)">back in the fleet</text>
<text class="m" font-size="9" text-anchor="middle" x="779" y="293.5" style="fill:var(--ink-2, #4a5763)">only after a restart</text>
<text class="m" font-size="9" text-anchor="middle" x="779" y="308.5" style="fill:var(--ink-2, #4a5763)">and a new lease</text>
<path d="M 211 218 L 211 258" fill="none" marker-end="url(#f6a)" stroke-width="1.4" style="stroke:var(--ink-3, #7b8791)"></path>
<path d="M 381 218 L 381 258" fill="none" marker-end="url(#f6c)" stroke-width="1.4" style="stroke:var(--cobalt, #2a56a0)"></path>
<path d="M 126 338 L 866 338" fill="none" marker-end="url(#f6a)" stroke-width="1.1" style="stroke:var(--ink-3, #7b8791)"></path>
<text class="m" font-size="9" x="126" y="332" style="fill:var(--ink-2, #4a5763)">time</text>
<rect height="54" rx="4" stroke-width="1.2" width="852" x="14" y="352" style="fill:var(--plate, #e6ebeb);stroke:var(--cobalt, #2a56a0)"></rect>
<text class="m" font-size="10" text-anchor="middle" x="440" y="374" style="fill:var(--ink, #1b252e)">A node that cannot prove its lease stops serving: first each request, then the whole process.</text>
<text class="f" font-size="12.5" text-anchor="middle" x="440" y="394" style="fill:var(--ink-2, #4a5763)">The fenced state is terminal; only a supervisor restart, at least one lease lifetime later, brings it back.</text>
</svg>
<figcaption>Self-fencing shown as a sequence. Requests are refused the moment the published expiry passes, before the fence itself runs, so a node never serves a cell it can no longer prove it owns. The fence then ends the process with exit code 3 and one of three events that name its cause. Because the fenced state is terminal, run celld under a supervisor with no attempt limit.</figcaption>
</figure>


> [!NOTE] Why read the record, not the clock
>
> The ownership check reads the record instead of comparing timestamps, and the takeover recovery gate checks the prior owner's node-log records before reading the bucket. These paths are what let celld make RPO=0 true under pause, skew, and split-brain, and they are the exact arguments the TLA+ model checks (see § 08).

### Remote calls and retries

Every proxied cell call (fetch, RPC, and WebSocket) runs through one versioned peer tunnel that streams the request body to the owner. The consequence for application code: **celld does not retry a call after transmission begins**, because it keeps no replay copy of the body. It retries only a peer attempt that proves the handler did not start; an ambiguous attempt (the handler may have completed without returning) is not retried. A stale route, a call that resolves an owner generation a replacement process now rejects, is handled underneath: celld waits for a different (node, epoch), refreshes the route, and re-attempts within `CELLD_OPERATION_DEADLINE_MS`. Keep one stable operation ID when you retry an ambiguous fetch, RPC, D1, or service operation, and make operations idempotent at the application layer. An `AbortSignal` passes through an RPC call on the same node; it does not cross a node boundary.

## Running a fleet {#running-fleet}

### Install and storage configuration

The installer downloads a signed binary. Replication runs in the celld process, so no external replicator is needed. Pin exact releases with `CELLD_VERSION` and verify build attestations with `gh attestation verify`. The immutable releases sit behind a single `current` pointer, which makes a previous SHA the rollback; there is no automatic update agent. Prebuilt binaries cover Linux x86-64, Linux ARM64, and Apple Silicon; Windows is not supported. On Amazon EKS, celld reads Pod Identity credentials from the injected environment and token file.

```bash
# one-time install (pin a release with CELLD_VERSION)
curl -fsSL https://celld.dev/install.sh | sh

# Cloudflare R2 bucket — the standard AWS credential chain works
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_REGION=auto
export S3_ENDPOINT=https://ACCOUNT_ID.r2.cloudflarestorage.com
export CELLD_BUCKET=s3://cells
```

Three storage families, one environment contract:

- **S3-compatible** (`s3://`): standard AWS chain; R2 via the S3 endpoint above; EKS Pod Identity supported.
- **Google Cloud Storage** (`gs://`): Application Default Credentials or a `GOOGLE_APPLICATION_CREDENTIALS` service-account key; no AWS variables, region ignored.
- **Azure Blob** (`az://`): exactly one credential family, which is an account key, VM managed identity, or AKS workload identity; the bucket name is the container.

### Develop locally with `celld dev`

`celld dev` opens a **local store** (a local SQLite object store), deploys the application, and starts one node, with no Docker and no cloud bucket:

```bash
cd ./my-wrangler-project
celld dev              # Worker listener on http://127.0.0.1:9876 by default
celld dev --port 3000  # pick the port
celld dev --host 0.0.0.0  # expose the Worker listener (internal stays loopback)
celld dev --logs       # show the node's info/warning logs too
celld dev --clean      # discard .celld/dev first
celld dev --watch-ignore "docs/**"   # extra watcher ignores (repeatable)
celld dev --no-watch   # no automatic builds or restarts
```

State lives in `.celld/dev` under the project (add `.celld/` to `.gitignore`), survives normal shutdown, and resets with `--clean`. The command watches the project and adopts a rebuilt deployment automatically; a failed build leaves the current app serving. The watcher ignores `.celld`, `.wrangler`, `.git`, `node_modules`, `target`, and any `--watch-ignore` globs, and a read is not a change. `--no-watch` turns automatic builds and restarts off entirely and cannot be combined with `--watch-ignore`. `celld dev` also reads a `.dev.vars` file beside the Wrangler config, as `wrangler dev` does: `NAME=value` lines, quotes stripped, overriding same-named `vars`, reloaded on edit, and never shipped to a fleet. Worker projects need esbuild on `PATH`; asset-only and `no_bundle` projects do not. The local store is not selectable by fleet nodes or operator subcommands. Fleets require a qualified cloud bucket.

### Deploy an application

`celld deploy` runs from a Wrangler project and accepts module Workers, Durable Object bindings, static assets, service bindings, D1 databases, KV namespaces, Queues, R2 buckets, Workflows, WebAssembly modules, cron triggers, `worker_loaders`, and `containers`. It stops with a named error on any Wrangler key it does not model. esbuild on `PATH` is needed only for projects with Worker code. Two properties of the deploy itself protect the fleet from a bad build. The manifest records a full SHA-256 digest for every JavaScript and WebAssembly module, and a node verifies each one before it builds the deployment, so changed bytes cannot become active. A prebuilt project (`no_bundle: true`) has its entry JavaScript preserved byte-for-byte, and celld discovers `**/*.wasm` modules below the entry's directory using Wrangler's default patterns (symlinks refused, no `rules`/`find_additional_modules`).

<figure class="topology">
<svg aria-labelledby="f4-t f4-d" role="img" viewbox="0 0 880 348" xmlns="http://www.w3.org/2000/svg">
<title id="f4-t">Deploy, then adoption in place</title>
<desc id="f4-d">A Wrangler project is bundled with esbuild and pushed by celld deploy into the fleet bucket. Each node polls deploy slash current.json every thirty seconds, builds the new deployment beside the one it is serving, and switches new requests to it in one step without restarting; a request already in flight finishes on the previous deployment, and a Durable Object moves at a safe point.</desc>
<defs>
<marker id="f4a" markerheight="7" markerwidth="7" orient="auto-start-reverse" refx="9" refy="5" viewbox="0 0 10 10">
<path d="M 0 0 L 10 5 L 0 10 z" style="fill:var(--ink-3, #7b8791)"></path>
</marker>
</defs>
<rect height="56" rx="4" stroke-width="1.2" width="180" x="20" y="26" style="fill:var(--plate, #e6ebeb);stroke:var(--ink-2, #4a5763)"></rect>
<text class="m" font-size="10" font-weight="600" text-anchor="middle" x="110" y="48" style="fill:var(--ink, #1b252e)">Wrangler project</text>
<text class="m" font-size="9" text-anchor="middle" x="110" y="64" style="fill:var(--ink-2, #4a5763)">wrangler.jsonc · src/</text>
<text class="m" font-size="9" text-anchor="middle" x="110" y="75" style="fill:var(--ink-2, #4a5763)">migrations/ · assets/</text>
<rect height="56" rx="4" stroke-width="1.2" width="180" x="235" y="26" style="fill:var(--plate, #e6ebeb);stroke:var(--ink-2, #4a5763)"></rect>
<text class="m" font-size="10" font-weight="600" text-anchor="middle" x="325" y="48" style="fill:var(--ink, #1b252e)">esbuild bundle</text>
<text class="m" font-size="9" text-anchor="middle" x="325" y="64" style="fill:var(--ink-2, #4a5763)">only if the project</text>
<text class="m" font-size="9" text-anchor="middle" x="325" y="75" style="fill:var(--ink-2, #4a5763)">has Worker code</text>
<rect height="56" rx="4" stroke-width="1.2" width="180" x="450" y="26" style="fill:var(--plate, #e6ebeb);stroke:var(--ink-2, #4a5763)"></rect>
<text class="m" font-size="10" font-weight="600" text-anchor="middle" x="540" y="48" style="fill:var(--ink, #1b252e)">celld deploy</text>
<text class="m" font-size="9" text-anchor="middle" x="540" y="64" style="fill:var(--ink-2, #4a5763)">signed with the</text>
<text class="m" font-size="9" text-anchor="middle" x="540" y="75" style="fill:var(--ink-2, #4a5763)">fleet secret</text>
<rect height="56" rx="4" stroke-width="1.5" width="180" x="665" y="26" style="fill:var(--paper-2, #ebeee9);stroke:var(--cobalt, #2a56a0)"></rect>
<text class="m" font-size="10" font-weight="600" text-anchor="middle" x="755" y="48" style="fill:var(--cobalt, #2a56a0)">fleet bucket</text>
<text class="m" font-size="9" text-anchor="middle" x="755" y="64" style="fill:var(--ink-2, #4a5763)">deploy/current.json</text>
<text class="m" font-size="9" text-anchor="middle" x="755" y="75" style="fill:var(--ink-2, #4a5763)">+ deploy-blobs/</text>
<path d="M 204 54 L 231 54" fill="none" marker-end="url(#f4a)" stroke-width="1.5" style="stroke:var(--ink-3, #7b8791)"></path>
<path d="M 419 54 L 446 54" fill="none" marker-end="url(#f4a)" stroke-width="1.5" style="stroke:var(--ink-3, #7b8791)"></path>
<path d="M 634 54 L 661 54" fill="none" marker-end="url(#f4a)" stroke-width="1.5" style="stroke:var(--ink-3, #7b8791)"></path>
<path d="M 755 84 L 755 126" fill="none" marker-end="url(#f4a)" stroke-width="1.5" style="stroke:var(--ink-3, #7b8791)"></path>
<text class="m" font-size="9" x="765" y="110" style="fill:var(--ink-2, #4a5763)">polled, not pushed</text>
<rect height="182" rx="5" stroke-width="1.5" width="840" x="20" y="130" style="fill:var(--plate, #e6ebeb);stroke:var(--ink-2, #4a5763)"></rect>
<text class="m" font-size="11" font-weight="600" x="40" y="155" style="fill:var(--ink, #1b252e)">EACH FLEET NODE—adoption in place, no restart</text>
<text class="m" font-size="9" x="40" y="173" style="fill:var(--ink-2, #4a5763)">reads deploy/current.json every CELLD_DEPLOY_POLL_S (30 s) · POST /reload on the internal listener adopts immediately</text>
<rect height="76" rx="4" stroke-width="1.2" width="300" x="60" y="190" style="fill:var(--paper-2, #ebeee9);stroke:var(--ink-3, #7b8791)"></rect>
<text class="m" font-size="9.5" text-anchor="middle" x="210" y="214" style="fill:var(--ink-2, #4a5763)">deployment N—serving</text>
<text class="m" font-size="9" text-anchor="middle" x="210" y="232" style="fill:var(--ink-2, #4a5763)">a request that already started</text>
<text class="m" font-size="9" text-anchor="middle" x="210" y="245" style="fill:var(--ink-2, #4a5763)">finishes here</text>
<rect height="76" rx="4" stroke-width="1.4" width="300" x="440" y="190" style="fill:var(--paper-2, #ebeee9);stroke:var(--cobalt, #2a56a0)"></rect>
<text class="m" font-size="9.5" text-anchor="middle" x="590" y="214" style="fill:var(--cobalt, #2a56a0)">deployment N+1—built beside it</text>
<text class="m" font-size="9" text-anchor="middle" x="590" y="232" style="fill:var(--ink-2, #4a5763)">new requests switch to it</text>
<text class="m" font-size="9" text-anchor="middle" x="590" y="245" style="fill:var(--ink-2, #4a5763)">in one step</text>
<path d="M 364 228 L 436 228" fill="none" marker-end="url(#f4a)" stroke-width="1.5" style="stroke:var(--ink-3, #7b8791)"></path>
<text class="m" font-size="9" text-anchor="middle" x="400" y="218" style="fill:var(--ink-2, #4a5763)">switch</text>
<text class="m" font-size="9.5" text-anchor="middle" x="440" y="288" style="fill:var(--ink-2, #4a5763)">a Durable Object moves at a safe point—no in-flight request, alarm, pending durability, or regular WebSocket</text>
<text class="m" font-size="9" text-anchor="middle" x="440" y="302" style="fill:var(--ink-2, #4a5763)">it keeps its storage, its epoch, and its hibernatable sockets · in the adoption window the two deployments must accept each other's calls</text>
<text class="m" font-size="9.5" text-anchor="middle" x="440" y="334" style="fill:var(--cobalt, #2a56a0)">no safe point within CELLD_DEPLOY_MAX_AGE_S (60 s) → the move is forced, with WebSocket code 1012, matching Cloudflare</text>
</svg>
<figcaption>Deployment is a push to the bucket and a pull by every node; no control plane tells nodes to reload. A node adopts the pulled deployment in place, without a restart.</figcaption>
</figure>

A running node adopts a new deployment in place. It reads `deploy/current.json` every 30 seconds (`CELLD_DEPLOY_POLL_S`), builds the new deployment beside the one it serves, then switches new requests to it in one step; a request started on the previous deployment finishes on it. `POST /reload` on the internal listener adopts immediately. A Durable Object that is not resident runs the new deployment at its next activation; a resident one moves at a safe point. In the adoption window a request on one deployment can call a Durable Object on the other, so adjacent versions must accept each other's calls.

### Start nodes and grow the fleet

Local development needs only the default listener. A fleet node binds two listeners: a public Worker listener for ingress and an internal listener for the peer protocol and operator API. An explicit advertised address requires an explicit internal-listener address. celld also rejects an explicit non-loopback public listener without an internal one; this rule catches a stale single-listener configuration.

```bash
celld \
  --bucket "$CELLD_BUCKET" \
  --listen 0.0.0.0:8080 \
  --internal-listen 10.0.0.12:8081 \
  --advertise node-a.internal:8081
```

To add a node, point it at the same bucket with a distinct internal address. **There is no join command and no fixed membership list**: nodes find each other through the leases in the bucket. The bucket supplies discovery and authority; it does not supply network reachability. The peer tunnel carries versioned plain HTTP for cell fetch and RPC traffic, with no content signature, so the private network is the security boundary; the fleet HMAC authenticates tunnel establishment and control requests. celld does not terminate TLS. Put the advertised addresses on a private network or an encrypted overlay such as WireGuard or Tailscale, and never expose the internal listener.

### Ownership balancing

A joining node takes hibernated cells from the nodes holding the most, so it carries its share within minutes, and the fleet evens out again after a node leaves. The mechanism keeps the no-coordinator posture. Every node reads a shared fleet capacity sample every 5 s (`CELLD_REBALANCE_INTERVAL_MS`; `0` disables). One node claims the refresh with a conditional write, reads every lease, and writes `fleet/capacity-v1.json`, so the cost does not grow with the square of the fleet. Each node's target is the fleet's owned cells divided by weight (`CELLD_PLACEMENT_WEIGHT`, default the CPU count). The node with the most owned cells per unit weight hands at most 32 hibernated cells per sample to the peer furthest below its share, one ownership-record write and one signed acquire each, and the receiver fills to 2% below target.

Only hibernated cells move. A resident cell hibernates through idle eviction first (`CELLD_IDLE_EVICT_S`), so a fleet without idle eviction balances only the cells that hibernate on their own. A moved cell's parked WebSockets close with code 1012. A draining node, or one with an activation backlog, receives nothing. The fleet moves nothing while any lease lacks a weight, so a rolling upgrade completes before the first move. `POST /rebalance/pause` and `/resume` on any internal listener govern the whole fleet.

### Graceful shutdown and upgrades

SIGTERM/SIGINT (what `systemctl stop`, `docker stop`, and a Kubernetes pod delete send) triggers a graceful drain: `/.well-known/celld/health` reports unhealthy, new public requests get a 503, and the node hands resident cells to peers. The handoff is batched and heavily engineered. For each batch the node:

1. reserves a batch of cells, ordered by local request count with the newest request ID breaking ties;
2. stops new local routes;
3. cancels firing alarms, arming a durable wake so the successor runs them at least once, and cancels any active internal fetch/RPC handler;
4. proves the batch durable in the live ensemble;
5. publishes a full L9 snapshot and verifies the bucket holds a restore object, so the successor skips replay (a database too large for the 10 s durability budget, roughly 80 MiB, skips the snapshot and hands off through its L0 chain);
6. releases ownership and asks a compatible peer to acquire, waiting for each acknowledgement before the next batch.

One variable bounds the whole stop. `CELLD_SHUTDOWN_TOTAL_MS` (default 40,000) derives the fleet drain-token wait (3/4 of it, 30 s) and the no-progress bound (5/8, 25 s). `CELLD_RELEASES` sets the number of concurrent handoffs (default 128). A fresh process holds its first healthy response until the fleet is settled (`CELLD_READY_FLEET_GATE_MS`, default 120,000). If the gate expires, the node emits a `ready_gate_expired` event once and **keeps readiness closed** until the condition clears, so give the orchestrator a rollout deadline that fails a persistent capacity problem.

<figure class="topology">
<svg aria-labelledby="f7-t f7-d" role="img" viewbox="0 0 880 500" xmlns="http://www.w3.org/2000/svg">
<title id="f7-t">Graceful shutdown, batch by batch</title>
<desc id="f7-d">SIGTERM or SIGINT starts a drain: the health endpoint reports unhealthy, new public requests get a 503, and resident cells are handed to peers in batches, up to 128 handoffs at once. For each batch the node reserves cells by local request count, stops new local routes, cancels firing alarms behind a durable wake and cancels active internal fetch and RPC handlers, proves the batch durable in the live ensemble, publishes an L9 snapshot and verifies the restore object, then releases ownership to a compatible peer and waits for each acknowledgement before the next batch. CELLD_SHUTDOWN_TOTAL_MS, 40 seconds by default, bounds the stop and derives a 30 second drain-token wait and a 25 second no-progress bound. An orchestrator grace shorter than these bounds, such as a 30 second one, ends in SIGKILL before the handoff finishes.</desc>
<defs>
<marker id="f7a" markerheight="7" markerwidth="7" orient="auto-start-reverse" refx="9" refy="5" viewbox="0 0 10 10">
<path d="M 0 0 L 10 5 L 0 10 z" style="fill:var(--ink-3, #7b8791)"></path>
</marker>
<marker id="f7c" markerheight="7" markerwidth="7" orient="auto-start-reverse" refx="9" refy="5" viewbox="0 0 10 10">
<path d="M 0 0 L 10 5 L 0 10 z" style="fill:var(--cobalt, #2a56a0)"></path>
</marker>
</defs>
<!-- trigger -->
<rect height="60" rx="4" stroke-width="1.5" width="190" x="24" y="18" style="fill:var(--paper-2, #ebeee9);stroke:var(--cobalt, #2a56a0)"></rect>
<text class="m" font-size="9.5" font-weight="600" text-anchor="middle" x="119" y="37.5" style="fill:var(--cobalt, #2a56a0)">SIGTERM / SIGINT</text>
<text class="m" font-size="9" text-anchor="middle" x="119" y="51.5" style="fill:var(--ink-2, #4a5763)">systemctl stop · docker stop</text>
<text class="m" font-size="9" text-anchor="middle" x="119" y="65.5" style="fill:var(--ink-2, #4a5763)">Kubernetes pod delete</text>
<rect height="60" rx="4" stroke-width="1.2" width="408" x="244" y="18" style="fill:var(--plate, #e6ebeb);stroke:var(--ink-2, #4a5763)"></rect>
<text class="m" font-size="9.5" font-weight="600" text-anchor="middle" x="448" y="37.5" style="fill:var(--ink, #1b252e)">the node drains</text>
<text class="m" font-size="9" text-anchor="middle" x="448" y="51.5" style="fill:var(--ink-2, #4a5763)">/.well-known/celld/health → unhealthy · new public requests → 503</text>
<text class="m" font-size="9" text-anchor="middle" x="448" y="65.5" style="fill:var(--ink-2, #4a5763)">resident cells hand off to peers, one batch at a time</text>
<rect height="60" rx="4" stroke-width="1.2" width="194" x="668" y="18" style="fill:var(--paper-2, #ebeee9);stroke:var(--ink-3, #7b8791)"></rect>
<text class="m" font-size="9.5" font-weight="600" text-anchor="middle" x="765" y="44" style="fill:var(--ink, #1b252e)">CELLD_RELEASES = 128</text>
<text class="m" font-size="9" text-anchor="middle" x="765" y="59" style="fill:var(--ink-2, #4a5763)">handoffs in flight at once</text>
<path d="M 218 48 L 240 48" fill="none" marker-end="url(#f7a)" stroke-width="1.4" style="stroke:var(--ink-3, #7b8791)"></path>
<path d="M 448 80 L 448 96" fill="none" marker-end="url(#f7a)" stroke-width="1.4" style="stroke:var(--ink-3, #7b8791)"></path>
<!-- the batch loop -->
<rect height="200" rx="5" stroke-width="1.2" width="652" x="8" y="98" style="fill:var(--paper-2, #ebeee9);stroke:var(--ink-3, #7b8791)"></rect>
<text class="m" font-size="9" font-weight="600" x="44" y="113" letter-spacing="1.2" style="fill:var(--ink, #1b252e)">FOR EACH BATCH</text>
<rect height="64" rx="4" stroke-width="1.2" width="186" x="44" y="120" style="fill:var(--plate, #e6ebeb);stroke:var(--ink-2, #4a5763)"></rect>
<text class="m" font-size="9.5" font-weight="600" text-anchor="middle" x="137" y="141.5" style="fill:var(--ink, #1b252e)">1 · reserve a batch</text>
<text class="m" font-size="9" text-anchor="middle" x="137" y="155.5" style="fill:var(--ink-2, #4a5763)">ordered by local request count</text>
<text class="m" font-size="9" text-anchor="middle" x="137" y="169.5" style="fill:var(--ink-2, #4a5763)">newest request ID breaks ties</text>
<rect height="64" rx="4" stroke-width="1.2" width="186" x="250" y="120" style="fill:var(--plate, #e6ebeb);stroke:var(--ink-2, #4a5763)"></rect>
<text class="m" font-size="9.5" font-weight="600" text-anchor="middle" x="343" y="141.5" style="fill:var(--ink, #1b252e)">2 · stop new local routes</text>
<text class="m" font-size="9" text-anchor="middle" x="343" y="155.5" style="fill:var(--ink-2, #4a5763)">no new requests start</text>
<text class="m" font-size="9" text-anchor="middle" x="343" y="169.5" style="fill:var(--ink-2, #4a5763)">here for these cells</text>
<rect height="64" rx="4" stroke-width="1.2" width="186" x="456" y="120" style="fill:var(--plate, #e6ebeb);stroke:var(--ink-2, #4a5763)"></rect>
<text class="m" font-size="9.5" font-weight="600" text-anchor="middle" x="549" y="141.5" style="fill:var(--ink, #1b252e)">3 · cancel in-flight work</text>
<text class="m" font-size="9" text-anchor="middle" x="549" y="155.5" style="fill:var(--ink-2, #4a5763)">firing alarms → a durable wake</text>
<text class="m" font-size="9" text-anchor="middle" x="549" y="169.5" style="fill:var(--ink-2, #4a5763)">active internal fetch / RPC</text>
<rect height="64" rx="4" stroke-width="1.2" width="186" x="456" y="220" style="fill:var(--plate, #e6ebeb);stroke:var(--ink-2, #4a5763)"></rect>
<text class="m" font-size="9.5" font-weight="600" text-anchor="middle" x="549" y="241.5" style="fill:var(--ink, #1b252e)">4 · prove it durable</text>
<text class="m" font-size="9" text-anchor="middle" x="549" y="255.5" style="fill:var(--ink-2, #4a5763)">the batch, in the</text>
<text class="m" font-size="9" text-anchor="middle" x="549" y="269.5" style="fill:var(--ink-2, #4a5763)">live ensemble</text>
<rect height="64" rx="4" stroke-width="1.2" width="186" x="250" y="220" style="fill:var(--plate, #e6ebeb);stroke:var(--ink-2, #4a5763)"></rect>
<text class="m" font-size="9.5" font-weight="600" text-anchor="middle" x="343" y="241.5" style="fill:var(--cobalt, #2a56a0)">5 · publish an L9 snapshot</text>
<text class="m" font-size="9" text-anchor="middle" x="343" y="255.5" style="fill:var(--ink-2, #4a5763)">verify the restore object</text>
<text class="m" font-size="9" text-anchor="middle" x="343" y="269.5" style="fill:var(--ink-2, #4a5763)">too big (~80 MiB): L0 chain</text>
<rect height="64" rx="4" stroke-width="1.2" width="186" x="44" y="220" style="fill:var(--plate, #e6ebeb);stroke:var(--ink-2, #4a5763)"></rect>
<text class="m" font-size="9.5" font-weight="600" text-anchor="middle" x="137" y="241.5" style="fill:var(--ink, #1b252e)">6 · release, peer acquires</text>
<text class="m" font-size="9" text-anchor="middle" x="137" y="255.5" style="fill:var(--ink-2, #4a5763)">a compatible peer takes over</text>
<text class="m" font-size="9" text-anchor="middle" x="137" y="269.5" style="fill:var(--ink-2, #4a5763)">wait for each acknowledgement</text>
<path d="M 232 152 L 246 152" fill="none" marker-end="url(#f7a)" stroke-width="1.4" style="stroke:var(--ink-3, #7b8791)"></path>
<path d="M 438 152 L 452 152" fill="none" marker-end="url(#f7a)" stroke-width="1.4" style="stroke:var(--ink-3, #7b8791)"></path>
<path d="M 549 186 L 549 216" fill="none" marker-end="url(#f7a)" stroke-width="1.4" style="stroke:var(--ink-3, #7b8791)"></path>
<path d="M 454 252 L 440 252" fill="none" marker-end="url(#f7a)" stroke-width="1.4" style="stroke:var(--ink-3, #7b8791)"></path>
<path d="M 248 252 L 234 252" fill="none" marker-end="url(#f7a)" stroke-width="1.4" style="stroke:var(--ink-3, #7b8791)"></path>
<path d="M 42 252 L 26 252 L 26 152 L 40 152" fill="none" marker-end="url(#f7c)" stroke-width="1.4" style="stroke:var(--cobalt, #2a56a0)"></path>
<text class="m" font-size="8.5" text-anchor="middle" x="18" y="202" transform="rotate(-90 18 202)" style="fill:var(--cobalt, #2a56a0)">next batch</text>
<rect height="64" rx="4" stroke-dasharray="5 3" stroke-width="1.2" width="184" x="676" y="120" style="fill:var(--plate, #e6ebeb);stroke:var(--ink-3, #7b8791)"></rect>
<text class="m" font-size="9.5" font-weight="600" text-anchor="middle" x="768" y="141.5" style="fill:var(--ink, #1b252e)">alarms still fire</text>
<text class="m" font-size="9" text-anchor="middle" x="768" y="155.5" style="fill:var(--ink-2, #4a5763)">the durable wake runs them</text>
<text class="m" font-size="9" text-anchor="middle" x="768" y="169.5" style="fill:var(--ink-2, #4a5763)">at least once, on the successor</text>
<rect height="64" rx="4" stroke-dasharray="5 3" stroke-width="1.2" width="184" x="676" y="220" style="fill:var(--plate, #e6ebeb);stroke:var(--ink-3, #7b8791)"></rect>
<text class="m" font-size="9.5" font-weight="600" text-anchor="middle" x="768" y="241.5" style="fill:var(--ink, #1b252e)">nothing moves in</text>
<text class="m" font-size="9" text-anchor="middle" x="768" y="255.5" style="fill:var(--ink-2, #4a5763)">a draining node receives</text>
<text class="m" font-size="9" text-anchor="middle" x="768" y="269.5" style="fill:var(--ink-2, #4a5763)">no cells from rebalancing</text>
<path d="M 644 152 L 672 152" fill="none" stroke-dasharray="3 3" stroke-width="1.2" style="stroke:var(--ink-3, #7b8791)"></path>
<!-- the bounds rail -->
<text class="m" font-size="9" x="24" y="360" style="fill:var(--ink, #1b252e)">bounds (defaults)</text>
<path d="M 150 356 L 645 356" fill="none" marker-end="url(#f7a)" stroke-width="1.3" style="stroke:var(--ink-2, #4a5763)"></path>
<path d="M 150 350 L 150 362" fill="none" stroke-width="1.3" style="stroke:var(--ink-2, #4a5763)"></path>
<path d="M 425 350 L 425 362" fill="none" stroke-width="1.3" style="stroke:var(--ink-2, #4a5763)"></path>
<path d="M 480 350 L 480 362" fill="none" stroke-width="1.3" style="stroke:var(--ink-2, #4a5763)"></path>
<path d="M 590 350 L 590 362" fill="none" stroke-width="1.3" style="stroke:var(--ink-2, #4a5763)"></path>
<text class="m" font-size="9" text-anchor="middle" x="150" y="344" style="fill:var(--ink-2, #4a5763)">0 · SIGTERM</text>
<text class="m" font-size="9" text-anchor="end" x="425" y="344" style="fill:var(--ink-2, #4a5763)">no progress · 25 s (5/8)</text>
<text class="m" font-size="9" text-anchor="start" x="480" y="344" style="fill:var(--ink-2, #4a5763)">drain-token wait · 30 s (3/4)</text>
<text class="m" font-size="9" font-weight="600" text-anchor="middle" x="590" y="376" style="fill:var(--ink, #1b252e)">CELLD_SHUTDOWN_TOTAL_MS · 40 s</text>
<text class="m" font-size="9" x="24" y="396" style="fill:var(--ink-2, #4a5763)">grace long enough</text>
<path d="M 150 392 L 645 392" fill="none" stroke-width="3" style="stroke:var(--ink-2, #4a5763)"></path>
<text class="m" font-size="9" x="653" y="396" style="fill:var(--ink-2, #4a5763)">stop grace outlasts every bound</text>
<text class="m" font-size="9" x="24" y="418" style="fill:var(--cobalt, #2a56a0)">grace too short</text>
<path d="M 150 414 L 480 414" fill="none" stroke-width="3" style="stroke:var(--cobalt, #2a56a0)"></path>
<path d="M 475 409 L 485 419 M 485 409 L 475 419" fill="none" stroke-width="2" style="stroke:var(--cobalt, #2a56a0)"></path>
<text class="m" font-size="9" x="492" y="418" style="fill:var(--cobalt, #2a56a0)">SIGKILL at 30 s (the Kubernetes default): the handoff is cut off</text>
<rect height="54" rx="4" stroke-width="1.2" width="852" x="14" y="434" style="fill:var(--plate, #e6ebeb);stroke:var(--cobalt, #2a56a0)"></rect>
<text class="m" font-size="10" text-anchor="middle" x="440" y="456" style="fill:var(--ink, #1b252e)">Give the orchestrator a stop grace longer than the shutdown bounds, or SIGKILL lands mid-handoff.</text>
<text class="f" font-size="12.5" text-anchor="middle" x="440" y="476" style="fill:var(--ink-2, #4a5763)">Raise systemd TimeoutStopSec or Kubernetes terminationGracePeriodSeconds past the 40 s default.</text>
</svg>
<figcaption>The drain is a loop of six steps per batch, and one variable bounds all of it. The hazard is outside celld: if the orchestrator's stop grace ends first, SIGKILL lands mid-handoff. Kubernetes' default 30 s grace and <code>docker stop</code>'s default 10 s are both shorter than celld's 40 s default bound, so raise the grace rather than trusting the default.</figcaption>
</figure>


> [!WARNING] Warn · orchestrator stop grace
>
> Your orchestrator's stop grace must be longer than the shutdown bounds. systemd `TimeoutStopSec` / Kubernetes `terminationGracePeriodSeconds` must cover the derived drain-token wait, the complete handoff, and the no-progress interval, plus the 40s total bound, or SIGKILL lands before the handoff finishes.

> [!WARNING] Warn · upgrade cliffs
>
> Seven documented transitions. The second, fourth, and sixth may roll, the seventh depends on the durability mode, and the rest are full stops:
>
> - **v0.1.0 → v0.2.0: full stop.** Internal-listener ownership records and block-object compaction are unreadable by v0.1.0.
> - **v0.2.1 → v0.3.0: rolling update allowed.** But never start a v0.2.x binary after v0.3.0 has run unless the shutdown log shows `node-log close: sealed epoch`; a downgrade can lose acknowledged writes.
> - **v0.3.0 → v0.4.0: full stop.** v0.4.0 moves every proxied cell call onto one versioned plain-HTTP tunnel that refuses a different version, and stores large KV values under an epoch-qualified reference v0.3.0 cannot read.
> - **v0.4.0 → v0.4.1: rolling update allowed.** v0.4.1 introduced paged restore; the fleet pages a cell only while every live lease publishes a format that supports it. But once a cell has been paged in, a v0.4.0 node can never activate it, so do not start a v0.4.0 binary again after the fleet begins paging.
> - **v0.4.1 → v0.5.0: full stop, with a procedure.** v0.5.0 replaces the alarm wake format (`wake/format.json` selects format 2; one node holds an advisory waker lease in `wake/waker.json`) and mixed versions cannot share a serving fleet. Stop application traffic and deployment writers; stop every old node and its supervisor; wait for every node lease to expire; back up the bucket and the node data directories; make sure no old binary can restart against the bucket (revoke its credentials, since the format marker cannot stop an old writer); then start v0.5.0 on every node with the same names, addresses, and data directories. Startup inventories the stored cells and migrates the wake format before serving, and a node that stops mid-migration is resumed by the next one to start. **Never roll back by starting an old binary against the upgraded bucket.** The only rollback is the stopped-fleet backup, which loses writes made after it.
> - **v0.5.0 → v0.5.1: rolling update allowed.** Stop one node, wait for its replacement to report healthy, continue to the next.
> - **v0.5.1 → v0.6.0: full stop under `fleet` durability, rolling under `bucket`.** A v0.6.0 node recovers its previous log session only when a follower answers `/peer/log/tail` in the ranged format (`CLT2`), which carries range evidence. A v0.5.1 follower only speaks the entries-only format (`CLT1`), so a v0.6.0 node that needs a follower witness refuses to start in a mixed fleet. Stop every v0.5.1 node, then start the v0.6.0 nodes. A fleet on `CELLD_DURABILITY=bucket` has no followers and can roll. Facets written by v0.5.1 migrate to their own files on first open.

### Release notes

<!-- series-only -->The body of this guide describes v0.6.0.<!-- /series-only --><!-- book-only -->The chapters of this book describe v0.6.0.<!-- /book-only --> This table records what each release since v0.4.0 changed, so the history is in one place. The "Upgrade" column repeats the transition rule from the callout above; a change marked **behaviour** altered what a running application observes and can bite on upgrade.

| Release | Date | Upgrade from previous | Notable changes |
|----|----|----|----|
| v0.4.0 | 2026·08·28 | Full stop from v0.3.0 | Workers KV, Queues, Workflows, and R2 arrive, graded *Partial* at the time. Every proxied cell call (fetch, RPC, WebSocket) moves onto one versioned plain-HTTP peer tunnel, and deployments adopt in place without a restart. The output gate applies one ordering rule across responses, outbound calls, Queue deliveries, and WebSocket sends. `celld dev` opens a local store, replacing the earlier "no local filesystem mode" guidance. Large KV values move under an epoch-qualified reference. **Behaviour:** the health path moves from `/__celld/health` to `/.well-known/celld/health`; update load balancers and readiness probes. Gaps at this release: `wrapKey`/`unwrapKey`, RSA signing, and HKDF/PBKDF2 derivation were unavailable; Workflow retention and manual deletion were unavailable; the store was allowed to ignore `Range`; a node whose ready gate expired reported healthy anyway; the docs said a queue consumer could not also export `fetch()`, and that `create()` with a terminal Workflow instance's ID replaced it. |
| v0.4.1 | 2026·09·05 | Rolling; never restart v0.4.0 once paging began | Durable Object facets, HTMLRewriter, TCP sockets, EventSource, MessageChannel, an always-miss Cache, and the missing Web Crypto pieces. Paged restore through a fault-in SQLite VFS, which makes exact ranged reads a correctness requirement. Ownership balancing replaces the earlier rule that a joining node took only unowned cells, with `POST /rebalance/pause` / `/resume`. The self-fence names its cause with three distinct events, and a failed lease renewal retries before the authority expires. Nodes that restart together recover acknowledged writes, with checkpoints and a heartbeat. The Queue producer path is rebuilt: shared transactions and durability rounds, time-ordered message IDs, 7,357 sends/s on one queue (up from a few hundred). `celld diagnose` shows each node's load sample. Outbound TCP makes egress control the fleet network's job. |
| v0.5.0 | 2026·09·15 | Full stop with a procedure (alarm wake format 2); no binary rollback | Containers and the Sandbox SDK (*Experimental*). Dynamic Workers, the renamed Worker Loader, leaves the experimental tier and is declared in `wrangler.jsonc` (`worker_loaders`) rather than `CELLD_WORKER_LOADER`. Exact ranged reads become the fourth documented store requirement, and the startup probe can no longer be disabled. The compatibility page is reframed to list only differences and to grade *Yes* / *Partial* / *Experimental* / *No*. Idle eviction becomes opt-in via `CELLD_IDLE_EVICT_S`. Deploy records SHA-256 module digests; `no_bundle` projects get Wrangler's `**/*.wasm` discovery; container images live under `deploy/images/`. `celld dev` gains `--clean`, `--watch-ignore`, and `.dev.vars`. A restarting node waits behind a peer already recovering its log. An `AbortSignal` passes through a same-node RPC call. Shutdown tunables collapse into `CELLD_SHUTDOWN_TOTAL_MS`; the `CELLD_RELEASES` default rises from 8 to 128; `CELLD_ACTIVATIONS` defaults to 8 per CPU. An expired ready gate keeps readiness closed. `/state` adds `handed_off`, `rebalanced`, `rebalance_failed`, `remote_route_refreshes`, and `node_load`. `CELLD_OTEL` picks the telemetry sink; `OTEL_EXPORTER_OTLP_ENDPOINT` is no longer read. Workflow retention becomes configurable and completed runs deletable; replay is no longer listed as a celld difference. D1 migration extensions become case-insensitive; KV prefix listings get faster; internal host functions stop being exposed to application code. **Behaviour:** the variables listed under *Rejected at startup* in the environment table stop a node that sets them. |
| v0.5.1 | 2026·09·19 | Rolling | `WorkerCode.limits` enforces `cpuMs` and `subRequests`, and `WorkerCode.tails` delivers Tail Worker reports (both rejected in v0.5.0). The `celld r2` CLI (`get`, `head`, `put`, `delete`, `list`) replaces `wrangler r2 object`. The documentation splits into per-service pages. `/state` adds `allocator`, `libc_malloc`, and `deployment.isolates`; `/evict/<cell>` waits for the eviction and reports the true outcome instead of reporting success early. Wrangler `define` and `rules` are accepted. Workflow defaults are documented for the first time, along with the REST API / `wrangler workflows` exclusion. The facets page states the alarm, depth, and name-length limits. `examples/queues` exports both `fetch` and `queue` from one script. **Behaviour:** on Azure the R2 metadata name becomes `celld_r2` (#209). |
| v0.6.0 | 2026·09·26 | Full stop under `fleet` durability (`CLT2` log tail); rolling under `bucket` | First **beta**. Each facet gets its own SQLite file and replication stream, and a facet class can come from `ctx.exports`; facets written by v0.5.1 migrate on first open. Ed25519 (also `NODE-ED25519`) and X25519 in Web Crypto. `ctx.exports` holds `default` and each entrypoint. `Headers` accepts values above U+00FF and decodes response values as UTF-8. The WebSocket output gate holds each frame only for its own proof, and a close is `wasClean: true` whenever the peer sent a close frame. R2 keeps empty key segments and percent-encodes special characters. **Behaviour:** a facet write no longer commits atomically with a root transaction; a D1 `TEXT` value that is not valid UTF-8 decodes to U+FFFD instead of failing; `WorkerCode` requires `compatibilityDate`, a wasm module entry must be `{ wasm: bytes }`, and a relative import in a module subdirectory resolves from the importing module's name; every export of the main module must be a handler object or a class; an R2 key v0.5.1 wrote as `photos/` stays at `photos`. |

### Diagnose a fleet

`celld diagnose` reads the node leases from the bucket and probes each live peer; it never takes a lease or changes ownership. It reports expired records, unsafe or incorrect advertised addresses, unreachable peers, authentication failures, and version disagreements, shows each node's load sample (owned cells, resident cells, WebSockets, RSS, CPU, file descriptors, pressure, shedding), and runs the storage test. `celld cell list` lists Durable Object instances, each line `Class:ID`. D1 databases, KV namespaces, and Workflows appear as reserved `__` cells. Paginate with `--after`; a class-name argument scopes the storage prefix so `--limit` applies to that class alone, and the listing does not load the namespace into memory. During a rolling update, wait for every node to report `restoring=0` before restarting the next.

`GET /state` on the internal listener is an autoscaler feed. It reports `owned_cells`, `occupied`, `capacity_waiting`, `activation_waiting`, `restoring`, and `shedding`, counters for `handed_off`, `rebalanced`, `rebalance_failed`, and `remote_route_refreshes`, and a `node_load` object mirroring the lease's sample (`placement_weight`, `resident_cells`, `host_websockets`, `rss_bytes`, `cpu_percent_x100`, `open_fds`, `pressured`, `memory_headroom`). It also carries `allocator` and (Linux) `libc_malloc` memory counters and a per-script `deployment.isolates` block: `live`, `live_empty`, `retiring`, `freed`, V8 heap and external bytes. A `live_empty` count that persists past 30 seconds signals a stuck maintenance pass, and a persistent `retiring` count a stuck request. A positive `capacity_waiting` is the add-a-node signal; scale down only while every remaining node reports headroom and a small `restoring` backlog. The health path stays a plain boolean: 503 during drain and before settle, no utilization number. `/evict/<cell>` waits for the eviction and answers `{"ok":true}`, or `{"ok":false,"error":{"kind":…,"reason":…}}` with a kind of `refused` (409/503: `cell_active`, `alarm_imminent`, `eviction_limit`, …), `cancelled` (new activity or a fence), or `failed` (500: a lost reply or a durability failure).

### Operate D1, KV, Queues, and R2

`celld d1` runs SQL and migrations against a deployed D1 database, routing through the fleet to the database cell. The migration extension is ASCII case-insensitive, and `migrations_dir` must be a relative path inside the project. `celld kv` reads and writes a deployed KV namespace. The bulk commands use the Wrangler file format, so `wrangler kv bulk get` can export data for `celld kv bulk put`, and `celld kv bulk get` streams rows rather than holding the namespace in memory (an `expiration` is exported in Unix seconds, as Wrangler expects). `celld kv list` caps at 1000 keys per read and reports `--after` to continue. Every celld command writes data to stdout and messages to stderr, so redirects and pipes carry only data. `celld queue info/peek/purge/pause/resume/redrive` operates queues (`purge` needs `--force`; `peek` and `redrive` take `--limit` 1–100). `celld r2 get|head|put|delete|list` stands in for `wrangler r2 object`: it reads the fleet bucket directly with no running node, takes the `bucket_name` rather than the binding name, streams a `get` to stdout, and preserves the binding's metadata (`--content-type`, `--cache-control`, `--metadata JSON`, …); `--local`, `--remote`, and `--jurisdiction` are refused with an explanation.

### Primary environment variables

| Variable | Purpose |
|----|----|
| `CELLD_BUCKET` | Fleet bucket (+ optional key prefix). Same as `--bucket`. |
| `S3_ENDPOINT`, `AWS_REGION`, `AWS_*` | S3-compatible endpoint and credentials (standard AWS chain; EKS Pod Identity supported). |
| `GOOGLE_*` | Google credentials for a `gs://` bucket (ADC or service-account key). |
| `AZURE_*` | Azure account/identity for an `az://` bucket (exactly one credential family). |
| `CELLD_DURABILITY` | Durability mode: `fleet` (default) or `bucket`. Fleet proof needs ≥ 2 nodes. |
| `CELLD_ADDR` / `CELLD_INTERNAL_ADDR` / `CELLD_ADVERTISE` | Public listener, internal peer/operator listener, advertised address. |
| `CELLD_ACTIVATIONS` | Concurrent cold-cell activations (default 8 per CPU, at least 16 and at most 128; a cold activation mostly waits on the store, so the default sits above the CPU count). |
| `CELLD_MAX_RESIDENT_CELLS` | Hard resident-cell cap, enforced at admission. |
| `CELLD_IDLE_EVICT_S` | Seconds without work after which an idle resident cell hibernates (unset: only pressure or the cap removes it). Balancing moves hibernated cells only. |
| `CELLD_PLACEMENT_WEIGHT` / `CELLD_REBALANCE_INTERVAL_MS` | This node's ownership share relative to its peers (default: CPU count) and the fleet-sample interval (default 5,000; 0 disables balancing). |
| `CELLD_MAX_CELL_REQUESTS` | Concurrent fetch limit for one Durable Object (default 64). A Queue broker has its own fixed limits: 256 concurrent producer calls, 64 per transaction, four overlapping proofs. |
| `CELLD_MAX_REQUEST_BODY_BYTES` | Body limit for a public Worker request or direct DO request (default 1 GiB). |
| `CELLD_MAX_RSS_MB` | Memory threshold for pressure shedding (default 80% of available memory; accounts for cgroup memory on Linux). |
| `CELLD_TTL_MS` | Node-lease lifetime (default 10,000 ms). |
| `CELLD_OPERATION_DEADLINE_MS` | Deadline for a non-restore operation (default 15,000). |
| `CELLD_DEPLOY_POLL_S` / `CELLD_DEPLOY_MAX_AGE_S` | Deployment-adoption poll interval (30s) and forced-move age (60s). |
| `CELLD_SHUTDOWN_TOTAL_MS` / `CELLD_RELEASES` | Total stop bound (40s; the drain-token wait and no-progress bound derive from it) and concurrent handoffs (default 128). |
| `CELLD_LTX_COMPACTION` | 1 (default) creates additive L1 objects so a takeover reads tens of objects instead of thousands. |
| `CELLD_LTX_PAGED` / `CELLD_LTX_PAGED_MIN_MB` / `CELLD_LTX_HYDRATE_MBPS` | Paged restore (default on) for chains above the threshold (default 256 MiB), and the background fill rate for the paged file (default 16; 0 keeps it sparse). |
| `CELLD_RECOVERY_RETRY_MS` / `CELLD_RECOVERY_RETRIES` | Node-log recovery retry pacing (defaults 1,000 and 240); recovery reads bundles in 512 MiB windows and checkpoints every 32 cell epochs. |
| `CELLD_WAKER_TICK_MS` | Interval of the fleet waker's alarm cleanup pass (default 60,000). |
| `CELLD_ALARM_RESIDENT_MS` | How close to its next alarm a cell (a Workflow instance, say) stays resident rather than hibernating (default one hour). |
| `CELLD_DOCKER` / `CELLD_CONTAINER_PLATFORM` / `CELLD_CONTAINER_RUNTIME` | Containers: the container CLI used to build and pull (default `docker`; Podman works), the deploy build platform (default `linux/amd64`), and a node-wide OCI runtime such as `runsc` or `kata`. |
| `CELLD_OTEL` | `0` off, `1` Parquet to the bucket, or an OTLP/HTTP collector base URL (see § 08). |
| *Rejected at startup* | `CELLD_OUTPUT_GATE` (the gate is always on; celld always waits for the configured durability proof), `CELLD_STORAGE_PROBE`, `CELLD_SHUTDOWN_DRAIN_MS`, `CELLD_DRAIN_TOKEN_WAIT_MS`, `CELLD_WORKER_LOADER`, `CELLD_MAX_LOADED_WORKERS`, `CELLD_OTEL_SINK`, `CELLD_AI_BINDING`, `CELLD_AI_URL`, `CELLD_REBALANCE_BATCH_CELLS`, and a handful of older tuning knobs. A node with any of them set does not start. |

## The Cloudflare compatibility surface {#cloudflare-surface}

celld runs the Workers runtime (module Workers, `fetch`, JS RPC, service bindings, Durable Objects, static assets, KV, Queues, Workflows, R2, Dynamic Workers, facets, and containers) with Durable Objects as the stateful core. The scope rule again: **a configuration or binding that is not available must fail loudly, at deploy or first use; a silent gap is a bug.** Each service has its own page under `docs/services/`, with a how-it-works narrative, a worked example, and a "differences from Cloudflare" list, while the runtime-API sections stay on the compatibility page. The pages list *only* an unavailable feature, a celld-specific limit, or an observable difference: "if an entry has no note, celld intends to match the linked Cloudflare API". Each surface is graded *Yes* (implemented, except the listed differences), *Partial* (a substantial part unavailable), *Experimental* (can change without notice), or *No*. On that scale every service celld carries is *Yes* except Containers (*Experimental*). In the runtime table only Node.js compatibility and the Cache API are *Partial*, and BroadcastChannel is the lone *No*.

<figure class="topology">
<svg aria-labelledby="f5-t f5-d" role="img" viewbox="0 0 880 434" xmlns="http://www.w3.org/2000/svg">
<title id="f5-t">The compatibility line, drawn as the scope rule</title>
<desc id="f5-d">Three nested regions. At the centre, the core celld carries: the Workers runtime and Durable Objects. Around it, everything Cloudflare builds on Durable Objects, which celld therefore carries—D1, KV, Queues, Workflows, R2, cron triggers, Dynamic Workers, facets, and, experimentally, Containers. Outside both, the Cloudflare platform surface celld does not carry: Workers AI, Vectorize, Hyperdrive, Browser Rendering, Email, Python Workers, BroadcastChannel, custom domains, and TLS termination.</desc>
<rect height="376" rx="6" stroke-dasharray="6 4" stroke-width="1.4" width="852" x="14" y="14" style="fill:var(--paper-2, #ebeee9);stroke:var(--ink-3, #7b8791)"></rect>
<text class="m" font-size="10.5" font-weight="600" x="34" y="38" style="fill:var(--ink-2, #4a5763)">OUTSIDE THE LINE—the Cloudflare platform surface, not a Durable-Object building block</text>
<rect height="246" rx="5" stroke-width="1.6" width="792" x="44" y="54" style="fill:var(--plate, #e6ebeb);stroke:var(--cobalt, #2a56a0)"></rect>
<text class="m" font-size="10.5" font-weight="600" x="64" y="78" style="fill:var(--cobalt, #2a56a0)">CARRIED—if Cloudflare builds it on Durable Objects, celld can carry it</text>
<rect height="86" rx="4" stroke-width="1.8" width="672" x="104" y="96" style="fill:var(--plate, #e6ebeb);stroke:var(--ink-2, #4a5763)"></rect>
<text class="m" font-size="12" font-weight="600" text-anchor="middle" x="440" y="124" style="fill:var(--ink, #1b252e)">THE CORE—Workers runtime + Durable Objects</text>
<text class="f" font-size="13" text-anchor="middle" x="440" y="146" style="fill:var(--ink-2, #4a5763)">a named cell, one thread, its own SQLite</text>
<text class="m" font-size="9" text-anchor="middle" x="440" y="168" style="fill:var(--ink-2, #4a5763)">conformance-tested against workerd on identical bytes—equal output required</text>
<rect height="52" rx="3" width="144" x="64" y="198" style="fill:var(--paper-2, #ebeee9);stroke:var(--ink-3, #7b8791)"></rect>
<text class="m" font-size="10" font-weight="600" text-anchor="middle" x="136" y="217" style="fill:var(--ink, #1b252e)">D1</text>
<text class="m" font-size="9" text-anchor="middle" x="136" y="231" style="fill:var(--ink-2, #4a5763)">a cell · one writer</text>
<text class="m" font-size="8.5" text-anchor="middle" x="136" y="243" style="fill:var(--ink-2, #4a5763)">graded Yes</text>
<rect height="52" rx="3" stroke-width="1.3" width="144" x="221" y="198" style="fill:var(--paper-2, #ebeee9);stroke:var(--cobalt, #2a56a0)"></rect>
<text class="m" font-size="10" font-weight="600" text-anchor="middle" x="293" y="217" style="fill:var(--ink, #1b252e)">KV</text>
<text class="m" font-size="9" text-anchor="middle" x="293" y="231" style="fill:var(--ink-2, #4a5763)">no edge cache</text>
<text class="m" font-size="8.5" text-anchor="middle" x="293" y="243" style="fill:var(--cobalt, #2a56a0)">graded Yes</text>
<rect height="52" rx="3" stroke-width="1.3" width="144" x="378" y="198" style="fill:var(--paper-2, #ebeee9);stroke:var(--cobalt, #2a56a0)"></rect>
<text class="m" font-size="10" font-weight="600" text-anchor="middle" x="450" y="217" style="fill:var(--ink, #1b252e)">Queues</text>
<text class="m" font-size="9" text-anchor="middle" x="450" y="231" style="fill:var(--ink-2, #4a5763)">one consumer</text>
<text class="m" font-size="8.5" text-anchor="middle" x="450" y="243" style="fill:var(--cobalt, #2a56a0)">graded Yes</text>
<rect height="52" rx="3" stroke-width="1.3" width="144" x="535" y="198" style="fill:var(--paper-2, #ebeee9);stroke:var(--cobalt, #2a56a0)"></rect>
<text class="m" font-size="10" font-weight="600" text-anchor="middle" x="607" y="217" style="fill:var(--ink, #1b252e)">Workflows</text>
<text class="m" font-size="9" text-anchor="middle" x="607" y="231" style="fill:var(--ink-2, #4a5763)">replay semantics</text>
<text class="m" font-size="8.5" text-anchor="middle" x="607" y="243" style="fill:var(--cobalt, #2a56a0)">graded Yes</text>
<rect height="52" rx="3" stroke-width="1.3" width="144" x="692" y="198" style="fill:var(--paper-2, #ebeee9);stroke:var(--cobalt, #2a56a0)"></rect>
<text class="m" font-size="10" font-weight="600" text-anchor="middle" x="764" y="217" style="fill:var(--ink, #1b252e)">R2</text>
<text class="m" font-size="9" text-anchor="middle" x="764" y="231" style="fill:var(--ink-2, #4a5763)">your fleet bucket</text>
<text class="m" font-size="8.5" text-anchor="middle" x="764" y="243" style="fill:var(--cobalt, #2a56a0)">graded Yes</text>
<text class="m" font-size="9" x="64" y="270" style="fill:var(--ink-2, #4a5763)">cron triggers · service bindings · Dynamic Workers (worker_loaders) · Durable Object facets · Containers + Sandbox SDK (experimental)</text>
<text class="m" font-size="9" x="64" y="288" style="fill:var(--ink-2, #4a5763)">everything here is graded Yes on the v0.6.0 page except Containers; the page lists only the remaining differences</text>
<text class="m" font-size="9.5" x="64" y="326" style="fill:var(--ink-2, #4a5763)">Workers AI (adapter removed) · Vectorize · Hyperdrive · Browser Rendering · Email · Python Workers</text>
<text class="m" font-size="9.5" x="64" y="346" style="fill:var(--ink-2, #4a5763)">BroadcastChannel (constructor throws) · the Cache API stores nothing (always-miss, Partial) · node:fs / node:os partial</text>
<text class="m" font-size="9.5" x="64" y="366" style="fill:var(--ink-2, #4a5763)">custom domains · TLS termination—your ingress proxy does both</text>
<text class="m" font-size="10" text-anchor="middle" x="440" y="416" style="fill:var(--cobalt, #2a56a0)">Every gap fails loudly, at deploy or at first use—a silent gap is a bug.</text>
</svg>
<figcaption>The compatibility line is a rule, not a list: celld carries what Cloudflare builds on Durable Objects. That rule puts KV, Queues, Workflows, R2, facets, the runtime APIs (HTMLRewriter, TCP sockets, EventSource, MessageChannel), and Containers inside the line, and keeps the platform surface outside for as long as it stays platform.</figcaption>
</figure>

### Runtime API surface: the parts that matter

| Surface | Status on celld |
|----|----|
| Fetch / Request / Response / Headers | Yes. The `cache` request option is unavailable; celld removes `Content-Length` from a Worker response (preserves it for `HEAD`); `Headers` accepts values above U+00FF and decodes response values as UTF-8 |
| Context (`ctx`) | Yes. `passThroughOnException()` is a no-op; `ctx.facets` is available only inside a Durable Object; `ctx.exports` holds `default` and each entrypoint, and `fetch()` on its stubs sends an HTTP request |
| Main module | As in workerd, every export of the main module must be a handler object or a class; `export const X = "..."` makes the Worker fail to start |
| Handlers | Yes. `fetch`, `alarm`, `scheduled`, `queue`, WebSocket handlers, RPC; `tail` and `email` unavailable |
| JS RPC | Yes. A stub cannot cross an isolate boundary; an `AbortSignal` passes through on the same node but not across a node boundary; retries only when the peer attempt provably did not start |
| Streams / Encoding | Yes. An HTTP stream expires after 60 s unclaimed or inactive (renewed by successful reads), and an expired or unknown stream errors rather than reporting EOF |
| WebSockets | Yes. Inbound (hibernatable, with attachments and tags) and outbound; a 1 MiB per-isolate input budget per non-terminal frame; a transport cannot move to a new owner, so reconnect with a stable operation ID; a mid-frame connection failure closes with 1012; the output gate holds each frame only for its own proof, so a `webSocketMessage()` handler can stream frames while it runs; a close is `wasClean: true` whenever the peer sent a close frame |
| Web Crypto | Yes, including `wrapKey`/`unwrapKey`, RSA signing, HKDF/PBKDF2 derivation, and Ed25519 (also spelled `NODE-ED25519`) and X25519 with `raw` import and export of the 32-byte point. Remaining limits are algorithm-specific: ECDSA P-256 with SHA-256 only, AES-GCM tags 96–128 bits, a secret key cannot use `jwk` with `exportKey()`/`wrapKey()`, and X25519 rejects a low-order peer key |
| `node:` imports | Partial. assert, async_hooks, buffer, diagnostics_channel, events, path, stream, timers/promises, util, os; crypto/zlib partial; `node:fs` covers `access`/`mkdir`/`realpath`/`stat`/`readFile` over a per-request `/tmp` and a read-only `/bundle`; http, net, tls, dns import but throw on first call; the bundler honors synchronous CommonJS `require()` of built-ins |
| D1 | Yes. A cell; one writer; results capped at 100,000 rows / 32 MiB; a `TEXT` value that is not valid UTF-8 decodes with U+FFFD, as in workerd (the stored bytes do not change) |
| KV · Queues · Workflows · R2 | Yes (remaining differences below) |
| HTMLRewriter · TCP sockets · EventSource · MessageChannel | Yes. A TCP socket cannot outlive its event (a Durable Object reconnects next event); TLS is verified against a bundled Mozilla root store; celld does not block the ports Cloudflare blocks, so the fleet network controls egress |
| Cache | Partial. An always-miss cache: `put()` validates and consumes the response but stores nothing, `match()` returns `undefined`, `delete()` returns `false` |
| BroadcastChannel | No. The class is defined so a bundle loads, but its constructor throws rather than acting as a silent stub |

### Dynamic Workers, facets, and containers

**Dynamic Workers** is the Worker Loader under its current name, graded *Yes*. A deployment declares its loaders in `wrangler.jsonc`: `"worker_loaders": [{ "binding": "LOADER" }]`. A loaded Worker can receive Service Binding capabilities through `WorkerCode.env` alongside structured-clone values (1 MiB total), so a parent can hand a child a `ctx.exports` entrypoint to call back on; `getEntrypoint()` and `getDurableObjectClass()` take only `props`. The process holds at most 256 live Dynamic Workers, 255 per script generation, and that limit is not tunable; module sources total at most 64 MiB. `globalOutbound` cannot `connect()` or open a WebSocket. `WorkerCode.limits` (and the `limits` option of `getEntrypoint()`) *enforces* `cpuMs` and `subRequests`. A `WorkerCode.tails` array of Service Binding Fetchers receives one invocation report per finished fetch (request metadata, response status, up to 256 KiB of console records, the uncaught exception, and the outcome), delivered after the response, with a Tail failure logged rather than surfaced. `allowExperimental` is rejected. The Wrangler `worker_loaders` entry itself accepts only `binding`; `limits` and `tails` belong in the `WorkerCode` object, and the deploy stops if they appear in the config entry. Three rules match workerd exactly and can break code written loosely against an earlier release: `WorkerCode` **requires** `compatibilityDate`, a wasm entry in `modules` must be `{ wasm: bytes }` (bare bytes are refused), and a relative import inside a module subdirectory resolves from the importing module's name.

**Durable Object facets**: `ctx.facets.get()`/`abort()`/`delete()` attach a child object with its own SQLite database. The class comes from a Worker Loader binding (`worker.getDurableObjectClass()`) or from `ctx.exports` for a `DurableObject` class the Worker exports *without* a storage migration; that facet runs in the root's isolate. A Durable Object binding cannot supply one. Each facet lives in **its own SQLite file with its own replication stream** under the root cell's bucket prefix, sharing the root's ownership record and epoch. The consequence: a facet write commits in the facet's own database, so rolling back a root transaction does not undo a facet call inside it. An application that needs one atomic commit must keep that state in one database. celld holds a facet's outbound effects and replies until the facet's own stream proves the call's writes, and a move proves every facet stream before the new owner opens the root. `clone()` is unavailable. Two more limits: a facet cannot set an alarm (`storage.setAlarm()` throws inside one, so the root holds the schedule), and facets nest to a total depth of four counting the root, with names up to 256 bytes. The `examples/facets` project shows the whole pattern, including the callback capability.

**Containers** are *Experimental*: "the configuration keys, the `ctx.container` surface, the node-side defaults, and the security boundary can change without notice". A container makes a Durable Object the supervisor of one container, driven by `@cloudflare/containers` as published; the **Sandbox SDK** (`@cloudflare/sandbox`, on the `cloudflare/sandbox` image) runs on top unchanged. A `containers` entry accepts exactly `class_name`, `image`, `name` (accepted, unused), `instance_type`, `max_instances`, and the celld-only `runtime` override; the class must be a SQLite-backed Durable Object of the same script. `celld deploy` builds or pulls the image with the Docker or Podman CLI (`CELLD_DOCKER`), for `linux/amd64` by default (`CELLD_CONTAINER_PLATFORM`), saves it once to the bucket under `deploy/images/`, and every node loads it on first use; each fleet node needs a container engine socket. `instance_type` maps to Cloudflare's CPU and memory tiers: `lite` (alias `dev`, the default: a sixteenth of a CPU and 256 MiB), `basic`, `standard-1` through `standard-4`. Disk size is not enforced. `max_instances` caps a class fleet-wide through the shared node sample, so it can overshoot by one refresh cycle. The node fences container bridges with nftables before the first start: `enableInternet: true` reaches only the Internet, never the node, its peers, or private ranges, and `false` is an internal bridge with no route out. Container disk is ephemeral; it dies with a move, restart, or reset. Idle eviction respects `setInactivityTimeout()` (default 10 minutes). Implemented: `running`, `start()`, `monitor()`, `destroy()`, `signal()`, `getTcpPort()`, `exec()`, `setInactivityTimeout()`; not implemented: `inspect()`, snapshots, and outbound interception. A sandbox that moves nodes loses its container, so the first call after a move can throw the SDK's `OperationInterruptedError`, matching Cloudflare's own restart behavior.

### KV

- **No edge cache.** `cacheTtl` has no effect and `cacheStatus` is `null`. KV is a durable store, not a CDN.
- A value above 1 MiB requires the fleet bucket (small values are in-cell). Large values are stored under their ownership epoch with an epoch-qualified row reference, so an old owner cannot delete the current value.
- **One writer per namespace.** Add namespaces, not writers. A namespace ID accepts the Cloudflare hex form or any stable string.
- Operate with `celld kv get/put/delete/list` and `bulk` variants (Wrangler file format, so it interops with `wrangler kv bulk`).

### Queues

- **One writer per queue**; scale with more queues. Producer calls share transactions and durability rounds, each message gets a time-ordered ID, and a broker admits up to 256 concurrent producer calls (committing at most 64 per transaction, four proofs overlapping), refusing more with an error the producer can retry. One queue sustained 7,357 sends per second over a 300,000-send soak with exact delivery. The refusal surfaces as `cell overload: admission refused` in a caught producer error, so a Worker can relay the 503.
- **One consumer script per queue.** A deployment where two scripts consume one queue fails. The consumer script may also export `fetch()`: `examples/queues` exports both `fetch` and `queue` from one script. [Notebook 2 Part 5](celld-02-bindings) shows what happens when a declared consumer's script loses its `queue()` handler: the local node exits with `queue consumer has no queue handler`. Consumer settings follow Cloudflare: `max_batch_size` 10 (max 100), `max_batch_timeout` 5 s (max 60), `max_retries` 3, `max_concurrency` up to 250, `retry_delay`, `dead_letter_queue` an ordinary queue; celld validates each bound at deploy time, so a bad value fails the deployment rather than the first delivery. A retried message becomes visible again after `delaySeconds` from `retry()` or `retryAll()`, defaulting to the consumer's `retry_delay`; celld adds no exponential backoff, so an application that wants one computes the delay from `message.attempts`. When `attempts` passes `max_retries`, celld moves the message to the `dead_letter_queue`, or **deletes it** if the consumer names none. Limits: messages up to 128,000 bytes, 100 per `sendBatch()` (256,000 bytes in total), `delaySeconds` up to 86,400.
- **Messages.** The `contentType` option selects `"v8"`, `"json"`, `"text"`, or `"bytes"`, and the `queues_json_messages` compatibility flag chooses the default, as on Cloudflare. A producer entry's `delivery_delay` sets the default delay for every message sent through that binding.
- Messages are retained four days, **not configurable**. Pull consumers, the Queues HTTP API, dashboard controls, manual consumer attachment, R2 event notifications, and Queue event subscriptions are not available.
- Operate with `celld queue info/peek/purge/pause/resume/redrive`.

### Workflows

- **Replay is the discipline.** A running workflow is stored as steps. After a crash, `run()` replays from the start, so code *outside* a step runs again, and a crash after a step side effect can run that step's callback again. The Workflows page does not list this as a celld difference, because it is how Cloudflare Workflows work too. Everything meaningful goes inside a step, and steps must be idempotent. [Notebook 3 Part 3](celld-03-processes) counts it: across one durable sleep, the top of `run()` ran twice while each step ran once.
- **Retention.** A successful or failed instance is kept 30 days by default, each duration in the `retention` option can be at most 30 days, and completed runs can be deleted manually. `locationHint` accepts Cloudflare's values but fleet ownership picks the actual location.
- **Limits.** Non-step work cannot stay pending more than 60 seconds; a step result, event payload, and workflow parameters are each capped at 1 MiB. Rollback, sensitive step results, and `ReadableStream` step results are unavailable. A `workflows` entry cannot carry `schedules`, `limits`, or a `script_name` naming another script. The Workflows REST API and `wrangler workflows` do not operate against celld.
- **Defaults.** `step.do()` retries 5 times, 10-second delay, exponential backoff, 10 minutes per attempt, stoppable with `NonRetryableError`; `waitForEvent()` times out after 24 hours; an instance within an hour of its next alarm stays resident (`CELLD_ALARM_RESIDENT_MS`).
- **Create-once semantics: verify.** The page says nothing about `create()` with a terminal instance's ID, and nothing about `pause()`/`resume()`/`restart()`. Cloudflare refuses the duplicate ID; celld replaced it in v0.4.0 <!-- series-only -->(see the release notes in § 05)<!-- /series-only --><!-- book-only -->(see [Appendix C](release-notes.html))<!-- /book-only -->. By the page's own rule the silence means celld intends to match Cloudflare, but no release note calls it out as a fix. Verify against your installed release if you depend on create-once semantics.

### R2

- The R2 binding uses your **fleet bucket** under `r2/<bucket_name>/`, which is how the fleet bucket earns its name. An object's `version` equals its content ETag, so identical content produces the same version. The version comes from the object store: most stores report no version identifier, so the ETag becomes the version. `celld dev`'s local store instead numbers each write from a store-wide counter, so identical bytes under two keys get different versions ([Notebook 2 Part 4](celld-02-bindings) shows it). Either way, an application must not use a version to count writes, and should not rely on version equality for de-duplication without checking the store it deploys to; `checksums.md5` is the content hash on both. The five content headers are stored as object headers; `customMetadata`, `cacheExpiry`, checksums, and storage class travel together in one JSON value under the `celld-r2` user-metadata name (`celld_r2` on Azure, which refuses a hyphen; #209). `celld r2 get|head|put|delete|list` operates these objects without a running node.
- **Access is through the binding only.** There is no public bucket URL, no presigned URL, and no S3 endpoint into an R2 binding, so an application must put a Worker in front of any bytes it wants to publish.
- **Interop.** An object another tool wrote still reads through the binding: its user metadata becomes its `customMetadata` and its headers become its `httpMetadata`. Use `celld r2 put` to write the complete record. `delete(keys)` removes up to 1,000 keys in one call.
- `ssecKey` and `jurisdiction` are not available. A conditional write cannot use a streamed body larger than 8 MiB.
- Multipart: `createMultipartUpload()` accepts no checksum; a multipart upload **cannot resume on another node or after a restart**; celld cannot replace a part the store already holds; out-of-order parts are limited to 256 MiB of memory, and completion cannot change the stored part order.
- **Keys.** celld keeps empty key segments, so `a/b`, `/a/b`, `a//b`, and `a/b/` are four objects, as in Cloudflare R2. The store percent-encodes keys with non-ASCII or special characters (`přehled.html` becomes `p%C5%99ehled.html`) and `list()` decodes them, so a listed key is the key `put()` received. But `list()` sorts and compares `startAfter` by the *encoded* form, so a key with one of those characters can land in a different position than on Cloudflare, and `startAfter` can skip or include a key Cloudflare would not. A celld `cursor` has no such problem. An object v0.5.1 wrote as `photos/` stays at `photos`.

### Wrangler configuration

`celld deploy` reads `wrangler.jsonc` or `wrangler.json`, **not** `wrangler.toml`. Supported keys: `$schema`, `name`, `main`, `no_bundle`, `compatibility_date`, `compatibility_flags`, `durable_objects`, `migrations`, `assets`, `services`, `triggers`, `vars`, `d1_databases`, `kv_namespaces`, `queues`, `workflows`, `r2_buckets`, `worker_loaders`, `containers`, `define`, and `rules`. `define` and `rules` are both handed to the esbuild run, so neither combines with `no_bundle`; a rule's `type` is `Text`, `Data`, or `CompiledWasm` with globs of the form `**/*.ext`, and a rule that gives `**/*.wasm` any type but `CompiledWasm` stops the deploy. The `name` must be 1–63 lowercase ASCII letters, digits, or internal hyphens. Anything else (`routes`, unknown keys) stops the deploy with an error naming the key. Compatibility flags (`js_rpc`, `sqlite_vec`, `websocket_standard_binary_type`, `delete_all_deletes_alarm`, `fetcher_no_get_put_delete`, and the assets navigation flags) are honored; unmodeled flags are accepted without effect.

```json
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "chat",
  "main": "src/index.ts",
  "compatibility_date": "2026-01-01",
  "durable_objects": {
    "bindings": [
      { "name": "ROOMS", "class_name": "ChatRoom" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["ChatRoom"] }
  ],
  "d1_databases": [
    { "binding": "DB", "database_name": "ledger" }
  ],
  "kv_namespaces": [
    { "binding": "SESSIONS", "id": "sessions-prod" }
  ],
  "queues": {
    "producers": [ { "binding": "OUTBOX", "queue": "outbox" } ],
    "consumers": [ { "queue": "outbox", "max_batch_size": 32 } ]
  },
  "r2_buckets": [
    { "binding": "FILES", "bucket_name": "files" }
  ],
  "triggers": { "crons": ["*/5 * * * *"] },
  "worker_loaders": [ { "binding": "LOADER" } ],
  "containers": [
    { "class_name": "Sandbox", "image": "./Dockerfile",
      "instance_type": "basic", "max_instances": 4 }
  ]
}
```

### D1 is a cell

A D1 database is just a cell holding one SQLite database, replicated to the fleet bucket, so it inherits the fencing, replication, and durable acknowledgement of any Durable Object. **One database has one writer**; a fleet gets more capacity from more databases, never from a larger one. Migrations are `NNNN_description.sql` files in `migrations/` (the extension is case-insensitive, and a custom `migrations_dir` must be a relative path inside the project), applied in numeric order exactly as Wrangler does, in one transaction per file. The `celld d1` command runs SQL and migrations against a deployed database, signed with the fleet secret. Import from Cloudflare with `wrangler d1 export` then `celld d1 execute DATABASE --file export.sql`; a migration already applied does not run twice when the history arrives with the data. `dump()`, Time Travel, the D1 REST API, and the `wrangler d1` commands do not operate against celld. A SQLite `TEXT` value that is not valid UTF-8 decodes with U+FFFD, as workerd decodes it; store arbitrary bytes in `BLOB`.

### Cron, alarms, and WebAssembly

Cron triggers run the `scheduled` handler on celld's own durable alarms, one minute resolution in UTC, exactly once per occurrence fleet-wide. One handler runs at a time per script; a handler can run late but never early. A thrown handler is retried with backoff (starting at 4 seconds, doubling, abandoned after 6 failures, and only the expression that threw), and `controller.noRetry()` cancels the retry. Note the day-of-week convention: 1 is Sunday, the same as Cloudflare and opposite to most cron dialects. A service-binding target cannot run its own cron triggers.

Wasm imports give the compiled module (Wrangler's rule), uploaded beside the bundle and marked with the `wasm-v1` feature so a mixed fleet fails at deploy time. celld compiles each module once per process and reuses it across isolates; `worker-build` (workers-rs) produces a shim that is a normal `celld deploy` entry point. Prebuilt deployments work the same way: with `no_bundle: true` the entry JavaScript ships byte-for-byte and celld applies Wrangler's default `**/*.wasm` patterns below the entry's directory, so `main: "./dist/shim.mjs"` importing `"./add.wasm"` just works, without esbuild on the node.

## Designing applications around cells {#designing-cells}

The model pays off when you **divide the application into named, stateful units from the start**: one cell per user, per room, per agent, per document, per device. Because cells share no database, the classic distributed-system problems (locking, message buses, hot shards in a shared table) simply do not arise; the cell *is* the partition.

### The workloads the model fits

- **Real-time applications.** A multiplayer game, chat room, or collaborative document is one cell holding both the WebSocket connections and the room's state, with no lock and no external message bus. A single Durable Object can coordinate thousands of clients through the hibernation API.
- **Agents.** Each AI agent is one cell holding memory, schedule, and inbox in its own SQLite; an idle agent hibernates to the bucket, so a large agent fleet costs almost nothing between events.
- **Sharded web applications.** One cell per user or tenant shards the app from the start; the contention of one shared database never appears because no shared database exists. KV, Queues, D1, and R2 round out the toolbox for the parts that are not per-entity state.

### Entities, not processes

A cell models an **entity**: a named unit with state that persists indefinitely, such as a concert, a user, or a document. A durable-execution engine (Temporal, Restate, Azure Durable Functions) models a **process**: a sequence of steps that ends, such as an order pipeline. celld's Workflows implementation is the process primitive built on the entity primitive, and its replay semantics (see § 06) are exactly the tradeoff that primitive carries: steps must be idempotent, because a crash re-runs them. Pick the shape that matches the problem rather than the tool you have.

### A working cell

This is the whole application shape, a hibernating chat room with durable state:

```ts
import { DurableObject } from "cloudflare:workers";

export class ChatRoom extends DurableObject {
  async fetch(req: Request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);          // hibernatable — the room can sleep
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== ws) peer.send(message);      // one room, no message bus
    }
  }

  async alarm() {
    await this.ctx.storage.put("lastAlarm", Date.now());
    this.ctx.storage.setAlarm(Date.now() + 60_000);  // durable self-schedule
  }
}
```

### Operational rules of thumb

- **Batch WebSocket messages.** Each frame costs a context switch; pack many small logical messages into one frame with an envelope format. Fewer, larger messages beat many small ones.
- **Keep the constructor trivial.** It runs on every wake, including each message to a hibernated cell. Restore from `storage` in the handler, not the constructor.
- **Route a cell's traffic to its owner node when latency matters.** The versioned peer tunnel lets any node ingress any cell, but the warm path (zero bucket operations, p50 ≈ 1.1 ms) only exists when the request lands on the owner.
- **Outbound WebSocket connections do not survive a move.** An outbound DO socket keeps the cell resident and dies with the node/owner move; keep connection intent in storage and reconnect after activation. A WS transport cannot move to a new owner, so reconnect with a stable operation ID.
- **Make remote operations idempotent.** celld does not retry a proxied call after transmission starts. Use a stable operation ID and design handlers to tolerate a retry.
- **One writer per cell, per D1 database, per KV namespace, per queue.** Shard by adding entities, never by growing one.

> [!NOTE] Scale math
>
> Warm requests do zero bucket operations. A cold activation (restore from the bucket) is the only path that touches object storage, and a full restore is treated as ordinary work. Measured restore numbers were pending at the time of writing, but a ten-node fleet recovered every cell after stopping two nodes in ~11 s at the tail.

## Reliability, testing, and telemetry {#reliability}

celld stakes three promises, and its testing is organized around breaking them: *an acknowledged write is durable*, *a cell has one writer at a time*, and *code written for Cloudflare behaves the same on celld*. The engineering is unusually rigorous for a pre-1.0 project, and worth respecting on its merits.

### Four test layers

- **Differential conformance.** Each program runs twice, once on workerd and once on celld, identical bytes, and the outputs must be equal. A test cannot agree with celld's own runtime by accident.
- **Exhaustive specification.** The coordination protocol is specified in TLA+ and model-checked at small configuration, with pinned expected verdicts, most of them failures that model bugs the protocol once had, kept as a canary. The model found four bugs and a split-brain that lost an acknowledged write, none of which had surfaced in review or testing. The fencing argument itself is checked, not asserted.
- **Deterministic simulation.** The coordination logic is a pure decision core with no I/O; a seeded scheduler injects latency, CAS races, lost responses, drifting clocks, and crashes at every await point. Safety and liveness properties must survive tens of thousands of seeds; the core protocols have run through millions of schedules. They also test the checkers: deliberately broken protocol variants must be caught.
- **Live fleet lab.** Real VMs, a real bucket, fault injection between verification passes (SIGKILL mid-write and delete the local DB; freeze an owner and unfreeze it; cut a node off from the bucket; throttle the bucket to 429s; stop a full host). Every scenario's verification sweep found zero lost acknowledged writes.

<figure class="topology">
<svg aria-labelledby="f8-t f8-d" role="img" viewbox="0 0 880 460" xmlns="http://www.w3.org/2000/svg">
<title id="f8-t">Four test layers, from model to fleet</title>
<desc id="f8-d">Four rows, ordered from abstract to concrete. The TLA+ specification model-checks the coordination protocol at small scale with pinned verdicts and found four bugs and a split-brain that lost an acknowledged write. Deterministic simulation drives a pure decision core with a seeded scheduler that injects latency, CAS races, lost responses, drifting clocks, and crashes at every await, across tens of thousands of seeds per property and millions of schedules. Differential conformance runs each program on workerd and on celld with identical bytes and requires equal outputs. The live fleet lab injects faults on real VMs and a real bucket, and every verification sweep found zero lost acknowledged writes.</desc>
<defs>
<marker id="f8a" markerheight="7" markerwidth="7" orient="auto-start-reverse" refx="9" refy="5" viewbox="0 0 10 10">
<path d="M 0 0 L 10 5 L 0 10 z" style="fill:var(--ink-3, #7b8791)"></path>
</marker>
<marker id="f8c" markerheight="7" markerwidth="7" orient="auto-start-reverse" refx="9" refy="5" viewbox="0 0 10 10">
<path d="M 0 0 L 10 5 L 0 10 z" style="fill:var(--cobalt, #2a56a0)"></path>
</marker>
</defs>
<text class="m" font-size="8.5" font-weight="600" x="60" y="40" letter-spacing="1.2" style="fill:var(--ink-3, #7b8791)">LAYER</text>
<text class="m" font-size="8.5" font-weight="600" x="276" y="40" letter-spacing="1.2" style="fill:var(--ink-3, #7b8791)">WHAT IT DOES</text>
<text class="m" font-size="8.5" font-weight="600" x="668" y="40" letter-spacing="1.2" style="fill:var(--ink-3, #7b8791)">EVIDENCE</text>
<path d="M 30 60 L 30 368" fill="none" marker-end="url(#f8a)" stroke-width="1.3" style="stroke:var(--ink-3, #7b8791)"></path>
<text class="m" font-size="8.5" text-anchor="middle" x="30" y="52" style="fill:var(--ink-3, #7b8791)">abstract</text>
<text class="m" font-size="8.5" text-anchor="middle" x="30" y="384" style="fill:var(--ink-3, #7b8791)">concrete</text>
<rect height="68" rx="4" stroke-width="1.2" width="196" x="60" y="56" style="fill:var(--plate, #e6ebeb);stroke:var(--ink-2, #4a5763)"></rect>
<text class="m" font-size="10.5" font-weight="600" text-anchor="middle" x="158" y="78.5" style="fill:var(--ink, #1b252e)">TLA+ specification</text>
<text class="m" font-size="9" text-anchor="middle" x="158" y="93.5" style="fill:var(--ink-2, #4a5763)">the protocol, as a model</text>
<text class="m" font-size="9" text-anchor="middle" x="158" y="108.5" style="fill:var(--ink-2, #4a5763)">checked at small scale</text>
<text class="f" font-size="12" x="276" y="78" style="fill:var(--ink, #1b252e)">The fencing argument is checked, not asserted</text>
<text class="m" font-size="9" x="276" y="98" style="fill:var(--ink-2, #4a5763)">pinned expected verdicts; most are failures that model</text>
<text class="m" font-size="9" x="276" y="113" style="fill:var(--ink-2, #4a5763)">bugs the protocol once had, kept as a canary</text>
<rect height="68" rx="4" stroke-width="1.4" width="194" x="668" y="56" style="fill:var(--paper-2, #ebeee9);stroke:var(--cobalt, #2a56a0)"></rect>
<text class="m" font-size="9.5" font-weight="600" text-anchor="middle" x="765" y="79.5" style="fill:var(--cobalt, #2a56a0)">4 bugs + a split-brain</text>
<text class="m" font-size="9" text-anchor="middle" x="765" y="93.5" style="fill:var(--ink-2, #4a5763)">the split-brain lost an</text>
<text class="m" font-size="9" text-anchor="middle" x="765" y="107.5" style="fill:var(--ink-2, #4a5763)">acknowledged write</text>
<path d="M 60 130 L 862 130" fill="none" stroke-dasharray="2 4" stroke-width="1" style="stroke:var(--rule, #d3d9d4)"></path>
<rect height="68" rx="4" stroke-width="1.2" width="196" x="60" y="136" style="fill:var(--plate, #e6ebeb);stroke:var(--ink-2, #4a5763)"></rect>
<text class="m" font-size="10.5" font-weight="600" text-anchor="middle" x="158" y="158.5" style="fill:var(--ink, #1b252e)">Deterministic simulation</text>
<text class="m" font-size="9" text-anchor="middle" x="158" y="173.5" style="fill:var(--ink-2, #4a5763)">a pure decision core</text>
<text class="m" font-size="9" text-anchor="middle" x="158" y="188.5" style="fill:var(--ink-2, #4a5763)">with no I/O</text>
<text class="f" font-size="12" x="276" y="158" style="fill:var(--ink, #1b252e)">A seeded scheduler injects a fault at every await</text>
<text class="m" font-size="9" x="276" y="178" style="fill:var(--ink-2, #4a5763)">latency · CAS races · lost responses · drifting clocks · crashes</text>
<text class="m" font-size="9" x="276" y="193" style="fill:var(--ink-2, #4a5763)">safety and liveness must hold for every seed</text>
<rect height="68" rx="4" stroke-width="1.4" width="194" x="668" y="136" style="fill:var(--paper-2, #ebeee9);stroke:var(--cobalt, #2a56a0)"></rect>
<text class="m" font-size="9.5" font-weight="600" text-anchor="middle" x="765" y="159.5" style="fill:var(--cobalt, #2a56a0)">millions of schedules</text>
<text class="m" font-size="9" text-anchor="middle" x="765" y="173.5" style="fill:var(--ink-2, #4a5763)">tens of thousands of</text>
<text class="m" font-size="9" text-anchor="middle" x="765" y="187.5" style="fill:var(--ink-2, #4a5763)">seeds per property</text>
<path d="M 60 210 L 862 210" fill="none" stroke-dasharray="2 4" stroke-width="1" style="stroke:var(--rule, #d3d9d4)"></path>
<rect height="68" rx="4" stroke-width="1.2" width="196" x="60" y="216" style="fill:var(--plate, #e6ebeb);stroke:var(--ink-2, #4a5763)"></rect>
<text class="m" font-size="10.5" font-weight="600" text-anchor="middle" x="158" y="238.5" style="fill:var(--ink, #1b252e)">Differential conformance</text>
<text class="m" font-size="9" text-anchor="middle" x="158" y="253.5" style="fill:var(--ink-2, #4a5763)">workerd vs celld</text>
<text class="m" font-size="9" text-anchor="middle" x="158" y="268.5" style="fill:var(--ink-2, #4a5763)">on identical bytes</text>
<text class="f" font-size="12" x="276" y="238" style="fill:var(--ink, #1b252e)">Each program runs twice, and the outputs must match</text>
<text class="m" font-size="9" x="276" y="258" style="fill:var(--ink-2, #4a5763)">once on workerd (Cloudflare's runtime), once on celld</text>
<text class="m" font-size="9" x="276" y="273" style="fill:var(--ink-2, #4a5763)">a test cannot agree with celld's own runtime by accident</text>
<rect height="68" rx="4" stroke-width="1.4" width="194" x="668" y="216" style="fill:var(--paper-2, #ebeee9);stroke:var(--cobalt, #2a56a0)"></rect>
<text class="m" font-size="9.5" font-weight="600" text-anchor="middle" x="765" y="239.5" style="fill:var(--cobalt, #2a56a0)">equal outputs</text>
<text class="m" font-size="9" text-anchor="middle" x="765" y="253.5" style="fill:var(--ink-2, #4a5763)">the two runs must agree</text>
<text class="m" font-size="9" text-anchor="middle" x="765" y="267.5" style="fill:var(--ink-2, #4a5763)">on every program</text>
<path d="M 60 290 L 862 290" fill="none" stroke-dasharray="2 4" stroke-width="1" style="stroke:var(--rule, #d3d9d4)"></path>
<rect height="68" rx="4" stroke-width="1.2" width="196" x="60" y="296" style="fill:var(--plate, #e6ebeb);stroke:var(--ink-2, #4a5763)"></rect>
<text class="m" font-size="10.5" font-weight="600" text-anchor="middle" x="158" y="318.5" style="fill:var(--ink, #1b252e)">Live fleet lab</text>
<text class="m" font-size="9" text-anchor="middle" x="158" y="333.5" style="fill:var(--ink-2, #4a5763)">real VMs</text>
<text class="m" font-size="9" text-anchor="middle" x="158" y="348.5" style="fill:var(--ink-2, #4a5763)">and a real bucket</text>
<text class="f" font-size="12" x="276" y="318" style="fill:var(--ink, #1b252e)">Faults are injected between verification passes</text>
<text class="m" font-size="9" x="276" y="338" style="fill:var(--ink-2, #4a5763)">SIGKILL mid-write + delete the local DB · freeze an owner</text>
<text class="m" font-size="9" x="276" y="353" style="fill:var(--ink-2, #4a5763)">cut a node off the bucket · throttle to 429s · stop a host</text>
<rect height="68" rx="4" stroke-width="1.4" width="194" x="668" y="296" style="fill:var(--paper-2, #ebeee9);stroke:var(--cobalt, #2a56a0)"></rect>
<text class="m" font-size="9.5" font-weight="600" text-anchor="middle" x="765" y="319.5" style="fill:var(--cobalt, #2a56a0)">0 lost acknowledged writes</text>
<text class="m" font-size="9" text-anchor="middle" x="765" y="333.5" style="fill:var(--ink-2, #4a5763)">in every scenario's</text>
<text class="m" font-size="9" text-anchor="middle" x="765" y="347.5" style="fill:var(--ink-2, #4a5763)">verification sweep</text>
<rect height="54" rx="4" stroke-width="1.2" width="852" x="14" y="394" style="fill:var(--plate, #e6ebeb);stroke:var(--cobalt, #2a56a0)"></rect>
<text class="m" font-size="10" text-anchor="middle" x="440" y="416" style="fill:var(--ink, #1b252e)">celld stakes three promises: an acknowledged write is durable · one writer per cell · Cloudflare code behaves the same</text>
<text class="f" font-size="12.5" text-anchor="middle" x="440" y="436" style="fill:var(--ink-2, #4a5763)">The checkers are tested too: a deliberately broken protocol variant must be caught by the simulation.</text>
</svg>
<figcaption>celld's four test layers, ordered from the protocol as a model to the running fleet. The evidence column is what each layer reported, not a coverage claim, and the simulation's own checkers are tested against deliberately broken protocol variants.</figcaption>
</figure>


### Numbers with their conditions

| Measurement | Result |
|----|----|
| Epoch fence under contention | 500 claimants, 5,500 attempts, one writer per epoch, zero violations |
| Warm resident request | zero bucket operations; p50 ≈ 1.1 ms, p99 ≈ 7 ms (fixed host) |
| Durable write | one bucket round trip with bucket proof; a fleet proof (≥2 nodes) answers on follower fsync. v0.3.0 measured 10× lower write latency and 100× fewer Class A S3 ops |
| Concurrent writes to one cell | join a single shared upload, so throughput is not one round trip per write |
| Scale (measured) | 10 nodes × 4 vCPU / 8 GB held 10,000 resident cells + 20,000 concurrent WebSockets |
| Node failure | stopping 2 of 10 nodes: every cell's data available again in ~11 s at the tail |
| Queue throughput | one queue sustained 7,357 sends/s over a 300,000-send soak with exact delivery (up from a few hundred before the v0.4.1 producer rebuild) |
| Whole-fleet restart | nodes that restart together recover acknowledged writes: a restarting node serves follower fragments while recovering its predecessor, with checkpoints and a heartbeat so a retry skips finished work |

> [!CAUTION] Caveat · the reserve edge
>
> The known edge is headroom: a fleet filled to its resident limit has no space for a lost node's cells, so losing more than one node at the limit degrades the service, and a fleet with headroom does not. Balancing narrows this but does not remove it: it counts cells by node weight rather than by the CPU or memory a cell actually uses, and it moves only hibernated cells.

### Telemetry

Telemetry is off by default and costs nothing until `CELLD_OTEL` is set; that one variable also picks the sink. `CELLD_OTEL=1` writes **Parquet** files to the fleet bucket under the `telemetry/` prefix, partitioned by node and hour, so a fleet with a bucket has observability with no other service; DuckDB queries the files directly. `CELLD_OTEL=https://collector.internal:4318` (a full HTTP(S) base URL) sends the same data as OTLP/HTTP protobuf instead, with `/v1/traces` and `/v1/logs` appended; celld does not read `OTEL_EXPORTER_OTLP_ENDPOINT`. The OTLP exporter retries a batch up to five times with jittered backoff (honoring `Retry-After`, 30 s cap) on 408/429/502/503/504, drops it on a permanent refusal, and bounds its buffer at 8,192 events so a collector outage cannot grow memory; new telemetry is dropped and counted rather than blocking requests. Spans cover each request, cell event (fetch, alarm, RPC, WebSocket message), outbound `fetch()`, and cell start, plus every `console.log` as a log record joined to its trace. W3C `traceparent` is read and emitted (a malformed one starts a new trace), so traces join the systems in front of and behind celld.

```sql
CREATE VIEW traces AS SELECT * FROM
  read_parquet('s3://YOUR-BUCKET/telemetry/traces/*/*/*/*/*/*.parquet');

SELECT name, duration_us, trace_id FROM traces
  ORDER BY duration_us DESC LIMIT 20;
```

Defaults: 5-minute / 5 MB flush (the byte threshold is an estimate, so a batch can slightly overshoot it), 30-day retention swept at startup and every six hours (`none` hands lifecycle to your own rules), `OTEL_TRACES_SAMPLER` for fractional sampling with a consistent per-trace decision across nodes. For a near-live view, set `CELLD_OTEL_FLUSH_MS=5000` and run the one-hour compaction job on a maintenance node; a short flush without compaction makes DuckDB open thousands of small files. There are no metrics yet. That is a named gap, and the span durations cover most of what a metric would answer.

## Security boundaries {#security}

celld is a beta, and it says so plainly: **not safe for hostile multi-tenant use**, and security fixes apply to the latest release only. The threat model is single-tenant with a trusted operator. Within that, the boundaries are explicit.

- **Two listeners.** The public Worker listener (`--listen`) is the only thing a load balancer or firewall should expose; it reserves `/.well-known/celld/health` and hands every other path to the Worker. The internal listener (`--internal-listen`) carries the peer protocol and the operator API and must stay on a private network or encrypted overlay. Most of the operator API is unauthenticated: anyone who can reach it can inspect state, evict cells, or stop the process. The one exception is the D1 route, which authenticates with the fleet secret because it runs caller-supplied SQL.
- **The bucket is the root of authority.** It holds deployments, cell state, ownership records, node leases, the shared peer-authentication secret, large KV values, and R2 objects. Scope credentials to one bucket, use a prefix to share a bucket safely, and rotate on any suspicion of disclosure.
- **One writer per cell.** The epoch fences each cell; a node that loses its lease cannot modify current cell state. Peer requests authenticate with HMAC, body signature, clock limit, and replay protection, but the peer tunnel carries plain HTTP for cell fetch/RPC, so **the private network or encrypted overlay is the confidentiality boundary**, not the protocol.
- **No TLS termination.** Put public TLS in your ingress proxy and use WireGuard/Tailscale for the internal plane. By default celld ignores `X-Forwarded-Host`/`X-Forwarded-Proto`; set `--trust-forwarded-headers` only behind a trusted proxy that rewrites both, and it reads the last value so a direct client can't spoof it.
- **Application auth is yours.** celld does not authenticate your application's users and does not enforce per-cell quotas; a defective cell can only touch its own database, but it can consume resources on its fleet node. Enforce request limits yourself via `CELLD_MAX_REQUEST_BODY_BYTES` and `CELLD_MAX_CELL_REQUESTS`.
- **Egress is your network's job.** Outbound TCP (`cloudflare:sockets`) verifies TLS against a bundled Mozilla root store, but celld does not block the ports Cloudflare blocks. Containers get an nftables-fenced bridge (`enableInternet: true` reaches the Internet only, never the node, its peers, or private ranges), but that fence is experimental by the docs' own label, and macOS `celld dev` keeps container egress on with a warning. Internal host functions are not exposed to application code.

> [!CAUTION] Caveat · operator API is release-changeable
>
> `/state`, `/cell/`, `/evict/`, `/do/`, `/__d1/`, `POST /reload`, `POST /shutdown`, and `POST /rebalance/pause` / `/resume` are a release-changeable interface. Keep operator tooling and the celld release together, and never point the internal listener at the public internet.

## Tradeoffs and a verdict {#tradeoffs}

|  | Cloudflare Durable Objects | celld |
|----|----|----|
| Placement | vendor scheduler, opaque | your fleet; ownership = a lease in your bucket |
| State & durability | platform DO storage | SQLite replicated as LTX to your bucket, RPO=0 (bucket or fleet proof) |
| Failure domain | shared platform (tenant-coupled) | your nodes + your bucket provider |
| Data services | KV, Queues, D1, R2, Workflows on the platform | all five graded Yes, backed by your bucket / cells |
| Containers & sandboxes | Cloudflare Containers, Sandbox SDK | Experimental: a Docker/Podman engine per node, images in your bucket, an nftables-fenced bridge |
| Placement balance | platform scheduler | weight-proportional balancing of hibernated cells, pausable fleet-wide |
| Multi-tenancy | platform | not yet; one application per fleet |
| Deployments | instant, platform-managed | adopt in place without restart; module digests verified; one app per fleet |
| Observability | Cloudflare dashboard | Parquet in your bucket + DuckDB, or OTLP |
| Write latency | platform-managed | one bucket round trip (single node) or follower fsync (fleet) |
| Ingress / TLS | platform | your proxy; peers over Tailscale/WireGuard |
| Correctness claims | platform SLA | explicit + tested: TLA+, simulation, differential conformance |

What celld buys you is **placement and blast radius you choose**: no shared Durable Objects scheduler can couple your application to another customer's workload, and when a cell misbehaves the evidence is on your disk (ownership records, SQLite and LTX files, logs), answerable with `sqlite3` and `grep` rather than a status page. It buys RPO=0 as a hard guarantee, which most self-hosted setups cannot claim, and it buys portability: the same Worker/DO code runs on workerd or on your fleet. KV, Queues, Workflows, and R2 close most of the "different primitive" gap; facets, HTMLRewriter, TCP sockets, and full Web Crypto close most of the runtime-API gap; and containers and sandboxes supervised by a Durable Object, on your own nodes, open a gap in celld's favor. The toolbox for building a full application on cells exists, not just the entity primitive.

What it costs is operational ownership. Balancing moves only hibernated cells and counts them by node weight. Updates are manual behind a `current` pointer. Cold restores touch object storage (paged, for a large cell). A durable write costs at least a follower fsync and eventually a bucket upload. The store must be on the qualified list: a wrong store fails the startup probe, which cannot be disabled, and a store that silently ignores conditional writes or ranged reads fails late and dangerously. The compatibility surface is still a strict subset of Cloudflare's. The platform services (AI, Vectorize, Hyperdrive, Browser Rendering, Email, Python) are absent, the Cache API is an always-miss, and KV/Queues/Workflows/R2 keep real gaps (no edge cache, 4-day fixed queue retention, multipart that cannot resume). Containers are experimental with a self-declared movable security boundary. The beta label changes none of the caveats: one application per fleet, no Windows, an operator API that can change between releases, full-stop upgrades (v0.4.1→v0.5.0 with no binary rollback, and v0.5.1→v0.6.0 under fleet durability), and WS transports that cannot move between owners. One semantic changed under running applications in v0.6.0 and deserves a check in any code that relies on it: a facet write does not commit atomically with the root object's transaction.

> [!TLDR] The verdict for practical use: the model is the best primitive in distributed systems right now, and celld's engineering discipline (TLA+, seeded simulation, differential conformance, live fault injection) is more rigorous than many production platforms. celld is a credible self-hosted platform for stateful serverless: the data-service toolbox exists, the fleet balances itself, large cells restore page by page, a cell can supervise a container, and celld itself has stopped calling it an alpha. It is ready for a team that wants DO semantics on its own infrastructure and can own the ops: agent fleets (with sandboxes), per-tenant sharding, real-time rooms, self-hosted stateful services. It is still not for hostile multi-tenancy, zero-ops, or anything that needs the full managed platform surface. Treat it as an unusually well-proven beta: pin releases, respect the upgrade cliffs (v0.5.0 is a full stop with a written procedure, and v0.6.0 is one under fleet durability), run under a supervisor, and re-check the compatibility page when you plan a release bump.

## Glossary {#glossary}

The terms this series uses, each defined once and used the same way in all six parts. The last column names the section that explains it.

| Term | Meaning | See |
|----|----|----|
| **Actor** | A unit of computation with private state that interacts only by asynchronous messages. In response to a message it can send messages, create actors, and choose its behavior for the next message. | [Part 0 § 04](celld-00-background#actors) |
| **Binding** | A permission and an API in one object on `env`, through which a Worker reaches a platform resource with no credential in its code. | [Part 0 § 02](celld-00-background#workers) |
| **Bucket proof** | The durability proof with one node: the write waits for one storage round trip to the bucket before it is acknowledged. | [§ 03](#bucket-coordinator) |
| **Cell** | A Durable Object instance: a small server with a name and a private SQLite database. One per user, document, room, or agent. | [§ 02](#cell-model) |
| **Durability mode** | `CELLD_DURABILITY`: `fleet` (the default) acknowledges on a fleet proof, `bucket` on a bucket proof. A single node falls back to bucket proof. | [§ 03](#bucket-coordinator) |
| **Durable execution** | Code that survives crashes: each step's result is recorded in a persistent log, and after a failure the code is replayed with recorded steps answered from the log. | [Part 0 § 05](celld-00-background#durable-execution) |
| **Ensemble** | A cell's owner together with the followers it sends each write to. | [§ 03](#bucket-coordinator) |
| **Entity** | A named unit whose state persists indefinitely, such as a user, room, or document. A cell is an entity; contrast *process*. | [Part 0 § 06](celld-00-background#entities-processes) |
| **Epoch** | The fencing number in an ownership record. Every activation advances it, and replicated data is written under an epoch prefix, `cells/<cell>/ltx/e<epoch>/`. | [§ 04](#fencing) |
| **Facet** | A child object attached to a Durable Object through `ctx.facets`, with its own SQLite database and replication stream, sharing the root's ownership record and epoch. | [§ 06](#cloudflare-surface) |
| **Fleet** | The set of nodes sharing one fleet bucket. | [§ 03](#bucket-coordinator) |
| **Fleet bucket** | The object-storage bucket a fleet shares. It holds deployments, cell state, ownership records, node leases, and R2 objects, and it is the root of authority. | [§ 03](#bucket-coordinator) |
| **Fleet proof** | The durability proof with two or more nodes: the write is acknowledged once every follower has it on disk, and the bucket upload finishes afterwards. | [§ 03](#bucket-coordinator) |
| **Follower** | A node, never the owner itself, that receives a cell's writes for a fleet proof. The owner picks one or two. | [§ 03](#bucket-coordinator) |
| **Hibernated** | A cell evicted from memory whose hibernatable WebSocket clients stay connected and which stays on its node. Balancing moves only hibernated cells. | [§ 02](#cell-model) |
| **Inactive** | A cell no node holds: only an object in the bucket. Every cell starts inactive. | [§ 02](#cell-model) |
| **Input gate** | Cloudflare's rule that no new event reaches an object while one of its storage operations is in flight. celld gets the same effect from synchronous storage calls. | [Part 0 § 03](celld-00-background#durable-objects) |
| **Internal listener** | The node listener for the peer protocol and the operator API (`--internal-listen`). It must stay on a private network or encrypted overlay. | [§ 09](#security) |
| **Isolate** | A V8 sandbox with its own memory and variables. One runtime process hosts many isolates, which is what makes Workers start fast. | [Part 0 § 02](celld-00-background#workers) |
| **Local store** | The on-disk store `celld dev` uses, in `.celld/dev` under the project. Fleet nodes cannot select it; fleets require a qualified cloud bucket. | [§ 05](#running-fleet) |
| **LTX segment** | Litestream's replica format, in which celld ships each cell's SQLite state to the bucket. | [§ 03](#bucket-coordinator) |
| **Node** | One celld process. | [§ 03](#bucket-coordinator) |
| **Node lease** | A node's record in the bucket with an expiry (`CELLD_TTL_MS`), renewed after one third of its lifetime. A node that cannot renew it fences itself. | [§ 04](#fencing) |
| **Output gate** | The rule that holds each write response until a durability proof covers it, applied in one order across responses, outbound calls, Queue deliveries, and WebSocket sends. | [§ 04](#fencing) |
| **Owner** | The node session an ownership record names: the only one that may run the cell. | [§ 04](#fencing) |
| **Ownership balancing** | How the fleet evens out ownership without a coordinator: the node with the most owned cells per unit of weight hands hibernated cells to the peer furthest below its share. | [§ 05](#running-fleet) |
| **Ownership record** | The one record per cell in the bucket that names its owner and epoch, acquired with a conditional write. | [§ 04](#fencing) |
| **Paged restore** | Restoring a large cell page by page through a fault-in SQLite VFS that reads each page from the bucket on first use. | [§ 03](#bucket-coordinator) |
| **Peer tunnel** | The versioned plain-HTTP tunnel that carries every proxied cell call (fetch, RPC, WebSocket) from the node that took the request to the owner. | [§ 04](#fencing) |
| **Process** | A sequence of steps that starts, runs, and finishes, such as an order pipeline. A workflow is a process; contrast *entity*. | [Part 0 § 06](celld-00-background#entities-processes) |
| **Replay** | Re-running durable code from the start, answering each completed step from the log. It requires deterministic control flow and idempotent steps. | [Part 0 § 05](celld-00-background#durable-execution) |
| **Resident** | A cell in memory: *active* while it does work, *idle* while it waits. | [§ 02](#cell-model) |
| **RPO=0** | No acknowledged write is lost: celld does not answer a write until the data survives a failure. | [§ 03](#bucket-coordinator) |
| **Self-fence** | A node whose lease expiry passes stops its cells, fails incomplete requests, logs `SELF-FENCE:`, and exits with code 3. | [§ 04](#fencing) |
| **Virtual actor** | An actor that always exists logically, is activated on demand and deactivated when idle, and is addressed by identity rather than location (an Orleans *grain*). A Durable Object is one. | [Part 0 § 04](celld-00-background#actors) |

<!-- series-only -->
------------------------------------------------------------------------

*Sources: celld.dev (docs, what celld guarantees, Cloudflare compatibility, limitations, security, telemetry, testing, WebAssembly) at the v0.6.0 tag of `denoland/celld`, the v0.4.1 through v0.6.0 release notes, and developers.cloudflare.com (Durable Objects overview, WebSockets hibernation, alarms). First written 2026·08·30 for v0.4.0 (2026·08·28); revised 2026·09·15 for v0.5.0 and the intervening v0.4.1; revised 2026·09·21 for v0.5.1 (2026·09·19) and the per-service documentation pages; revised 2026·09·26 for v0.6.0 (2026·09·26); rewritten 2026·09·27 as one description of v0.6.0 with the release history consolidated in § 05. celld is a beta, so verify current behavior against the installed release.*
<!-- /series-only -->
