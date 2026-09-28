import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { bottomNav, type TocEntry } from "./shell.ts";

const entry = (slug: string, label: string, title: string): TocEntry => ({
  slug,
  file: `${slug}.html`,
  label,
  title,
  part: "ii",
});

Deno.test("bottomNav links both neighbors and names them for screen readers", () => {
  const html = bottomNav(entry("bucket", "Chapter 3", "The bucket"), entry("fleet", "Chapter 5", "A fleet"));
  assertStringIncludes(
    html,
    '<a class="bn-prev" rel="prev" href="bucket.html" aria-label="Previous: Chapter 3 · The bucket">',
  );
  assertStringIncludes(html, '<a class="bn-next" rel="next" href="fleet.html" aria-label="Next: Chapter 5 · A fleet">');
  assertStringIncludes(html, 'class="bn-toc" type="button" aria-expanded="false" aria-controls="booktoc"');
});

Deno.test("bottomNav keeps the three-column layout at the ends of the book", () => {
  const first = bottomNav(undefined, entry("foundations", "Chapter 1", "Foundations"));
  assertStringIncludes(first, '<span class="bn-prev" aria-hidden="true"></span>');
  assert(!first.includes('rel="prev"'));
  const last = bottomNav(entry("bibliography", "Bibliography", "Bibliography"), undefined);
  assertStringIncludes(last, '<span class="bn-next" aria-hidden="true"></span>');
  assertStringIncludes(last, 'aria-label="Previous: Bibliography"');
});

Deno.test("bottomNav escapes chapter names", () => {
  const html = bottomNav(entry("x", "Chapter 9", 'Cells & "facets"'), undefined);
  assertEquals(html.includes('Cells & "facets"'), false);
  assertStringIncludes(html, "Cells &amp;");
});
