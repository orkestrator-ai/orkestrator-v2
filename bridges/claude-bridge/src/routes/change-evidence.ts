import { Hono } from "hono";
import {
  CHANGE_EVIDENCE_ACK_ROUTE,
  CHANGE_EVIDENCE_BODY_ROUTE,
  CHANGE_EVIDENCE_ROUTE,
  changeEvidenceAckRouteBody,
  changeEvidenceBodyRouteBody,
  changeEvidenceReadBody,
} from "@orkestrator/protocol/node/change-tracking/evidence-routes";
import { claudeChangeEvidence } from "../services/change-evidence.js";

/**
 * The backend's pull surface for this bridge's change-evidence spool.
 *
 * Mounted at the root behind the same token middleware as every session
 * route. Reads never touch a session: no liveness, no hydration, no
 * re-attach, so the activity sweep can call them on every pass. An unknown
 * body id is answered in band (`missing`); a 404 here would read as a bridge
 * that predates change evidence.
 */
const changeEvidence = new Hono();

changeEvidence.get(CHANGE_EVIDENCE_ROUTE, (c) =>
  c.json(changeEvidenceReadBody(claudeChangeEvidence().spool, (name) => c.req.query(name))),
);

changeEvidence.get(CHANGE_EVIDENCE_BODY_ROUTE, (c) =>
  c.json(changeEvidenceBodyRouteBody(claudeChangeEvidence().spool, (name) => c.req.query(name))),
);

changeEvidence.post(CHANGE_EVIDENCE_ACK_ROUTE, async (c) => {
  const body = await c.req.json().catch(() => null);
  const result = changeEvidenceAckRouteBody(claudeChangeEvidence().spool, body);
  return result.ok ? c.json(result) : c.json(result, 400);
});

export default changeEvidence;
