import { homedir } from "node:os";
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Showrunner ships one skill (src/starter-kit/skills/) that teaches the coding
 * agent to start and manage runs. Unlike blueprints/agents/gates — which
 * materialize into the Showrunner DATA DIR because the RUNTIME loads them — the
 * skill is agent-facing: it installs into the coding agent's GLOBAL skills dir
 * (~/.agents/skills), the cross-agent location the agent reads at startup. So
 * skills never touch the data dir; they install here.
 */

/** The starter-kit skills source: src/starter-kit/skills, resolved from this
 * module so it works no matter where the CLI is launched from. */
const SKILLS_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "starter-kit", "skills");

/**
 * The global skills dir: SHOWRUNNER_SKILLS_DIR when set (tests point it at a
 * scratch dir), else ~/.agents/skills — the cross-agent skills location, NOT
 * the Showrunner data dir.
 */
export function resolveSkillsDir(env: Record<string, string | undefined> = process.env): string {
  const override = env.SHOWRUNNER_SKILLS_DIR;
  if (override !== undefined && override.trim() !== "") return override;
  return join(homedir(), ".agents", "skills");
}

export interface InstallSkillsResult {
  /** the resolved global skills dir the skills were installed into */
  skillsDir: string;
  /** skill dir names copied in this call */
  installed: string[];
  /** skill dir names already present and left alone (no --force) */
  skipped: string[];
}

/**
 * Install the starter-kit skills into the global skills dir, one dir per skill.
 * Copy-if-absent by default (an already-installed skill is left alone so a user's
 * edits survive); `force` overwrites. Idempotent without force.
 */
export function installSkills(opts: { skillsDir?: string; sourceDir?: string; force?: boolean } = {}): InstallSkillsResult {
  const sourceDir = opts.sourceDir ?? SKILLS_SRC;
  const skillsDir = opts.skillsDir ?? resolveSkillsDir();
  const installed: string[] = [];
  const skipped: string[] = [];

  const skillDirs = existsSync(sourceDir)
    ? readdirSync(sourceDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    : [];

  for (const name of skillDirs) {
    const dest = join(skillsDir, name);
    if (existsSync(dest) && opts.force !== true) {
      skipped.push(name);
      continue;
    }
    mkdirSync(skillsDir, { recursive: true });
    cpSync(join(sourceDir, name), dest, { recursive: true, force: true });
    installed.push(name);
  }
  return { skillsDir, installed, skipped };
}
