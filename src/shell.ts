/**
 * The book shell around bench-sheet pages: a top bar, a contents drawer, previous/next
 * links (plus a bottom bar at phone width), and the glossary popover. Styling uses bench-sheet's color tokens, so the light and
 * dark themes carry over unchanged.
 */

import { esc } from "../vendor/bench-sheet/bench.ts";

export interface TocEntry {
  slug: string;
  file: string;
  label: string;
  title: string;
  part: string;
}

export interface TocPart {
  key: string;
  title: string;
  entries: TocEntry[];
}

export function tocParts(entries: TocEntry[], partTitles: Record<string, string>): TocPart[] {
  const parts: TocPart[] = [];
  for (const e of entries) {
    let p = parts[parts.length - 1];
    if (!p || p.key !== e.part) {
      p = { key: e.part, title: partTitles[e.part] ?? "", entries: [] };
      parts.push(p);
    }
    p.entries.push(e);
  }
  return parts;
}

/** "Chapter 3 · The bucket…" — or just the title when the label adds nothing. */
export function entryName(e: TocEntry): string {
  return e.label === e.title ? e.title : `${e.label} · ${e.title}`;
}

export function tocList(parts: TocPart[], current?: string): string {
  return parts.map((p) =>
    `<li class="bt-part">${p.title ? `<p class="bt-ptitle">${esc(p.title)}</p>` : ""}<ol>${
      p.entries.map((e) =>
        `<li><a href="${e.file}"${e.slug === current ? ' aria-current="page"' : ""}><span class="bt-label">${
          esc(e.label === e.title ? "" : e.label)
        }</span><span class="bt-title">${esc(e.title)}</span></a></li>`
      ).join("")
    }</ol></li>`
  ).join("");
}

export function topBar(bookTitle: string, here: string, parts: TocPart[], current?: string): string {
  return `<header class="bookbar">
  <button class="bb-toc" type="button" aria-expanded="false" aria-controls="booktoc">Contents</button>
  <a class="bb-title" href="index.html">${esc(bookTitle)}</a>
  <span class="bb-here">${esc(here)}</span>
</header>
<div class="bt-scrim" hidden></div>
<nav id="booktoc" class="booktoc" aria-label="Book contents" hidden>
  <div class="bt-head"><a href="index.html">${
    esc(bookTitle)
  }</a><button class="bt-close" type="button" aria-label="Close contents">×</button></div>
  <ol class="bt-parts">${tocList(parts, current)}</ol>
</nav>`;
}

export function pager(prev?: TocEntry, next?: TocEntry): string {
  const cell = (e: TocEntry | undefined, rel: "prev" | "next") =>
    e
      ? `<a class="pg-${rel}" rel="${rel}" href="${e.file}"><span class="pg-dir">${
        rel === "prev" ? "← Previous" : "Next →"
      }</span><span class="pg-name">${esc(entryName(e))}</span></a>`
      : `<span class="pg-${rel}"></span>`;
  return `<nav class="pager" aria-label="Previous and next">${cell(prev, "prev")}${cell(next, "next")}</nav>`;
}

/**
 * The phone-width bottom bar: previous, contents, next. It is hidden above 40rem, where the top
 * bar and the end-of-page pager are enough, and BOOK_JS tucks it away while the reader scrolls down.
 */
export function bottomNav(prev?: TocEntry, next?: TocEntry): string {
  const cell = (e: TocEntry | undefined, rel: "prev" | "next") => {
    const text = rel === "prev" ? "‹ Previous" : "Next ›";
    return e
      ? `<a class="bn-${rel}" rel="${rel}" href="${e.file}" aria-label="${rel === "prev" ? "Previous" : "Next"}: ${
        esc(entryName(e))
      }">${text}</a>`
      : `<span class="bn-${rel}" aria-hidden="true"></span>`;
  };
  return `<nav class="booknav" aria-label="Chapter navigation">${
    cell(prev, "prev")
  }<button class="bn-toc" type="button" aria-expanded="false" aria-controls="booktoc">Contents</button>${
    cell(next, "next")
  }</nav>`;
}

