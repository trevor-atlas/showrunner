import type { Gate } from "../../core/index.ts";

// ── verdict gates ────────────────────────────────────────────────────────────

export interface ReviewApprovedOptions {
  /** the field that must be true (default: "approved") */
  field?: string;
}

/**
 * reviewApproved — the reviewer's verdict gate: the envelope must assert
 * approval (default field `approved: true`). A rejected review becomes a
 * violation, which the phase budget turns into a correction or routes through
 * on_fail back to the builder (the bounded revise loop).
 */
export function reviewApproved(opts: ReviewApprovedOptions = {}): Gate {
  const field = opts.field ?? "approved";
  return async function reviewApproved(envelope) {
    const value = (envelope as unknown as Record<string, unknown>)[field];
    if (value === true) return { pass: true };
    const verdict = (envelope as unknown as Record<string, unknown>).verdict;
    return {
      pass: false,
      violations: [
        `review did not approve (${field} !== true)` + (typeof verdict === "string" && verdict !== "" ? ` — ${verdict}` : ""),
      ],
    };
  };
}
