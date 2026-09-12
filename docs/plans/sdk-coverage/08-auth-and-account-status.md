# 08 — Auth and account status

**Status:** 🟨 In progress · ~65% · Depends on: 02

Refreshed 2026-09-11. `NativeAgentAuthStatus` and `/global/auth*` exist on
Claude, Codex, Cursor, Pi, and ACP; OpenCode reports through the capabilities
adapter. Still open: OpenCode per-provider OAuth, turn-time auth notices, a
settings-pane auth card, and browser QA.

## Goal

Every platform reports a normalized sign-in state, the backend owns the
sign-in flow where the SDK offers one, and "auth in progress" or "auth
failed" during a turn is visible in the tab rather than as a spawn error.
Today only Cursor can sign in from the app, only Cursor and Pi have a
`/global/auth` route, and Claude drops `auth_status` messages.

## Normalized model

`packages/protocol/src/native-agent.ts`:

```
NativeAgentAuthStatus = {
  state: "signed-in" | "signed-out" | "needs-auth" | "expired" | "unknown"
  account?: { label: string; plan?: string; expiresAt?: string }   // no secrets, no emails unless already shown today
  providers?: Array<{ id: string; label: string; state: NativeAgentAuthStatus["state"]; method?: "api-key" | "oauth" | "subscription" }>
  signIn?: { kind: "browser-url" | "device-code" | "terminal" | "none"; hint?: string }
  signOut?: boolean
}
```

Bridge routes on every bridge (Cursor and Pi already have two of three):

- `GET /global/auth` → `NativeAgentAuthStatus`
- `POST /global/auth/login` → `{ url?: string; code?: string }` (browser or
  device flow) or `405` when `signIn.kind` is `none`/`terminal`
- `POST /global/auth/logout`

Backend: `NativeAgentRuntimeProvider.authStatus?()`, `beginSignIn?()`,
`signOut?()`. The renderer's settings pane renders one auth card per
platform from the projection; `signIn.kind: "terminal"` renders the existing
"open a terminal tab and run /login" hint.

Turn-time: `NativeAgentNotice` `{ kind: "auth"; state; message }` for
auth-in-progress and auth-failed during a turn.

## Tasks

### Protocol, backend, renderer

- [ ] Add the type, notice, provider methods and route mapping;
  protocol tests. `HttpBridgeProvider` treats 404 on `/global/auth` as
  `unknown`, never as an error.
- [ ] Generic auth card in the settings pane; delete the Cursor-only
  `authentication-required` path in `http-bridge-provider.ts:762-770` in
  favour of the generic status.
- [ ] Session creation and prompt dispatch map a `needs-auth`/`expired`
  status to a `ProviderSessionFailedError` whose message names the sign-in
  kind, so the tab shows an actionable state instead of a spawn failure.

### Claude bridge

- [ ] `GET /global/auth` from `Query.accountInfo()` on a throwaway
  `maxTurns: 0` query (the same pattern `supportedModels()` uses at
  `session-manager-interactions.ts:241-251`), cached with a TTL. Report
  `apiKeySource` from `system/init`.
- [ ] Handle `auth_status` messages (no branch today) → `auth` notice with
  the SDK's `state`/`error`.
- [ ] `signIn.kind: "terminal"` for now; the SDK exposes no login call. If a
  later SDK adds one, this is the seam.

### Codex bridge

- [ ] `GET /global/auth` from `getAuthStatus` and `account/read` (replaces
  the token-echo `/global/auth-check`, which stays for the health probe).
- [ ] `POST /global/auth/login` → `account/login/start`; return the URL for
  the browser flow; `account/login/cancel` on abort; `account/logout` for
  sign-out. Handle `modelProvider/authRecoveryStarted`/`Completed` (plan 02
  routes them here) → `auth` notice.

### OpenCode (backend)

- [ ] `authStatus` from `provider.list` connectivity plus `auth` config,
  per provider (the same per-provider shape Pi reports).
- [ ] `beginSignIn` per provider: API key → `client.auth.set`; OAuth →
  `provider.oauth.authorize` returning the URL, `provider.oauth.callback`
  on return. The key entry itself is a generic "secret input" interaction
  (plan 04's `elicitation` with a `secret` field), never a renderer form.

### Cursor bridge

- [ ] Already serves all three routes; add `Cursor.me()` to `GET /global/auth`
  for `account.label`/`expiresAt`, and `Cursor.auth.status()` instead of
  reading the store file (`credentials.ts:61-77`).

### Grok bridge

- [ ] Read `authMethods` from the `initialize` result; if the agent requires
  `authenticate`, call it with the configured method before `session/new`.
  Report `needs-auth` on `GET /global/auth` when the credential file is
  absent, `signIn.kind: "terminal"` with the Grok login command as the hint.

### Pi bridge

- [ ] Keep login out (by design). Enrich `GET /global/auth` per provider
  with `getProviderAuthStatus`, `isUsingOAuth`, `isUsingSubscription` →
  `method`. `signIn.kind: "terminal"` with `/login` as the hint.

## Verification

- [ ] Bridge tests: each state on `GET /global/auth` from fixtures; login
  URL returned without logging it; no token or key in any response body
  except the intended `url`.
- [ ] Backend tests: `needs-auth` maps to an actionable session failure.
- [ ] Browser: settings pane shows one card per enabled platform; a Codex
  sign-out then sign-in round-trip on a fixture profile with
  `--credential-source codex`.

## Out of scope

Pi login flow. Storing any credential in Orkestrator's own store beyond what
Cursor already does. Codex `account/usage/read` (plan 11).
