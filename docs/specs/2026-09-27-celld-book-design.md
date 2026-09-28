# celld book — design

Date: 2026-09-27. Status: approved direction (hosting, structure, look, and source model
chosen by Thomas); details below are the implementation plan.

## Goal

Turn the seven-document celld series (three articles, three executed notebooks, one
review sheet) into a standalone static site that reads as a mini-book, *without* forking
the content: one source, two outputs.

- **Book site** (`dist/`): chapters, parts, appendices, a contents drawer, previous/next
  navigation, cross-references as chapter links, and glossary hover definitions.
- **Series pages** (`out/series/`): the seven Reading Room documents and their artifact
  variants, byte-compatible with what the Reading Room serves today.

## Decisions

| Question | Decision |
|---|---|
| Where it lives | New private repo `tlockney/celld-book`; static host chosen at deploy time (Cloudflare Pages or GitHub Pages). |
| Structure | Book restructure: Parts I–IV plus appendices; the Field Guide split into chapters. |
| Look | The series' bench-sheet renderers (vendored, unmodified) plus a book shell. |
| Source model | This repo is the single source; both outputs are generated. |
| Transparency | An Introduction and a Colophon; the Colophon states plainly that the text was generated with AI from materials Thomas curated. |

## Table of contents

| # | Page | Source |
|---|---|---|
| — | Introduction | `content/book/introduction.md` (book-only) |
| I | 1 · Actors, Durable Objects, and durable execution | `celld-00-background.md` (whole) |
| II | Part II introduction · What celld is | Field Guide § 01 |
| | 2 · The cell model | Field Guide § 02 |
| | 3 · The bucket is the coordinator | § 03 |
| | 4 · Ownership, leases, and fencing | § 04 |
| | 5 · Running a fleet | § 05 (its release notes move to Appendix C) |
| | 6 · The Cloudflare compatibility surface | § 06 |
| | 7 · Designing applications around cells | § 07 |
| | 8 · Reliability, security, and a verdict | §§ 08–10 |
| III | 9 · Building on celld, step by step | `celld-step-by-step.md` (whole) |
| IV | 10–12 · Labs 1–3 | the three executed notebooks |
| App. | A · Quick reference and self-quiz | `celld-review.md` |
| | B · Glossary | Field Guide § 11 |
| | C · Release notes and upgrade cliffs | Field Guide § 05's upgrade callout + "Release notes" |
| — | Colophon | `content/book/colophon.md` (book-only) |

A single-section chapter (a Field Guide section) promotes its `###` headings to `##`, so
the chapter gets its own numbered sections.

## Variants

Most text is shared. Where the two outputs must differ, the source marks it:

```
<!-- series-only -->…<!-- /series-only -->   dropped from the book
<!-- book-only -->…<!-- /book-only -->       dropped from the series
```

Markers work in markdown sources and in notebook markdown cells. The series build strips
book-only blocks and the markers, so its output stays identical to today's pages.

## Cross-references

Series prose refers to "Part 1 § 04", "Part 2 Step 05", "Notebook 2 Part 3". The book
rewrites these at build time, on the rendered HTML's text nodes (never inside `code`,
`pre`, `svg`, or `script`):

| Series text | Book text | Target |
|---|---|---|
| Part 0 § NN | Chapter 1 § NN | chapter 1, section anchor |
| Part 1 § NN (and lists: "§ 03, § 04", "§ 02 and § 07") | Chapter N (Chapters N and M) | per the § → chapter map |
| Part 1 § 11 | Appendix B | glossary |
| Part 2 Step NN / Step NN | Chapter 9, Step NN / Step NN | step anchor |
| Notebook N (Part M) | Lab N (, Part M) | chapter 9+N |
| bare Part 0 / Part 1 / Part 2 (articles only) | Chapter 1 / Part II / Chapter 9 | |
| `href="celld-…"` / `href="#id"` on another page | chapter URL (+ anchor) | id → page map |

Inside an existing link, only the text is rewritten (no nested links). Notebooks number
their own parts ("## Part 2—…"), so bare "Part N" is never rewritten inside a lab. A small
list of whole-phrase substitutions in `book.jsonc` covers the rest (e.g. "the release notes
in § 05" → "Appendix C").

## Glossary hover definitions

Parsed from the Field Guide's § 11 table. On each page, the first prose occurrence of each
term (longest terms first, case-insensitive, plural `s` allowed) becomes
`<span class="gloss" tabindex="0" data-def="…">`, with a CSS popover on hover and focus that
works on touch too. Ambiguous terms are listed in `book.jsonc` and never auto-wrapped
("Process" is also an OS process). Headings, code, links, and figures are skipped.

## Shell

A top bar (book title, the current part/chapter, a Contents button), a left drawer with the
full contents (focus-trapped, closes on Escape), and previous/next links at the foot of every
page. Colors and type come from bench-sheet's tokens, so dark mode works unchanged. The index
page is the cover: title, dek, and the contents.

## Tests

Deno tests cover the application logic: variant stripping, chapter slicing and heading
promotion, cross-reference rewriting (table-driven), glossary parsing and wrapping, and the
contents/prev-next model. The build also checks that every internal link resolves.

## Out of scope for the first cut

Search (Pagefind would slot in later), a print/PDF edition, Notebook 4 (deferred; see the
personal-workspace todo), and deployment (confirmed with Thomas before going public).
