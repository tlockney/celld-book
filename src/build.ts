/**
 * Build the book site into dist/.
 *
 *   deno task build
 *
 * Pass 1 renders every page with the bench-sheet renderers (book variant of the sources).
 * Pass 2 rewrites cross-references, marks glossary terms, adds the sources footer and the
 * book shell, then checks that every internal link resolves.
 */

import { parseHTML } from "linkedom";
import { type BookConfig, type DocKey, type PageConfig, parseBibliography, parseBookConfig } from "./config.ts";
import { applyVariants } from "./variants.ts";
import {
  extractSubsection,
  findCallout,
  promoteHeadings,
  replaceSubsection,
  type Section,
  splitFrontmatter,
  splitSections,
} from "./markdown.ts";
import { type DocKind, type Resolver, rewrite, type Target } from "./xref.ts";
import { markTerms, parseGlossary, type Term } from "./glossary.ts";
import { BOOK_CSS, BOOK_JS, entryName, pager, type TocEntry, tocList, tocParts, topBar } from "./shell.ts";
import { esc, readAssets, wrapPage } from "../vendor/bench-sheet/bench.ts";
import { renderArticle } from "../vendor/bench-sheet/render-article.ts";
import { isNotebook, type Notebook, renderNotebook, toNotebookMeta } from "../vendor/bench-sheet/render-notebook.ts";
import { parse as parseYaml } from "@std/yaml";
import { FIGURE_CSS } from "./figures.ts";
import { ZOOM_CSS, ZOOM_JS } from "./zoom.ts";
import { LABS_README, labsZip, notebookForDownload } from "./downloads.ts";
import { contentVersion, ICON_FILES, manifest, REGISTER_JS, serviceWorker, withHeadTags } from "./pwa.ts";

const ROOT = new URL("../", import.meta.url).pathname;
const read = (p: string) => Deno.readTextFileSync(ROOT + p);

// ── inputs ────────────────────────────────────────────────────────────────

export interface BuildInputs {
  book: BookConfig;
  docs: Record<DocKey, { data: Record<string, unknown>; body: string; sections: Section[] }>;
}

export function loadInputs(): BuildInputs {
  const book = parseBookConfig(read("book.jsonc"));
  const doc = (key: DocKey) => {
    const { data, body } = splitFrontmatter(applyVariants(read(book.sources[key]), "book"));
    return { data, body, sections: splitSections(body).sections };
  };
  return { book, docs: { part0: doc("part0"), fg: doc("fg"), guide: doc("guide"), review: doc("review") } };
}

const DOC_KIND: Record<DocKey, DocKind> = { part0: "part0", fg: "fg", guide: "guide", review: "review" };
const LEGACY: Record<string, string> = {
  "celld-00-background": "foundations",
  "celld-durable-objects": "how-celld-works",
  "celld-step-by-step": "building",
  "celld-review": "review",
  "celld-01-cells": "lab-1",
  "celld-02-bindings": "lab-2",
  "celld-03-processes": "lab-3",
};

const fileOf = (slug: string) => `${slug}.html`;
const yamlStr = (v: string) => JSON.stringify(v);

