---
title: "SQLite's WAL, Litestream, and LTX"
dek: "What sits under every cell's durability: how SQLite's write-ahead log records a transaction, how Litestream turned that log into replication, what an LTX file is, and how celld's own replication library captures, stores, compacts, and restores a cell."
kind: "Appendix D"
section_label: "§"
---

## Why this appendix {#why}

The chapters say that celld "continuously ships each cell's SQLite state to the bucket as LTX segments" ([Chapter 3](bucket.html)), that a large cell restores "page by page through a fault-in SQLite VFS", and that a v0.6.0 node needs the ranged `CLT2` log-tail format ([Appendix C](release-notes.html)). Each of those sentences leans on three older ideas: SQLite's write-ahead log, the Litestream replicator, and the LTX file format. This appendix explains them in that order, then shows what celld's replication library (`crates/ltx` in `denoland/celld`) does with them, with the details as they stand at celld v0.6.0.

Where celld departs from Litestream, the appendix says so. The departures are the interesting part: celld keeps Litestream's capture and file format but replaces its coordination with the epoch fencing, output gate, and node log that the chapters describe.

## SQLite's write-ahead log {#wal}

SQLite has two ways to make a transaction atomic. In the older **rollback journal** mode, it copies each page it is about to change into a `-journal` file, then overwrites the page in place; a crash is repaired by copying the originals back. In **WAL mode** the database file is left alone during a write. Changed pages are appended to a separate `-wal` file instead, and readers combine the two. Writers no longer block readers, readers no longer block the writer, and the disk sees mostly sequential writes and fewer `fsync()` calls.

### Frames and commits

A WAL file is a 32-byte header followed by **frames**. The header carries a magic number (which also fixes the checksum byte order), the format version, the page size, a checkpoint sequence number, two random **salts**, and a checksum. Each frame is a 24-byte frame header and one page of data. The frame header records:

| Field | Meaning |
|----|----|
| Page number | Which database page the frame holds. |
| Commit size | The database size in pages *after* the transaction, on the frame that commits it; 0 on every other frame. |
| Salt-1, salt-2 | Copies of the header's salts. |
| Checksum-1, checksum-2 | A cumulative checksum over the header and every frame up to this one. |

A frame is valid only if its salts match the header's and its cumulative checksum holds. A transaction is committed when a valid frame carries a nonzero commit size; frames after the last commit frame belong to a transaction that never finished.

### Readers and the wal-index

A reader starting a transaction notes the last valid commit frame as its end mark and ignores anything appended later, which gives it a stable snapshot. To find a page, it looks for the newest frame of that page at or before its end mark, and falls back to the database file if there is none. So that this lookup is not a scan, SQLite keeps a **wal-index** in shared memory, backed by the `-shm` file. Shared memory is also why a WAL database cannot live on a network filesystem: every process using it must be on the same host.

### Checkpoints

A **checkpoint** copies the committed frames back into the database file, syncs it, and lets the WAL start over from the beginning. By default SQLite runs a PASSIVE checkpoint whenever a commit leaves the WAL at 1,000 pages or more. The four modes differ in how hard they push:

| Mode | Behavior |
|----|----|
| PASSIVE | Copies what it can without waiting for readers or writers. |
| FULL | Waits for the writer and current readers, then copies every frame. |
| RESTART | A FULL checkpoint that then waits for readers so the next writer starts the WAL from the top. |
| TRUNCATE | A RESTART checkpoint that also truncates the `-wal` file to zero bytes. |

One rule matters more than the rest for replication. A checkpoint can never overwrite database pages that an active reader still needs, so **a long-running read transaction stops the WAL from being reset**. Frames stay in the file until that reader lets go.

### The VFS

Everything SQLite does to files goes through a **VFS**, the operating-system interface at the bottom of the library: open, read, write, sync, lock, and the shared-memory calls behind the wal-index. A custom VFS, or a shim around the default one, can intercept any of them. That is how a database can be read from somewhere other than a local file.

## Litestream: replication from the WAL {#litestream}

Ben Johnson released **Litestream** in 2020 to give an ordinary SQLite application continuous backup to object storage, with no server to run. It is a separate process (or a Go library) beside an unmodified application, and it works entirely through the WAL rules above:

