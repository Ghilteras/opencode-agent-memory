import { afterEach, describe, expect, test } from "bun:test";
import { requestRerank, type RerankFailureReason } from "./rerank-transport";
import type { RerankCandidate } from "./rerank";

const candidates: RerankCandidate[] = [{ label: "C01", title: "t", excerpt: "e" }];
const body = { model: "m", messages: [], temperature: 0, max_completion_tokens: 256, stream: false };
const valid = () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: '["C01"]' } }] }), { status: 200 });
const call = (fetchImpl: typeof fetch, extra: Partial<Parameters<typeof requestRerank>[0]> = {}) => requestRerank({
  baseURL: "https://provider.example/v1", apiKey: "secret", body, candidates, count: 1, fetchImpl, ...extra,
});

describe("rerank transport", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("returns labels with exactly one injected POST and never uses global fetch", async () => {
    globalThis.fetch = (() => { throw new Error("global fetch must not run"); }) as unknown as typeof fetch;
    let calls = 0;
    const outcome = await call((async (_input: Request | URL | string, init?: RequestInit) => {
      calls++;
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      return valid();
    }) as unknown as typeof fetch);
    expect(outcome).toEqual({ ok: true, labels: ["C01"] });
    expect(calls).toBe(1);
  });

  test("maps credential, fetch, HTTP, malformed envelope, malformed labels, and abort failures", async () => {
    const cases: Array<[string, () => Promise<unknown>, RerankFailureReason]> = [
      ["empty credential", () => call((async () => valid()) as unknown as typeof fetch, { apiKey: "" }), "missing_credential"],
      ["invalid config", () => call((async () => valid()) as unknown as typeof fetch, { baseURL: "http://localhost" }), "invalid_config"],
      ["fetch throw", () => call((async () => { throw new Error("private provider detail"); }) as unknown as typeof fetch), "transport_error"],
      ["429", () => call((async () => new Response("no", { status: 429 })) as unknown as typeof fetch), "http_error"],
      ["bad JSON", () => call((async () => new Response("not json")) as unknown as typeof fetch), "malformed_body"],
      ["invalid labels", () => call((async () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: '["C02"]' } }] }))) as unknown as typeof fetch), "malformed_labels"],
      ["refusal", () => call((async () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: '["C01"]', refusal: "no" } }] }))) as unknown as typeof fetch), "malformed_body"],
      ["tool calls", () => call((async () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: '["C01"]', tool_calls: [{}] } }] }))) as unknown as typeof fetch), "malformed_body"],
      ["length", () => call((async () => new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "[]" } }] }))) as unknown as typeof fetch), "budget_exceeded"],
    ];
    for (const [name, invoke, expected] of cases) {
      const result = await invoke() as { ok: boolean; reason?: string };
      expect(result, name).toEqual({ ok: false, reason: expected });
    }
    const controller = new AbortController();
    controller.abort();
    expect(await call((async () => valid()) as unknown as typeof fetch, { signal: controller.signal })).toEqual({ ok: false, reason: "aborted" });
  });

  test("times out and aborts a never-resolving request", async () => {
    let receivedSignal: AbortSignal | undefined;
    const result = await call(((_input: Request | URL | string, init?: RequestInit) => {
      receivedSignal = init?.signal as AbortSignal;
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch, { timeoutMs: 10 });
    expect(result).toEqual({ ok: false, reason: "timeout" });
    expect(receivedSignal?.aborted).toBe(true);
  });

  test("rejects oversized response while streaming without Content-Length", async () => {
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(40000));
        controller.enqueue(new Uint8Array(30000));
      },
    });
    const result = await call((async () => { sent = true; return new Response(stream); }) as unknown as typeof fetch);
    expect(sent).toBe(true);
    expect(result).toEqual({ ok: false, reason: "budget_exceeded" });
  });

  test("returns promptly when cancellation of an oversized response never settles", async () => {
    let cancelCalls = 0;
    const reader = {
      reads: 0,
      async read() {
        this.reads++;
        return this.reads === 1
          ? { done: false, value: new Uint8Array(40000) }
          : { done: false, value: new Uint8Array(30000) };
      },
      cancel() {
        cancelCalls++;
        return new Promise<void>(() => {});
      },
    };
    const response = { ok: true, body: { getReader: () => reader } } as unknown as Response;
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("requestRerank did not complete within 2 seconds")), 2000);
    });
    const result = await Promise.race([call((async () => response) as unknown as typeof fetch), timeout]);
    expect(result).toEqual({ ok: false, reason: "budget_exceeded" });
    expect(cancelCalls).toBe(1);
  });

  test("swallows rejecting cancellation without an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      let reads = 0;
      const reader = {
        async read() {
          reads++;
          return reads === 1
            ? { done: false, value: new Uint8Array(40000) }
            : { done: false, value: new Uint8Array(30000) };
        },
        cancel() { return Promise.reject(new Error("boom")); },
      };
      const response = { ok: true, body: { getReader: () => reader } } as unknown as Response;
      const result = await call((async () => response) as unknown as typeof fetch);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(result).toEqual({ ok: false, reason: "budget_exceeded" });
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("returns promptly on HTTP errors when body cancellation never settles", async () => {
    let cancelCalls = 0;
    const response = {
      ok: false,
      body: {
        getReader() {
          return {
            cancel() {
              cancelCalls++;
              return new Promise<void>(() => {});
            },
          };
        },
      },
    } as unknown as Response;
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("HTTP error handling did not complete within 2 seconds")), 2000);
    });
    const result = await Promise.race([call((async () => response) as unknown as typeof fetch), timeout]);
    expect(result).toEqual({ ok: false, reason: "http_error" });
    expect(cancelCalls).toBe(1);
  });

  test("rejects oversized request without sending and rejects redirects", async () => {
    let calls = 0;
    const oversized = await call((async () => { calls++; return valid(); }) as unknown as typeof fetch, { body: "x".repeat(65537) });
    expect(oversized).toEqual({ ok: false, reason: "budget_exceeded" });
    expect(calls).toBe(0);
    const redirect = await call((async (_input: Request | URL | string, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      throw new TypeError("redirect rejected");
    }) as unknown as typeof fetch);
    expect(redirect).toEqual({ ok: false, reason: "transport_error" });
  });
});
