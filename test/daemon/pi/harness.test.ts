import { test, expect } from "bun:test";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  ContentBlocks,
  RawAgentEnd,
  RawAgentSettled,
  RawToolExecutionEnd,
  RawToolExecutionStart,
  RawToolExecutionUpdate,
} from "../../../src/core/index.ts";
import {
  FIXTURE_NAMES,
  FIXTURE_SCENARIOS,
  fakePiEntryPath,
  fixturePath,
  isFixtureName,
} from "../../../src/daemon/pi/harness/fixtures.ts";
import type { FixtureName } from "../../../src/daemon/pi/harness/fixtures.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));

function fixtureLines(name: string): string[] {
  const text = readFileSync(fixturePath(name as never), "utf8");
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function parseLine(line: string): unknown {
  const parsed = JSON.parse(line) as { type?: string };
  expect(typeof parsed.type).toBe("string");
  return parsed;
}

// ── fixtures are well-formed scripted pi streams ─────────────────────────────

test("every fixture line parses as JSON with a type field", () => {
  for (const name of FIXTURE_NAMES) {
    for (const line of fixtureLines(name)) {
      const evt = parseLine(line) as { type: string };
      expect(evt.type.length).toBeGreaterThan(0);
    }
  }
});

test("tool execution events match the verified pi shapes", () => {
  for (const name of FIXTURE_NAMES) {
    for (const line of fixtureLines(name)) {
      const evt = parseLine(line) as { type: string };
      switch (evt.type) {
        case "tool_execution_start": {
          const r = RawToolExecutionStart.safeParse(evt);
          expect(r.success, `${name}: bad tool_execution_start`).toBe(true);
          if (r.success) expect(typeof r.data.toolCallId).toBe("string");
          break;
        }
        case "tool_execution_update": {
          const r = RawToolExecutionUpdate.safeParse(evt);
          expect(r.success, `${name}: bad tool_execution_update`).toBe(true);
          break;
        }
        case "tool_execution_end": {
          const r = RawToolExecutionEnd.safeParse(evt);
          expect(r.success, `${name}: bad tool_execution_end`).toBe(true);
          if (r.success) expect(typeof r.data.isError).toBe("boolean");
          break;
        }
      }
    }
  }
});

test("content blocks are text arrays we can join into snippets", () => {
  const blocks = ContentBlocks.parse([{ type: "text", text: "a\n" }, { type: "text", text: "b" }]);
  const joined = blocks.map((b) => b.text ?? "").join("\n");
  expect(joined).toBe("a\n\nb");
});

test("happy and gate-fail settle; crash dies before agent_settled", () => {
  const lastType = (name: string) => {
    const lines = fixtureLines(name);
    return (JSON.parse(lines[lines.length - 1]!) as { type: string }).type;
  };
  expect(lastType("happy")).toBe("agent_settled");
  expect(lastType("gate-fail")).toBe("agent_settled");
  expect(lastType("crash")).not.toBe("agent_settled");
  expect(RawAgentSettled.safeParse({ type: "agent_settled" }).success).toBe(true);
  expect(RawAgentEnd.safeParse({ type: "agent_end", willRetry: false }).success).toBe(true);
});

// ── FakePi replays deterministically ──────────────────────────────

function replay(name: FixtureName, delayMs = 0): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [fakePiEntryPath(), fixturePath(name), name],
      {
        timeout: 30_000,
        env: { ...process.env, FAKE_PI_DELAY_MS: String(delayMs) },
        encoding: "utf8",
      },
      (error, stdout, _stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, code: 0 });
      },
    );
  });
}

test("FakePi replays the fixture byte-identically on stdout", async () => {
  for (const name of FIXTURE_NAMES) {
    const { stdout } = await replay(name);
    const expected = readFileSync(fixturePath(name), "utf8");
    expect(stdout, name).toBe(expected);
  }
});

test("FakePi honors FAKE_PI_DELAY_MS without changing output", async () => {
  const { stdout } = await replay("happy", 3);
  expect(stdout).toBe(readFileSync(fixturePath("happy"), "utf8"));
});

test("FakePi exits with the scenario's exit code", async () => {
  const codes: number[] = [];
  for (const name of FIXTURE_NAMES) {
    const code = await new Promise<number>((resolve, reject) => {
      execFile(
        process.execPath,
        [fakePiEntryPath(), fixturePath(name)],
        {
          timeout: 30_000,
          env: {
            ...process.env,
            FAKE_PI_EXIT_CODE: String(FIXTURE_SCENARIOS[name].exitCode),
          },
        },
        (error) => {
          // non-zero exit is an error from execFile's perspective; read it via the signal/code
          if (error) {
            const code = (error as NodeJS.ErrnoException & { code?: number | string }).code;
            resolve(typeof code === "number" ? code : 1);
          } else {
            resolve(0);
          }
        },
      );
    });
    codes.push(code);
  }
  expect(codes[0]).toBe(0); // happy
  expect(codes[1]).toBe(0); // gate-fail
  expect(codes[2]).toBe(1); // crash
});

// ── registry helpers ─────────────────────────────────────────────────────────

test("fixture registry resolves paths and guards names", () => {
  expect(fixturePath("happy")).toEndWith("/fixtures/happy.jsonl");
  expect(fakePiEntryPath()).toEndWith("/fake-pi.ts");
  expect(isFixtureName("happy")).toBe(true);
  expect(isFixtureName("nope")).toBe(false);
  expect(HERE.endsWith("/test/daemon/pi/")).toBe(true); // the harness suite lives in test/daemon/pi/
});
