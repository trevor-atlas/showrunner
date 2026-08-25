/**
 * Pure-helper unit tests for the browser-safe phase cards (issue #37) — the
 * data derivations the cards render, tested DOM-free the way
 * envelope-parse.test.ts / timeline-model.test.ts are. Importing the card
 * modules here is intentional: `css()` evaluates without a DOM, only `render()`
 * needs one, so the exported helpers are reachable without the harness.
 */
import { describe, expect, it } from "bun:test";

import type { EnvelopeRow } from "../../src/server/repository/db.ts";
import { acceptedEnvelope, attemptLabel, attemptState } from "../../src/server/ui/public/envelope-card.tsx";
import { acceptedArtifacts, artifactPresent } from "../../src/server/ui/public/outputs-card.tsx";
import { contextKindLabel } from "../../src/server/ui/public/agent-card.tsx";
import { renderEnvelopeContract } from "../../src/server/ui/public/phase-config-card.tsx";

function envelope(over: Partial<EnvelopeRow> = {}): EnvelopeRow {
  return {
    id: "e1",
    run_id: "r1",
    phase_id: "p1",
    visit: 1,
    attempt: 0,
    json: "{}",
    source: "outputs/envelope.json",
    validated_at: "2024-01-01T14:02:11.000Z",
    valid: 1,
    violations: "[]",
    correction: null,
    ...over,
  };
}

describe("acceptedEnvelope", () => {
  it("returns the last valid attempt with no violations", () => {
    const a = envelope({ id: "a", attempt: 0, valid: 0 });
    const b = envelope({ id: "b", attempt: 1, valid: 1, violations: "[]" });
    expect(acceptedEnvelope([a, b])?.id).toBe("b");
  });

  it("skips valid attempts that still have gate violations", () => {
    const a = envelope({ id: "a", valid: 1, violations: "[]" });
    const b = envelope({ id: "b", valid: 1, violations: '["gate x"]' });
    // b is later but rejected by a violation → a is the accepted one
    expect(acceptedEnvelope([a, b])?.id).toBe("a");
  });

  it("returns null when nothing was accepted", () => {
    expect(acceptedEnvelope([envelope({ valid: 0 })])).toBeNull();
    expect(acceptedEnvelope([])).toBeNull();
  });
});

describe("attemptState", () => {
  it("labels an invalid attempt", () => {
    expect(attemptState(envelope({ valid: 0 }))).toBe("invalid");
  });

  it("labels a clean valid attempt", () => {
    expect(attemptState(envelope({ valid: 1, violations: "[]" }))).toBe("valid, gates passed");
  });

  it("labels a valid attempt with violations, counting them", () => {
    expect(attemptState(envelope({ valid: 1, violations: '["a","b"]' }))).toBe("valid, gate violations (2)");
  });
});

describe("attemptLabel", () => {
  it("renders a single-visit attempt label", () => {
    expect(attemptLabel(envelope({ visit: 1, attempt: 0 }), 3, false)).toBe("1 of 3");
  });

  it("prefixes the visit when the phase was revisited", () => {
    expect(attemptLabel(envelope({ visit: 2, attempt: 0 }), 4, true)).toBe("v2 #1 of 4");
  });
});

describe("acceptedArtifacts", () => {
  it("returns the accepted envelope's claimed artifacts", () => {
    const accepted = envelope({
      valid: 1,
      violations: "[]",
      json: JSON.stringify({ artifacts: ["out.md", "report.txt"] }),
    });
    expect(acceptedArtifacts([accepted])).toEqual(["out.md", "report.txt"]);
  });

  it("returns [] when no envelope is accepted", () => {
    expect(acceptedArtifacts([envelope({ valid: 0 })])).toEqual([]);
  });

  it("returns [] when the accepted envelope lists no artifacts", () => {
    expect(acceptedArtifacts([envelope({ valid: 1, json: "{}" })])).toEqual([]);
  });
});

describe("artifactPresent", () => {
  it("reports presence in the outputs/ listing", () => {
    expect(artifactPresent("out.md", ["out.md", "x.txt"])).toBe(true);
    expect(artifactPresent("missing.md", ["out.md"])).toBe(false);
  });
});

describe("contextKindLabel", () => {
  it("labels the two context-entry kinds", () => {
    expect(contextKindLabel("inlined-file")).toBe("inlined file");
    expect(contextKindLabel("literal")).toBe("literal string");
  });
});

describe("renderEnvelopeContract", () => {
  it("renders a pre-rendered schema string verbatim", () => {
    const schema = "{\n  summary: string — what you did\n}";
    expect(renderEnvelopeContract(schema)).toBe(schema);
  });

  it("coerces a non-string defensively with String()", () => {
    expect(renderEnvelopeContract(42)).toBe("42");
  });

  it("falls back for absent or empty contracts", () => {
    expect(renderEnvelopeContract(null)).toBe("(no envelope contract recorded)");
    expect(renderEnvelopeContract(undefined)).toBe("(no envelope contract recorded)");
    expect(renderEnvelopeContract("")).toBe("(no envelope contract recorded)");
  });
});
