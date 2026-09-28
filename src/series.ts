/**
 * Build the Reading Room series from the same sources as the book (series variant).
 *
 *   deno task series            → out/series/{rr,artifact,labs}/
 *   deno task series:install    → also copies the rr/ pages into the Reading Room home
 *
 * rr/        the seven Reading Room pages (what ~/.local/share/reading-room/_migrated/ serves)
 * artifact/  the claude.ai artifact variants: series links point at artifact URLs, <title> is the gallery name
 * labs/      the notebooks with variants resolved, for uploading to JupyterLab
 */

import { applyVariants } from "./variants.ts";
import { FIGURE_CSS } from "./figures.ts";
import { readAssets } from "../vendor/bench-sheet/bench.ts";
import { renderArticle } from "../vendor/bench-sheet/render-article.ts";
import { isNotebook, type Notebook, renderNotebook, toNotebookMeta } from "../vendor/bench-sheet/render-notebook.ts";
import { parse as parseYaml } from "@std/yaml";

const ROOT = new URL("../", import.meta.url).pathname;
const read = (p: string) => Deno.readTextFileSync(ROOT + p);

const ARTICLES = ["celld-00-background", "celld-durable-objects", "celld-step-by-step", "celld-review"];
const LABS = ["celld-01-cells", "celld-02-bindings", "celld-03-processes"];

interface ArtifactInfo {
  url: string;
  title: string;
}

export function loadArtifacts(text: string): Record<string, ArtifactInfo> {
  const raw: unknown = JSON.parse(text);
  const arts = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).artifacts : undefined;
  if (typeof arts !== "object" || arts === null) throw new Error("artifacts.json: missing artifacts");
  const out: Record<string, ArtifactInfo> = {};
  for (const [slug, v] of Object.entries(arts as Record<string, unknown>)) {
    const o = v as Record<string, unknown>;
    if (typeof o.url !== "string" || typeof o.title !== "string") throw new Error(`artifacts.json: bad entry ${slug}`);
    out[slug] = { url: o.url, title: o.title };
  }
  return out;
}

/** Point series links (`href: "slug"` in frontmatter, `](slug#anchor)` in markdown) at artifact URLs. */
export function toArtifactLinks(text: string, arts: Record<string, ArtifactInfo>): string {
  let s = text;
  for (const [slug, a] of Object.entries(arts)) {
    s = s.split(`href: "${slug}"`).join(`href: "${a.url}"`);
    s = s.replace(
      new RegExp(`\\]\\(${slug}(#[\\w-]+)?\\)`, "g"),
      (_m, anchor: string | undefined) => `](${a.url}${anchor ?? ""})`,
    );
  }
  return s;
}

/** Replace the page's <title> with the artifact's gallery name. */
export function setTitle(html: string, title: string): string {
  const out = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${title}</title>`);
  if (out === html && !html.includes(`<title>${title}</title>`)) throw new Error("no <title> to replace");
  return out;
}

function seriesNotebook(slug: string): Notebook {
  const raw: unknown = JSON.parse(read(`content/labs/${slug}.ipynb`));
  if (!isNotebook(raw)) throw new Error(`${slug}.ipynb is not a notebook`);
  return {
    ...raw,
    cells: raw.cells.map((c) => {
      if (c.cell_type !== "markdown") return c;
      const src = Array.isArray(c.source) ? c.source.join("") : c.source;
      return { ...c, source: applyVariants(src, "series") };
    }),
  };
}

if (import.meta.main) {
  const install = Deno.args.includes("--install");
  const arts = loadArtifacts(read("content/series/artifacts.json"));
  const articleCss = (await readAssets("bench.css", "article.css")) + FIGURE_CSS;
  const notebookCss = await readAssets("bench.css", "notebook.css");
  const js = await readAssets("bench.js");
  const nbJs = await readAssets("bench.js", "notebook.js");
  const out = ROOT + "out/series/";
  for (const d of ["rr", "artifact", "labs"]) await Deno.mkdir(out + d, { recursive: true });

  for (const slug of ARTICLES) {
    const md = applyVariants(read(`content/series/${slug}.md`), "series");
    await Deno.writeTextFile(`${out}rr/${slug}.html`, renderArticle(md, { css: articleCss, js }));
    const art = renderArticle(toArtifactLinks(md, arts), { css: articleCss, js, artifact: true });
    await Deno.writeTextFile(`${out}artifact/${slug}.html`, setTitle(art, arts[slug].title));
  }
  for (const slug of LABS) {
    const nb = seriesNotebook(slug);
    await Deno.writeTextFile(`${out}labs/${slug}.ipynb`, JSON.stringify(nb, null, 1));
    const opts = { source: `work/celld/${slug}.ipynb`, date: "", css: notebookCss, js: nbJs };
    const rrMeta = toNotebookMeta(parseYaml(read(`content/labs/${slug}.meta.yaml`)));
    await Deno.writeTextFile(`${out}rr/${slug}.html`, renderNotebook(nb, { ...opts, meta: rrMeta }));
    const artMeta = toNotebookMeta(parseYaml(read(`content/labs/${slug}.artifact.meta.yaml`)));
    const art = renderNotebook(nb, { ...opts, meta: artMeta, artifact: true });
    await Deno.writeTextFile(`${out}artifact/${slug}.html`, setTitle(art, arts[slug].title));
  }
  console.log(`wrote ${ARTICLES.length + LABS.length} pages × 2 variants and ${LABS.length} notebooks to out/series/`);

  if (install) {
    const home = Deno.env.get("READING_ROOM_HOME") ?? `${Deno.env.get("HOME")}/.local/share/reading-room`;
    for (const slug of [...ARTICLES, ...LABS]) {
      await Deno.copyFile(`${out}rr/${slug}.html`, `${home}/_migrated/${slug}.html`);
    }
    console.log(`installed ${ARTICLES.length + LABS.length} pages into ${home}/_migrated/`);
  }
}
