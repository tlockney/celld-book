import { assertEquals } from "@std/assert";
import { type Context, type Resolver, rewrite, type Segment, type Target } from "./xref.ts";

const FG: Record<number, Target> = {
  1: { label: "Part II's introduction", href: "how-celld-works.html" },
  2: { label: "Chapter 2", href: "cell-model.html" },
  3: { label: "Chapter 3", href: "bucket.html" },
  4: { label: "Chapter 4", href: "ownership.html" },
  5: { label: "Chapter 5", href: "fleet.html" },
  7: { label: "Chapter 7", href: "designing.html" },
  8: { label: "Chapter 8", href: "verdict.html#reliability" },
  9: { label: "Chapter 8", href: "verdict.html#security" },
  11: { label: "Appendix B", href: "glossary.html" },
};
const r: Resolver = {
  fg: (n) => FG[n],
  part0: (n) => ({ label: `Chapter 1 § 0${n}`, href: `foundations.html#s${n}` }),
  step: (n) => ({ label: `Step ${n}`, href: `building.html#step${n}` }),
  lab: (n, p) => ({ label: `Lab ${n}`, href: `lab-${n}.html${p ? `#part-${p}` : ""}` }),
  local: (n) => ({ label: `§ ${n}`, href: `#local${n}` }),
  part: (n) =>
    ({
      0: { label: "Chapter 1", href: "foundations.html" },
      1: { label: "Part II", href: "how-celld-works.html" },
      2: { label: "Chapter 9", href: "building.html" },
    })[n],
};
const art: Context = { doc: "guide", inLink: false };

const cases: [string, Context, Segment[]][] = [
  ["see Part 1 § 04 now", art, ["see ", { text: "Chapter 4", href: "ownership.html" }, " now"]],
  ["Part 1 § 03, § 04", art, ["Chapters ", { text: "3", href: "bucket.html" }, " and ", {
    text: "4",
    href: "ownership.html",
  }]],
  ["Part 1 § 02 and § 05", art, ["Chapters ", { text: "2", href: "cell-model.html" }, " and ", {
    text: "5",
    href: "fleet.html",
  }]],
  ["Part 1 § 08 and § 09", art, [{ text: "Chapter 8", href: "verdict.html#reliability" }]],
  ["Part 1 § 11 defines", art, [{ text: "Appendix B", href: "glossary.html" }, " defines"]],
  ["Part 2 Step 04", art, [{ text: "Chapter 9", href: "building.html" }, ", ", {
    text: "Step 04",
    href: "building.html#step4",
  }]],
  ["Part 2 Steps 05 and 07", art, [
    { text: "Chapter 9", href: "building.html" },
    ", Steps ",
    {
      text: "05",
      href: "building.html#step5",
    },
    " and ",
    { text: "07", href: "building.html#step7" },
  ]],
  ["Steps 02–04", art, ["Steps ", { text: "02", href: "building.html#step2" }, "–", {
    text: "04",
    href: "building.html#step4",
  }]],
  ["Part 0 § 03", art, [{ text: "Chapter 1 § 03", href: "foundations.html#s3" }]],
  ["Notebook 2 Part 3 shows", art, [{ text: "Lab 2, Part 3", href: "lab-2.html#part-3" }, " shows"]],
  ["Notebooks 1–3", art, ["Labs 1–3"]],
  ["Part 1 explains; Part 2 builds", art, [{ text: "Part II", href: "how-celld-works.html" }, " explains; ", {
    text: "Chapter 9",
    href: "building.html",
  }, " builds"]],
  ["(§ 05) records", { doc: "fg", inLink: false }, ["(", { text: "Chapter 5", href: "fleet.html" }, ") records"]],
  ["see § 03", { doc: "part0", inLink: false }, ["see ", { text: "§ 03", href: "#local3" }]],
  ["§ 03 stays", art, ["§ 03 stays"]],
  ["## Part 2—One thread", { doc: "lab", inLink: false }, ["## Part 2—One thread"]],
  ["Part 1 § 02 in a lab", { doc: "lab", inLink: false }, [
    { text: "Chapter 2", href: "cell-model.html" },
    " in a lab",
  ]],
  ["Notebook 1 Part 2", { doc: "fg", inLink: true }, ["Lab 1, Part 2"]],
  ["Part 1 § 04", { doc: "guide", inLink: true }, ["Chapter 4"]],
  ['and § 07 "Designing"', { doc: "lab", inLink: false }, [
    "and ",
    { text: "Chapter 7", href: "designing.html" },
    ' "Designing"',
  ]],
  ["no references here", art, ["no references here"]],
];

for (const [input, ctx, want] of cases) {
  Deno.test(`rewrite: ${input} (${ctx.doc}${ctx.inLink ? ", in link" : ""})`, () => {
    assertEquals(rewrite(input, r, ctx), want);
  });
}
