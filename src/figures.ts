/**
 * Figure styling for the inline SVG diagrams, shared by the book and the series. The diagrams'
 * colors are bench-sheet tokens (see tools/recolor_svgs.py), so they follow the light and dark
 * themes; this sets them on the bench sheet's own engineering-paper grid instead of the fixed light
 * card bench-sheet gives figures drawn for paper. Raster images and mermaid keep that card.
 */
export const FIGURE_CSS = `
/* ── figures: diagrams on the bench sheet ─────────────────────────────────── */
.r-fig figure > svg, .r-fig figure > .diagram-inner {
  background-color: var(--paper);
  background-image:
    linear-gradient(var(--rule-2) 1px, transparent 1px),
    linear-gradient(90deg, var(--rule-2) 1px, transparent 1px);
  background-size: 16px 16px;
  background-position: -1px -1px;
  border: 1px solid var(--rule);
  border-radius: 2px;
}
.r-fig svg .f { font-family: var(--f-head); }
.r-fig svg text { font-variant-numeric: tabular-nums; }
@media print {
  .r-fig figure > svg { background-image: none; }
}
`;
