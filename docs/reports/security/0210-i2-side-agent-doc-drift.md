# Correct what the docs say a side agent can do

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Add `schedules` to the two stale statements**: the README and one line of the Control MCP guide. Status: open.

### 1. Add `schedules` to the two stale statements

**Problem.** Two documents say side agents get only `discovery` and `mail`. The code also grants `schedules`.

**Context.** `docs/architecture/coordinator.md:352` and `:2261` were already corrected, and `docs/architecture/control-mcp.md:518` is right.

**Investigation.** The grant is `apps/backend/src/core/control-mcp-tools.ts:193`. `README.md:19` and `docs/architecture/control-mcp.md:505` still have the old list.

**Decisions.** None: this is a documentation correction.

## Related

- [Security report, §6 Informational](../2-26-10-27-security.md#6-informational) (I2)
