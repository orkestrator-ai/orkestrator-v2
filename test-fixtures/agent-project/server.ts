const version = "fixture-v1";
let clicks = 0;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 4173),
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true, version });
    if (url.pathname === "/click" && request.method === "POST") {
      clicks += 1;
      return Response.json({ clicks });
    }
    return new Response(
      `<!doctype html>
      <html><body><main><h1>Orkestrator test project</h1>
      <p data-testid="version">${version}</p>
      <button id="increment">Clicks: <span>0</span></button>
      <script>
        document.querySelector('#increment').addEventListener('click', async () => {
          const result = await fetch('/click', { method: 'POST' }).then(r => r.json());
          document.querySelector('#increment span').textContent = String(result.clicks);
        });
      </script></main></body></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  },
});

console.log(`Fixture server ${version}: http://127.0.0.1:${server.port}`);
