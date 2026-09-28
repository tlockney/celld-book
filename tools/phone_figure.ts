/** Phone-sized screenshot of the first figure on a page: phone_figure.ts page.html out.png */
import { openSession } from "./cdp.ts";

const [page, out] = Deno.args;
const s = await openSession(8424, 9338);
await s.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await s.send("Emulation.setTouchEmulationEnabled", { enabled: true });
await s.send("Emulation.setEmulatedMedia", { features: [{ name: "hover", value: "none" }] });
await s.go(page);
await s.evaluate(`document.querySelector("figure").scrollIntoView({ block: "center" })`);
await new Promise((r) => setTimeout(r, 300));
await s.screenshot(out);
await s.close();
console.log(out);
