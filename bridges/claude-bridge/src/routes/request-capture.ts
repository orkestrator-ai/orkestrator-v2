import { Hono } from "hono";
import { requestCapture } from "../services/request-capture.js";
const app = new Hono();
app.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
app.get("/", async (c) =>
  c.json({
    enabled: await requestCapture.enabled(),
    files: await requestCapture.list(),
    index: await requestCapture.index(),
  }),
);
app.post("/", async (c) => {
  const reader = c.req.raw.body?.getReader();
  let text = "";
  if (reader) {
    const decoder = new TextDecoder();
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 100) {
          await reader.cancel();
          return c.json({ error: "Invalid capture setting" }, 400);
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return c.json({ error: "Invalid capture setting" }, 400);
  }
  if (typeof body?.enabled !== "boolean") return c.json({ error: "Expected enabled boolean" }, 400);
  await requestCapture.setEnabled(body.enabled);
  return c.json({
    enabled: body.enabled,
    files: await requestCapture.list(),
    index: await requestCapture.index(),
  });
});
app.get("/:name", async (c) => {
  try {
    if (!/^[a-zA-Z0-9_-]+\.(request|response)\.json$/.test(c.req.param("name")))
      return c.json({ error: "Invalid capture file" }, 400);
    return c.json({ body: JSON.parse(await requestCapture.detail(c.req.param("name"))) });
  } catch {
    return c.json({ error: "Capture unavailable, expired or too large" }, 404);
  }
});
export default app;
