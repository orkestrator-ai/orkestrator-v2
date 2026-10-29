import { DesignProfileLedger } from "../browser-profiles.js";
import { DesignRenderer } from "../renderer.js";

// A backend stand-in for renderer.test.ts: renders once with a profile ledger,
// reports readiness, then waits to be killed without closing its browser.
const renderer = new DesignRenderer({ profiles: new DesignProfileLedger(process.argv[2]!) });
await renderer.run({
  environmentId: "env",
  canvasId: "canvas",
  priority: "interactive",
  frame: { html: "<p>Hello</p>", width: 320, height: 240 },
  operation: { op: "serialize" },
});
console.log("ready");
setInterval(() => {}, 60_000);
