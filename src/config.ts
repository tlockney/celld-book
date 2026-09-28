/** Typed loading of book.jsonc and the bibliography, with validation (both are untrusted input to the build). */

import { parse as parseJsonc } from "@std/jsonc";
import { parse as parseYaml } from "@std/yaml";

export type DocKey = "part0" | "fg" | "guide" | "review";

export interface PageConfig {
  slug: string;
  part: string;
  label: string;
  /** Shorter label for the contents list (defaults to label). */
  tocLabel?: string;
  title?: string;
  kind?: string;
  md?: string;
  doc?: DocKey;
  sections?: string[];
  promote?: boolean;
  moveOut?: { subsection: string; pointer: string };
  gather?: { callout: string; from: string; subsection: string };
  lab?: number;
  chapter?: number;
  bibliography?: string;
}

export interface BookConfig {
  title: string;
  subtitle: string;
  edition: string;
  curator: string;
  dek: string;
  sources: Record<DocKey, string> & { labs: string[] };
  parts: Record<string, string>;
  pages: PageConfig[];
  sourcesFor: Record<string, string[]>;
  glossary: { exclude: string[] };
  phrases: [string, string][];
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const str = (o: Obj, k: string, where: string): string => {
  const v = o[k];
  if (typeof v !== "string") throw new Error(`${where}: "${k}" must be a string`);
  return v;
};
const optStr = (o: Obj, k: string): string | undefined => typeof o[k] === "string" ? o[k] as string : undefined;
const strList = (v: unknown, where: string): string[] => {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new Error(`${where} must be a string list`);
  return v as string[];
};
const DOCS: DocKey[] = ["part0", "fg", "guide", "review"];

function toPage(raw: unknown, i: number): PageConfig {
  const w = `pages[${i}]`;
  if (!isObj(raw)) throw new Error(`${w} must be an object`);
  const doc = optStr(raw, "doc");
  if (doc !== undefined && !DOCS.includes(doc as DocKey)) throw new Error(`${w}: unknown doc "${doc}"`);
  const page: PageConfig = {
    slug: str(raw, "slug", w),
    part: str(raw, "part", w),
    label: str(raw, "label", w),
    tocLabel: optStr(raw, "tocLabel"),
    title: optStr(raw, "title"),
    kind: optStr(raw, "kind"),
    md: optStr(raw, "md"),
    doc: doc as DocKey | undefined,
    promote: raw.promote === true,
    bibliography: optStr(raw, "bibliography"),
  };
  if (raw.sections !== undefined) page.sections = strList(raw.sections, `${w}.sections`);
  if (typeof raw.lab === "number") page.lab = raw.lab;
  if (typeof raw.chapter === "number") page.chapter = raw.chapter;
  if (isObj(raw.moveOut)) {
    page.moveOut = { subsection: str(raw.moveOut, "subsection", w), pointer: str(raw.moveOut, "pointer", w) };
  }
  if (isObj(raw.gather)) {
    page.gather = {
      callout: str(raw.gather, "callout", w),
      from: str(raw.gather, "from", w),
      subsection: str(raw.gather, "subsection", w),
    };
  }
  const kinds = [page.md, page.doc, page.lab, page.bibliography].filter((x) => x !== undefined).length;
  if (kinds !== 1) throw new Error(`${w}: exactly one of md, doc, lab, bibliography`);
  return page;
}

export function parseBookConfig(text: string): BookConfig {
  const raw = parseJsonc(text);
  if (!isObj(raw)) throw new Error("book.jsonc must be an object");
  const src = raw.sources;
  if (!isObj(src)) throw new Error("sources must be an object");
  const parts = raw.parts;
  if (!isObj(parts)) throw new Error("parts must be an object");
  if (!Array.isArray(raw.pages)) throw new Error("pages must be a list");
  const pages = raw.pages.map(toPage);
  const slugs = new Set<string>();
  for (const p of pages) {
    if (slugs.has(p.slug)) throw new Error(`duplicate slug "${p.slug}"`);
    slugs.add(p.slug);
    if (!(p.part in parts)) throw new Error(`page "${p.slug}": unknown part "${p.part}"`);
  }
  const sourcesFor: Record<string, string[]> = {};
  if (isObj(raw.sourcesFor)) {
    for (const [k, v] of Object.entries(raw.sourcesFor)) sourcesFor[k] = strList(v, `sourcesFor.${k}`);
  }
  const phrases: [string, string][] = Array.isArray(raw.phrases)
    ? raw.phrases.map((p, i) => {
      const l = strList(p, `phrases[${i}]`);
      if (l.length !== 2) throw new Error(`phrases[${i}] must be [from, to]`);
      return [l[0], l[1]] as [string, string];
    })
    : [];
  const glossary = isObj(raw.glossary) && raw.glossary.exclude !== undefined
    ? { exclude: strList(raw.glossary.exclude, "glossary.exclude") }
    : { exclude: [] };
  return {
    title: str(raw, "title", "book"),
    subtitle: str(raw, "subtitle", "book"),
    edition: str(raw, "edition", "book"),
    curator: str(raw, "curator", "book"),
    dek: str(raw, "dek", "book"),
    sources: {
      part0: str(src, "part0", "sources"),
      fg: str(src, "fg", "sources"),
      guide: str(src, "guide", "sources"),
      review: str(src, "review", "sources"),
      labs: strList(src.labs, "sources.labs"),
    },
    parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, typeof v === "string" ? v : ""])),
    pages,
    sourcesFor,
    glossary,
    phrases,
  };
}

// ── bibliography ───────────────────────────────────────────────────────────

export interface BibEntry {
  id: string;
  title: string;
  author?: string;
  publisher?: string;
  date?: string;
  url?: string;
  usedIn: string[];
}

export interface BibGroup {
  id: string;
  title: string;
  entries: BibEntry[];
}

export interface Bibliography {
  accessed: string;
  groups: BibGroup[];
}

export function parseBibliography(text: string): Bibliography {
  const raw: unknown = parseYaml(text);
  if (!isObj(raw) || !Array.isArray(raw.groups)) throw new Error("bibliography: needs groups");
  const ids = new Set<string>();
  const groups = raw.groups.map((g, gi): BibGroup => {
    if (!isObj(g) || !Array.isArray(g.entries)) throw new Error(`bibliography group ${gi}: needs entries`);
    return {
      id: str(g, "id", `group ${gi}`),
      title: str(g, "title", `group ${gi}`),
      entries: g.entries.map((e, ei): BibEntry => {
        const w = `group ${gi} entry ${ei}`;
        if (!isObj(e)) throw new Error(`${w} must be an object`);
        const id = str(e, "id", w);
        if (ids.has(id)) throw new Error(`bibliography: duplicate id "${id}"`);
        ids.add(id);
        return {
          id,
          title: str(e, "title", w),
          author: optStr(e, "author"),
          publisher: optStr(e, "publisher"),
          date: optStr(e, "date"),
          url: optStr(e, "url"),
          usedIn: strList(e.used_in, `${w}.used_in`),
        };
      }),
    };
  });
  return { accessed: typeof raw.accessed === "string" ? raw.accessed : "", groups };
}
