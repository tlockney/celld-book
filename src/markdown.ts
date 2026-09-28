/**
 * Markdown slicing for the book: frontmatter, `## … {#id}` sections, heading promotion,
 * and lifting a `###` subsection or a callout out of a section. Everything here is
 * fence-aware: a `##` line inside a code block is code, not a heading.
 */

import { parse as parseYaml } from "@std/yaml";

export interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
}

export function splitFrontmatter(src: string): Frontmatter {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: src };
  const raw: unknown = parseYaml(m[1]);
  const data = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return { data, body: src.slice(m[0].length) };
}

/** Indices of lines that are outside fenced code blocks. */
function outsideFences(lines: string[]): boolean[] {
  let fence: string | null = null;
  return lines.map((l) => {
    const m = l.match(/^(`{3,}|~{3,})/);
    if (m) {
      if (fence === null) fence = m[1][0];
      else if (m[1][0] === fence) fence = null;
      return false;
    }
    return fence === null;
  });
}

export interface Section {
  id: string;
  title: string;
  /** Markdown after the heading line, up to the next `##` heading. */
  body: string;
}

export interface Sectioned {
  preamble: string;
  sections: Section[];
}

const H2 = /^## (.+?)\s*\{#([\w-]+)\}\s*$/;

/** Split a document body at its `## Title {#id}` headings. */
export function splitSections(body: string): Sectioned {
  const lines = body.split("\n");
  const ok = outsideFences(lines);
  const preamble: string[] = [];
  const sections: Section[] = [];
  let cur: { id: string; title: string; lines: string[] } | null = null;
  lines.forEach((l, i) => {
    const m = ok[i] ? l.match(H2) : null;
    if (m) {
      if (cur) sections.push({ id: cur.id, title: cur.title, body: cur.lines.join("\n") });
      cur = { id: m[2], title: m[1], lines: [] };
      return;
    }
    (cur ? cur.lines : preamble).push(l);
  });
  if (cur) {
    const c = cur as { id: string; title: string; lines: string[] };
    sections.push({ id: c.id, title: c.title, body: c.lines.join("\n") });
  }
  return { preamble: preamble.join("\n"), sections };
}

/** Raise every heading outside code by one level (`###` → `##`), for a one-section chapter. */
export function promoteHeadings(md: string): string {
  const lines = md.split("\n");
  const ok = outsideFences(lines);
  return lines.map((l, i) => ok[i] && /^#{3,6} /.test(l) ? l.slice(1) : l).join("\n");
}

/** Remove the `### title` subsection (up to the next `###`/`##` heading) and return both parts. */
export function extractSubsection(md: string, title: string): { rest: string; extracted: string } {
  const lines = md.split("\n");
  const ok = outsideFences(lines);
  const start = lines.findIndex((l, i) => ok[i] && l.trim() === `### ${title}`);
  if (start < 0) throw new Error(`no "### ${title}" subsection`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (ok[i] && /^#{2,3} /.test(lines[i])) {
      end = i;
      break;
    }
  }
  return {
    rest: [...lines.slice(0, start), ...lines.slice(end)].join("\n"),
    extracted: lines.slice(start + 1, end).join("\n").trim(),
  };
}

/** Replace the body of the `### title` subsection, keeping its heading. */
export function replaceSubsection(md: string, title: string, body: string): string {
  const { rest } = extractSubsection(md, title);
  const lines = md.split("\n");
  const ok = outsideFences(lines);
  const start = lines.findIndex((l, i) => ok[i] && l.trim() === `### ${title}`);
  const before = lines.slice(0, start).join("\n");
  const after = rest.slice(before.length);
  return `${before}\n### ${title}\n\n${body}\n${after.startsWith("\n") ? after : `\n${after}`}`;
}

/** Return the callout (`> [!KIND] title` and its `>` lines) whose title line contains `titleText`. */
export function findCallout(md: string, titleText: string): string {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => /^> \[!\w+\]/.test(l) && l.includes(titleText));
  if (start < 0) throw new Error(`no callout titled "${titleText}"`);
  let end = start + 1;
  while (end < lines.length && lines[end].startsWith(">")) end++;
  return lines.slice(start, end).join("\n");
}

/** Section ids in document order: `§ 01` is index 0. */
export function sectionIds(body: string): string[] {
  return splitSections(body).sections.map((s) => s.id);
}
