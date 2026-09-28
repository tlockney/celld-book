/**
 * Downloadable labs. Each lab's executed notebook is offered as an .ipynb, beside the helper
 * `celld_nb.ts` that every lab's setup cell imports (`./celld_nb.ts`), plus a zip of all of them.
 *
 * The downloaded notebooks keep their code cells, outputs, and metadata exactly as executed. Only
 * markdown cells change: the book variant is applied and series cross-references ("Part 1 § 04")
 * become book references linked to the published site ("[Chapter 4](https://…/ownership.html)"),
 * because a notebook opened in Jupyter has no site around it to resolve relative links against.
 */

import { zipSync } from "fflate";
import { applyVariants } from "./variants.ts";
import { type Resolver, rewrite } from "./xref.ts";
import type { Notebook } from "../vendor/bench-sheet/render-notebook.ts";

/** Code spans, fenced code, and existing links are left alone; only the prose between them is rewritten. */
const PROTECTED = /(```[\s\S]*?```|`[^`\n]*`|\[[^\]]*\]\([^)]*\))/;

export function absolute(href: string, siteUrl: string, pageFile: string): string {
  if (/^https?:/.test(href)) return href;
  return siteUrl + (href.startsWith("#") ? pageFile + href : href);
}

/** Rewrite one markdown cell's text for download: series references → linked book references. */
export function rewriteMarkdown(
  md: string,
  resolver: Resolver,
  siteUrl: string,
  pageFile: string,
  phrases: [string, string][] = [],
): string {
  return md.split(PROTECTED).map((part, i) => {
    if (i % 2 === 1) return part; // a protected span
    let out = rewrite(part, resolver, { doc: "lab", inLink: false })
      .map((s) => typeof s === "string" ? s : `[${s.text}](${absolute(s.href, siteUrl, pageFile)})`)
      .join("");
    for (const [from, to] of phrases) out = out.split(from).join(to);
    return out;
  }).join("");
}

export function notebookForDownload(
  nb: Notebook,
  resolver: Resolver,
  siteUrl: string,
  pageFile: string,
  phrases: [string, string][] = [],
): Notebook {
  return {
    ...nb,
    cells: nb.cells.map((c) => {
      if (c.cell_type !== "markdown") return c;
      const src = Array.isArray(c.source) ? c.source.join("") : c.source;
      return { ...c, source: rewriteMarkdown(applyVariants(src, "book"), resolver, siteUrl, pageFile, phrases) };
    }),
  };
}

export const LABS_README = `celld labs: executed Deno notebooks from "celld: Durable Objects on Your Own Storage"

Keep celld_nb.ts in the same folder as the notebooks: every lab's setup cell imports it.

1. Open a notebook in JupyterLab with a Deno kernel (Deno 2.9 or later).
2. Run the setup cell. It installs celld v0.6.0 and esbuild into a cache folder if they are missing,
   then starts a local \`celld dev\` node for the lab.
3. Run the cells in order. The outputs already in the notebook are from a run on 2026-09-26, so you
   can compare yours with them.

Each lab ends with an exercise: fill in the TODO stubs, then run the checker cell.
The book: https://tlockney.github.io/celld-book/
`;

export function labsZip(files: Record<string, Uint8Array>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [`celld-labs/${k}`, v])), { level: 9 });
}
