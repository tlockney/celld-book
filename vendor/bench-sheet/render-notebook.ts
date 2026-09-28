/**
 * Render a Jupyter notebook (.ipynb) as a standalone "bench sheet" HTML page.
 *
 *   deno run -A render-notebook.ts <notebook.ipynb> [-o out.html]
 *     [--source "work/celld/celld-02-bindings.ipynb"] [--date 2026-09-22]
 *     [--artifact] [--fold-code] [--meta notebook.yaml]
 *
 * --meta takes a YAML file of presentation details the .ipynb doesn't carry:
 *   title, dek, series (kicker text), meta (label → value pairs), series_parts
 *   ({ title, href? } list; the part without href is this notebook), preface
 *   (markdown shown before the first cell) and preface_label (its gutter label).
 *
 * Everything is done at build time: markdown via marked, syntax highlighting
 * via highlight.js, ANSI escapes in outputs converted to classed spans. The
 * page's only runtime script (notebook.js) adds the fold/hide toggles, the
 * long-cell clamp, and the outline scrollspy; without it the page still reads
 * completely.
 *
 * --artifact omits the document wrappers (see bench.ts wrapPage), which the
 * Claude Artifact publisher adds itself.
 */

import { Marked, type Tokens } from "npm:marked@15.0.12";
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

export { esc, highlight };

// ── notebook shape ──────────────────────────────────────────────────────────

type MultiLine = string | string[];

