/** Test-only listener process; closed by EOF from the owning browser test. */
import { installFatalRejectionGuard } from "@orkestrator/protocol/fatal-rejections";
import { PreviewExternalForward } from "../electron/preview-external-forward";

installFatalRejectionGuard({ label: "[external-forward-browser-harness]" });
const forwards: PreviewExternalForward[] = [];
try {
  const urls: Array<{ preferred: number; url: string }> = [];
  for (const preferred of [6000, 6667, 10080]) {
    const forward = new PreviewExternalForward(
      {
        applicationPort: () => preferred,
        available: () => true,
        forwardRequest: async (_request, response) => {
          response.setHeader("content-type", "text/html; charset=utf-8");
          response.end(`<!doctype html><body data-port="${preferred}">browser-safe forward</body>`);
        },
        forwardUpgrade: async (_request, socket) => {
          socket.destroy();
        },
      },
      { onIdle: () => void forward.close() },
    );
    forwards.push(forward);
    const port = await forward.listen();
    urls.push({ preferred, url: `http://localhost:${port}/` });
  }
  process.stdout.write(`${JSON.stringify(urls)}\n`);
  for await (const _chunk of process.stdin) {
    /* EOF owns shutdown. */
  }
} finally {
  await Promise.all(forwards.map((forward) => forward.close()));
}
