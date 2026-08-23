import { request } from "node:http";
import type { IncomingMessage } from "node:http";

/**
 * A minimal JSON client for the daemon's HTTP API over its unix socket
 * (spec §13 client note: node:http with socketPath). The CLI talks only to
 * this API; it never touches the DB directly.
 */

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export const REQUEST_TIMEOUT_MS = 15_000;

export async function apiRequest(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        method,
        path,
        headers: body === undefined ? {} : { "content-type": "application/json" },
      },
      (res: IncomingMessage) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (data += chunk));
        res.on("end", () => {
          let parsed: unknown = data;
          try {
            parsed = JSON.parse(data);
          } catch {
            // keep the raw text
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

/** GET a JSON endpoint, unwrapping the body; throws ApiError on non-2xx. */
export async function getJson(socketPath: string, path: string): Promise<unknown> {
  const { status, body } = await apiRequest(socketPath, "GET", path);
  if (status < 200 || status >= 300) {
    throw new ApiError(status, errorMessage(body, `${status} ${path}`));
  }
  return body;
}

/** POST a JSON endpoint, unwrapping the body; throws ApiError on non-2xx. */
export async function postJson(socketPath: string, path: string, body: unknown): Promise<unknown> {
  const { status, body: res } = await apiRequest(socketPath, "POST", path, body);
  if (status < 200 || status >= 300) {
    throw new ApiError(status, errorMessage(res, `${status} ${path}`));
  }
  return res;
}

function errorMessage(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null && "error" in body) {
    return String((body as { error: unknown }).error);
  }
  return fallback;
}

export function isSocketDown(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "ENOENT" || code === "ECONNREFUSED" || code === "EADDRNOTAVAIL";
}
