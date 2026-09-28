/**
 * Shared pieces of the bench-sheet renderers (render-notebook.ts,
 * render-article.ts): highlighting, escaping, slugs, markdown table and
 * code-block rendering, the outline rail, the page wrapper, and CLI flags.
 */

import type { Tokens } from "npm:marked@15.0.12";
import hljs from "npm:highlight.js@11.11.1/lib/core";
import bash from "npm:highlight.js@11.11.1/lib/languages/bash";
import css from "npm:highlight.js@11.11.1/lib/languages/css";
import dockerfile from "npm:highlight.js@11.11.1/lib/languages/dockerfile";
import go from "npm:highlight.js@11.11.1/lib/languages/go";
import ini from "npm:highlight.js@11.11.1/lib/languages/ini";
import javascript from "npm:highlight.js@11.11.1/lib/languages/javascript";
import json from "npm:highlight.js@11.11.1/lib/languages/json";
import nginx from "npm:highlight.js@11.11.1/lib/languages/nginx";
import python from "npm:highlight.js@11.11.1/lib/languages/python";
import rust from "npm:highlight.js@11.11.1/lib/languages/rust";
import sql from "npm:highlight.js@11.11.1/lib/languages/sql";
import swift from "npm:highlight.js@11.11.1/lib/languages/swift";
import typescript from "npm:highlight.js@11.11.1/lib/languages/typescript";
import xml from "npm:highlight.js@11.11.1/lib/languages/xml";
import yaml from "npm:highlight.js@11.11.1/lib/languages/yaml";

for (
  const [name, lang] of Object.entries({
    bash,
    css,
    dockerfile,
    go,
    ini,
    javascript,
    json,
    nginx,
    python,
    rust,
    sql,
    swift,
    typescript,
    xml,
    yaml,
  })
) hljs.registerLanguage(name, lang);

const LANG_ALIASES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  typescript: "typescript",
  js: "javascript",
  jsx: "javascript",
  javascript: "javascript",
  mjs: "javascript",
  py: "python",
  python: "python",
  python3: "python",
  sh: "bash",
  bash: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  json: "json",
  jsonc: "json",
  json5: "json",
  sql: "sql",
  yaml: "yaml",
  yml: "yaml",
  html: "xml",
  xml: "xml",
  svg: "xml",
  css: "css",
  rust: "rust",
  rs: "rust",
  go: "go",
  swift: "swift",
  toml: "ini",
  ini: "ini",
  conf: "ini",
  dockerfile: "dockerfile",
  docker: "dockerfile",
  nginx: "nginx",
};

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function highlight(code: string, lang: string | undefined): string {
  const name = LANG_ALIASES[(lang ?? "").toLowerCase().trim()];
  if (!name) return esc(code);
  return hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
}

export function slugify(text: string, seen: Map<string, number>): string {
  const base = text.toLowerCase().replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "section";
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  return n ? `${base}-${n + 1}` : base;
}

export const stripTags = (html: string): string =>
  html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** A GFM table wrapped so it scrolls inside its own box. */
export function renderTable(token: Tokens.Table, inline: (tokens: Tokens.Generic[]) => string): string {
  const cell = (c: Tokens.TableCell, tag: string) =>
    `<${tag}${c.align ? ` style="text-align:${c.align}"` : ""}>${inline(c.tokens)}</${tag}>`;
  const head = `<tr>${token.header.map((c) => cell(c, "th")).join("")}</tr>`;
  const body = token.rows.map((r) => `<tr>${r.map((c) => cell(c, "td")).join("")}</tr>`).join("\n");
  return `<div class="table-wrap"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>\n`;
}

export interface SeriesPart {
  title: string;
  href?: string;
}

/** Parse a series list from untrusted data (frontmatter, a YAML/JSON file). */
export function toSeriesParts(raw: unknown): SeriesPart[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null)
    .filter((p) => typeof p.title === "string")
    .map((p) => ({ title: String(p.title), href: typeof p.href === "string" ? p.href : undefined }));
}

/** A numbered series line for the masthead; the part without an href is this page. */
export function seriesNav(parts: SeriesPart[]): string {
  if (!parts.length) return "";
  return `<nav class="series" aria-label="Series"><ol>${
    parts.map((p, i) =>
      `<li${p.href ? "" : ' class="current" aria-current="page"'}><span class="sp-n">${i + 1}</span>${
        p.href ? `<a href="${esc(p.href)}">${esc(p.title)}</a>` : esc(p.title)
      }</li>`
    ).join("")
  }</ol></nav>`;
}

export interface OutlineEntry {
  id: string;
  text: string;
  mark?: string;
}

export function outlineNav(entries: OutlineEntry[], heading = "Sections"): string {
  if (!entries.length) return "";
  const items = entries.map((o) =>
    `<li><a href="#${o.id}">${o.mark ? `<span class="o-mark">${esc(o.mark)}</span>` : ""}${esc(o.text)}</a></li>`
  ).join("");
  return `<nav class="outline" aria-label="${esc(heading)}"><p class="o-head">${
    esc(heading)
  }</p><ol>${items}</ol></nav>`;
}

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Condensed:wght@500;600&family=JetBrains+Mono:ital,wght@0,400;0,600;1,400&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400&display=swap">`;

export interface PageParts {
  title: string;
  css?: string;
  js?: string;
  /** Extra <head> content (e.g. a library <script src>), placed after the stylesheet. */
  head?: string;
  body: string;
  /** Omit <!doctype>/<html>/<head>/<body>: the Claude Artifact publisher adds its own. */
  artifact?: boolean;
}

export function wrapPage(p: PageParts): string {
  const head = `<title>${esc(p.title)}</title>
${FONTS}
<style>
${p.css ?? ""}
</style>${p.head ? `\n${p.head}` : ""}`;
  const body = `${p.body}
<script>
${p.js ?? ""}
</script>
`;
  if (p.artifact) return `${head}\n${body}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${head}
</head>
<body>
${body}</body>
</html>
`;
}

/** Read sibling asset files (CSS/JS) and concatenate them in order. */
export async function readAssets(...names: string[]): Promise<string> {
  const here = new URL(".", import.meta.url);
  const parts = await Promise.all(names.map((n) => Deno.readTextFile(new URL(n, here))));
  return parts.join("\n");
}

export function parseArgs(args: string[], booleans: string[], valued: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const name = a.replace(/^-+/, "");
    if (a.startsWith("-") && booleans.includes(name)) flags[name] = true;
    else if (a.startsWith("-") && valued.includes(name)) flags[name] = args[++i] ?? "";
    else positional.push(a);
  }
  const str = (k: string) => typeof flags[k] === "string" ? flags[k] as string : undefined;
  return { flags, positional, str, bool: (k: string) => flags[k] === true };
}
