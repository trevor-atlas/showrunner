/**
 * Unit tests for the UI's single envelope-format adapter (envelope-parse.ts)
 * — the shared parseEnvelope/parseViolations the timeline panel and the
 * drill-in cards use. Pure module — no DOM (the repo's convention: parsing is
 * tested directly; SSR integration is covered by run-detail.test.ts and
 * phase-drill-in.test.ts).
 */
import { describe, expect, it } from "bun:test";

import {
  parseEnvelope,
  parseViolations,
  type ParsedEnvelope,
} from "../../src/server/ui/public/envelope-parse.ts";

describe("parseViolations", () => {
  it("returns [] for the default '[]' column value", () => {
    expect(parseViolations("[]")).toEqual([]);
  });

  it("returns [] for the empty string", () => {
    expect(parseViolations("")).toEqual([]);
  });

  it("parses a valid array of strings", () => {
    expect(parseViolations('["gate a", "gate b"]')).toEqual(["gate a", "gate b"]);
  });

  it("filters non-string entries", () => {
    expect(parseViolations('[1, "ok", null, { "x": 1 }, true]')).toEqual(["ok"]);
  });

  it("returns [] for malformed JSON", () => {
    expect(parseViolations("not json")).toEqual([]);
    expect(parseViolations('["unclosed')).toEqual([]);
  });

  it("returns [] for non-array JSON", () => {
    expect(parseViolations('{"a": 1}')).toEqual([]);
    expect(parseViolations("42")).toEqual([]);
    expect(parseViolations("null")).toEqual([]);
  });
});

describe("parseEnvelope", () => {
  it("parses the happy path envelope fields", () => {
    const text = JSON.stringify({
      summary: "Did the thing.",
      notes_for_next_agent: "Handoff notes.",
      artifacts: ["a.txt", "b.txt"],
      blocked: true,
      blocked_reason: "waiting on approval",
    });
    const e = parseEnvelope(text);
    expect(e).not.toBeNull();
    expect(e).toEqual({
      summary: "Did the thing.",
      notes: "Handoff notes.",
      artifacts: ["a.txt", "b.txt"],
      blocked: true,
      blockedReason: "waiting on approval",
    });
  });

  it("defaults missing fields", () => {
    const e = parseEnvelope("{}");
    expect(e).toEqual({
      summary: "",
      notes: "",
      artifacts: [],
      blocked: false,
      blockedReason: "",
    });
  });

  it("defaults typed-wrong fields", () => {
    const e = parseEnvelope(
      JSON.stringify({
        summary: 42,
        notes_for_next_agent: null,
        artifacts: "not-an-array",
        blocked: "yes",
        blocked_reason: ["nope"],
      }),
    );
    expect(e).toEqual({
      summary: "",
      notes: "",
      artifacts: [],
      blocked: false,
      blockedReason: "",
    });
  });

  it("filters non-string artifacts but keeps string ones", () => {
    const e = parseEnvelope(JSON.stringify({ artifacts: ["ok.txt", 1, null] }));
    expect(e).not.toBeNull();
    expect(e!.artifacts).toEqual(["ok.txt"]);
  });

  it("returns null for non-object JSON", () => {
    expect(parseEnvelope('["an", "array"]')).toBeNull();
    expect(parseEnvelope("42")).toBeNull();
    expect(parseEnvelope("null")).toBeNull();
  });

  it("returns null for unparseable text", () => {
    expect(parseEnvelope("")).toBeNull();
    expect(parseEnvelope("not json")).toBeNull();
  });

  it("exposes the ParsedEnvelope shape via the type", () => {
    // compile-time check only: the interface must remain importable
    const _shape: ParsedEnvelope = { summary: "", notes: "", artifacts: [], blocked: false, blockedReason: "" };
    expect(_shape).toEqual({ summary: "", notes: "", artifacts: [], blocked: false, blockedReason: "" });
  });
});
