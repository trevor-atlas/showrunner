/**
 * The RPC wire contract (Appendix A — verified against pi 0.84.2).
 *
 * Commands are JSON objects written to the child's stdin, one per line
 * (LF-only framing). Responses echo the request `id`:
 *
 *   {"id":<req>,"type":"response","command":…,"success":true|false}
 *
 * failures carry `error`. Agent events stream on stdout between responses;
 * `agent_settled` is the authoritative idle signal.
 */

export interface RpcCommand {
  type: string;
  [k: string]: unknown;
}

export interface RpcResponse {
  /** the request id echoed by pi (absent on spontaneous responses) */
  id?: string | number | null;
  command?: string;
  success: boolean;
  data?: unknown;
  error?: string;
}
