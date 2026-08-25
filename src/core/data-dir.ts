import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Data directory resolution: defaults to ~/.showrunner, overridable
 * via SHOWRUNNER_DATA_DIR. Used by both the server and the CLI so they always
 * agree on where the DB and per-run records live.
 */
export const DEFAULT_DATA_DIR_NAME = ".showrunner";

export function resolveDataDir(env: Record<string, string | undefined> = process.env): string {
  const override = env.SHOWRUNNER_DATA_DIR;
  if (override !== undefined && override.trim() !== "") {
    return override;
  }
  return join(homedir(), DEFAULT_DATA_DIR_NAME);
}

/** The DB file. */
export function dbPathFor(dataDir: string): string {
  return join(dataDir, "showrunner.db");
}

/** Per-run raw record directory: {data_dir}/runs/<run_id>/. */
export function runDirFor(dataDir: string, runId: string): string {
  return join(dataDir, "runs", runId);
}
