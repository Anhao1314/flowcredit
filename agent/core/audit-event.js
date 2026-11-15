import { RunRecord } from "./run-record.js";

export const AUDIT_EVENT_VERSION = "flowcredit.audit_event/v1";

/**
 * Shared governance envelope with adapter-owned metadata at the top level.
 * Common fields are applied last so product payloads cannot spoof run identity.
 */
export function createAuditEvent({ eventType, timestamp, run = null, payload = {} } = {}) {
  if (typeof eventType !== "string" || !eventType.trim()) throw new TypeError("eventType must be a non-empty string");
  if (typeof timestamp !== "string" || !timestamp.trim()) throw new TypeError("timestamp must be a non-empty string");
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new TypeError("payload must be an object");
  const event = { ...structuredClone(payload), eventVersion: AUDIT_EVENT_VERSION, eventType, timestamp };
  if (run !== null) event.run = RunRecord.fromJSON(run).snapshot();
  return event;
}
