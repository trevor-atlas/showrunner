/**
 * Unit tests for the raw pi JSONL line classifier (raw-lines.ts) — the single
 * owner of the stream's `type` vocabulary. Type-string
 * classification only: payload validation stays in the tracer handlers.
 */
import { describe, expect, it } from "bun:test";

import { classifyLine, isSettledLine, SETTLED_KIND } from "../../src/server/engine/pi/raw-lines.ts";
import type { RawLineKind } from "../../src/server/engine/pi/raw-lines.ts";

describe("isSettledLine", () => {
  it("recognizes the minimal settle line", () => {
    expect(isSettledLine('{"type": "agent_settled"}')).toBe(true);
  });

  it("recognizes the real settle shape", () => {
    expect(isSettledLine('{"type":"agent_settled","sessionId":"x","messageCount":4}')).toBe(true);
  });

  it("never settles on agent_end, with or without willRetry", () => {
    expect(isSettledLine('{"type": "agent_end", "willRetry": false}')).toBe(false);
    expect(isSettledLine('{"type": "agent_end", "willRetry": true}')).toBe(false);
    expect(isSettledLine('{"type": "agent_end"}')).toBe(false);
  });

  it("returns false for junk input", () => {
    expect(isSettledLine("not json")).toBe(false);
    expect(isSettledLine("42")).toBe(false);
    expect(isSettledLine("null")).toBe(false);
    expect(isSettledLine("[]")).toBe(false);
    expect(isSettledLine("")).toBe(false);
  });
});

describe("classifyLine", () => {
  it("classifies every vocabulary type to its kind with minimal payloads", () => {
    const cases: Array<[string, RawLineKind]> = [
      ['{"type":"agent_start","messageCount":0}', "agent_start"],
      ['{"type":"agent_end","willRetry":false}', "agent_end"],
      ['{"type":"agent_settled"}', "agent_settled"],
      ['{"type":"turn_start"}', "turn_start"],
      ['{"type":"turn_end"}', "turn_end"],
      ['{"type":"message_start","message":{"id":"u1"}}', "message_start"],
      ['{"type":"message_update"}', "message_update"],
      ['{"type":"message_end"}', "message_end"],
      ['{"type":"tool_execution_start","toolCallId":"t1"}', "tool_execution_start"],
      ['{"type":"tool_execution_update","toolCallId":"t1"}', "tool_execution_update"],
      ['{"type":"tool_execution_end","toolCallId":"t1"}', "tool_execution_end"],
      ['{"type":"response","id":1}', "response"],
    ];
    for (const [line, kind] of cases) {
      const c = classifyLine(line);
      expect(c.kind, line).toBe(kind);
      expect(c.evt, line).toBeDefined();
    }
  });

  it("classifies delta-only update payloads (no partialResult) by type string", () => {
    expect(classifyLine('{"type":"tool_execution_update","toolCallId":"t1"}').kind).toBe(
      "tool_execution_update",
    );
    expect(classifyLine('{"type":"message_update"}').kind).toBe("message_update");
  });

  it("classifies a machinery type as machinery", () => {
    expect(classifyLine('{"type":"auto_retry","attempt":2}').kind).toBe("machinery");
    expect(classifyLine('{"type":"queue_update","queued":0}').kind).toBe("machinery");
  });

  it("classifies an unknown type as unknown", () => {
    expect(classifyLine('{"type":"made_up_event"}').kind).toBe("unknown");
  });

  it("returns unknown without throwing on junk", () => {
    for (const line of ["not json", "42", "null", "[]", "", "undefined", '{"type":42}']) {
      expect(classifyLine(line).kind, line).toBe("unknown");
    }
  });

  it("carries the parsed event object for recognized lines", () => {
    const c = classifyLine('{"type":"agent_settled","sessionId":"x","messageCount":4}');
    expect(c.evt).toEqual({ type: "agent_settled", sessionId: "x", messageCount: 4 });
  });

  it("exposes SETTLED_KIND as the settle kind constant", () => {
    expect(SETTLED_KIND).toBe("agent_settled");
    expect(classifyLine('{"type":"agent_settled"}').kind === SETTLED_KIND).toBe(true);
  });
});
