/**
 * Render a markdown technical article as a standalone "bench sheet" HTML page,
 * the article counterpart of render-notebook.ts.
 *
 *   deno run -A render-article.ts <article.md> [-o out.html]
 *     [--source label] [--date YYYY-MM-DD] [--artifact]
 *
 * The notebook's gutter marks become the article's: section numbers beside
 * each `##` (01, 02, … under a label such as "Step" or "§"), sub-numbers
 * beside `###` (05.1), the language or filename beside each code block,
 * the kind beside each callout (GitHub `> [!NOTE]` alerts), and "Fig. n" /
 * "Tbl. n" beside figures and tables. Prose rows leave the gutter empty.
 *
 * Optional YAML frontmatter:
 *   title, dek, kind (masthead chip, default "Article"), series,
 *   section_label (default "§"), numbered (default true),
 *   meta (map of label → value shown in the masthead), source, date,
 *   series_parts (list of { title, href? }; the entry without href is this page)
 *
 * Two alert kinds beyond GitHub's five: `> [!RUN]` (a "Run it" line of links,
 * e.g. to companion notebooks) and `> [!TLDR]` (a takeaway set as a pull line).
 * Raw HTML `<figure>` and `<table>` blocks are numbered like their markdown kin.
 */

import { Marked, type Token, type Tokens } from "npm:marked@15.0.12";
import markedFootnote from "npm:marked-footnote@1.2.4";
import { parse as parseYaml } from "jsr:@std/yaml@1";
import {
  esc,
  highlight,
  type OutlineEntry,
  outlineNav,
  parseArgs,
  readAssets,
  renderTable,
  seriesNav,
  type SeriesPart,
  slugify,
  stripTags,
  toSeriesParts,
  wrapPage,
} from "./bench.ts";

export interface ArticleMeta {
  title?: string;
  dek?: string;
  kind?: string;
  series?: string;
  section_label?: string;
  numbered?: boolean;
  meta?: Record<string, string>;
  series_parts?: SeriesPart[];
  source?: string;
  date?: string;
}

export interface ArticleOptions {
  source?: string;
  date?: string;
  artifact?: boolean;
  css?: string;
  js?: string;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Split `---` YAML frontmatter from the body. Unknown keys are ignored. */
export function splitFrontmatter(src: string): { meta: ArticleMeta; body: string } {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: src };
  const raw: unknown = parseYaml(m[1]);
  const meta: ArticleMeta = {};
  if (isRecord(raw)) {
    for (const k of ["title", "dek", "kind", "series", "section_label", "source", "date"] as const) {
      const v = raw[k];
      if (typeof v === "string") meta[k] = v;
      else if (v instanceof Date) meta[k] = v.toISOString().slice(0, 10);
    }
    if (typeof raw.numbered === "boolean") meta.numbered = raw.numbered;
    if (isRecord(raw.meta)) {
      meta.meta = Object.fromEntries(
        Object.entries(raw.meta).map(([k, v]) => [k, v instanceof Date ? v.toISOString().slice(0, 10) : String(v)]),
      );
    }
    if (Array.isArray(raw.series_parts)) meta.series_parts = toSeriesParts(raw.series_parts);
  }
  return { meta, body: src.slice(m[0].length) };
}

const ALERT = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION|RUN|TLDR)\][ \t]*([^\n]*)\n?/i;
const ALERT_LABEL: Record<string, string> = {
  NOTE: "Note",
  TIP: "Tip",
  IMPORTANT: "Important",
  WARNING: "Warning",
  CAUTION: "Caution",
  RUN: "Run it",
  TLDR: "TL;DR",
};

/** Parse a fence info string: `ts title="src/index.ts"` or `ts src/index.ts`. */
export function parseFence(info: string | undefined): { lang?: string; file?: string } {
  const parts = (info ?? "").trim();
  if (!parts) return {};
  const lang = parts.split(/\s+/)[0];
  const titled = parts.match(/title=["']([^"']+)["']/);
  const bare = parts.split(/\s+/)[1];
  const file = titled?.[1] ?? (bare && /[./]/.test(bare) && !bare.includes("=") ? bare : undefined);
  return { lang, file };
}

