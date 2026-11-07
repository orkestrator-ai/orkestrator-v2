# Same-site preview domain warning on a real deployment

## Task analysis

Analysed 2026-11-05 against `main` at `69a3b4ca5`. Carried from security report
`0230` (I5, "Needs verification"), whose code task was done on this branch; the
report stays in git history at `69a3b4ca5`, under `docs/reports/security/`.

### Tasks

1. **Check the same-site warning against real deployments**: confirm on a real
   private zone and wildcard certificate that the publication status warns
   for a preview domain under Orkestrator's own site and not for a separate
   one, and record which domain deployments are in use. Status: open (depends
   on [0042](0042-service-preview-rollout.md) task 2).

### 1. Check the same-site warning against real deployments

**Problem.** A preview host that is same-site with the gateway can send it
same-site requests and set cookies on the shared parent domain, the cookie
tossing that [todo 2960](../cross-cutting/2960-host-prefixed-gateway-cookie.md)
describes. Publication now warns about this, but the warning has only run
against fixtures, and nobody knows which domain layouts operators actually use.

**Context.** The warning is `sameSiteWarning` in
`apps/backend/src/preview-publication.ts`. It compares the preview domain with
the application's own origins (gateway, Tailscale Serve URL, managed web client,
allowed origins, passed from `apps/backend/src/main.ts`) through
`hostsShareSite` in `apps/backend/src/core/host-site.ts`, with `ts.net` treated
as a public suffix so each tailnet name is its own site. The Preview settings
page shows it under the publication status
(`apps/web/src/components/settings/PreviewSettings.tsx`), and the backend logs
`preview/publication.same-site` once per configuration. Publication still
serves: the report chose warn over refuse because a refusal would block the
tailnet setup its own example (`preview.example.ts.net`) recommends.

**Investigation.** Tests cover a sibling of the preview hosts, the same and a
different tailnet under `ts.net`, disabled publication and unparseable origins
(`apps/backend/src/preview-publication.test.ts`,
`apps/backend/src/core/host-site.test.ts`). What no test can show: the Serve URL
the gateway reports on a real tailnet (the warning depends on it), whether a
custom private zone (for example split DNS on a company domain) shares its
registrable domain with the gateway's name, and whether any operator relies on
a same-site layout. 0042 task 2 is blocked on exactly this real zone and
certificate.

**Decisions.**

- **When to run it?**
  - **With 0042 task 2's support rows (recommended).**
    - Pros: the same zone, certificate and Serve setup; one row per deployment
      type can record whether the warning showed.
    - Cons: waits on that blocked prerequisite.
  - **A separate run now with a throwaway private zone.**
    - Pros: earlier answer.
    - Cons: needs its own DNS and certificate, which is the prerequisite 0042 is
      blocked on anyway.
- **After the run, keep warning or refuse?**
  - **Keep the warning unless no real deployment needs a same-site domain
    (recommended).**
    - Pros: never blocks a working setup; the operator sees the risk.
    - Cons: a warning can be ignored.
  - **Refuse, as the artifact content origin does.**
    - Pros: matches the artifact rule; no same-site preview host can exist.
    - Cons: blocks any deployment that has only its own tailnet name, and the
      site comparison is an approximation without a public suffix list.

## Related

- [Todo 0042](0042-service-preview-rollout.md), task 2
- [Todo 2960](../cross-cutting/2960-host-prefixed-gateway-cookie.md)
- [Browser previews: private HTTPS origins](../../architecture/browser-previews.md#private-https-origins)
- Security report, §6 Informational (`git show 413bd6219:docs/reports/2-26-10-27-security.md`) (I5)