1. It holds a **long-running read transaction** on the database. By the rule in § 02, SQLite then cannot reset the WAL under it, so no frame is lost before Litestream has copied it.
2. It **takes over checkpointing**, running its own checkpoints when it chooses, after it has captured the frames.
3. It copies each new run of committed frames, and uploads it to object storage.
4. A **restore** downloads the newest snapshot, then replays everything written after it, in order.

Early versions stored raw WAL segments in a "shadow WAL", grouped into random-ID **generations** that started over whenever continuity broke. Restoring a busy database meant replaying every intermediate page write.

**Litestream v0.5** replaced that design. Johnson announced it in "Litestream Revamped" (2025·05·20), taking "our LiteFS learnings" back into Litestream, and v0.5.0 shipped on 2025·10·02. It brought:

- **LTX files** in place of WAL segments and generations, numbered by a monotonically increasing transaction ID (TXID).
- **Compaction levels** for fast point-in-time restore. By default L1 merges the L0 files of each 30-second window, L2 the L1 files of each 5 minutes, L3 the L2 files of each hour, and a full snapshot is taken daily, so "a dozen or so files on average" restore a database to any point.
- **A lease** built on object storage's conditional writes, so only one primary replicates to a destination.
- **Read replicas through a VFS**, which serve queries by fetching pages from object storage on demand.

## The LTX format {#ltx}

**LTX** began in **LiteFS**, Fly.io's distributed SQLite filesystem (introduced 2022·09·21), which needed a transaction-aware unit to ship between nodes instead of a raw WAL stream. An LTX file holds the pages a range of transactions changed, **sorted by page number**, with enough metadata to check that it applies cleanly.

| Part | Contents |
|----|----|
| Header (100 bytes) | Magic `LTX1`, flags, page size, commit (database size in pages after the file), minimum and maximum TXID, a timestamp, the pre-apply checksum, the WAL offset, size, and salts it was read from, a node ID, reserved bytes. |
| Pages | Each page: a small header (page number, flags), then the page data compressed with LZ4, in ascending page order, ended by an empty page header. |
| Page index | For each page: its number, its byte offset in the file, and its encoded size. |
| Trailer (16 bytes) | The post-apply checksum and a file checksum. |

A file is named for its TXID range, `<min>-<max>.ltx`, in zero-padded hex. Three design choices do most of the work:

- **Sorted pages make files mergeable.** Two adjacent files can be **compacted** into one that keeps only the newest version of each page, which is why restore needs few files.
- **Per-page compression plus the page index make pages addressable.** A reader can fetch and decode a single page with a ranged read, without downloading the file; this is what the VFS read replicas, and celld's paged restore, rely on.
- **Checksums make chains verifiable.** The *file checksum* is a CRC-64 over the header, the page headers, the uncompressed page data, the index, and the post-apply checksum. The *database checksum* is the XOR of a CRC of every page, so a transaction updates it incrementally; a file's pre-apply checksum must equal the database's checksum before it applies, and its post-apply checksum afterward. A file may also carry a *no-checksum* flag that turns the database checksums off.

LTX has two page layouts. The original **frame layout** stores each page as an independent LZ4 frame. The **block layout** introduced in LTX v0.5.2 stores a 4-byte size and a raw LZ4 block, which is more compact. A reader that knows only the frame layout cannot read block files.

## How celld uses it {#celld}

celld's replication library, `crates/ltx`, is a Rust port of this lineage. Its README records the provenance: it was seeded on 2026·08·03 from **rustyriver**, a from-scratch Rust reimplementation of Litestream v0.5 and LTX, and celld now owns it as first-class source. The replication behavior comes from Litestream v0.5.11 and the block format from Litestream v0.5.16 (LTX v0.5.2); a pinned port of the pierrec/lz4 compressor makes the compressed bytes match upstream exactly. The README also draws the boundary that the rest of this section follows: the library "captures committed WAL data as L0 LTX segments", while "the output gate, epoch fencing, replicated node log, and takeover recovery enforce the write acknowledgement contract".

