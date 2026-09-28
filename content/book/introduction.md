---
title: "Introduction"
kind: "Front matter"
numbered: false
---

## What this book is {#what-this-book-is}

Cloudflare's Durable Objects gave serverless programming a primitive it had been missing: a named object with one thread and its own storage, reachable from anywhere by its name. celld, from the Deno team, runs that same programming model on machines you control, with an object-storage bucket as the only coordinator. This book explains celld v0.6.0, the release that made it a beta. It covers what celld is, how it keeps its guarantees, how to build and operate an application on it, and where it still differs from the platform it imitates.

It is written for engineers who build stateful services and want to understand a system before they depend on it. You do not need to know Durable Objects already. You should be comfortable reading TypeScript, a shell session, and a little SQL.

## How it is organized {#organization}

- **Part I, Foundations** (Chapter 1), is the background the rest assumes: the Cloudflare Workers platform, what a Durable Object is, the fifty-year lineage of the actor model, and durable execution.
- **Part II, How celld works** (Chapters 2–8), is the reference: the cell model, the bucket as coordinator, ownership and fencing, running a fleet, the Cloudflare compatibility surface, designing around cells, and a closing assessment.
- **Part III, Building on celld** (Chapter 9), is a walkthrough in ten steps, from an empty directory to an operated fleet.
- **Part IV, Labs** (Chapters 10–12), are executed notebooks. Each one drives a real `celld dev` node and checks the book's claims against what the node actually does.
- **The appendices** hold a quick reference and self-quiz, the glossary, the release notes with every upgrade rule, and a look under the hood at SQLite's write-ahead log, Litestream, and the LTX files celld replicates.

## How to read it {#how-to-read}

Read Part I if Durable Objects are new to you; otherwise start at Part II. Part III can be read on its own, but it points back to Part II wherever the reasoning lives there. The labs are meant to sit beside Chapter 9: Lab 1 with Steps 02–04, Lab 2 with Steps 05 and 07, and Lab 3 with Step 06.

The labs are evidence, not illustrations. Every output in them came from a live node, and each lab is a frozen export of a run against celld v0.6.0 on 2026·09·26. Each ends with an exercise: TODO stubs and a checker cell. The checkers in the export print ✗ by design, because they are waiting for your solution. To run a lab yourself, download it from the top of its chapter together with the helper `celld_nb.ts` it imports, or get [all three labs and the helper as one zip](labs/celld-labs.zip), and open it in JupyterLab with a Deno kernel.

A few conventions run throughout:

- **Section numbers** sit in the left margin of every chapter, and cross-references use them ("Chapter 4", "Chapter 9, Step 05", "Chapter 1 § 03").
- **Callouts** mark tips, warnings, and caveats in the margin by kind.
- **Terms** with a dotted underline have a definition on hover or tap. Appendix B collects them all.
- **Versions matter.** celld moves fast, with five releases in the four weeks before this edition. Where behavior changed between releases, the chapters state the current behavior, and Appendix C records the history once.

## How it was made {#how-made}

This book was generated with AI, from materials curated by Thomas Lockney for this purpose: celld's own documentation and release notes, Cloudflare's documentation and engineering posts, and a set of articles on actors and durable execution. The Colophon describes the process, and the Bibliography lists every source. Treat it as a well-researched guide rather than the vendor's documentation, and check anything load-bearing against the release you run.
