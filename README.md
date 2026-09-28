# celld: Durable Objects on Your Own Storage

A mini-book on [celld](https://github.com/denoland/celld), Deno's self-hosted runtime for Cloudflare's Workers
and Durable Objects model, at celld v0.6.0. It was generated with AI from materials curated by Thomas Lockney;
the book's Colophon describes how.

This repository is the **single source** for two outputs:

| Output | Command | Where it goes |
|---|---|---|
| The book site | `deno task build` | `dist/` (static; any host) |
| The Reading Room series (seven pages, plus claude.ai artifact variants and JupyterLab notebooks) | `deno task series` | `out/series/{rr,artifact,labs}/` |

`deno task series:install` also copies the series pages into the Reading Room home
(`~/.local/share/reading-room/_migrated/`, or `$READING_ROOM_HOME`).

## Layout

| Path | What it is |
|---|---|
| `book.jsonc` | The book's structure: parts, pages, which source sections each chapter takes, and phrase substitutions. |
| `content/series/` | The four article sources (markdown) and the artifact URL map. |
| `content/labs/` | The three **executed** notebooks and their page metadata. |
| `content/book/` | Book-only pages (Introduction, Colophon) and the bibliography data. |
| `labs/` | The notebook generators (`build_0N.py`), the notebook helper `celld_nb.ts`, and tools to carry outputs across prose edits. |
| `src/` | The build: variants, markdown slicing, cross-references, glossary, shell, book and series builders, with tests. |
| `vendor/bench-sheet/` | The bench-sheet renderers, vendored unmodified (see `ORIGIN`). |
| `tools/` | Checks: `audit.py` (leftover series phrasing), `phone.ts` (true 390px phone emulation), `shots.sh`. |
| `docs/specs/` | The design. |

## Publishing

`.github/workflows/pages.yml` publishes the book to GitHub Pages at <https://tlockney.github.io/celld-book/>:
pull requests run the tests and the build (a broken internal link fails it); pushes to `main` also deploy `dist/`.
Pages must be set to deploy from GitHub Actions (Settings → Pages → Source → GitHub Actions). Every URL in the site
is relative, so the project subpath needs no configuration, and the service worker is scoped to it.

## One source, two outputs

Most text is shared. Where the book and the series must differ, the source marks the span:

```
<!-- series-only -->…<!-- /series-only -->   dropped from the book
<!-- book-only -->…<!-- /book-only -->       dropped from the series
```

The book build also rewrites series cross-references ("Part 1 § 04", "Part 2 Step 05", "Notebook 2 Part 3") into
book references ("Chapter 4", "Chapter 9, Step 05", "Lab 2, Part 3") with links, marks glossary terms with hover
definitions, adds a sources footer to every chapter, and fails if any internal link is broken.

## Installable and offline

The site is a progressive web app: a manifest with maskable icons (`assets/`, rendered by `tools/icons.ts`), theme
colors and touch icons on every page, and a service worker (`src/pwa.ts`) that precaches every page under a
cache name hashed from the built content, so a rebuild invalidates the old copy. All URLs are relative, so the book
works at a domain root or under a subpath. Service workers need HTTPS (or `127.0.0.1`), so the claude.ai artifact
preview is readable but not installable.

## Diagrams

The inline SVG figures use bench-sheet's color tokens (`style="fill:var(--ink, #1b252e)"`), so they follow the
light and dark themes, and sit on the bench sheet's engineering-paper grid (`src/figures.ts`, shared by both
outputs). `tools/recolor_svgs.py` converted the original editorial palette; use tokens for any new figure.

## Editing

- **Articles:** edit `content/series/*.md`, then `deno task build` and `deno task series`.
- **Lab prose:** the executed notebooks are evidence, so their code and outputs never change by hand. A markdown
  edit must land in the generator and the executed notebook together: put the change in a JSON file and run
  `python3 tools/lab_prose_edit.py edits.json` (it refuses unless each phrase occurs exactly once in both).
- **Re-running a lab** (a new celld release): regenerate with `labs/build_0N.py`, execute on the homelab JupyterLab
  (Deno kernel), and replace `content/labs/<slug>.ipynb` with the executed result. `labs/transplant.py` carries
  outputs onto a regenerated notebook when only prose changed.
- **Bibliography:** `content/book/bibliography.yaml`; every entry records where the book uses it.

## Checks

```
deno task test                      # unit tests for the build logic
deno task build                     # fails on a broken internal link
python3 tools/audit.py dist         # series phrasing left in book text
deno task serve &                   # http://127.0.0.1:8420
deno run -A tools/phone.ts /tmp/shots index.html …   # 390px overflow check + screenshots (INTERACT=1 also drives the drawer and glossary)
deno run -A tools/pwa_check.ts                        # manifest, installability, service worker, offline reading
deno run -A tools/figshot.ts /tmp/figs dark bucket.html   # every figure on a page, in a forced color scheme
sh tools/stage_preview.sh DIR                         # stage dist/ for a multi-page claude.ai artifact preview
```
