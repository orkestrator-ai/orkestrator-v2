import { defineLogAreas, THROTTLE_LOG_EVENTS } from "./define.js";

export const PREVIEW_LOG_AREAS = defineLogAreas({
  preview: {
    description: "Browser and service previews: transports, partitions and captures.",
    events: {
      "attachment.release-failed": "Releasing a preview attachment failed; its lease expires it.",
      "capture-spool.load-failed": "The pending browser capture spool could not be loaded.",
      "certificate.refresh-failed":
        "Re-reading the preview certificate failed; the next check retries.",
      "certificate.renewal-refused":
        "A renewed certificate does not cover the preview hosts, so it was ignored.",
      "connection-cleanup.record-failed": "A forgotten connection's cleanup could not be recorded.",
      "link.open-external-failed": "A preview link could not be opened in the system browser.",
      "node.record-failed": "A node that owns preview partitions could not be recorded.",
      "partition.clear-failed": "A preview partition could not be cleared.",
      "partitions.record-cleared-failed": "Cleared preview partitions could not be recorded.",
      "partitions.record-nodes-failed": "The nodes that own preview partitions could not be saved.",
      "partitions.remove-failed": "Cleared preview partition directories could not be removed.",
      "partitions.retry-forgotten-failed": "Retrying a forgotten preview cleanup failed.",
      "port-hints.persist-failed": "Preview port hints could not be saved.",
      "transport.close-failed": "A preview transport could not be closed.",
      "ca-bundle.read-failed": "The upstream CA bundle could not be read.",
      "publication.start-failed": "Private preview publication did not start.",
      "publication.reconfigure-failed": "Preview publication could not be reconfigured.",
      "publication.listening": "Private preview origins are listening.",
      "publication.same-site":
        "The preview domain is the same site as the application; publication runs with a warning.",
      "certificate.reloaded": "The preview certificate was reloaded.",
      "access.revoked-close-failed":
        "A revoked preview resource could not be closed. Error class only.",
      "registry.invalid-definition": "An invalid stored preview service definition was ignored.",
      "registry.environment-reconcile-failed":
        "An environment's preview services could not be reconciled.",
      "registry.resolver-failed": "A preview resolver failed. Error class only.",
      "registry.revocation-listener-failed":
        "A preview revocation listener threw. Error class only.",
      "registry.change-emit-failed":
        "A preview change event could not be emitted. Error class only.",
      ...THROTTLE_LOG_EVENTS,
    },
  },
});
