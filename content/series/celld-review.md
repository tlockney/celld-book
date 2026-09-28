---
title: "celld Review Sheet and Self-Quiz"
dek: "The compressible tenth of the celld series on one page, then twenty-six questions that each target a documented misconception. Every fact and every answer comes from the series itself, at celld v0.6.0."
kind: "Review Sheet"
meta:
  Status: "Review · v0.6.0"
  Source: "The celld series + celld.dev docs"
  Updated: "2026·09·27"
series: "celld"
series_parts:
  - title: "Part 0—Actors, Durable Objects, and durable execution"
    href: "celld-00-background"
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
section_label: "§"
---

## How to use this sheet {#use}

Part A is for looking things up: the rules and numbers you reach for while building or operating, compressed from Part 1 and Part 2. Part B is for testing yourself after reading the series. Each question targets a mistake the series warns about; answer it in your head, then check the answer in § 04. Each answer names the place in the series that explains it.

> [!NOTE] Scope · celld v0.6.0
>
> Everything here describes celld v0.6.0, the release the series is written against. Limits and defaults move between releases; <!-- series-only -->Part 1 § 05's release notes record what changed and when.<!-- /series-only --><!-- book-only -->[Appendix C](release-notes.html) records what changed and when.<!-- /book-only -->

## Part A · Quick reference {#reference}

### The compatibility line

**If Cloudflare builds a function on Durable Objects, celld can carry it.** A configuration or binding that is not available must fail loudly, at deploy or first use; a silent gap is a bug.

| Carried (graded *Yes*) | Not carried |
|----|----|
| Workers, Durable Objects, facets, static assets, cron, Dynamic Workers, KV, Queues, D1, Workflows, R2 | Workers AI, Vectorize, Hyperdrive, Browser Rendering, Email, Python Workers, BroadcastChannel |
| Containers and the Sandbox SDK: *Experimental* | Cache API: *Partial*, an always-miss cache |

Part 1 § 01 and § 06 have the full surface.

### Durability: which proof acknowledges a write

A write is acknowledged only once it survives a failure (**RPO=0**). What proves it depends on the fleet:

| Fleet | Proof | What the write waits for |
|----|----|----|
| One node | **Bucket proof** | One storage round trip to the bucket |
| Two or more nodes | **Fleet proof** | Every follower (one or two, never the owner) has fsynced it; the bucket upload finishes afterwards |

`CELLD_DURABILITY` selects the mode: `fleet` (the default) or `bucket`. A single node that asks for `fleet` falls back to bucket proof. A fleet of three or more nodes holds three copies of an acknowledged write. Part 1 § 03.

### One writer, everywhere

| Unit | Rule |
|----|----|
| Cell | One owner node at a time, fenced by the epoch in its ownership record |
| D1 database | One writer; more capacity means more databases, never a bigger one |
| KV namespace | One writer; add namespaces, not writers |
| Queue | One writer, and one consumer script |

Shard by adding entities, never by growing one. Part 1 § 07.

### Environment variables