function frontmatter(fields: Record<string, string | boolean | Record<string, string> | undefined>): string {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (typeof v === "object") {
      lines.push(`${k}:`);
      for (const [mk, mv] of Object.entries(v)) lines.push(`  ${yamlStr(mk)}: ${yamlStr(mv)}`);
    } else lines.push(`${k}: ${typeof v === "boolean" ? String(v) : yamlStr(v)}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

// ── page markdown ─────────────────────────────────────────────────────────

export interface PlannedPage {
  cfg: PageConfig;
  title: string;
  kind: DocKind;
  /** Markdown for article-rendered pages; undefined for labs. */
  md?: string;
}

function sectionById(sections: Section[], id: string): Section {
  const s = sections.find((x) => x.id === id);
  if (!s) throw new Error(`no section {#${id}}`);
  return s;
}

export function planPage(cfg: PageConfig, inp: BuildInputs): PlannedPage {
  const { book, docs } = inp;
  const series = `${book.title}: ${book.subtitle}`;
  const partTitle = book.parts[cfg.part] ?? "";
  const partMeta = partTitle
    ? { ...(partTitle.startsWith("Part ") ? { Part: partTitle.slice(5) } : { In: partTitle }), Edition: "celld v0.6.0" }
    : undefined;

  if (cfg.md) {
    const { data, body } = splitFrontmatter(applyVariants(read(cfg.md), "book"));
    const title = String(data.title ?? cfg.label);
    return {
      cfg,
      title,
      kind: "book",
      md: frontmatter({ title, kind: String(data.kind ?? cfg.label), series, numbered: false }) + body,
    };
  }
  if (cfg.bibliography) return { cfg, title: "Bibliography", kind: "book", md: bibliographyMarkdown(inp) };
  if (cfg.lab) {
    const meta = parseYaml(read(`${book.sources.labs[cfg.lab - 1]}.meta.yaml`));
    const title = typeof meta === "object" && meta !== null && "title" in meta ? String(meta.title) : cfg.label;
    return { cfg, title, kind: "lab" };
  }

  const key = cfg.doc as DocKey;
  const d = docs[key];
  let body: string;
  let title: string;
  let numbered = true;
  if (cfg.gather) {
    const from = sectionById(d.sections, cfg.gather.from);
    const callout = findCallout(from.body, cfg.gather.callout);
    const { extracted } = extractSubsection(from.body, cfg.gather.subsection);
    body = `## Upgrade cliffs {#upgrade-cliffs}\n\n${callout}\n\n## Release notes {#release-notes}\n\n${extracted}\n`;
    title = cfg.title ?? "Release notes";
  } else if (cfg.sections) {
    const secs = cfg.sections.map((id) => {
      const s = sectionById(d.sections, id);
      return cfg.moveOut ? { ...s, body: replaceSubsection(s.body, cfg.moveOut.subsection, cfg.moveOut.pointer) } : s;
    });
    if (secs.length === 1 && cfg.promote) {
      body = promoteHeadings(secs[0].body);
      title = cfg.title ?? secs[0].title;
      if (!/^## /m.test(body)) numbered = false;
    } else {
      body = secs.map((s) => `## ${s.title} {#${s.id}}\n${s.body}`).join("\n");
      title = cfg.title ?? secs[0].title;
    }
  } else {
    body = d.body;
    title = cfg.title ?? String(d.data.title ?? cfg.label);
  }
  const dek = !cfg.sections && !cfg.gather && typeof d.data.dek === "string" ? d.data.dek : undefined;
  const sectionLabel = typeof d.data.section_label === "string" ? d.data.section_label : "§";
  return {
    cfg,
    title,
    kind: DOC_KIND[key],
    md: frontmatter({
      title,
      dek,
      kind: cfg.kind ?? cfg.label,
      series,
      section_label: sectionLabel,
      numbered,
      meta: partMeta,
    }) + body,
  };
}

const USED_IN: Record<string, string> = {
  ch1: "Chapter 1",
  part2: "Chapters 2–8 and Appendices B–C",
  ch9: "Chapter 9",
  labs: "Labs 1–3",
  appA: "Appendix A",
  appD: "Appendix D",
};

function bibDate(d: string): string {
  return d.replace(/-/g, "·");
}

export function bibliographyMarkdown(inp: BuildInputs): string {
  const page = inp.book.pages.find((p) => p.bibliography);
  const bib = parseBibliography(read(page?.bibliography ?? ""));
  const out = [
    frontmatter({
      title: "Bibliography",
      kind: "Back matter",
      series: `${inp.book.title}: ${inp.book.subtitle}`,
      numbered: false,
    }),
    `Every source this book draws on, grouped by subject. "Used in" names the parts of the book whose text cites the source; attribution is at that level, because that is how the sources were used. Pages were read between 2026·09·15 and ${
      bibDate(bib.accessed)
    }; celld's documentation is cited at the v0.6.0 tag so the links keep matching the text.`,
    "",
  ];
  for (const g of bib.groups) {
    out.push(`## ${g.title} {#bib-${g.id}}`, "");
    for (const e of g.entries) {
      const parts = [
        e.author ? `${e.author}.` : "",
        `*${e.title}*.`,
        [e.publisher, e.date ? bibDate(e.date) : ""].filter(Boolean).join(", ") + ".",
        e.url ? `[${e.url.replace(/^https?:\/\//, "")}](${e.url})` : "",
      ].filter((x) => x && x !== ".");
      const used = e.usedIn.map((k) => USED_IN[k] ?? k).join("; ");
      out.push(`- <span id="bib-${e.id}"></span>${parts.join(" ")} — Used in: ${used}.`);
    }
    out.push("");
  }
  return out.join("\n");
}

// ── rendering ─────────────────────────────────────────────────────────────

async function renderPage(p: PlannedPage, inp: BuildInputs, assets: Assets): Promise<string> {
  if (p.md !== undefined) {
    return renderArticle(p.md, { css: assets.articleCss, js: assets.js });
  }
  const base = inp.book.sources.labs[(p.cfg.lab ?? 1) - 1];
  const raw: unknown = JSON.parse(read(`${base}.ipynb`));
  if (!isNotebook(raw)) throw new Error(`${base}.ipynb is not a notebook`);
  const nb: Notebook = {
    ...raw,
    cells: raw.cells.map((c) => {
      if (c.cell_type !== "markdown") return c;
      const src = Array.isArray(c.source) ? c.source.join("") : c.source;
      return { ...c, source: applyVariants(src, "book") };
    }),
  };
  const metaRaw = parseYaml(read(`${base}.meta.yaml`));
  const meta = toNotebookMeta(metaRaw);
  meta.series_parts = [];
  const nbName = `${base.split("/").pop()}.ipynb`;
  meta.preface_label = "Run it yourself";
  meta.preface = "This chapter is an executed notebook: every output below came from a run against celld v0.6.0 on " +
    `2026·09·26. To run it yourself, download [this notebook](labs/${nbName}) and the helper ` +
    "[celld_nb.ts](labs/celld_nb.ts) into the same folder (the setup cell imports it), or get " +
    "[all three labs and the helper as a zip](labs/celld-labs.zip). Open the notebook in JupyterLab with a Deno " +
    "kernel; the setup cell installs celld and esbuild if they are missing.";
  meta.series = `${p.cfg.label} · Chapter ${p.cfg.chapter} · ${inp.book.title}: ${inp.book.subtitle}`;
  return await Promise.resolve(renderNotebook(nb, {
    meta,
    source: `labs/${base.split("/").pop()}.ipynb`,
    date: "",
    css: assets.notebookCss,
    js: assets.js,
  }));
}

interface Assets {
  articleCss: string;
  notebookCss: string;
  js: string;
}

// ── cross-page indexes ────────────────────────────────────────────────────

const ID_RE = /\sid="([^"]+)"/g;

export interface Index {
  /** Every element id on every page. */
  idsByPage: Map<string, Set<string>>;
  /** Source section id → page (+ anchor when the section heading survives on the page). */
  sectionPage: Map<string, { slug: string; anchor?: string }>;
  /** Lab n → notebook part m → cell id. */
  labParts: Map<number, Map<number, string>>;
}

export function buildIndex(planned: PlannedPage[], html: Map<string, string>, inp: BuildInputs): Index {
  const idsByPage = new Map<string, Set<string>>();
  for (const [slug, h] of html) idsByPage.set(slug, new Set([...h.matchAll(ID_RE)].map((m) => m[1])));
  const sectionPage = new Map<string, { slug: string; anchor?: string }>();
  for (const p of planned) {
    const c = p.cfg;
    if (c.doc && !c.sections && !c.gather) {
      for (const s of inp.docs[c.doc].sections) sectionPage.set(s.id, { slug: c.slug, anchor: s.id });
    }
    if (c.doc && c.sections) {
      const multi = c.sections.length > 1 || !c.promote;
      for (const id of c.sections) sectionPage.set(id, { slug: c.slug, anchor: multi ? id : undefined });
    }
  }
  const labParts = new Map<number, Map<number, string>>();
  for (const p of planned) {
    if (!p.cfg.lab) continue;
    const parts = new Map<number, string>();
    const h = html.get(p.cfg.slug) ?? "";
    for (const m of h.matchAll(/<section class="cell cell-md" id="([^"]+)">[\s\S]*?<\/section>/g)) {
      const pm = m[0].match(/<h2[^>]*>\s*Part (\d)\b/);
      if (pm && !parts.has(Number(pm[1]))) parts.set(Number(pm[1]), m[1]);
    }
    labParts.set(p.cfg.lab, parts);
  }
  return { idsByPage, sectionPage, labParts };
}