export const BOOK_CSS = `
/* ── book shell ─────────────────────────────────────────────────────────── */
.bookbar {
  position: sticky; top: 0; z-index: 40;
  display: flex; align-items: center; gap: .75rem;
  padding: .45rem 1rem; min-height: 2.6rem;
  background: var(--paper); border-bottom: 1px solid var(--rule);
  font-family: var(--f-head); font-size: .92rem;
}
.bookbar .bb-title { color: var(--ink); font-weight: 600; text-decoration: none; white-space: nowrap; }
.bookbar .bb-here { color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.bb-toc, .bt-close {
  font: inherit; color: var(--ink); background: var(--paper-2);
  border: 1px solid var(--rule); border-radius: 4px; padding: .2rem .6rem; cursor: pointer;
}
.bb-toc:hover, .bt-close:hover { border-color: var(--cobalt); color: var(--cobalt); }
.booktoc {
  position: fixed; inset: 0 auto 0 0; z-index: 60; width: min(24rem, 88vw);
  overflow-y: auto; background: var(--paper-2); border-right: 1px solid var(--rule);
  box-shadow: 0 0 2rem rgba(0,0,0,.18); padding: 0 0 2rem;
  font-family: var(--f-head);
}
.booktoc[hidden], .bt-scrim[hidden] { display: none; }
.bt-scrim { position: fixed; inset: 0; z-index: 50; background: rgba(0,0,0,.28); }
.bt-head {
  position: sticky; top: 0; display: flex; justify-content: space-between; align-items: center;
  padding: .6rem 1rem; background: var(--paper-2); border-bottom: 1px solid var(--rule);
}
.bt-head a { color: var(--ink); font-weight: 600; text-decoration: none; }
.booktoc ol { list-style: none; margin: 0; padding: 0; }
.bt-part { padding: .6rem 1rem 0; }
.bt-ptitle { margin: .4rem 0 .2rem; font-size: .78rem; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-3); }
.booktoc li li a {
  display: grid; grid-template-columns: 5.6rem 1fr; gap: .4rem; padding: .28rem .4rem;
  color: var(--ink-2); text-decoration: none; border-radius: 3px; font-size: .92rem; line-height: 1.3;
}
.booktoc li li a:hover { background: var(--cobalt-wash); color: var(--ink); }
.booktoc a[aria-current="page"] { color: var(--cobalt); background: var(--cobalt-wash); font-weight: 600; }
.bt-label { color: var(--ink-3); font-size: .82rem; }
.pager {
  display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;
  max-width: calc(var(--gutter) + var(--col)); margin: 2.5rem auto 1rem; padding: 0 1rem;
  font-family: var(--f-head);
}
.pager a {
  display: flex; flex-direction: column; gap: .15rem; padding: .7rem .9rem;
  border: 1px solid var(--rule); border-radius: 4px; text-decoration: none; color: var(--ink);
}
.pager a:hover { border-color: var(--cobalt); }
.pager .pg-next { text-align: right; }
.pg-dir { font-size: .78rem; color: var(--ink-3); letter-spacing: .04em; }
.pg-name { font-size: .95rem; }
.booknav { display: none; }
@media (max-width: 40rem) {
  .bookbar .bb-here { display: none; }
  .pager { grid-template-columns: 1fr; }
  .pager .pg-next { text-align: left; }
  /* Phone bottom bar: slim, quiet, and out of the way while reading. */
  body:has(.booknav) { padding-bottom: calc(3rem + env(safe-area-inset-bottom, 0px)); }
  .booknav {
    position: fixed; inset: auto 0 0 0; z-index: 40;
    display: grid; grid-template-columns: 1fr auto 1fr; align-items: center;
    padding: .3rem .75rem calc(.3rem + env(safe-area-inset-bottom, 0px));
    background: color-mix(in srgb, var(--paper) 94%, transparent);
    -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
    border-top: 1px solid var(--rule);
    font-family: var(--f-head); font-size: .9rem;
    transition: transform .2s ease;
  }
  .booknav.bn-away { transform: translateY(100%); }
  .booknav a, .booknav .bn-toc {
    display: inline-flex; align-items: center; min-height: 2.4rem; padding: 0 .5rem;
    color: var(--ink-2); text-decoration: none; border-radius: 4px;
  }
  .booknav .bn-next { justify-self: end; }
  .booknav .bn-toc { font: inherit; color: var(--ink); background: none; border: 1px solid var(--rule); cursor: pointer; }
  .booknav a:active, .booknav .bn-toc:active { background: var(--cobalt-wash); color: var(--cobalt); }
  .booknav a:focus-visible, .booknav .bn-toc:focus-visible { outline: 2px solid var(--cobalt); outline-offset: 1px; }
}
@media (prefers-reduced-motion: reduce) { .booknav { transition: none; } }
@media print { .booknav { display: none !important; } }

/* glossary terms */
.gloss { text-decoration: underline dotted var(--ink-3); text-underline-offset: .18em; cursor: help; }
.gloss:focus-visible { outline: 2px solid var(--cobalt); outline-offset: 1px; border-radius: 2px; }
.gloss-pop {
  position: absolute; z-index: 70; max-width: min(22rem, calc(100vw - 1rem));
  padding: .55rem .7rem; border-radius: 4px; background: var(--ink); color: var(--paper);
  font: .86rem/1.45 var(--f-prose); box-shadow: 0 .4rem 1.2rem rgba(0,0,0,.22);
}
.gloss-pop b { font-family: var(--f-head); font-weight: 600; margin-right: .3rem; }
.gloss-pop a { color: inherit; }
.gloss-pop[hidden] { display: none; }

/* long URLs (the bibliography) wrap instead of widening the page */
.prose a { overflow-wrap: anywhere; }

/* chapter sources footer */
.book-sources { font-family: var(--f-head); font-size: .9rem; color: var(--ink-2); }
.book-sources a { color: var(--cobalt); }

/* cover */
.cover { max-width: calc(var(--gutter) + var(--col)); margin: 0 auto; padding: 3rem 1rem 2rem; }
.cover .c-kicker { font-family: var(--f-head); color: var(--ink-3); letter-spacing: .06em; text-transform: uppercase; font-size: .82rem; margin: 0; }
.cover h1 { font-family: var(--f-head); font-size: clamp(2.4rem, 7vw, 4rem); line-height: 1; margin: .4rem 0 .2rem; color: var(--ink); }
.cover .c-sub { font-family: var(--f-head); font-size: clamp(1.2rem, 3.4vw, 1.7rem); color: var(--ink-2); margin: 0 0 1.2rem; }
.cover .c-dek { font-family: var(--f-prose); font-size: 1.12rem; line-height: 1.55; color: var(--ink); max-width: 42rem; }
.cover .c-meta { font-family: var(--f-head); color: var(--ink-3); font-size: .9rem; }
.cover .c-ai { font-family: var(--f-prose); font-size: .95rem; color: var(--ink-2); border-left: 3px solid var(--signal); padding: .2rem 0 .2rem .8rem; max-width: 42rem; }
.cover .c-toc { margin-top: 2rem; }
.cover .c-toc ol { list-style: none; margin: 0; padding: 0; }
.cover .bt-part { padding: .8rem 0 0; }
.cover .bt-ptitle { font-family: var(--f-head); font-size: .8rem; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-3); margin: .6rem 0 .3rem; border-bottom: 1px solid var(--rule); padding-bottom: .2rem; }
.cover li li a { display: grid; grid-template-columns: 6.5rem 1fr; gap: .5rem; padding: .3rem 0; color: var(--ink); text-decoration: none; font-family: var(--f-head); }
.cover li li a:hover .bt-title { color: var(--cobalt); }
`;

