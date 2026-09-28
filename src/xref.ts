/**
 * Cross-reference rewriting: series phrasing ("Part 1 § 04", "Part 2 Step 05",
 * "Notebook 2 Part 3") becomes book phrasing with links ("Chapter 4", "Chapter 9, Step 05",
 * "Lab 2, Part 3"). Pure: text in, segments out; the DOM pass applies them to text nodes.
 */

export interface Target {
  label: string;
  href: string;
}

/** Which source document a page's text came from; decides what a bare "§ NN" means. */
export type DocKind = "part0" | "fg" | "guide" | "lab" | "review" | "book";

export interface Resolver {
  /** Field Guide section n (1-based), e.g. "Chapter 3" or "Appendix B". */
  fg(n: number): Target | undefined;
  /** Part 0 section n: "Chapter 1 § 0n". */
  part0(n: number): Target | undefined;
  /** Guide step n: href only; the text stays "Step 0n". */
  step(n: number): Target | undefined;
  /** Lab n, optionally at its own Part m. */
  lab(n: number, part?: number): Target | undefined;
  /** A bare "§ NN" in the current page's own document. */
  local(n: number): Target | undefined;
  /** Whole-part references: Part 0 → Chapter 1, Part 1 → Part II, Part 2 → Chapter 9. */
  part(n: 0 | 1 | 2): Target | undefined;
}

export type Segment = string | { text: string; href: string };

export interface Context {
  doc: DocKind;
  /** Text inside an existing link: rewrite the words, add no nested links. */
  inLink: boolean;
}

const NN = String.raw`\d{2}`;
const LIST_SEP = String.raw`(?:, and |, | and |–)`;
const PATTERN = new RegExp(
  [
    String.raw`(?<nbRange>Notebooks (?<nbA>\d)–(?<nbB>\d))`,
    String.raw`(?<nb>Notebook (?<nbN>\d)(?: Part (?<nbPart>\d))?)`,
    String.raw`(?<p1>Part 1 §§? ?(?<p1First>${NN})(?<p1Rest>(?:${LIST_SEP}§ ?${NN})*))`,
    String.raw`(?<p0>Part 0 § ?(?<p0N>${NN}))`,
    String.raw`(?<p2Steps>Part 2(?=,? Steps? ${NN}))`,
    String.raw`(?<steps>Steps? (?<stFirst>${NN})(?<stRest>(?:${LIST_SEP}${NN})*))`,
    String.raw`(?<sec>§ (?<secN>${NN}))`,
    String.raw`(?<bare>\bPart (?<bareN>[012])\b(?![—–-]| §| Steps?))`,
  ].join("|"),
  "g",
);

const nums = (rest: string) => [...rest.matchAll(/\d{2}/g)].map((m) => Number(m[0]));

function link(t: Target | undefined, text: string, ctx: Context): Segment {
  if (!t) return text;
  return ctx.inLink ? text : { text, href: t.href };
}

/** Join labels as prose: "A", "A and B", "A, B, and C". */
function joinSegs(parts: Segment[][]): Segment[] {
  const out: Segment[] = [];
  parts.forEach((p, i) => {
    if (i > 0) out.push(parts.length > 2 ? (i === parts.length - 1 ? ", and " : ", ") : " and ");
    out.push(...p);
  });
  return out;
}

export function rewrite(text: string, r: Resolver, ctx: Context): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(PATTERN)) {
    const g = m.groups ?? {};
    const at = m.index ?? 0;
    let segs: Segment[] | null = null;

    if (g.nbRange) {
      segs = [`Labs ${g.nbA}–${g.nbB}`];
    } else if (g.nb) {
      const n = Number(g.nbN);
      const part = g.nbPart ? Number(g.nbPart) : undefined;
      const label = part ? `Lab ${n}, Part ${part}` : `Lab ${n}`;
      segs = [link(r.lab(n, part), label, ctx)];
    } else if (g.p1) {
      const all = [Number(g.p1First), ...nums(g.p1Rest ?? "")];
      const targets = all.map((n) => r.fg(n)).filter((t): t is Target => !!t);
      const seen = new Set<string>();
      const uniq = targets.filter((t) => !seen.has(t.label) && seen.add(t.label));
      if (uniq.length === 1) {
        segs = [link(uniq[0], uniq[0].label, ctx)];
      } else if (uniq.length > 1 && uniq.every((t) => t.label.startsWith("Chapter "))) {
        segs = ["Chapters ", ...joinSegs(uniq.map((t) => [link(t, t.label.slice("Chapter ".length), ctx)]))];
      } else if (uniq.length > 1) {
        segs = joinSegs(uniq.map((t) => [link(t, t.label, ctx)]));
      }
    } else if (g.p0) {
      const t = r.part0(Number(g.p0N));
      segs = [link(t, `Chapter 1 § ${g.p0N}`, ctx)];
    } else if (g.p2Steps) {
      const t = r.part(2);
      segs = [link(t, t?.label ?? "Part 2", ctx), ","];
      // The following "Step(s) NN" is matched on the next iteration; drop a comma already in the text.
      const after = text.slice(at + m[0].length);
      if (after.startsWith(",")) {
        out.push(text.slice(last, at), ...segs);
        last = at + m[0].length + 1;
        continue;
      }
    } else if (g.steps) {
      const word = m[0].startsWith("Steps") ? "Steps" : "Step";
      const all = [Number(g.stFirst), ...nums(g.stRest ?? "")];
      if (all.length === 1) {
        segs = [link(r.step(all[0]), m[0], ctx)];
      } else {
        // Keep the original separators between the numbers.
        const body = m[0].slice(word.length + 1);
        const pieces: Segment[] = [`${word} `];
        let pos = 0;
        for (const nm of body.matchAll(/\d{2}/g)) {
          pieces.push(body.slice(pos, nm.index));
          pieces.push(link(r.step(Number(nm[0])), nm[0], ctx));
          pos = (nm.index ?? 0) + 2;
        }
        pieces.push(body.slice(pos));
        segs = pieces.filter((p) => p !== "");
      }
    } else if (g.sec) {
      const n = Number(g.secN);
      if (ctx.doc === "fg" || ctx.doc === "lab") {
        const t = r.fg(n);
        segs = [link(t, t?.label ?? m[0], ctx)];
      } else if (ctx.doc === "part0" || ctx.doc === "review") {
        segs = [link(r.local(n), m[0], ctx)];
      }
    } else if (g.bare && ctx.doc !== "lab") {
      const t = r.part(Number(g.bareN) as 0 | 1 | 2);
      if (t) segs = [link(t, t.label, ctx)];
    }

    if (segs) {
      out.push(text.slice(last, at), ...segs);
      last = at + m[0].length;
    }
  }
  out.push(text.slice(last));
  // Merge adjacent strings and drop empties.
  const merged: Segment[] = [];
  for (const s of out) {
    if (s === "") continue;
    const prev = merged[merged.length - 1];
    if (typeof s === "string" && typeof prev === "string") merged[merged.length - 1] = prev + s;
    else merged.push(s);
  }
  return merged;
}
