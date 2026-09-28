import { assert, assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import { contentVersion, manifest, serviceWorker, withHeadTags } from "./pwa.ts";

Deno.test("manifest is installable-shaped and fully relative", () => {
  const m = JSON.parse(manifest({ title: "celld", subtitle: "Sub", dek: "Dek" }));
  assertEquals(m.name, "celld: Sub");
  assertEquals(m.short_name, "celld");
  assertEquals(m.start_url, "./index.html");
  assertEquals(m.scope, "./");
  assertEquals(m.display, "standalone");
  const sizes = m.icons.map((i: { sizes: string; purpose: string }) => `${i.sizes}/${i.purpose}`);
  for (const want of ["192x192/any", "512x512/any", "192x192/maskable", "512x512/maskable"]) {
    assert(sizes.includes(want));
  }
  for (const i of m.icons) assert(!i.src.startsWith("/"), "icon paths must be relative");
});

Deno.test("head tags go before </head> and a page without a head is an error", () => {
  const out = withHeadTags("<html><head><title>x</title></head><body></body></html>", "celld");
  assert(out.indexOf('rel="manifest"') < out.indexOf("</head>"));
  assert(out.includes('rel="apple-touch-icon"'));
  assertThrows(() => withHeadTags("<p>no head</p>", "celld"));
});

Deno.test("the cache version changes with any content change and is stable otherwise", async () => {
  const a = await contentVersion(new Map([["a.html", "one"], ["b.html", "two"]]));
  const b = await contentVersion(new Map([["b.html", "two"], ["a.html", "one"]]));
  const c = await contentVersion(new Map([["a.html", "one!"], ["b.html", "two"]]));
  assertEquals(a, b);
  assertNotEquals(a, c);
  assertEquals(a.length, 12);
});

Deno.test("the service worker precaches exactly the given list under the versioned cache", () => {
  const sw = serviceWorker("abc123", ["index.html", "cell-model.html"]);
  assert(sw.includes('const CACHE = "celld-book-abc123";'));
  assert(sw.includes('const PRECACHE = ["index.html","cell-model.html"];'));
});