Copied from Part 1 § 05.

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
| `CELLD_TTL_MS` | Node-lease lifetime (default 10,000 ms). |
| `CELLD_OPERATION_DEADLINE_MS` | Deadline for a non-restore operation (default 15,000). |
| `CELLD_DEPLOY_POLL_S` / `CELLD_DEPLOY_MAX_AGE_S` | Deployment-adoption poll interval (30s) and forced-move age (60s). |
| `CELLD_SHUTDOWN_TOTAL_MS` / `CELLD_RELEASES` | Total stop bound (40s; the drain-token wait and no-progress bound derive from it) and concurrent handoffs (default 128). |
| `CELLD_LTX_COMPACTION` | 1 (default) creates additive L1 objects so a takeover reads tens of objects instead of thousands. |
| `CELLD_LTX_PAGED` / `CELLD_LTX_PAGED_MIN_MB` / `CELLD_LTX_HYDRATE_MBPS` | Paged restore (default on) for chains above the threshold (default 256 MiB), and the background fill rate for the paged file (default 16; 0 keeps it sparse). |
| `CELLD_RECOVERY_RETRY_MS` / `CELLD_RECOVERY_RETRIES` | Node-log recovery retry pacing (defaults 1,000 and 240); recovery reads bundles in 512 MiB windows and checkpoints every 32 cell epochs. |
| `CELLD_WAKER_TICK_MS` | Interval of the fleet waker's alarm cleanup pass (default 60,000). |
| `CELLD_ALARM_RESIDENT_MS` | How close to its next alarm a cell (a Workflow instance, say) stays resident rather than hibernating (default one hour). |
| `CELLD_DOCKER` / `CELLD_CONTAINER_PLATFORM` / `CELLD_CONTAINER_RUNTIME` | Containers: the container CLI used to build and pull (default `docker`; Podman works), the deploy build platform (default `linux/amd64`), and a node-wide OCI runtime such as `runsc` or `kata`. |
| `CELLD_OTEL` | `0` off, `1` Parquet to the bucket, or an OTLP/HTTP collector base URL. |
| *Rejected at startup* | `CELLD_OUTPUT_GATE` (the gate is always on; celld always waits for the configured durability proof), `CELLD_STORAGE_PROBE`, `CELLD_SHUTDOWN_DRAIN_MS`, `CELLD_DRAIN_TOKEN_WAIT_MS`, `CELLD_WORKER_LOADER`, `CELLD_MAX_LOADED_WORKERS`, `CELLD_OTEL_SINK`, `CELLD_AI_BINDING`, `CELLD_AI_URL`, `CELLD_REBALANCE_BATCH_CELLS`, and a handful of older tuning knobs. A node with any of them set does not start. |

### Upgrade cliffs

Seven documented transitions. A full stop means stop every old node before starting any new one.

| Transition | Rule |
|----|----|
| v0.1.0 → v0.2.0 | Full stop |
| v0.2.1 → v0.3.0 | Rolling; never start a v0.2.x binary after v0.3.0 has run unless the shutdown log shows `node-log close: sealed epoch` |
| v0.3.0 → v0.4.0 | Full stop |
| v0.4.0 → v0.4.1 | Rolling; never start a v0.4.0 binary once the fleet begins paging |
| v0.4.1 → v0.5.0 | Full stop, with a written procedure; the only rollback is the stopped-fleet backup |
| v0.5.0 → v0.5.1 | Rolling |
| v0.5.1 → v0.6.0 | Full stop under `fleet` durability; rolling under `bucket` |

**Never roll back by starting an old binary against an upgraded bucket.** Part 1 § 05 has each transition's reason and the v0.5.0 procedure.

### Limits worth memorizing

| Area | Limit |
|----|----|
| Isolate heap | 128 MB V8 heap by default (`CELLD_V8_HEAP_LIMIT_MB`); `acceptWebSocket()` throws past 90% |
| WebSocket input | 1 MiB per-isolate input budget per non-terminal frame |
| Workflows | Step result, event payload, and workflow parameters each at most 1 MiB; non-step work pending at most 60 s; instances kept 30 days by default |
| `step.do()` defaults | 5 retries, 10-second delay, exponential backoff, 10 minutes per attempt |
| D1 | Results capped at 100,000 rows / 32 MiB per binding result |
| Queue messages | At most 128,000 bytes each; `sendBatch()` at most 100 messages and 256,000 bytes; `delaySeconds` up to 86,400 |
| Queue retention | Four days, not configurable |
| Queue consumer | `max_batch_size` 10 (max 100), `max_batch_timeout` 5 s (max 60), `max_retries` 3, `max_concurrency` up to 250 |
| KV | Key at most 512 bytes; value at most 25 MiB; metadata at most 1,024 bytes; a value above 1 MiB needs the fleet bucket |
| R2 | A conditional write cannot stream a body above 8 MiB; `delete(keys)` takes up to 1,000 keys |
| Dynamic Workers | At most 256 live per process, 255 per script generation; module sources at most 64 MiB |