const words = (s: string) => (stripTags(s).match(/\S+/g) ?? []).length;
const pad2 = (n: number) => String(n).padStart(2, "0");

interface Section {
  id: string;
  num: number;
  title: string;
  words: number;
  rows: string[];
}

export function renderArticle(markdown: string, opts: ArticleOptions = {}): string {
  const { meta, body } = splitFrontmatter(markdown);
  const numbered = meta.numbered ?? true;
  const label = meta.section_label ?? "§";
  const seen = new Map<string, number>();

  const md = new Marked({ gfm: true });
  md.use(markedFootnote({ prefixId: "fn-", description: "Notes" }));
  md.use({
    renderer: {
      code({ text, lang }: Tokens.Code): string {
        return `<pre class="md-code"><code>${highlight(text, parseFence(lang).lang)}</code></pre>\n`;
      },
      table(token: Tokens.Table): string {
        return renderTable(token, (t) => this.parser.parseInline(t));
      },
    },
  });

  let tokens: Token[] = md.lexer(body);
  let title = meta.title;
  // marked-footnote always emits a (possibly empty) "footnotes" token first.
  const firstHeading = tokens.find((t) => t.type !== "space" && t.type !== "footnotes");
  if (firstHeading?.type === "heading" && (firstHeading as Tokens.Heading).depth === 1) {
    title ??= stripTags(md.parseInline((firstHeading as Tokens.Heading).text) as string);
    tokens = tokens.filter((t) => t !== firstHeading);
  }
  title ??= opts.source?.split("/").pop()?.replace(/\.md$/, "") ?? "Article";

  const footnotes = tokens.filter((t) => {
    const items: unknown = (t as { rawItems?: unknown }).rawItems;
    return t.type === "footnotes" && Array.isArray(items) && items.length > 0;
  });
  tokens = tokens.filter((t) => t.type !== "footnotes");
  // Render notes now: any later md.lexer() call (callout bodies) resets the extension's footnote state.
  const notesHtml = footnotes.length ? md.parser(footnotes) : "";

  const intro: string[] = [];
  const sections: Section[] = [];
  let current: Section | null = null;
  let sub = 0;
  let fig = 0;
  let tbl = 0;
  let prose: Token[] = [];

  const target = () => current?.rows ?? intro;
  const row = (cls: string, gutter: string, content: string) =>
    `<div class="row ${cls}"><div class="gutter">${gutter}</div><div class="rbody">${content}</div></div>`;
  const flushProse = () => {
    if (!prose.length) return;
    const html = md.parser(prose);
    if (current) current.words += words(html);
    target().push(row("r-prose", "", `<div class="prose">${html}</div>`));
    prose = [];
  };

  const headingText = (h: Tokens.Heading) => {
    const idMatch = h.text.match(/\s*\{#([\w-]+)\}\s*$/);
    const text = idMatch ? h.text.slice(0, idMatch.index) : h.text;
    const html = md.parseInline(text) as string;
    const id = idMatch ? idMatch[1] : slugify(html, seen);
    if (idMatch) seen.set(id, 1);
    return { html, id };
  };

  for (const t of tokens) {
    if (t.type === "heading" && (t as Tokens.Heading).depth <= 2) {
      flushProse();
      const { html, id } = headingText(t as Tokens.Heading);
      current = { id, num: sections.length + 1, title: stripTags(html), words: 0, rows: [] };
      sections.push(current);
      sub = 0;
      continue;
    }
    if (t.type === "heading" && (t as Tokens.Heading).depth === 3) {
      flushProse();
      const { html, id } = headingText(t as Tokens.Heading);
      sub++;
      const mark = numbered && current ? `${pad2(current.num)}.${sub}` : "";
      target().push(
        row("r-h3", mark ? `<span class="glabel g-num">${mark}</span>` : "", `<h3 id="${id}">${html}</h3>`),
      );
      continue;
    }
    if (t.type === "code") {
      flushProse();
      const c = t as Tokens.Code;
      const { lang, file } = parseFence(c.lang);
      if (lang === "mermaid") {
        fig++;
        target().push(
          row(
            "r-fig",
            `<span class="glabel">Fig. ${fig}</span>`,
            `<figure><pre class="mermaid">${esc(c.text)}</pre></figure>`,
          ),
        );
        continue;
      }
      if (current) current.words += words(c.text);
      const plate = `<pre class="md-code"><code>${highlight(c.text, lang)}</code></pre>`;
      target().push(
        row(
          "r-code",
          lang ? `<span class="glabel g-lang">${esc(lang)}</span>` : "",
          file ? `<div class="codefile"><div class="fname">${esc(file)}</div>${plate}</div>` : plate,
        ),
      );
      continue;
    }
    if (t.type === "blockquote") {
      const q = t as Tokens.Blockquote;
      const m = q.text.match(ALERT);
      if (m) {
        flushProse();
        const kind = m[1].toUpperCase();
        const inner = md.parser(md.lexer(q.text.slice(m[0].length)));
        const heading = m[2].trim() ? `<p class="c-title">${md.parseInline(m[2].trim())}</p>` : "";
        if (current) current.words += words(inner);
        if (kind === "RUN" || kind === "TLDR") {
          // Not boxed: a run line is a row of links, a TL;DR is a pull line.
          const text = [m[2].trim(), q.text.slice(m[0].length).trim()].filter(Boolean).join(" ");
          target().push(
            row(
              `r-${kind.toLowerCase()}`,
              `<span class="glabel">${ALERT_LABEL[kind]}</span>`,
              `<p class="${kind === "RUN" ? "runline" : "pull"}">${md.parseInline(text.replace(/\n>?\s*/g, " "))}</p>`,
            ),
          );
          continue;
        }
        target().push(
          row(
            `r-callout c-${kind.toLowerCase()}`,
            `<span class="glabel">${ALERT_LABEL[kind]}</span>`,
            `<aside class="callout">${heading}<div class="prose">${inner}</div></aside>`,
          ),
        );
        continue;
      }
    }
    if (t.type === "paragraph") {
      const p = t as Tokens.Paragraph;
      const only = p.tokens.filter((x) => !(x.type === "text" && !x.raw.trim()));
      if (only.length === 1 && only[0].type === "image") {
        flushProse();
        fig++;
        const img = only[0] as Tokens.Image;
        const caption = img.title || img.text;
        target().push(
          row(
            "r-fig",
            `<span class="glabel">Fig. ${fig}</span>`,
            `<figure><img src="${esc(img.href)}" alt="${esc(img.text)}">${
              caption ? `<figcaption>${md.parseInline(caption)}</figcaption>` : ""
            }</figure>`,
          ),
        );
        continue;
      }
    }
    if (t.type === "html" && /^\s*<figure[\s>]/i.test(t.raw)) {
      flushProse();
      fig++;
      target().push(row("r-fig", `<span class="glabel">Fig. ${fig}</span>`, t.raw.trim()));
      continue;
    }
    if (t.type === "html" && /^\s*(<div class="table-wrap">\s*)?<table[\s>]/i.test(t.raw)) {
      flushProse();
      tbl++;
      const raw = t.raw.trim();
      const wrapped = raw.startsWith("<table") ? `<div class="table-wrap">${raw}</div>` : raw;
      target().push(row("r-table", `<span class="glabel">Tbl. ${tbl}</span>`, wrapped));
      continue;
    }
    if (t.type === "table") {
      flushProse();
      tbl++;
      target().push(row("r-table", `<span class="glabel">Tbl. ${tbl}</span>`, md.parser([t])));
      continue;
    }
    prose.push(t);
  }
  flushProse();

  // ── assemble ──
  const totalWords = words(intro.join(" ")) + sections.reduce((n, s) => n + s.words, 0);
  const minutes = Math.max(1, Math.round(totalWords / 230));
  const metaPairs = Object.entries(meta.meta ?? {});
  const source = opts.source ?? meta.source;
  const date = opts.date ?? meta.date;
  const metaHtml = [
    ...metaPairs.map(([k, v]) => `<span><b>${esc(k)}</b> ${md.parseInline(v)}</span>`),
    !metaPairs.length && date ? `<span><b>Date</b> ${esc(date)}</span>` : "",
    `<span><b>Length</b> ${totalWords.toLocaleString("en-US")} words · ${minutes} min</span>`,
  ].filter(Boolean).join("");

  const sectionMark = (s: Section) => numbered ? pad2(s.num) : "";
  const secmap = sections.length > 1
    ? `<div class="secmap" aria-label="Section map">${
      sections.map((s) =>
        `<a class="tick" href="#${s.id}" style="flex-grow:${Math.max(s.words, 40)}" title="${
          esc(`${sectionMark(s)} ${s.title}`.trim())
        }"><span>${sectionMark(s)}</span></a>`
      ).join("")
    }</div>`
    : "";

  const sectionsHtml = sections.map((s) =>
    `<section class="sec" aria-labelledby="${s.id}">` +
    row(
      "r-h2",
      numbered ? `<span class="s-label">${esc(label)}</span><span class="s-num">${sectionMark(s)}</span>` : "",
      `<h2 id="${s.id}">${esc(s.title)}</h2>`,
    ) +
    s.rows.join("\n") + `</section>`
  ).join("\n");

  const notes = notesHtml
    ? `<section class="sec sec-notes" aria-label="Notes">${
      row("r-notes", `<span class="glabel">Notes</span>`, `<div class="prose notes">${notesHtml}</div>`)
    }</section>`
    : "";

  const outline: OutlineEntry[] = sections.map((s) => ({ id: s.id, text: s.title, mark: sectionMark(s) }));
  const hasMermaid = /<pre class="mermaid">/.test(sectionsHtml + intro.join(""));
  const seriesHtml = seriesNav(meta.series_parts ?? []);
  const kicker = `<span class="k-kind">${esc(meta.kind ?? "Article")}</span>${
    meta.series ? `<span>${esc(meta.series)}</span>` : ""
  }`;

  const page = `<div class="art" id="bench">
