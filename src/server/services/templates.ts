import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The starter kit is shipped as source (src/starter-kit); on boot it is
 * MATERIALIZED into the user data dir so users can edit their own copy.
 * Resolved relative to THIS module (not process.cwd()) so it works no matter
 * where the server is launched from.
 */
const STARTER_KIT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "starter-kit");

/**
 * The repo root — two levels up from src/starter-kit — so a materialized data
 * dir can point back at the self-contained core module and the shared
 * node_modules. Computed from the module constant (not the sourceDir override)
 * so it always names the real repo tree the data dir must borrow from.
 */
const REPO_ROOT = join(STARTER_KIT_DIR, "..", "..");

/**
 * Copy src/starter-kit/** into <dataDir>/templates/, copy-if-absent: a file is
 * written ONLY when its destination does not already exist. Existing user files
 * are never clobbered (the whole point of this step), and a second call with
 * everything present copies nothing (idempotent). This is a plain additive copy
 * — no manifest, no hashing, no diff.
 *
 * @returns the relative paths that were actually created this call.
 */
export function materializeTemplates(dataDir: string, sourceDir: string = STARTER_KIT_DIR): { copied: string[] } {
  const destRoot = join(dataDir, "templates");
  const copied: string[] = [];

  for (const rel of walkRelFiles(sourceDir)) {
    const dest = join(destRoot, rel);
    if (existsSync(dest)) continue;
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(sourceDir, rel), dest);
    copied.push(rel);
  }
  linkDataDirImports(dataDir);
  return { copied };
}

/**
 * Make the data dir importable so a materialized blueprint copy at
 * <dataDir>/templates/blueprints/<name>.ts can resolve its `../../core/index.ts`
 * import and its bare deps (zod, ...). Two symlinks from the data-dir root back
 * to the repo:
 *   <dataDir>/core         → <repoRoot>/src/core   (core is self-contained)
 *   <dataDir>/node_modules → <repoRoot>/node_modules (bare deps + core's zod)
 * Sharing the SAME node_modules also keeps a single zod instance (the runner's
 * instanceof/merge checks would fail across two copies). Idempotent: an
 * already-correct link is left alone, a stale one is refreshed.
 */
function linkDataDirImports(dataDir: string): void {
  linkInto(join(dataDir, "core"), join(REPO_ROOT, "src", "core"));
  linkInto(join(dataDir, "node_modules"), join(REPO_ROOT, "node_modules"));
}

/** Create (or refresh) a symlink at `link` pointing at `target`. */
function linkInto(link: string, target: string): void {
  try {
    if (lstatSync(link).isSymbolicLink()) {
      if (readlinkSync(link) === target) return;
    }
    unlinkSync(link);
  } catch {
    // link does not exist — create it below
  }
  try {
    symlinkSync(target, link);
  } catch {
    // a concurrent boot won the race; the link is present either way
  }
}

/**
 * Shared tree walk over the starter-kit source (used by both materialize and
 * sync so the traversal is defined once). Yields each regular file's path
 * RELATIVE to sourceDir, recursing directories depth-first.
 */
function* walkRelFiles(sourceDir: string, relDir = ""): Generator<string> {
  for (const entry of readdirSync(join(sourceDir, relDir), { withFileTypes: true })) {
    const rel = relDir === "" ? entry.name : join(relDir, entry.name);
    if (entry.isDirectory()) {
      yield* walkRelFiles(sourceDir, rel);
      continue;
    }
    if (!entry.isFile()) continue;
    yield rel;
  }
}

/** A materialized file's relationship to its starter-kit source. */
type TemplateStatus = "missing" | "same" | "drifted";

/** Classify a destination against its source by byte-compare (no hashing). */
function classify(sourcePath: string, destPath: string): TemplateStatus {
  if (!existsSync(destPath)) return "missing";
  return readFileSync(sourcePath).equals(readFileSync(destPath)) ? "same" : "drifted";
}

export interface SyncTemplatesOptions {
  /**
   * Per-file confirmation seam for DRIFTED files. Called ONLY for a file that
   * exists and differs from source; returning true overwrites it with the
   * starter-kit copy. Omitted (the safe default) means no drifted file is ever
   * overwritten — drift is reported only. This is the sole interactive seam so
   * the whole function stays testable without a TTY.
   */
  confirm?: (relPath: string) => boolean | Promise<boolean>;
  /** Override the starter-kit source (tests inject a private fixture tree). */
  sourceDir?: string;
}

export interface SyncResult {
  /** MISSING files copied in automatically. */
  added: string[];
  /** Files that exist but differ from source (reported regardless of confirm). */
  drifted: string[];
  /** The subset of `drifted` the caller confirmed and we overwrote. */
  overwritten: string[];
}

/**
 * Explicit post-bootstrap pull of starter-kit updates into <dataDir>/templates/,
 * WITHOUT starting the server. One classification pass over src/starter-kit/**:
 *   - MISSING  → copied automatically (added)
 *   - SAME     → left alone
 *   - DRIFTED  → reported; overwritten ONLY when `confirm(relPath)` resolves true
 * Preserves #59's invariant: nothing is clobbered without explicit confirmation.
 */
export async function syncTemplates(dataDir: string, opts: SyncTemplatesOptions = {}): Promise<SyncResult> {
  const sourceDir = opts.sourceDir ?? STARTER_KIT_DIR;
  const destRoot = join(dataDir, "templates");
  const added: string[] = [];
  const drifted: string[] = [];
  const overwritten: string[] = [];

  for (const rel of walkRelFiles(sourceDir)) {
    const src = join(sourceDir, rel);
    const dest = join(destRoot, rel);
    const status = classify(src, dest);
    if (status === "same") continue;
    if (status === "missing") {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      added.push(rel);
      continue;
    }
    // drifted
    drifted.push(rel);
    if (opts.confirm && (await opts.confirm(rel))) {
      copyFileSync(src, dest);
      overwritten.push(rel);
    }
  }
  return { added, drifted, overwritten };
}