export const BOOK_JS = `
// Book shell: contents drawer, phone bottom bar, and glossary popover. The pages read completely without it.
(() => {
  const toc = document.getElementById("booktoc");
  const scrim = document.querySelector(".bt-scrim");
  const openBtns = [...document.querySelectorAll(".bb-toc, .bn-toc")];
  const closeBtn = document.querySelector(".bt-close");
  if (toc && openBtns.length) {
    let opener = openBtns[0];
    const setOpen = (open) => {
      toc.hidden = !open;
      if (scrim) scrim.hidden = !open;
      openBtns.forEach((b) => b.setAttribute("aria-expanded", String(open)));
      if (open) (toc.querySelector('[aria-current="page"]') || toc.querySelector("a"))?.focus();
      else opener.focus();
    };
    openBtns.forEach((b) => b.addEventListener("click", () => { opener = b; setOpen(toc.hidden); }));
    closeBtn?.addEventListener("click", () => setOpen(false));
    scrim?.addEventListener("click", () => setOpen(false));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !toc.hidden) setOpen(false); });
  }

  // Phone bottom bar: tuck it away while reading down, bring it back on any scroll up, near the top,
  // at the end of the page, or when it takes keyboard focus.
  const nav = document.querySelector(".booknav");
  if (nav) {
    let lastY = scrollY;
    const update = () => {
      const y = scrollY;
      const atEnd = y + innerHeight >= document.documentElement.scrollHeight - 48;
      if (y < 64 || atEnd || y < lastY - 6) nav.classList.remove("bn-away");
      else if (y > lastY + 6) nav.classList.add("bn-away");
      if (Math.abs(y - lastY) > 6) lastY = y;
    };
    addEventListener("scroll", update, { passive: true });
    nav.addEventListener("focusin", () => nav.classList.remove("bn-away"));
  }

  const terms = document.querySelectorAll(".gloss");
  if (!terms.length) return;
  const pop = document.createElement("div");
  pop.className = "gloss-pop";
  pop.id = "gloss-pop";
  pop.setAttribute("role", "tooltip");
  pop.hidden = true;
  document.body.append(pop);
  let current = null;
  const show = (el) => {
    current = el;
    pop.innerHTML = "";
    const b = document.createElement("b");
    b.textContent = el.dataset.term || el.textContent;
    pop.append(b, document.createTextNode(el.dataset.def || ""));
    pop.hidden = false;
    const r = el.getBoundingClientRect();
    const w = pop.offsetWidth;
    const left = Math.min(Math.max(8, r.left + scrollX), scrollX + document.documentElement.clientWidth - w - 8);
    const below = r.bottom + 6 + pop.offsetHeight < innerHeight;
    pop.style.left = left + "px";
    pop.style.top = (below ? r.bottom + scrollY + 6 : r.top + scrollY - pop.offsetHeight - 6) + "px";
    el.setAttribute("aria-describedby", "gloss-pop");
  };
  const hide = () => { pop.hidden = true; current?.removeAttribute("aria-describedby"); current = null; };
  terms.forEach((el) => {
    el.removeAttribute("title"); // the native tooltip is the no-script fallback
    el.addEventListener("mouseenter", () => show(el));
    el.addEventListener("mouseleave", hide);
    el.addEventListener("focus", () => show(el));
    el.addEventListener("blur", hide);
    el.addEventListener("click", (e) => { e.stopPropagation(); current === el && !pop.hidden ? hide() : show(el); });
  });
  document.addEventListener("click", hide);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });
  addEventListener("scroll", () => { if (current) show(current); }, { passive: true });
})();
`;