<header class="masthead">
  <div class="mh-inner">
    <p class="kicker">${kicker}</p>
    <h1>${esc(title)}</h1>
    ${meta.dek ? `<p class="dek">${md.parseInline(meta.dek)}</p>` : ""}
    <p class="meta">${metaHtml}</p>
    ${seriesHtml}
    ${secmap}
  </div>
</header>
<div class="layout">
<main class="article">
${intro.length ? `<div class="intro">${intro.join("\n")}</div>` : ""}
${sectionsHtml}
${notes}
</main>
${outlineNav(outline, "Contents")}
</div>
<footer class="colophon">${esc(title)}${source ? ` · ${esc(source)}` : ""}${date ? ` · ${esc(date)}` : ""}</footer>
</div>`;

  // Artifacts render mermaid natively; elsewhere load it only when a diagram exists.
  const mermaid = hasMermaid && !opts.artifact
    ? `<script src="https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js"></script>
<script>addEventListener("DOMContentLoaded", () => mermaid.initialize({ startOnLoad: true, theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "neutral" }));</script>`
    : undefined;

  return wrapPage({ title, css: opts.css, js: opts.js, head: mermaid, body: page, artifact: opts.artifact });
}

if (import.meta.main) {
  const { positional, str, bool } = parseArgs(Deno.args, ["artifact"], ["o", "out", "source", "date"]);
  const input = positional[0];
  if (!input) {
    console.error(
      "usage: render-article.ts <article.md> [-o out.html] [--source label] [--date YYYY-MM-DD] [--artifact]",
    );
    Deno.exit(2);
  }
  const html = renderArticle(await Deno.readTextFile(input), {
    source: str("source"),
    date: str("date"),
    artifact: bool("artifact"),
    css: await readAssets("bench.css", "article.css"),
    js: await readAssets("bench.js"),
  });
  const out = str("o") ?? str("out") ?? input.replace(/\.md$/, ".html");
  await Deno.writeTextFile(out, html);
  console.log(`wrote ${out} (${(html.length / 1024).toFixed(0)} KB)`);
}