export interface NbOutput {
  output_type: string;
  name?: string;
  text?: MultiLine;
  data?: Record<string, unknown>;
  execution_count?: number | null;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

export interface NbCell {
  cell_type: string;
  source: MultiLine;
  execution_count?: number | null;
  outputs?: NbOutput[];
  attachments?: Record<string, Record<string, unknown>>;
}

export interface Notebook {
  cells: NbCell[];
  metadata?: {
    kernelspec?: { display_name?: string; language?: string; name?: string };
    language_info?: { name?: string; version?: string };
  };
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export function isNotebook(x: unknown): x is Notebook {
  return isRecord(x) && Array.isArray(x.cells) &&
    x.cells.every((c) => isRecord(c) && typeof c.cell_type === "string");
}

const joined = (m: MultiLine | undefined): string => Array.isArray(m) ? m.join("") : (m ?? "");

// ── text helpers ────────────────────────────────────────────────────────────

// deno-lint-ignore no-control-regex
const ANSI_SGR = /\x1b\[([0-9;]*)m/g;
// deno-lint-ignore no-control-regex
const ANSI_OTHER = /\x1b\[[0-9;?]*[A-Za-ln-z]|\x1b\][^\x07]*\x07/g;

/**
 * Escape text and turn ANSI SGR colour codes into `<span class="a-…">`.
 * Supports the 16 basic colours plus bold / dim / italic / underline, which is
 * what Deno, Python tracebacks, and most CLIs emit; any other escape sequence
 * is dropped.
 */
export function ansiToHtml(text: string): string {
  const src = text.replace(ANSI_OTHER, "");
  let out = "";
  let last = 0;
  let classes: string[] = [];
  const flush = (chunk: string) => {
    if (!chunk) return;
    out += classes.length ? `<span class="${classes.join(" ")}">${esc(chunk)}</span>` : esc(chunk);
  };
  for (const m of src.matchAll(ANSI_SGR)) {
    flush(src.slice(last, m.index));
    last = (m.index ?? 0) + m[0].length;
    const codes = m[1] === "" ? [0] : m[1].split(";").map(Number);
    for (const c of codes) {
      if (c === 0) classes = [];
      else if (c === 1) classes.push("a-b");
      else if (c === 2) classes.push("a-dim");
      else if (c === 3) classes.push("a-i");
      else if (c === 4) classes.push("a-u");
      else if (c === 22) classes = classes.filter((k) => k !== "a-b" && k !== "a-dim");
      else if (c === 39) classes = classes.filter((k) => !k.startsWith("a-fg"));
      else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) {
        classes = classes.filter((k) => !k.startsWith("a-fg"));
        classes.push(`a-fg${c >= 90 ? c - 90 + 8 : c - 30}`);
      }
    }
  }
  flush(src.slice(last));
  return out;
}

// ── rendering ───────────────────────────────────────────────────────────────

/** Presentation details the .ipynb doesn't carry (the --meta file). */
export interface NotebookMeta {
  title?: string;
  dek?: string;
  series?: string;
  meta?: Record<string, string>;
  series_parts?: SeriesPart[];
  preface?: string;
  preface_label?: string;
}

export function toNotebookMeta(raw: unknown): NotebookMeta {
  if (!isRecord(raw)) return {};
  const str = (k: string) => typeof raw[k] === "string" ? raw[k] as string : undefined;
  return {
    title: str("title"),
    dek: str("dek"),
    series: str("series"),
    meta: isRecord(raw.meta) ? Object.fromEntries(Object.entries(raw.meta).map(([k, v]) => [k, String(v)])) : undefined,
    series_parts: toSeriesParts(raw.series_parts),
    preface: str("preface"),
    preface_label: str("preface_label"),
  };
}

export interface RenderOptions {
  source?: string;
  date?: string;
  artifact?: boolean;
  foldCode?: boolean;
  meta?: NotebookMeta;
  css?: string;
  js?: string;
}

function makeMarkdown(outline: OutlineEntry[], seen: Map<string, number>, lang: string | undefined): Marked {
  const md = new Marked({ gfm: true });
  md.use({
    renderer: {
      code({ text, lang: fence }: Tokens.Code): string {
        const l = fence?.split(/\s/)[0] || undefined;
        return `<pre class="md-code"><code>${highlight(text, l ?? lang)}</code></pre>\n`;
      },
      heading({ tokens, depth }: Tokens.Heading): string {
        const html = this.parser.parseInline(tokens);
        const id = slugify(html, seen);
        if (depth === 2) outline.push({ id, text: stripTags(html) });
        return `<h${depth} id="${id}">${html}</h${depth}>\n`;
      },
      table(token: Tokens.Table): string {
        return renderTable(token, (t) => this.parser.parseInline(t));
      },
    },
  });
  return md;
}

function inlineAttachments(src: string, cell: NbCell): string {
  if (!cell.attachments) return src;
  return src.replace(/attachment:([^\s)"']+)/g, (whole, name: string) => {
    const bundle = cell.attachments?.[name];
    if (!bundle) return whole;
    const [mime, data] = Object.entries(bundle)[0] ?? [];
    return typeof data === "string" && mime ? `data:${mime};base64,${data.replace(/\s/g, "")}` : whole;
  });
}

function renderOutput(o: NbOutput, md: Marked, count: string): string {
  const row = (kind: string, label: string, body: string) =>
    `<div class="row output out-${kind}"><div class="gutter"><span class="olabel">${label}</span></div>` +
    `<div class="obody">${body}</div></div>`;

  if (o.output_type === "stream") {
    const name = o.name === "stderr" ? "stderr" : "stdout";
    const text = joined(o.text).replace(/\n$/, "");
    return text ? row(name, name, `<pre class="stream">${ansiToHtml(text)}</pre>`) : "";
  }
  if (o.output_type === "error") {
    const tb = (o.traceback ?? []).join("\n") || `${o.ename ?? "Error"}: ${o.evalue ?? ""}`;
    return row("error", "error", `<pre class="stream">${ansiToHtml(tb)}</pre>`);
  }
  if (o.output_type === "execute_result" || o.output_type === "display_data") {
    const d = o.data ?? {};
    const label = o.output_type === "execute_result" ? `Out[${count}]` : "display";
    const str = (k: string) => {
      const v = d[k];
      return typeof v === "string" ? v : Array.isArray(v) ? v.join("") : undefined;
    };
    let body: string | undefined;
    for (const img of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      const v = str(img);
      if (v) body = `<img alt="output image" src="data:${img};base64,${v.replace(/\s/g, "")}">`;
      if (body) break;
    }
    body ??= str("image/svg+xml") && `<div class="rich">${str("image/svg+xml")}</div>`;
    body ??= str("text/html") && `<div class="rich">${str("text/html")}</div>`;
    body ??= str("text/markdown") && `<div class="rich prose">${md.parse(str("text/markdown") ?? "")}</div>`;
    if (!body && d["application/json"] !== undefined) {
      body = `<pre class="stream">${highlight(JSON.stringify(d["application/json"], null, 2), "json")}</pre>`;
    }
    body ??= str("text/plain") !== undefined
      ? `<pre class="stream">${ansiToHtml(str("text/plain") ?? "")}</pre>`
      : undefined;
    return body ? row(o.output_type === "execute_result" ? "result" : "display", label, body) : "";
  }
  return "";
}

function summaryLine(code: string): string {
  const line = code.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("//") && !l.startsWith("#")) ??
    code.split("\n")[0] ?? "";
  return line.length > 88 ? line.slice(0, 86) + " …" : line;
}

export function renderNotebook(nb: Notebook, opts: RenderOptions = {}): string {
  const lang = nb.metadata?.language_info?.name ?? nb.metadata?.kernelspec?.language;
  const kernel = nb.metadata?.kernelspec?.display_name ?? nb.metadata?.kernelspec?.name ?? "Unknown kernel";
  const outline: OutlineEntry[] = [];
  const seen = new Map<string, number>();
  const md = makeMarkdown(outline, seen, lang);

  // Title: a leading "# Heading" in the first markdown cell moves to the masthead.
  let title = opts.source?.split("/").pop()?.replace(/\.ipynb$/, "") ?? "Notebook";
  const cells = nb.cells.map((c) => ({ ...c, src: joined(c.source) }));
  const first = cells.find((c) => c.cell_type === "markdown");
  if (first) {
    const m = first.src.match(/^\s*#\s+(.+)\n?/);
    if (m) {
      title = m[1].trim();
      first.src = first.src.slice(m[0].length);
    }
  }

  const nm = opts.meta ?? {};
  if (nm.title) title = nm.title;

  const counts: number[] = [];
  const ticks: string[] = [];
  const body: string[] = [];
  if (nm.preface) {
    body.push(
      `<section class="cell cell-md cell-preface"><div class="row"><div class="gutter"><span class="olabel">${
        esc(nm.preface_label ?? "Note")
      }</span></div><div class="prose preface">${md.parse(nm.preface)}</div></div></section>`,
    );
  }

  cells.forEach((c, i) => {
    const id = `cell-${i + 1}`;
    if (c.cell_type === "markdown") {
      if (!c.src.trim()) return;
      const html = md.parse(inlineAttachments(c.src, c)) as string;
      ticks.push(`<a class="tick t-md" href="#${id}" title="Cell ${i + 1} · markdown"></a>`);
      body.push(
        `<section class="cell cell-md" id="${id}"><div class="row"><div class="gutter"></div>` +
          `<div class="prose">${html}</div></div></section>`,
      );
      return;
    }
    if (c.cell_type === "raw") {
      ticks.push(`<a class="tick t-md" href="#${id}" title="Cell ${i + 1} · raw"></a>`);
      body.push(
        `<section class="cell cell-raw" id="${id}"><div class="row"><div class="gutter"><span class="olabel">raw</span></div>` +
          `<pre class="raw">${esc(c.src)}</pre></div></section>`,
      );
      return;
    }
    const n = c.execution_count;
    if (typeof n === "number") counts.push(n);
    const count = typeof n === "number" ? String(n) : " ";
    const outputs = (c.outputs ?? []).map((o) => renderOutput(o, md, count)).join("");
    const hasError = (c.outputs ?? []).some((o) =>
      o.output_type === "error" || (o.output_type === "stream" && o.name === "stderr")
    );
    const lines = c.src.replace(/\n$/, "").split("\n").length;
    ticks.push(
      `<a class="tick t-code${hasError ? " t-err" : ""}" href="#${id}" title="Cell ${i + 1} · In [${
        count.trim() || " "
      }]${hasError ? " · error" : ""}"></a>`,
    );
    body.push(
      `<section class="cell cell-code${hasError ? " has-error" : ""}" id="${id}">` +
        `<div class="row input"><div class="gutter"><button class="count" type="button" title="Fold or unfold this cell" aria-label="Toggle cell ${
          i + 1
        }">[${esc(count)}]</button></div>` +
        `<div class="ibody"><pre class="src" data-lines="${lines}"><code>${
          highlight(c.src.replace(/\n$/, ""), lang)
        }</code></pre>` +
        `<div class="src-sum"><code>${esc(summaryLine(c.src))}</code><span class="lines">${lines} line${
          lines === 1 ? "" : "s"
        }</span></div></div></div>` +
        (outputs ? `<div class="outputs">${outputs}</div>` : "") +
        `</section>`,
    );
  });

  const codeCells = cells.filter((c) => c.cell_type === "code").length;
  const range = counts.length ? `In [${Math.min(...counts)}]–[${Math.max(...counts)}]` : "not executed";
  const langLabel = [lang, nb.metadata?.language_info?.version].filter(Boolean).join(" ");
  const meta = [
    opts.source ? `<span class="m-src">${esc(opts.source)}</span>` : "",
    `<span>${cells.length} cells · ${codeCells} code · ${range}</span>`,
    opts.date ? `<span>${esc(opts.date)}</span>` : "",
    ...Object.entries(nm.meta ?? {}).map(([k, v]) => `<span><b>${esc(k)}</b> ${md.parseInline(v)}</span>`),
  ].filter(Boolean).join("");

  const page = `<div class="nb${opts.foldCode ? " fold-code" : ""}" id="nb">
<header class="masthead">
  <div class="mh-inner">
    <p class="kicker"><span class="k-kind">Notebook</span><span class="k-kernel">${esc(kernel)}${
    langLabel ? ` · ${esc(langLabel)}` : ""
  }</span>${nm.series ? `<span>${esc(nm.series)}</span>` : ""}</p>
    <h1>${esc(title)}</h1>
    ${nm.dek ? `<p class="dek">${md.parseInline(nm.dek)}</p>` : ""}
    <p class="meta">${meta}</p>
    ${seriesNav(nm.series_parts ?? [])}
    <div class="cellmap" aria-label="Cell map">${ticks.join("")}</div>
    <div class="toolbar" role="group" aria-label="View">
      <button type="button" data-toggle="foldCode" aria-pressed="${opts.foldCode ? "true" : "false"}">Fold code</button>
      <button type="button" data-toggle="hideOut" aria-pressed="false">Hide outputs</button>
    </div>
  </div>
</header>
<div class="layout">
<main class="cells">
${body.join("\n")}
</main>
${outlineNav(outline)}
</div>
<footer class="colophon">Rendered from ${esc(opts.source ?? "a notebook")} · ${esc(kernel)} kernel</footer>
</div>`;

  return wrapPage({ title, css: opts.css, js: opts.js, body: page, artifact: opts.artifact });
}

// ── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const { positional, str, bool } = parseArgs(Deno.args, ["artifact", "fold-code"], [
    "o",
    "out",
    "source",
    "date",
    "meta",
  ]);
  const input = positional[0];
  if (!input) {
    console.error(
      "usage: render-notebook.ts <notebook.ipynb> [-o out.html] [--source label] [--date YYYY-MM-DD] [--artifact] [--fold-code] [--meta notebook.yaml]",
    );
    Deno.exit(2);
  }
  const parsed: unknown = JSON.parse(await Deno.readTextFile(input));
  if (!isNotebook(parsed)) {
    console.error(`${input}: not a Jupyter notebook (no cells array)`);
    Deno.exit(1);
  }
  const mtime = (await Deno.stat(input)).mtime;
  const html = renderNotebook(parsed, {
    source: str("source") ?? input.split("/").pop(),
    date: str("date") ?? mtime?.toISOString().slice(0, 10),
    artifact: bool("artifact"),
    foldCode: bool("fold-code"),
    meta: str("meta") ? toNotebookMeta(parseYaml(await Deno.readTextFile(str("meta") ?? ""))) : undefined,
    css: await readAssets("bench.css", "notebook.css"),
    js: await readAssets("bench.js", "notebook.js"),
  });
  const out = str("o") ?? str("out") ?? input.replace(/\.ipynb$/, ".html");
  await Deno.writeTextFile(out, html);
  console.log(`wrote ${out} (${(html.length / 1024).toFixed(0)} KB, ${parsed.cells.length} cells)`);
}
