import { assertEquals, assertThrows } from "@std/assert";
import { applyVariants } from "./variants.ts";

Deno.test("keeps the target's span and drops the other", () => {
  const src = "A <!-- book-only -->B<!-- /book-only --><!-- series-only -->S<!-- /series-only --> C";
  assertEquals(applyVariants(src, "book"), "A B C");
  assertEquals(applyVariants(src, "series"), "A S C");
});

Deno.test("drops whole blocks and collapses the blank lines they leave", () => {
  const src = "one\n\n<!-- series-only -->\n> callout\n<!-- /series-only -->\n\ntwo\n";
  assertEquals(applyVariants(src, "book"), "one\n\ntwo\n");
  assertEquals(applyVariants(src, "series"), "one\n\n\n> callout\n\n\ntwo\n".replace(/\n{3,}/g, "\n\n"));
});

Deno.test("text without markers is unchanged", () => {
  assertEquals(applyVariants("plain\n\ntext", "book"), "plain\n\ntext");
});

Deno.test("an unbalanced marker is an error, not silent output", () => {
  assertThrows(() => applyVariants("a <!-- book-only -->b", "series"), Error, "unbalanced");
});