The KV key, value, and metadata limits come from the [celld.dev KV service page](https://celld.dev/docs/services/kv/); the rest are in Part 1 § 06 and Part 2.

### Fail loudly

celld's rule for everything it does not model is to refuse it where you will see it. For deploys, that means:

- **An unknown Wrangler key stops the deploy** with an error naming the key (`routes`, for example).
- **A binding celld does not carry fails** at deploy or on first use, never silently.
- **Queue consumer settings are validated at deploy time**, so a bad value fails the deployment rather than the first delivery.
- **Two scripts consuming one queue** is a deployment that fails.
- **A node with a rejected environment variable set does not start**, and a store that fails the startup probe's contract checks stops the node.

## Part B · Self-quiz {#quiz}

Answer each in a sentence or two, then check § 04.

### The model

1. What is a cell, in Cloudflare's terms, and what does it own?
2. A handler reads a counter, awaits an outbound `fetch()`, then writes the counter back. Why does this lose updates under concurrent requests, and what are the two fixes?
3. Must you `await` a storage write before responding, to be sure the client never sees an unpersisted success?
4. What exactly survives hibernation, and what does not?
5. Is idle eviction on by default, and why does the answer matter for balancing?
6. Which primitive models an entity, and which models a process?

### Durability and fencing

7. What proves a write durable on a one-node fleet, and on a fleet of two or more nodes?
8. What does `CELLD_DURABILITY=fleet` do on a single node?
9. How does a node acquire a cell, and what does every activation do to the epoch?
10. Why does the ownership check read the ownership record instead of comparing clocks?
11. What does a node do when it can no longer renew its node lease?

### The bucket

12. Which stores are fleet-qualified, and what does the startup storage probe actually test?
13. Can you turn the storage probe off?
14. What does the bucket hold, and why does that make its credentials special?

### Operating a fleet

15. Which cells does ownership balancing move, and how is a node's share decided?
16. How do you upgrade a fleet from v0.5.1 to v0.6.0?
17. After upgrading to v0.5.0, how do you roll back?

### Services

18. Does KV on celld have an edge cache?
19. A queue message fails more than `max_retries` times and the consumer names no dead-letter queue. What happens, and how long does celld wait between attempts?
20. What happens to a deployment in which a declared queue consumer's script has no `queue()` handler?
21. Two R2 objects hold identical bytes. Do they have the same `version` on the fleet bucket, and on `celld dev`'s local store?
22. How do you give a browser a public link to an object in an R2 binding?
23. Why must a facet write never be assumed to commit with the root object's transaction?
24. A workflow sleeps durably, then continues. Is that resumption the same mechanism as recovery after a crash?
25. In a cron expression on celld, what day is day-of-week 1?
26. You ship a D1 migration file with `celld dev`. Is the table there afterwards?

## Answers {#answers}

Each answer is collapsed. Open one only after answering it.

<details>
<summary>1. What a cell is</summary>

A cell is a Durable Object instance: a small server with a name and a private SQLite database. It serves HTTP, holds WebSocket connections, sets alarms, and makes outbound connections. Part 1 § 02.

</details>

<details>
<summary>2. The lost update</summary>

One thread per cell means two requests never run at the same instant, but a second request can interleave while the first *awaits* anything that is not a storage call. Both requests read the same old value and both write value + 1. Fix it by keeping the read-modify-write free of non-storage awaits (storage calls are synchronous and never interleave), or by wrapping the work in `blockConcurrencyWhile()`. Notebook 1 Part 2 shows ten racy increments all returning 1, and the gated version returning 1 through 10. Part 1 § 02.

</details>

<details>
<summary>3. Awaiting writes</summary>

No. The **output gate** holds each write response, and every outbound effect, until a durability proof covers the write. A client cannot see a success for a write that was not made durable. Part 1 § 04; Part 0 § 03.

</details>

<details>
<summary>4. What survives hibernation</summary>

Two things separate a hibernated cell from a cold one: its hibernatable WebSocket clients stay connected, and it stays on its node. Memory does not survive. The constructor runs again on every wake, including each message to a hibernated room, so restore state from storage inside the handler and keep the constructor trivial. Part 1 § 02; Notebook 3 Part 2.

</details>

<details>
<summary>5. Idle eviction</summary>

No, it is opt-in: `CELLD_IDLE_EVICT_S` sets the idle seconds, and without it only memory pressure or the residency cap removes a resident cell. It matters because balancing moves only hibernated cells, so a fleet without idle eviction balances only the cells that hibernate on their own. Part 1 § 02 and § 05.

</details>

<details>
<summary>6. Entity or process</summary>

A cell (a Durable Object) models an entity: a named unit whose state persists indefinitely. A workflow models a process: steps that start, run, and finish. celld's Workflows are the process primitive built on the entity primitive. Part 0 § 06; Part 1 § 07.

</details>

<details>
<summary>7. Proofs by fleet size</summary>

One node: a **bucket proof**, one storage round trip to the bucket. Two or more nodes: a **fleet proof**, which answers once every follower has fsynced the write; the bucket upload finishes afterwards. Part 1 § 03.

</details>

<details>
<summary>8. Fleet durability on one node</summary>

It requests the fleet posture and does not get it: the node falls back to bucket proof, because a fleet proof needs at least two nodes. Part 1 § 03.

</details>

<details>
<summary>9. Acquiring a cell</summary>

With a conditional write to the cell's ownership record in the bucket: create when no record exists, compare-and-swap when one does. The bucket accepts only one such write. Every activation advances the epoch, a takeover and a local wake alike, and the cell's data is written under that epoch's prefix. Part 1 § 04.

</details>

<details>
<summary>10. Records, not clocks</summary>

After a bucket proof, celld re-reads the ownership record and acknowledges only if it still names this node at this epoch. Reading the record means a paused process or a skewed clock cannot pass the check; a clock comparison could be fooled by either. Part 1 § 04.

</details>

<details>
<summary>11. Losing the lease</summary>

It fences itself. When its published lease expiry passes, it stops each active cell, fails incomplete requests, logs a line starting `SELF-FENCE:`, and exits with code 3, so it cannot keep serving state it can no longer prove. Part 1 § 04.

</details>

<details>
<summary>12. Qualified stores and the probe</summary>

Fleet-qualified: Amazon S3, Cloudflare R2, Google Cloud Storage, Tigris, and Azure Blob Storage. MinIO passes the test but is not qualified; Backblaze B2, Hetzner, and DigitalOcean Spaces are not. The startup probe runs conditional writes that must succeed and fail in the right places, plus a ranged read that must return exactly the requested bytes. A clear contract violation stops the node; an ambiguous failure gets three attempts and then a warning. Part 1 § 03.

</details>

<details>
<summary>13. Disabling the probe</summary>

No. The startup probe cannot be disabled: `CELLD_STORAGE_PROBE` is on the rejected list, and a node with it set does not start. `celld diagnose --read-only` skips the probe only for that on-demand check. Part 1 § 03 and § 05.

</details>

<details>
<summary>14. What the bucket holds</summary>

Deployments (with container images), cell state, ownership records, node leases, the shared peer-authentication secret, the fleet capacity sample, alarm wake entries, large KV values, and all R2 objects. Whoever holds the bucket credentials controls the fleet. Part 1 § 03 and § 09.

</details>

<details>
<summary>15. Balancing</summary>

Only hibernated cells move. A node's target is the fleet's owned cells divided by weight, where `CELLD_PLACEMENT_WEIGHT` defaults to the CPU count. `POST /rebalance/pause` and `/resume` on any internal listener govern the whole fleet. Part 1 § 05.

</details>

<details>
<summary>16. v0.5.1 to v0.6.0</summary>

Under `fleet` durability, as a full stop: stop every v0.5.1 node, then start the v0.6.0 nodes, because a v0.6.0 node needs a follower that speaks the ranged `CLT2` log-tail format and refuses to start in a mixed fleet. A fleet on `CELLD_DURABILITY=bucket` has no followers and can roll. Part 1 § 05.

</details>

<details>
<summary>17. Rolling back from v0.5.0</summary>

Never by starting an old binary against the upgraded bucket. The only rollback is the backup taken while the fleet was stopped, and it loses every write made after it. Part 1 § 05.

</details>

<details>
<summary>18. KV edge cache</summary>

No. `cacheTtl` has no effect and `cacheStatus` is `null`: KV on celld is a durable store with KV's API, not a CDN. Reads route to the namespace's cell. Part 1 § 06; Notebook 2 Part 2.

</details>

<details>
<summary>19. Past max_retries without a dead-letter queue</summary>

celld deletes the message. Between attempts, a retried message becomes visible again after the `delaySeconds` passed to `retry()` or `retryAll()`, or the consumer's `retry_delay` by default; celld adds no exponential backoff, so an application that wants one computes it from `message.attempts`. Part 1 § 06; Part 2 Step 05.

</details>

<details>
<summary>20. A consumer without a handler</summary>

The script fails to load and the node goes down: Notebook 2 Part 5 shows the local node exiting with `queue consumer has no queue handler`. Declare a consumer only in a script that exports `queue()`. Part 1 § 06.

</details>

<details>
<summary>21. R2 versions</summary>

On a store that reports no version of its own, the ETag becomes the version, so identical content produces the same version. `celld dev`'s local store instead numbers each write from a store-wide counter, so identical bytes get different versions there (Notebook 2 Part 4 showed 74 and 75). Either way, never use a version to count writes, and use `checksums.md5` as the content hash. Part 1 § 06; Part 2 Step 07.

</details>

<details>
<summary>22. Publishing an R2 object</summary>

Through a Worker. celld serves a bucket through the binding only: there is no public bucket URL, no presigned URL, and no S3 endpoint into an R2 binding. Part 1 § 06; Part 2 Step 07.

</details>

<details>
<summary>23. Facet writes</summary>

Each facet lives in its own SQLite file with its own replication stream, so a facet write commits in the facet's database. Rolling back a root transaction does not undo a facet call made inside it. State that needs one atomic commit belongs in one database. This changed in v0.6.0. Part 1 § 06; <!-- series-only -->Part 1 § 05 release notes.<!-- /series-only --><!-- book-only -->[Appendix C](release-notes.html).<!-- /book-only -->

</details>

<details>
<summary>24. Sleep versus crash</summary>

The same mechanism. `run()` executes again from the top, completed steps return their stored results, and everything outside a step runs again. After a durable sleep nothing failed, but the re-execution is identical: Notebook 3 Part 3 counted the top of `run()` running twice across one sleep while each step ran once. Part 1 § 06; Part 2 Step 06.

</details>

<details>
<summary>25. Cron day-of-week</summary>

Sunday. Day-of-week 1 is Sunday, as on Cloudflare and opposite to most cron dialects. Cron runs in UTC at one-minute resolution, exactly once per occurrence fleet-wide. Part 1 § 06.

</details>

<details>
<summary>26. D1 migrations on celld dev</summary>

No. A `celld dev` deploy does not apply migrations, and `celld d1 migrations apply` needs a fleet. Locally, run the SQL from the Worker (for example `CREATE TABLE IF NOT EXISTS`), as celld's own `examples/d1` does. Part 2 Step 07; Notebook 2 Part 3.

</details>

<!-- series-only -->
------------------------------------------------------------------------

*A companion to the celld series, compiled 2026·09·27 from Parts 0–2 and Notebooks 1–3 at celld v0.6.0, plus the celld.dev KV service page for the KV key, value, and metadata limits.*
<!-- /series-only -->
