import type { Gate } from "../../core/index.ts";

// ── envelope gates ───────────────────────────────────────────────────────────

export interface EnvelopeShapeOptions {  /** cap on how many zod issues become violations */
  maxIssues?: number;
}

/** The structural slice of zod's safeParse result the gate needs. */
interface ShapeParseResult {
  success: boolean;
  error?: { issues: { path: (string | number)[]; message: string }[] };
}

/**
 * envelopeShape — the envelope must satisfy a schema. Useful when a phase must
 * double-check a contract stricter than its own parse schema (the daemon
 * already parses against phase.envelope; this gate exists for the extra
 * contract the phase wants to enforce on top).
 */
export function envelopeShape<S extends { safeParse(input: unknown): ShapeParseResult }>(
  schema: S,
  opts: EnvelopeShapeOptions = {},
): Gate {
  const maxIssues = opts.maxIssues ?? 5;
  return async function envelopeShape(envelope) {
    const res = schema.safeParse(envelope);
    if (res.success) return { pass: true };
    const issues = res.error?.issues.map((i) => `${i.path.join(".")}: ${i.message}`) ?? [];
    const shown = issues.slice(0, maxIssues);
    if (issues.length > maxIssues) shown.push(`... and ${issues.length - maxIssues} more`);
    return { pass: false, violations: shown.length > 0 ? shown : ["envelope does not match the required shape"] };
  };
}
