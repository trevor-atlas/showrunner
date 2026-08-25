import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Gate } from "../../core/index.ts";
import { outputsDirFor } from "./shared.ts";

// ── file gates ───────────────────────────────────────────────────────────────

export interface FilesExistOptions {
  /** exact relative paths that envelope.artifacts must include (default: []) */
  paths?: string[];
  /** also require at least one artifact beyond the listed paths */
  requireAny?: boolean;
}

/**
 * filesExist — the envelope must list real files. With `paths`, each listed
 * path must appear in envelope.artifacts (and exist in the phase's outputs
 * dir). With no paths, the envelope must carry at least one artifact — the
 * phase must have produced something, not just prose.
 */
export function filesExist(opts: FilesExistOptions = {}): Gate {
  const required = opts.paths ?? [];
  const requireAny = opts.requireAny ?? required.length === 0;
  return async function filesExist(envelope, ctx) {
    const out = outputsDirFor(ctx);
    const violations: string[] = [];
    if (requireAny && envelope.artifacts.length === 0) {
      violations.push("envelope lists no artifacts — the phase must produce at least one file");
    }
    for (const rel of required) {
      if (!envelope.artifacts.includes(rel)) {
        violations.push(`artifact "${rel}" is missing from envelope.artifacts`);
        continue;
      }
      if (out === "") {
        violations.push(`cannot verify artifact "${rel}" — the daemon did not provide ctx.outputs_dir`);
        continue;
      }
      const full = join(out, rel);
      if (!existsSync(full)) violations.push(`artifact "${rel}" does not exist in your outputs directory (${out})`);
    }
    if (violations.length > 0) return { pass: false, violations };
    return { pass: true };
  };
}