<figure>
<svg aria-labelledby="fwl-t fwl-d" role="img" viewbox="0 0 880 300" xmlns="http://www.w3.org/2000/svg">
<title id="fwl-t">A cell's write, from SQLite's WAL to the bucket and back</title>
<desc id="fwl-d">A committed transaction in the cell's SQLite WAL is captured on demand as one L0 LTX file. Under fleet durability the L0 segment goes to follower nodes through the node log and is acknowledged on their fsync; under bucket durability it is uploaded and acknowledged on the upload. Segments reach the bucket under the cell's epoch prefix at level 0000, where the compactor publishes additive L1 files at level 0001, and a released cell leaves a checksummed handoff snapshot at level 0009. A new owner restores either fully, by replaying snapshot plus chain, or paged, faulting pages in through a VFS.</desc>
<defs>
<marker id="fwl-a" markerheight="7" markerwidth="7" orient="auto-start-reverse" refx="9" refy="5" viewbox="0 0 10 10">
<path d="M 0 0 L 10 5 L 0 10 z" style="fill:var(--ink-3, #7b8791)"></path>
</marker>
<marker id="fwl-c" markerheight="7" markerwidth="7" orient="auto-start-reverse" refx="9" refy="5" viewbox="0 0 10 10">
<path d="M 0 0 L 10 5 L 0 10 z" style="fill:var(--cobalt, #2a56a0)"></path>
</marker>
</defs>
<rect height="84" rx="4" stroke-width="1.2" width="170" x="16" y="40" style="fill:var(--plate, #e6ebeb);stroke:var(--ink-2, #4a5763)"></rect>
<text class="m" font-size="11" font-weight="600" text-anchor="middle" x="101" y="64" style="fill:var(--ink, #1b252e)">the cell's SQLite</text>
<text class="m" font-size="9" text-anchor="middle" x="101" y="82" style="fill:var(--ink-2, #4a5763)">db.sqlite + -wal</text>
<text class="m" font-size="9" text-anchor="middle" x="101" y="97" style="fill:var(--ink-2, #4a5763)">commit frame: size ≠ 0</text>
<text class="m" font-size="9" text-anchor="middle" x="101" y="112" style="fill:var(--ink-2, #4a5763)">crate owns checkpoints</text>
<path d="M 188 82 L 246 82" fill="none" marker-end="url(#fwl-a)" stroke-width="1.5" style="stroke:var(--ink-3, #7b8791)"></path>
<text class="m" font-size="8.5" text-anchor="middle" x="217" y="74" style="fill:var(--ink-2, #4a5763)">sync()</text>
<rect height="84" rx="4" stroke-width="1.5" width="170" x="250" y="40" style="fill:var(--plate, #e6ebeb);stroke:var(--cobalt, #2a56a0)"></rect>
<text class="m" font-size="11" font-weight="600" text-anchor="middle" x="335" y="64" style="fill:var(--cobalt, #2a56a0)">one L0 LTX file</text>
<text class="m" font-size="9" text-anchor="middle" x="335" y="82" style="fill:var(--ink-2, #4a5763)">TXID n, changed pages</text>
<text class="m" font-size="9" text-anchor="middle" x="335" y="97" style="fill:var(--ink-2, #4a5763)">on demand, output gate</text>
<text class="m" font-size="9" text-anchor="middle" x="335" y="112" style="fill:var(--ink-2, #4a5763)">(25 ms tick or wake-up)</text>
<path d="M 422 70 L 520 46" fill="none" marker-end="url(#fwl-c)" stroke-width="1.5" style="stroke:var(--cobalt, #2a56a0)"></path>
<path d="M 422 100 L 520 132" fill="none" marker-end="url(#fwl-a)" stroke-width="1.5" style="stroke:var(--ink-3, #7b8791)"></path>
<rect height="52" rx="4" stroke-width="1.2" width="340" x="524" y="16" style="fill:var(--paper-2, #ebeee9);stroke:var(--ink-2, #4a5763)"></rect>
<text class="m" font-size="10" font-weight="600" text-anchor="middle" x="694" y="36" style="fill:var(--ink, #1b252e)">fleet: node log → 1–2 followers</text>
<text class="m" font-size="9" text-anchor="middle" x="694" y="54" style="fill:var(--ink-2, #4a5763)">ack on every follower's fsync · bucket copy later, in bundles</text>
<rect height="52" rx="4" stroke-width="1.2" width="340" x="524" y="108" style="fill:var(--paper-2, #ebeee9);stroke:var(--ink-2, #4a5763)"></rect>
<text class="m" font-size="10" font-weight="600" text-anchor="middle" x="694" y="128" style="fill:var(--ink, #1b252e)">bucket: upload the L0 file</text>
<text class="m" font-size="9" text-anchor="middle" x="694" y="146" style="fill:var(--ink-2, #4a5763)">ack on the upload, then re-read the ownership record</text>
<rect height="84" rx="4" stroke-width="1.2" width="848" x="16" y="190" style="fill:var(--plate, #e6ebeb);stroke:var(--ink-2, #4a5763)"></rect>
<text class="m" font-size="10" font-weight="600" x="30" y="210" style="fill:var(--ink, #1b252e)">the fleet bucket · cells/&lt;cell&gt;/ltx/e&lt;epoch&gt;/</text>
<text class="m" font-size="9" x="30" y="232" style="fill:var(--ink-2, #4a5763)">0000/  L0 captures, one per sync</text>
<text class="m" font-size="9" x="30" y="248" style="fill:var(--ink-2, #4a5763)">0001/  L1: additive compactions, sources kept</text>
<text class="m" font-size="9" x="30" y="264" style="fill:var(--ink-2, #4a5763)">0009/  handoff snapshot, checksummed</text>
<text class="m" font-size="9" x="450" y="232" style="fill:var(--ink-2, #4a5763)">restore, full: snapshot + contiguous chain, newest page wins</text>
<text class="m" font-size="9" x="450" y="248" style="fill:var(--ink-2, #4a5763)">restore, paged: page map from the files' indexes;</text>
<text class="m" font-size="9" x="450" y="264" style="fill:var(--cobalt, #2a56a0)">a VFS faults each page in with a ranged read</text>
<path d="M 694 70 L 694 104" fill="none" marker-end="url(#fwl-a)" stroke-dasharray="4 3" stroke-width="1.2" style="stroke:var(--ink-3, #7b8791)"></path>
<path d="M 694 162 L 694 186" fill="none" marker-end="url(#fwl-a)" stroke-width="1.5" style="stroke:var(--ink-3, #7b8791)"></path>
</svg>
<figcaption>A cell's write path through the replication library. SQLite's WAL and Litestream's capture sit at the left; celld's own protocol decides the acknowledgement (fleet or bucket proof) and fences every object by the epoch in its key.</figcaption>
</figure>