export function makeResolver(planned: PlannedPage[], idx: Index, inp: BuildInputs, current: PlannedPage): Resolver {
  const bySlug = new Map(planned.map((p) => [p.cfg.slug, p]));
  const ids = (k: DocKey) => inp.docs[k].sections.map((s) => s.id);
  const toTarget = (sectionId: string | undefined, label?: string): Target | undefined => {
    if (!sectionId) return undefined;
    const loc = idx.sectionPage.get(sectionId);
    if (!loc) return undefined;
    const page = bySlug.get(loc.slug);
    if (!page) return undefined;
    const here = loc.slug === current.cfg.slug;
    const href = loc.anchor ? `${here ? "" : fileOf(loc.slug)}#${loc.anchor}` : fileOf(loc.slug);
    return { label: label ?? page.cfg.label, href };
  };
  const partPage = (slug: string, label: string): Target => ({ label, href: fileOf(slug) });
  const labSlug = (n: number) => planned.find((p) => p.cfg.lab === n)?.cfg.slug;
  return {
    fg: (n) => toTarget(ids("fg")[n - 1]),
    part0: (n) => toTarget(ids("part0")[n - 1]),
    step: (n) => toTarget(ids("guide")[n - 1]),
    lab: (n, part) => {
      const slug = labSlug(n);
      if (!slug) return undefined;
      const anchor = part ? idx.labParts.get(n)?.get(part) : undefined;
      return { label: `Lab ${n}`, href: `${fileOf(slug)}${anchor ? `#${anchor}` : ""}` };
    },
    local: (n) => {
      const key = current.cfg.doc;
      if (!key) return undefined;
      const id = ids(key)[n - 1];
      return id ? { label: `§ ${String(n).padStart(2, "0")}`, href: `#${id}` } : undefined;
    },
    part: (n) =>
      n === 0
        ? partPage("foundations", "Chapter 1")
        : n === 1
        ? partPage("how-celld-works", "Part II")
        : partPage("building", "Chapter 9"),
  };
}

// ── pass 2: DOM post-processing ───────────────────────────────────────────

type El = {
  tagName: string;
  nodeType: number;
  childNodes: ArrayLike<El>;
  parentNode: El | null;
  textContent: string | null;
  classList?: { contains(c: string): boolean };
  getAttribute(n: string): string | null;
  setAttribute(n: string, v: string): void;
  closest?(sel: string): El | null;
  replaceWith(...nodes: unknown[]): void;
  insertAdjacentHTML(pos: string, html: string): void;
  append(...nodes: unknown[]): void;
  querySelectorAll(sel: string): ArrayLike<El>;
  querySelector(sel: string): El | null;
};

const SKIP = new Set(["pre", "code", "script", "style", "svg", "button"]);
const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

export interface PostContext {
  planned: PlannedPage[];
  idx: Index;
  inp: BuildInputs;
  terms: Term[];
  toc: TocEntry[];
}

function rewriteHref(href: string, page: PlannedPage, pc: PostContext): string {
  const m = href.match(/^(celld-[\w-]+)(#[\w-]+)?$/);
  if (m && LEGACY[m[1]]) {
    const anchor = m[2]?.slice(1);
    const sec = anchor ? pc.idx.sectionPage.get(anchor) : undefined;
    if (sec) return sec.anchor ? `${fileOf(sec.slug)}#${sec.anchor}` : fileOf(sec.slug);
    return fileOf(LEGACY[m[1]]) + (m[2] ?? "");
  }
  if (href.startsWith("#")) {
    const id = href.slice(1);
    if (pc.idx.idsByPage.get(page.cfg.slug)?.has(id)) return href;
    const sec = pc.idx.sectionPage.get(id);
    if (sec) return sec.anchor ? `${fileOf(sec.slug)}#${sec.anchor}` : fileOf(sec.slug);
    for (const [slug, set] of pc.idx.idsByPage) if (set.has(id)) return `${fileOf(slug)}#${id}`;
  }
  return href;
}

export function postprocess(html: string, page: PlannedPage, pc: PostContext): string {
  const { document } = parseHTML(html);
  const doc = document as unknown as El & {
    createTextNode(t: string): unknown;
    createElement(t: string): El;
    body: El;
  };
  const resolver = makeResolver(pc.planned, pc.idx, pc.inp, page);

  for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
    const href = a.getAttribute("href") ?? "";
    const next = rewriteHref(href, page, pc);
    if (next !== href) a.setAttribute("href", next);
    if (/^labs\/[\w.-]+\.(ipynb|ts|zip)$/.test(next)) a.setAttribute("download", next.slice("labs/".length));
  }

  const containers = page.kind === "lab"
    ? "main .prose, header .dek, nav.outline"
    : "main .prose, main .table-wrap, main .c-title, main .pull, main .runline, main figcaption, main h2, main h3, header .dek, nav.outline";
  const used = new Set<string>(pc.inp.book.glossary.exclude);
  // Glossary hovers everywhere except the glossary itself and the front/back matter.
  const glossOn = !["glossary", "introduction", "bibliography", "colophon"].includes(page.cfg.slug);
  const seen = new Set<El>();

  const visit = (node: El, inLink: boolean, inHeading: boolean) => {
    if (node.nodeType === 3) {
      const text = node.textContent ?? "";
      if (!text.trim()) return;
      let segs = rewrite(text, resolver, { doc: page.kind, inLink: inLink || inHeading });
      segs = segs.map((s) => {
        if (typeof s !== "string") return s;
        let t = s;
        for (const [from, to] of pc.inp.book.phrases) t = t.split(from).join(to);
        return t;
      });
      const nodes: unknown[] = [];
      let changed = !(segs.length === 1 && segs[0] === text);
      for (const s of segs) {
        if (typeof s !== "string") {
          const a = doc.createElement("a");
          a.setAttribute("href", s.href);
          a.append(doc.createTextNode(s.text));
          nodes.push(a);
          continue;
        }
        if (!glossOn || inLink || inHeading) {
          nodes.push(doc.createTextNode(s));
          continue;
        }
        for (const g of markTerms(s, pc.terms, used)) {
          if (typeof g === "string") nodes.push(doc.createTextNode(g));
          else {
            changed = true;
            const span = doc.createElement("span");
            span.setAttribute("class", "gloss");
            span.setAttribute("tabindex", "0");
            span.setAttribute("data-term", g.term.term);
            span.setAttribute("data-def", g.term.def);
            span.setAttribute("title", `${g.term.term}: ${g.term.def}`);
            span.append(doc.createTextNode(g.text));
            nodes.push(span);
          }
        }
      }
      if (changed) node.replaceWith(...nodes);
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();
    if (SKIP.has(tag)) return;
    if (node.classList?.contains("outputs") || node.classList?.contains("gloss")) return;
    const kids = Array.from(node.childNodes);
    for (const k of kids) visit(k, inLink || tag === "a", inHeading || HEADINGS.has(tag));
  };

  for (const c of Array.from(doc.querySelectorAll(containers))) {
    if (seen.has(c)) continue;
    if (c.closest?.(".outputs")) continue;
    // A nested match (a .prose inside a .table-wrap, say) is visited through its container.
    let anc = c.parentNode;
    let nested = false;
    while (anc) {
      if (seen.has(anc)) nested = true;
      anc = anc.parentNode;
    }
    seen.add(c);
    if (!nested) visit(c, !!c.closest?.("a"), HEADINGS.has(c.tagName.toLowerCase()));
  }

  // Sources footer.
  const main = doc.querySelector("main");
  const footer = sourcesFooter(page, pc);
  if (main && footer) main.insertAdjacentHTML("beforeend", footer);

  // Shell: top bar + drawer, pager.
  const i = pc.toc.findIndex((e) => e.slug === page.cfg.slug);
  const here = pc.toc[i];
  const parts = tocParts(pc.toc, pc.inp.book.parts);
  doc.body.insertAdjacentHTML("afterbegin", topBar(bookTitle(pc), here ? entryName(here) : "", parts, page.cfg.slug));
  const colophon = doc.querySelector("footer.colophon");
  const pg = pager(pc.toc[i - 1], pc.toc[i + 1]);
  if (colophon) colophon.insertAdjacentHTML("beforebegin", pg);
  else doc.body.insertAdjacentHTML("beforeend", pg);

  return "<!doctype html>\n" +
    (document as unknown as { documentElement: { outerHTML: string } }).documentElement.outerHTML;
}

const bookTitle = (pc: PostContext) => `${pc.inp.book.title}: ${pc.inp.book.subtitle}`;

function sourcesFooter(page: PlannedPage, pc: PostContext): string {
  const keys = pc.inp.book.sourcesFor[page.cfg.slug];
  if (!keys?.length) return "";
  const bibPage = pc.inp.book.pages.find((p) => p.bibliography);
  if (!bibPage?.bibliography) return "";
  const bib = parseBibliography(read(bibPage.bibliography));
  const groups = bib.groups
    .map((g) => ({ g, n: g.entries.filter((e) => e.usedIn.some((u) => keys.includes(u))).length }))
    .filter((x) => x.n > 0);
  if (!groups.length) return "";
  const items = groups.map(({ g, n }) =>
    `<a href="${fileOf(bibPage.slug)}#bib-${g.id}">${esc(g.title)}</a> (${n} ${n === 1 ? "entry" : "entries"})`
  );
  return `<section class="sec book-sources" aria-label="Sources"><div class="row r-prose"><div class="gutter"><span class="glabel">Sources</span></div><div class="rbody"><div class="prose"><p>This ${
    page.cfg.lab ? "lab" : "chapter"
  } draws on: ${items.join(" · ")}. The full entries are in the <a href="${
    fileOf(bibPage.slug)
  }">Bibliography</a>.</p></div></div></div></section>`;
}

// ── cover ─────────────────────────────────────────────────────────────────

function coverPage(pc: PostContext, css: string, js: string): string {
  const b = pc.inp.book;
  const parts = tocParts(pc.toc, b.parts);
  const body = `${topBar(bookTitle(pc), "Contents", parts)}
<main class="cover">
  <p class="c-kicker">A mini-book · ${esc(b.edition)}</p>
  <h1>${esc(b.title)}</h1>
  <p class="c-sub">${esc(b.subtitle)}</p>
  <p class="c-dek">${esc(b.dek)}</p>
  <p class="c-ai">Generated with AI from materials curated by ${
    esc(b.curator)
  }. The <a href="introduction.html">Introduction</a> explains how to read it, and the <a href="colophon.html">Colophon</a> describes how it was made.</p>
  <nav class="c-toc" aria-label="Contents"><ol class="bt-parts">${tocList(parts)}</ol></nav>
</main>`;
  return wrapPage({ title: `${b.title}: ${b.subtitle}`, css, js, body });
}

// ── link check ────────────────────────────────────────────────────────────

export function checkLinks(files: Map<string, string>, assets: Set<string> = new Set()): string[] {
  const ids = new Map<string, Set<string>>();
  for (const [f, h] of files) ids.set(f, new Set([...h.matchAll(ID_RE)].map((m) => m[1])));
  const problems: string[] = [];
  for (const [f, h] of files) {
    for (const m of h.matchAll(/<a\b[^>]*\shref="([^"]+)"/g)) {
      const href = m[1];
      if (/^(https?:|mailto:)/.test(href)) continue;
      const [file, anchor] = href.split("#");
      const target = file === "" ? f : file;
      if (assets.has(target)) continue;
      if (!ids.has(target)) {
        problems.push(`${f}: link to missing page ${href}`);
        continue;
      }
      if (anchor && !ids.get(target)?.has(anchor)) problems.push(`${f}: link to missing anchor ${href}`);
    }
  }
  return problems;
}

// ── main ──────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const inp = loadInputs();
  const assets: Assets = {
    articleCss: (await readAssets("bench.css", "article.css")) + FIGURE_CSS + BOOK_CSS + ZOOM_CSS,
    notebookCss: (await readAssets("bench.css", "notebook.css")) + BOOK_CSS,
    js: (await readAssets("bench.js")) + BOOK_JS + ZOOM_JS + REGISTER_JS,
  };
  const nbJs = (await readAssets("bench.js", "notebook.js")) + BOOK_JS + REGISTER_JS;

  const planned = inp.book.pages.map((c) => planPage(c, inp));
  const raw = new Map<string, string>();
  for (const p of planned) {
    raw.set(p.cfg.slug, await renderPage(p, inp, p.cfg.lab ? { ...assets, js: nbJs } : assets));
  }
  const idx = buildIndex(planned, raw, inp);
  const terms = parseGlossary(sectionById(inp.docs.fg.sections, "glossary").body);
  const toc: TocEntry[] = planned.map((p) => ({
    slug: p.cfg.slug,
    file: fileOf(p.cfg.slug),
    label: p.cfg.lab ? `${p.cfg.label} · Ch. ${p.cfg.chapter}` : p.cfg.tocLabel ?? p.cfg.label,
    title: p.title,
    part: p.cfg.part,
  }));
  const pc: PostContext = { planned, idx, inp, terms, toc };

  const out = new Map<string, string>();
  for (const p of planned) out.set(fileOf(p.cfg.slug), postprocess(raw.get(p.cfg.slug) ?? "", p, pc));
  out.set("index.html", coverPage(pc, (await readAssets("bench.css")) + BOOK_CSS, BOOK_JS + REGISTER_JS));
  const appName = inp.book.title;
  for (const [f, h] of out) out.set(f, withHeadTags(h, appName));

  const dist = ROOT + "dist/";
  await Deno.remove(dist, { recursive: true }).catch(() => {});
  await Deno.mkdir(dist, { recursive: true });
  for (const [f, h] of out) await Deno.writeTextFile(dist + f, h);

  // PWA: icons, manifest, and a service worker whose cache name hashes everything it serves.
  await Deno.mkdir(dist + "icons", { recursive: true });
  const icons = new Map<string, Uint8Array>();
  for (const f of ICON_FILES) {
    const bytes = await Deno.readFile(ROOT + "assets/" + f);
    icons.set(`icons/${f}`, bytes);
    await Deno.writeFile(dist + "icons/" + f, bytes);
  }
  // Downloads: the labs (book references, absolute links), the helper they import, and a zip of all.
  await Deno.mkdir(dist + "labs", { recursive: true });
  const downloads = new Map<string, Uint8Array>();
  const enc = new TextEncoder();
  const zipFiles: Record<string, Uint8Array> = {};
  for (const p of planned.filter((x) => x.cfg.lab)) {
    const base = inp.book.sources.labs[(p.cfg.lab ?? 1) - 1];
    const nbRaw: unknown = JSON.parse(read(`${base}.ipynb`));
    if (!isNotebook(nbRaw)) throw new Error(`${base}.ipynb is not a notebook`);
    const nb = notebookForDownload(
      nbRaw,
      makeResolver(planned, idx, inp, p),
      inp.book.siteUrl,
      fileOf(p.cfg.slug),
      inp.book.phrases,
    );
    const name = `${base.split("/").pop()}.ipynb`;
    const bytes = enc.encode(JSON.stringify(nb, null, 1) + "\n");
    downloads.set(`labs/${name}`, bytes);
    zipFiles[name] = bytes;
  }
  const helper = await Deno.readFile(ROOT + "labs/celld_nb.ts");
  downloads.set("labs/celld_nb.ts", helper);
  zipFiles["celld_nb.ts"] = helper;
  zipFiles["README.txt"] = enc.encode(LABS_README);
  downloads.set("labs/celld-labs.zip", labsZip(zipFiles));
  for (const [f, b] of downloads) await Deno.writeFile(dist + f, b);
  console.log(`downloads: ${[...downloads.keys()].join(", ")}`);

  const man = manifest(inp.book);
  await Deno.writeTextFile(dist + "manifest.webmanifest", man);
  const version = await contentVersion(
    new Map<string, string | Uint8Array>([...out, ...icons, ...downloads, ["manifest.webmanifest", man]]),
  );
  const precache = ["./", ...out.keys(), "manifest.webmanifest", ...icons.keys(), ...downloads.keys()];
  await Deno.writeTextFile(dist + "sw.js", serviceWorker(version, precache));
  console.log(`PWA: manifest, ${icons.size} icons, service worker (cache ${version}, ${precache.length} entries)`);

  const problems = checkLinks(out, new Set(downloads.keys()));
  console.log(`built ${out.size} pages into dist/`);
  if (problems.length) {
    console.error(`${problems.length} broken internal link(s):`);
    for (const p of problems) console.error("  " + p);
    Deno.exit(1);
  }
  console.log("all internal links resolve");
}
