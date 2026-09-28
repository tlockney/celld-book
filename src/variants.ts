/**
 * Output variants. Most text is shared between the book and the Reading Room series; where
 * the two must differ, the source marks the span:
 *
 *   <!-- series-only -->…<!-- /series-only -->   kept in the series, dropped from the book
 *   <!-- book-only -->…<!-- /book-only -->       kept in the book, dropped from the series
 *
 * Markers work inline or around whole blocks, in markdown files and notebook markdown cells.
 */

export type Target = "book" | "series";

const BLOCK = /<!-- (series|book)-only -->([\s\S]*?)<!-- \/\1-only -->/g;

/** Keep the target's spans (without their markers) and drop the other target's spans. */
export function applyVariants(text: string, target: Target): string {
  const out = text.replace(BLOCK, (_m, kind: string, body: string) => kind === target ? body : "");
  const stray = out.match(/<!-- \/?(series|book)-only -->/);
  if (stray) throw new Error(`unbalanced variant marker: ${stray[0]}`);
  // A dropped block can leave three or more newlines behind; keep paragraphs separated by one blank line.
  return out.replace(/\n{3,}/g, "\n\n");
}