### Capture

The library opens the cell's database on two connections. One holds a **long-running read transaction**, exactly as Litestream does, so the WAL cannot be reset before its frames are captured. The other runs the library's own checkpoints; auto-checkpoint is switched off on that connection, while the application's writer connection keeps SQLite's default, which is safe because the pinned read mark stops any reset. Every database also gets two small control tables, `_litestream_seq` and `_litestream_lock`, whose definitions match Litestream's character for character.

Capture happens only when the library's `sync()` is called: the crate has no timer of its own. In celld, the **output gate** drives it. A write that needs a durability proof takes a ticket, and a sync loop that wakes on that ticket or every 25 ms captures every cell with pending work. One `sync()` reads the WAL, keeps only frames that belong to committed transactions (salts and cumulative checksum valid, ending in a nonzero commit size), and writes **one new L0 file** at the next TXID. If the WAL no longer continues from the last capture (another process truncated it, or its salts reset), the library writes a whole-database file instead.

The library also decides when to checkpoint: a TRUNCATE once the WAL reaches a threshold (celld sets `CELLD_LTX_TRUNCATE_PAGES` to 128 pages), a PASSIVE after 1,000 new frames, and a time-based PASSIVE every 60 seconds. A Queue cell uses passive checkpoints only.

### Where the files go

Every object a cell produces lives under its **epoch prefix**, with the compaction level as a 4-digit hex directory:

```text
<fleet prefix>cells/<cell>/ltx/e<epoch>/<level:04x>/<minTXID:016x>-<maxTXID:016x>.ltx
e.g. cells/chat-1/ltx/e7/0000/0000000000000005-0000000000000005.ltx   (an L0 capture)
```

The epoch in the key is the fence ([Chapter 4](ownership.html)): the uploads themselves are plain PUTs, and a stale owner can only write into its own, superseded epoch. This is why celld **removed Litestream's object-storage lease**. The port included it and deleted it on 2026·08·06, unused, because a lease file under the replica prefix "would be a second, competing layer".

Under fleet durability, captured segments reach the bucket in **bundles**: one object per flush interval that concatenates the L0 files of every dirty cell (magic `CLB1`), instead of one upload per cell. Bundles are celld's own addition, not part of Litestream. A cell's per-cell prefix is filled from them when it is needed, and "at rest, the bucket is pure Litestream".

