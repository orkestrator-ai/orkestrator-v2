/**
 * Annotation fixture server. Loopback only; synthetic content.
 *
 *   bun annotation-app/server.ts            # PORT (default 4174), HOST 127.0.0.1
 *
 * Control endpoints (for tests; no credentials, loopback only):
 *   GET  /__fixture/state   current state and marker
 *   POST /__fixture/state   JSON patch of `FixtureState` (server-side "hot reload")
 *   POST /__fixture/reset   restore the deterministic initial state
 *   GET  /health            liveness plus the Team CTA label rendered from source
 *
 * In the page, `window.__annotationFixture` exposes DOM-replacement hooks
 * (`reorderCards`, `reorderFeatures`, `duplicateTeamCard`, `removeTeamCard`,
 * `replaceSaveButton`, `hotReload`).
 */
import { PLANS } from "./content";
import { FIXTURE_MARKER } from "./fixture-data";
import { INITIAL_STATE, renderPage, type FixtureState } from "./page";

export interface AnnotationFixture {
  url: string;
  port: number;
  state(): FixtureState;
  reset(): void;
  close(): Promise<void>;
}

const MAX_CONTROL_BODY_BYTES = 4 * 1024;

function applyPatch(state: FixtureState, patch: unknown): FixtureState | null {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return null;
  const input = patch as Record<string, unknown>;
  const next: FixtureState = { ...state };
  for (const [key, value] of Object.entries(input)) {
    if (key === "cardOrder" || key === "featureOrder") {
      if (value !== "default" && value !== "reversed") return null;
      next[key] = value;
    } else if (key === "duplicateTeam") {
      if (typeof value !== "boolean") return null;
      next.duplicateTeam = value;
    } else {
      return null;
    }
  }
  next.generation = state.generation + 1;
  return next;
}

export function startAnnotationFixture(
  options: { port?: number; host?: string } = {},
): AnnotationFixture {
  let state: FixtureState = { ...INITIAL_STATE };
  const server = Bun.serve({
    hostname: options.host ?? "127.0.0.1",
    port: options.port ?? 0,
    async fetch(request) {
      const url = new URL(request.url);
      const headers = { "x-fixture-marker": FIXTURE_MARKER, "cache-control": "no-store" };
      if (url.pathname === "/health") {
        const team = PLANS.find((plan) => plan.id === "team");
        return Response.json(
          { ok: true, marker: FIXTURE_MARKER, teamCta: team?.cta ?? null },
          { headers },
        );
      }
      if (url.pathname === "/__fixture/state") {
        if (request.method === "GET")
          return Response.json({ marker: FIXTURE_MARKER, state }, { headers });
        if (request.method === "POST") {
          const body = await request.text();
          if (body.length > MAX_CONTROL_BODY_BYTES)
            return new Response("Too large", { status: 413 });
          let patch: unknown;
          try {
            patch = JSON.parse(body);
          } catch {
            return new Response("Invalid JSON", { status: 400, headers });
          }
          const next = applyPatch(state, patch);
          if (!next) return new Response("Invalid state patch", { status: 400, headers });
          state = next;
          return Response.json({ marker: FIXTURE_MARKER, state }, { headers });
        }
        return new Response("Method not allowed", { status: 405, headers });
      }
      if (url.pathname === "/__fixture/reset" && request.method === "POST") {
        state = { ...INITIAL_STATE };
        return Response.json({ marker: FIXTURE_MARKER, state }, { headers });
      }
      if (request.method !== "GET")
        return new Response("Method not allowed", { status: 405, headers });
      const page = renderPage(url, state);
      if (!page) return new Response("Not found", { status: 404, headers });
      return new Response(page.html, {
        headers: { ...headers, "content-type": "text/html; charset=utf-8" },
      });
    },
  });
  const port = server.port ?? 0;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    state: () => ({ ...state }),
    reset: () => {
      state = { ...INITIAL_STATE };
    },
    close: async () => {
      await server.stop(true);
    },
  };
}

if (import.meta.main) {
  const fixture = startAnnotationFixture({
    port: Number(process.env.PORT ?? 4174),
    host: process.env.HOST ?? "127.0.0.1",
  });
  console.log(`Annotation fixture ${FIXTURE_MARKER}: ${fixture.url}/settings`);
}
