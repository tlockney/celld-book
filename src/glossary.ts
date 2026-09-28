/**
 * Glossary hover definitions. Terms come from the Field Guide's glossary table
 * (`| **Term** | Meaning | See |`). On each page, the first prose occurrence of each term
 * is marked so the shell can show its definition on hover, focus, or tap.
 */

export interface Term {
  term: string;
  /** Plain-text definition (markdown stripped). */
  def: string;
}

/** Markdown inline → plain text: drop emphasis, code ticks, and links (keeping link text). */
export function plainInline(md: string): string {
  return md
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .trim();
}

export function parseGlossary(md: string): Term[] {
  const terms: Term[] = [];
  for (const line of md.split("\n")) {
    const m = line.match(/^\|\s*\*\*(.+?)\*\*\s*\|\s*(.+?)\s*\|\s*.*\|\s*$/);
    if (m) terms.push({ term: m[1].trim(), def: plainInline(m[2]) });
  }
  return terms;
}

export type GlossSegment = string | { text: string; term: Term };

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Mark the first occurrence of each term not yet in `used` (case-insensitive, whole word,
 * optional plural "s"/"es"). Longer terms win over their prefixes ("Fleet bucket" before
 * "Fleet"). `used` is updated so a term is marked once per page.
 */
export function markTerms(text: string, terms: Term[], used: Set<string>): GlossSegment[] {
  const open = terms.filter((t) => !used.has(t.term)).sort((a, b) => b.term.length - a.term.length);
  if (!open.length) return [text];
  const re = new RegExp(`(?<![\\w-])(${open.map((t) => escRe(t.term)).join("|")})(?:e?s)?(?![\\w-])`, "gi");
  const out: GlossSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const t = open.find((x) => x.term.toLowerCase() === m[1].toLowerCase());
    if (!t || used.has(t.term)) continue;
    used.add(t.term);
    out.push(text.slice(last, m.index), { text: m[0], term: t });
    last = (m.index ?? 0) + m[0].length;
  }
  out.push(text.slice(last));
  return out.filter((s) => s !== "");
}
