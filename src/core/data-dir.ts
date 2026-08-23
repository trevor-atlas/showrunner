import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Data directory resolution (spec §4.1): defaults to ~/.showrunner, overridable
 * via SHOWRUNNER_DATA_DIR. Used by both the daemon and the CLI so they always
 * agree on where the DB and the daemon's pidfile live.
 */
export const DEFAULT_DATA_DIR_NAME = ".showrunner";

export function resolveDataDir(env: Record<string, string | undefined> = process.env): string {
  const override = env.SHOWRUNNER_DATA_DIR;
  if (override !== undefined && override.trim() !== "") {
    return override;
  }
  return join(homedir(), DEFAULT_DATA_DIR_NAME);
}

/** The DB file (spec §4.1). */
export function dbPathFor(dataDir: string): string {
  return join(dataDir, "showrunner.db");
}

/** Per-run raw record directory: {data_dir}/runs/<run_id>/ (spec §10). */
export function runDirFor(dataDir: string, runId: string): string {
  return join(dataDir, "runs", runId);
}
