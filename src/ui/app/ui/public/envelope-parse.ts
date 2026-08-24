/**
 * The UI's single adapter to the daemon's stored envelope/violations format
 * (spec §9.1, §16.8). Extracted verbatim from the three former local copies
 * (timeline-panel, envelope-card, gates-card) — pure dedup, byte-identical
 * behavior.
 *
 * Input contract:
 * - `violations` is a JSON-array-of-strings TEXT column, default `'[]'`
 *   (db.ts:83,108,195-196; written via `JSON.stringify` at
 *   envelope-runner.ts:115,170,217). The server passes the columns through
 *   untouched (apiPhaseEnvelopes/apiPhaseGates, server.ts:624-647).
 * - `text` is the raw envelope JSON string (the `envelopes.json` column).
 *
 * The module is deliberately import-free: it lives in the BROWSER module
 * graph (timeline-panel renders inside the run-live-region clientEntry) and
 * must not pull daemon/server-only types or modules.
 */
export interface ParsedEnvelope {
  summary: string;
  notes: string;
  artifacts: string[];
  blocked: boolean;
  blockedReason: string;
}

/** Parse the stored violations JSON column ('[]' when none). */
export function parseViolations(violations: string): string[] {
  try {
    const parsed = JSON.parse(violations) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** The envelope.json fields the panel shows (null when unparseable). */
export function parseEnvelope(text: string): ParsedEnvelope | null {
  try {
    const v = JSON.parse(text) as unknown;
    if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
    const e = v as Record<string, unknown>;
    return {
      summary: str(e.summary),
      notes: str(e.notes_for_next_agent),
      artifacts: Array.isArray(e.artifacts) ? e.artifacts.filter((a): a is string => typeof a === "string") : [],
      blocked: e.blocked === true,
      blockedReason: str(e.blocked_reason),
    };
  } catch {
    return null;
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
