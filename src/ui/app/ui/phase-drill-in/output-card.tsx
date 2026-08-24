import { css } from "remix/ui";
import type { Handle } from "remix/ui";

import type { RawTail } from "../../../../daemon/contract.ts";
import { Card, Pre } from "./card.tsx";

/**
 * OUTPUT card — the raw_output.jsonl tail from the daemon's
 * `?lines=` endpoint: the record of truth, rendered verbatim in
 * a scrollable mono block — the drill-in's "TUI-like" view. `truncated` /
 * `line_count` come from the endpoint's tail semantics.
 */

export interface OutputCardProps {
  raw: RawTail;
}

export function OutputCard(handle: Handle<OutputCardProps>) {
  return () => {
    const { raw } = handle.props;
    return (
      <Card
        title="OUTPUT"
        summary={
          raw.line_count === 0
            ? "raw_output.jsonl (empty)"
            : `raw_output.jsonl tail · ${raw.line_count} line${raw.line_count === 1 ? "" : "s"}` +
              (raw.truncated ? ` · earlier lines omitted` : "")
        }
      >
        <div mix={scrollWrapStyle}>
          <Pre>{raw.raw === "" ? "(no raw output)" : raw.raw}</Pre>
        </div>
      </Card>
    );
  };
}

const scrollWrapStyle = css({
  maxHeight: "24rem",
  overflowY: "auto",
});
