/** Desktop screenshot of a page scrolled to an element: page_top.ts page.html "css selector" out.png */
import { openSession } from "./cdp.ts";

const [page, selector, out] = Deno.args;
const s = await openSession(8425, 9339);
await s.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 760, deviceScaleFactor: 1, mobile: false });
await s.go(page);
await s.evaluate(
  `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "start" }); scrollBy(0, -70)`,
);
await new Promise((r) => setTimeout(r, 300));
await s.screenshot(out);
await s.close();
console.log(out);