### Compaction

celld runs **L1 only**, and **additively**: a compaction publishes a new L1 object covering a contiguous TXID run of L0 files and never deletes its sources. In each page, the newest version wins. A node-wide scheduler compacts a cell once 256 TXIDs or 32 MiB have accumulated, two cells at a time by default; the knobs are `CELLD_LTX_COMPACTION`, `CELLD_LTX_COMPACTION_MIN_TXIDS`, `CELLD_LTX_COMPACTION_MIN_MB`, and `CELLD_LTX_COMPACTIONS`. The payoff is the one Litestream's levels give: "a takeover reads tens of objects instead of thousands". celld does not produce Litestream's L2 or L3 tiers.

The two LTX layouts meet here. Ordinary L0 captures are still written in the older frame layout, while compaction output uses the v0.5.2 block layout. A node that cannot read block files could not restore a cell after the first L1 file appeared, which is why a mixed-version fleet must set `CELLD_LTX_COMPACTION=0` until every node can read them.

### How integrity is checked

celld does **not** rely on LTX's pre-apply and post-apply checksum chain. Every L0 capture, every compaction output, and the markers described below are written with the no-checksum flag. What holds a chain together instead is a **CRC-64 file checksum** on every file, checked on every full decode, and **contiguous TXID ranges**: restore refuses a chain with a gap, and refuses a file that grows the database without supplying every new page. The one checksummed file is the **handoff snapshot**, a full image published at level `0009` when a cell is released.

### Restore

A new owner rebuilds a cell one of two ways ([Chapter 3](bucket.html)).

- **Full restore.** Anchor on the newest handoff snapshot, then take the longest contiguous chain of files across the levels, verify each file's CRC as it decodes, and apply them oldest to newest, the newest version of each page winning. The result is written to a temporary file, synced, and renamed into place.
- **Paged restore**, for a chain of 256 MiB or more (`CELLD_LTX_PAGED_MIN_MB`). celld builds a **page map** from the page indexes at the tail of each file, then opens the database through a **fault-in VFS**: the local file starts sparse, and the first read of a missing page performs one ranged read. The byte range is exact, taken from the page index, but a fault normally fetches a run of neighboring pages up to 1 MiB, and prefetches the children of an interior b-tree page on a sequential scan. A page that should exist but cannot be read fails the query rather than returning zeros. In the background, one cell per node at a time is **hydrated** at `CELLD_LTX_HYDRATE_MBPS` (16 MiB/s by default; `0` keeps it sparse). This is why the store must serve exact ranged reads ([Chapter 3](bucket.html)). A paged fault cannot check a whole file's CRC, because it never reads the whole file; it checks the page header and the LZ4 decode.

A paged cell cannot afford to write a whole-database opener into its new epoch; on a 2 GB cell that took minutes through the fault path. So a paged epoch **continues the chain it paged from**: celld writes a zero-page **marker** file at the next TXID, and the next capture is a normal incremental file.

### The node log

Fleet durability adds one more piece outside the library ([Chapter 3](bucket.html)). Each node streams the L0 segments it has captured but not yet uploaded to a small ensemble of followers, and a write is acknowledged when every follower holds its segment on disk. When a node takes over a cell, it first seals the previous owner's log and uploads what the followers retained. The followers answer that recovery with a **log tail**: `CLT1` returns entries only, while `CLT2`, added in v0.6.0, also states the range it covers and whether it is complete. A v0.6.0 node that needs a follower's witness recovers its previous log session only from a `CLT2` tail, and a v0.5.1 follower can answer only with `CLT1`; that is the reason behind the v0.5.1 → v0.6.0 full stop under fleet durability ([Appendix C](release-notes.html)).

## Where the book covers each piece {#map}

| Topic | Where |
|----|----|
| LTX segments, bucket proof and fleet proof, the four store requirements, exact ranged reads | [Chapter 3](bucket.html) |
| Epochs, the ownership record, the output gate, self-fencing | [Chapter 4](ownership.html) |
| `CELLD_LTX_*` settings, compaction, and paged restore in operation | [Chapter 5](fleet.html) |
| Why a facet has its own SQLite file and replication stream | [Chapter 6](compatibility.html) |
| The `CLT2` upgrade rule and the release history of paging and compaction | [Appendix C](release-notes.html) |
