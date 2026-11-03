# Add a Content Security Policy to the renderer and the gateway-served app

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Add the policy to both surfaces**: the Electron renderer and the HTML the gateway serves. Status: open.
2. **Consider Trusted Types**: the report's optional follow-up. Status: open (depends on 1).
3. **Consider an allowlist of renderer-invokable commands**: narrow the generic command bridge in the main process. Status: open.

### 1. Add the policy to both surfaces

**Problem.** The renderer shows attacker-influenced markdown, Mermaid, SVG and transcripts. One sanitiser bypass would run script that can reach `window.orkestrator.invoke`, and from there the host.

**Context.** The hosted client already has a strict policy (`apps/web-public/vercel.json:17-18`), which is a useful starting list. The toolchain bootstrap windows and the artifact host have their own too (`apps/desktop/electron/toolchain-bootstrap-window.ts:45`, `apps/desktop/electron/artifact-host-shell.ts:258`).

**Investigation.** `apps/web/index.html` has no policy. `serveStatic` (`apps/backend/src/gateway-proxy.ts:700`) sets none, and the Electron window loads the renderer by URL or file with none (`apps/desktop/electron/window.ts:134`, `:137`). The sinks are still `apps/web/src/components/chat/rich/MermaidBlock.tsx:400`, `:405`, `apps/web/src/components/chat/rich/ArtifactPartBodies.tsx:417` and `apps/web/src/components/chat/MentionableInput.tsx:443`. The bridge still forwards any command string (`apps/desktop/electron/ipc.ts:297-306`). With a dev server configured, `serveStatic` proxies instead (`apps/backend/src/gateway-proxy.ts:712-718`), so that path needs no policy of its own. The login page carries an inline `<style>` (`apps/backend/src/gateway-support-extra.ts:271`).

**Decisions.**

- **Where should the policy live?**
  - **A response header from `serveStatic`, and a `<meta>` tag in `apps/web/index.html` for the `file://` load (recommended).**
    - Pros: one policy text can be generated for both; a header also carries `frame-ancestors`, which a `<meta>` tag ignores.
    - Cons: two delivery paths to keep in step; Electron's `file://` load gets no `frame-ancestors`.
  - **Only a `<meta>` tag in `index.html`.**
    - Pros: one line, covers both surfaces.
    - Cons: no `frame-ancestors`, and connection targets that vary per deployment cannot be expressed at build time.
- **How wide should `connect-src` and `frame-src` start?**
  - **Follow the hosted client's `connect-src 'self' https: wss:` and add loopback and the known preview and artifact origins (recommended).**
    - Pros: fits a renderer that connects to remote gateways chosen at run time; script is still confined by `script-src 'self'`.
    - Cons: an injected script that does run could still send data out.
  - **Exact origin lists, as the report suggests.**
    - Pros: the tightest result.
    - Cons: the backend URL and any preview origins are only known at run time, so the policy has to be generated per connection.

### 2. Consider Trusted Types

**Problem.** Task 1 restricts script sources, but the DOM sinks stay open to any script that runs.

**Context.** The report says to consider this; it is not part of its core fix.

**Investigation.** Three components assign HTML directly (task 1's list). Not checked: whether Mermaid or other dependencies assign to sinks in ways that Trusted Types would refuse.

**Decisions.**

- **Adopt it?**
  - **Decide after task 1, in report-only mode first (recommended).**
    - Pros: shows real violations before anything breaks.
    - Cons: needs a place to receive the reports.
  - **Skip it.**
    - Pros: no work.
    - Cons: the sinks rely on the sanitisers alone once a script is allowed.

### 3. Consider an allowlist of renderer-invokable commands

**Problem.** `orkestrator:invoke` passes any string to the backend, gated only by the sender check.

**Context.** The report says to consider this. The backend already holds deny-lists for other callers (see [0200](0200-i1-workspace-grant-allowlist.md)).

**Investigation.** `apps/desktop/electron/ipc.ts:297-306`. A renderer legitimately uses a very large part of the command registry, because it is the application's main client.

**Decisions.**

- **Add one?**
  - **No, rely on task 1 (recommended).**
    - Pros: the renderer needs most commands, including terminals, so an allowlist would remove little of what injected script could do.
    - Cons: the bridge stays generic.
  - **Yes, an allowlist in the main process.**
    - Pros: a clear statement of the renderer's surface; refuses new internal commands by default.
    - Cons: a second list to maintain for every command, with little security gain while terminals stay on it.

## Needs verification

Nothing was run for this file.

- Whether `style-src` needs `'unsafe-inline'` here as it does on the hosted client: Mermaid SVG output and the login page's inline `<style>` suggest it does.
- Whether `script-src 'self'` behaves as expected on Electron's `file://` load.
- Whether the renderer's workers and blob URLs fit `worker-src 'self' blob:`.

## Related

- [Security report, M6](../2-26-10-27-security.md#m6-no-csp-on-the-main-renderer-or-the-gateway-served-app-which-hold-a-generic-command-bridge)
- [0130](0130-l5-renderer-permission-handler.md): the same renderer's permission handler
