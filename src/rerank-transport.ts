import { parseLabels, type RerankCandidate } from "./rerank";

export type RerankFailureReason =
  | "invalid_config" | "missing_credential" | "timeout" | "transport_error"
  | "http_error" | "malformed_body" | "malformed_labels" | "budget_exceeded" | "aborted";

export type RerankOutcome =
  | { ok: true; labels: string[] }
  | { ok: false; reason: RerankFailureReason };

const MAX_BYTES = 65536;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("request aborted"));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export async function requestRerank(args: {
  baseURL: string;
  apiKey: string;
  body: unknown;
  candidates: RerankCandidate[];
  count: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<RerankOutcome> {
  if (typeof args.apiKey !== "string" || args.apiKey.length === 0) return { ok: false, reason: "missing_credential" };
  try {
    const url = new URL(args.baseURL);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      return { ok: false, reason: "invalid_config" };
    }
  } catch {
    return { ok: false, reason: "invalid_config" };
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(args.body);
  } catch {
    return { ok: false, reason: "malformed_body" };
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_BYTES) return { ok: false, reason: "budget_exceeded" };
  const fetchImpl = args.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeoutMs = Math.min(args.timeoutMs ?? 5000, 5000);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const signal = args.signal ? AbortSignal.any([controller.signal, args.signal]) : controller.signal;

  try {
    if (args.signal?.aborted) return { ok: false, reason: "aborted" };
    let response: Response;
    try {
      response = await raceAbort(fetchImpl(`${args.baseURL}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${args.apiKey}`, "Content-Type": "application/json" },
        body: serialized,
        redirect: "error",
        signal,
      }), signal);
    } catch {
      if (timedOut) return { ok: false, reason: "timeout" };
      if (args.signal?.aborted) return { ok: false, reason: "aborted" };
      return { ok: false, reason: "transport_error" };
    }
    if (!response.ok) return { ok: false, reason: "http_error" };

    if (!response.body) return { ok: false, reason: "malformed_body" };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await raceAbort(reader.read(), signal);
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BYTES) {
          await reader.cancel().catch(() => {});
          return { ok: false, reason: "budget_exceeded" };
        }
        chunks.push(value);
      }
    } catch {
      if (timedOut) return { ok: false, reason: "timeout" };
      if (args.signal?.aborted) return { ok: false, reason: "aborted" };
      return { ok: false, reason: "transport_error" };
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let envelope: unknown;
    try {
      envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return { ok: false, reason: "malformed_body" };
    }
    if (!isRecord(envelope) || !Array.isArray(envelope.choices) || envelope.choices.length !== 1) {
      return { ok: false, reason: "malformed_body" };
    }
    const choice = envelope.choices[0];
    if (!isRecord(choice)) return { ok: false, reason: "malformed_body" };
    if (choice.finish_reason === "length") return { ok: false, reason: "budget_exceeded" };
    if (choice.finish_reason !== "stop" || !isRecord(choice.message) || typeof choice.message.content !== "string") {
      return { ok: false, reason: "malformed_body" };
    }
    if ((choice.message.tool_calls !== undefined && choice.message.tool_calls !== null &&
      (!Array.isArray(choice.message.tool_calls) || choice.message.tool_calls.length > 0)) || choice.message.refusal) {
      return { ok: false, reason: "malformed_body" };
    }
    const labels = parseLabels(choice.message.content, args.candidates, args.count);
    return labels ? { ok: true, labels } : { ok: false, reason: "malformed_labels" };
  } finally {
    clearTimeout(timer);
  }
}
