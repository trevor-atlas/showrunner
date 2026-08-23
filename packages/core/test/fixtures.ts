import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The scripted pi fixture registry (spec §17, §7). The daemon's minimal submit
 * path drives these through the FakePi harness; daemon and core tests replay
 * them for deterministic, CI-safe assertions.
 */
export const FIXTURE_NAMES = ["happy", "gate-fail", "crash"] as const;
export type FixtureName = (typeof FIXTURE_NAMES)[number];

export interface FixtureScenario {
  /** human-readable description of the scenario */
  label: string;
  /** the exit code the FakePi process should produce at the end of the stream */
  exitCode: number;
}

export const FIXTURE_SCENARIOS: Record<FixtureName, FixtureScenario> = {
  happy: {
    label: "a full session that settles cleanly (2 tools, usage, agent_settled)",
    exitCode: 0,
  },
  "gate-fail": {
    label: "a full session whose tool results would fail gates (error tool calls, agent_settled)",
    exitCode: 0,
  },
  crash: {
    label: "a session that dies mid-tool-call before agent_settled",
    exitCode: 1,
  },
};

const HERE = dirname(fileURLToPath(import.meta.url));

/** Absolute path to a fixture's JSONL file. */
export function fixturePath(name: FixtureName): string {
  return join(HERE, "fixtures", `${name}.jsonl`);
}

/** Absolute path to the FakePi entry script (spawned by the daemon driver). */
export function fakePiEntryPath(): string {
  return join(HERE, "fake-pi.ts");
}

export function isFixtureName(v: unknown): v is FixtureName {
  return typeof v === "string" && (FIXTURE_NAMES as readonly string[]).includes(v);
}
