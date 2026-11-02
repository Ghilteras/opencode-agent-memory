import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { JournalEntry, JournalStore } from "./journal";
import { JournalSearch } from "./tools";
import type { RerankCandidate } from "./rerank";
import { loadRerankConfig, type RerankConfigLoad } from "./rerank-config";
import { requestRerank, type RerankOutcome } from "./rerank-transport";

const now = new Date("2026-01-01T00:00:00.000Z");
function makeEntry(index: number, project = "/p", tags = ["include"]): JournalEntry {
  return { id: `entry-${index}`, title: `Title ${index}`, project, model: "m", provider: "p", agent: "a", sessionId: "s", created: new Date(now.getTime() + index), tags, body: `Body ${index} query`, filePath: `/tmp/${index}.md` };
}
function makeStore(count: number): JournalStore {
  const all = Array.from({ length: count }, (_, i) => makeEntry(i));
  return {
    write: async () => all[0]!,
    read: async () => all[0]!,
    search: async (query) => {
      const filtered = all.filter((entry) => (!query.project || entry.project === query.project) && (!query.tags?.length || query.tags.every((tag) => entry.tags.includes(tag))));
      const limit = Math.min(50, Math.max(1, Math.trunc(query.limit ?? 20)));
      const offset = Math.max(0, Math.trunc(query.offset ?? 0));
      return { entries: filtered.slice(offset, offset + limit), total: filtered.length, allTags: ["include"] };
    },
  };
}
const enabled = async () => ({ status: "enabled" as const, config: { baseURL: "https://rerank.example/v1", model: "test" } });
const disabled = async () => ({ status: "disabled" as const });
const success = (labels: string[], seen?: RerankCandidate[]) => async (args: Parameters<typeof import("./rerank-transport").requestRerank>[0]): Promise<RerankOutcome> => {
  if (seen) seen.push(...args.candidates);
  return { ok: true, labels };
};
const run = (store: JournalStore, loadConfig: () => Promise<RerankConfigLoad>, request?: typeof requestRerank, env?: (name: string) => string | undefined, input: Record<string, unknown> = {}, signal?: AbortSignal) => JournalSearch(store, { loadConfig, request, env }).execute(input, { agent: "a", sessionID: "s", signal });

function resultIds(content: string): string[] {
  return [...content.matchAll(/\b(entry-\d+)\b/g)].map((match) => match[1]!);
}

function resultTotal(content: string): number {
  const match = content.match(/Found (\d+) candidate entries/);
  if (!match) throw new Error(`Missing result total in content: ${content}`);
  return Number(match[1]);
}

const noQueryCases = ([undefined, "", "   "] as const).flatMap((text) =>
  [0, 5, 45, 49, 50, 60].flatMap((offset) =>
    [1, 5, 20, 50].map((limit) => ({ text, offset, limit })),
  ),
);

describe("journal_search rerank integration", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });
  const trapFetch = () => {
    let calls = 0;
    globalThis.fetch = (() => { calls++; throw new Error("unexpected network"); }) as unknown as typeof fetch;
    return () => expect(calls).toBe(0);
  };

  test("disabled configuration preserves the baseline result and has no ranking key", async () => {
    const checkFetch = trapFetch();
    const store = makeStore(5);
    const baseline = { content: `Found 5 candidate entries (showing 1–3):\nTags in use: include\n\nentry-0\n  Title 0 [include]\n  ${new Date(now.getTime()).toISOString()}\n\nentry-1\n  Title 1 [include]\n  ${new Date(now.getTime() + 1).toISOString()}\n\nentry-2\n  Title 2 [include]\n  ${new Date(now.getTime() + 2).toISOString()}` };
    const actual = await run(store, disabled, undefined, undefined, { limit: 3 });
    expect(actual).toEqual(baseline);
    expect(Object.keys(actual)).toEqual(["content"]);
    checkFetch();
  });

  test("success fuses order without changing total or candidate membership", async () => {
    const checkFetch = trapFetch();
    const store = makeStore(50);
    const response = await run(store, enabled, success(["C50", "C49", "C48", "C47", "C46", "C45", "C44", "C43", "C42", "C41"]), () => "key", { text: "query", limit: 50 });
    expect(response.metadata?.ranking).toEqual({ method: "bm25+llm-rrf", status: "applied", candidateCount: 50, labelCount: 10, k: 10 });
    expect(response.content).toContain("Found 50 candidate entries");
    expect(resultIds(response.content)).toEqual([
      "entry-49", "entry-48", "entry-47", "entry-0", "entry-46", "entry-45", "entry-1", "entry-44", "entry-43", "entry-2",
      "entry-42", "entry-41", "entry-3", "entry-40", ...Array.from({ length: 36 }, (_, i) => `entry-${i + 4}`),
    ]);
    checkFetch();
  });

  test("ranking diagnostics use metadata for every outcome", async () => {
    const checkShape = (response: Awaited<ReturnType<typeof run>>, expected: NonNullable<Awaited<ReturnType<typeof run>>["metadata"]>["ranking"]) => {
      expect(Object.hasOwn(response, "ranking")).toBe(false);
      expect(response.metadata?.ranking).toEqual(expected);
    };
    const applied = await run(makeStore(4), enabled, success(["C04"]), () => "key", { text: "query" });
    checkShape(applied, { method: "bm25+llm-rrf", status: "applied", candidateCount: 4, labelCount: 1, k: 10 });

    const fallback = await run(makeStore(4), enabled, async () => ({ ok: false, reason: "timeout" }), () => "key", { text: "query" });
    checkShape(fallback, { method: "bm25", status: "fallback", reason: "timeout" });

    const noQuery = await run(makeStore(4), enabled, undefined, undefined, {});
    checkShape(noQuery, { method: "bm25", status: "skipped", reason: "no_query" });

    const outsideWindow = await run(makeStore(60), enabled, success(["C50"]), () => "key", { text: "query", offset: 50, limit: 1 });
    checkShape(outsideWindow, { method: "bm25", status: "skipped", reason: "outside_window" });

    const insufficient = await run(makeStore(1), enabled, success([]), () => "key", { text: "query" });
    checkShape(insufficient, { method: "bm25", status: "skipped", reason: "insufficient_candidates" });

    const disabledResult = await run(makeStore(4), disabled, undefined, undefined, { text: "query" });
    expect(Object.hasOwn(disabledResult, "ranking")).toBe(false);
    expect(Object.hasOwn(disabledResult, "metadata")).toBe(false);
  });

  test("invalid configuration preserves BM25 results and reports fallback", async () => {
    const checkFetch = trapFetch();
    const store = makeStore(6);
    const input = { text: "query", limit: 5 };
    const baseline = await run(store, disabled, undefined, undefined, input);
    const injected = await run(store, async () => ({ status: "invalid", reason: "fixture invalid" }), undefined, undefined, input);
    expect(injected.metadata?.ranking).toEqual({ method: "bm25", status: "fallback", reason: "invalid_config" });
    expect(resultIds(injected.content)).toEqual(resultIds(baseline.content));
    expect(injected.content).toBe(baseline.content);
    expect(injected.content).toContain("Found 6 candidate entries");

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rerank-invalid-config-"));
    try {
      await fs.writeFile(path.join(dir, "agent-memory-rerank.json"), "{ malformed", "utf8");
      const actualLoader = await loadRerankConfig(dir);
      expect(actualLoader.status).toBe("invalid");
      const actual = await run(store, () => loadRerankConfig(dir), undefined, undefined, input);
      expect(actual.metadata?.ranking).toEqual({ method: "bm25", status: "fallback", reason: "invalid_config" });
      expect(actual.content).toBe(baseline.content);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
    checkFetch();
  });

  test("rerank pagination preserves BM25 result counts across the requested matrix", async () => {
    const offsets = [0, 5, 45, 49, 50, 60];
    const limits = [0, 1, 5, 20, 50, 51, 100];
    const corpora = [0, 1, 6, 20, 50, 51, 100];
    const labels = Array.from({ length: 50 }, (_, i) => `C${String(50 - i).padStart(2, "0")}`);
    const mismatches: string[] = [];
    let sawApplied = false;
    for (const corpus of corpora) {
      for (const offset of offsets) {
        for (const limit of limits) {
          const input = { text: "query", offset, limit };
          const baseline = await run(makeStore(corpus), disabled, undefined, undefined, input);
          const reranked = await run(makeStore(corpus), enabled, success(labels), () => "key", input);
          const baselineCount = resultIds(baseline.content).length;
          const rerankedCount = resultIds(reranked.content).length;
          sawApplied ||= reranked.metadata?.ranking.status === "applied";
          if (baselineCount !== rerankedCount) mismatches.push(`corpus=${corpus} offset=${offset} limit=${limit}: BM25=${baselineCount}, rerank=${rerankedCount}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
    expect(sawApplied).toBe(true);
  });

  test("forwards caller cancellation and returns aborted fallback", async () => {
    const store = makeStore(6);
    const controller = new AbortController();
    controller.abort();
    let fetchCalls = 0;
    globalThis.fetch = (() => { fetchCalls++; throw new Error("must not fetch"); }) as unknown as typeof fetch;
    const preAborted = await run(store, enabled, requestRerank, () => "key", { text: "query", limit: 5 }, controller.signal);
    expect(preAborted.metadata?.ranking).toEqual({ method: "bm25", status: "fallback", reason: "aborted" });
    expect(fetchCalls).toBe(0);

    const duringRead = new AbortController();
    let bodyChunkDelivered = false;
    globalThis.fetch = (async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode('{"choices":')); },
        pull() {
          if (!bodyChunkDelivered) {
            bodyChunkDelivered = true;
            duringRead.abort();
          }
        },
      });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;
    const aborted = await run(store, enabled, requestRerank, () => "key", { text: "query", limit: 5 }, duringRead.signal);
    expect(bodyChunkDelivered).toBe(true);
    expect(aborted.metadata?.ranking).toEqual({ method: "bm25", status: "fallback", reason: "aborted" });
  });

  test("uses one search snapshot for eligible pages and never splices outside-window results", async () => {
    const sequence = (results: Array<Awaited<ReturnType<JournalStore["search"]>>>) => {
      let calls = 0;
      const base = makeStore(7);
      const store: JournalStore = { ...base, search: async () => results[calls++]! };
      return { store, count: () => calls };
    };
    const first = makeStore(6);
    const firstResult = await first.search({ text: "query", limit: 50, offset: 0 });
    const secondResult = await makeStore(7).search({ text: "query", limit: 50, offset: 0 });
    const eligible = sequence([firstResult, secondResult]);
    const eligibleResponse = await run(eligible.store, enabled, success(["C06"]), () => "key", { text: "query", limit: 2 });
    expect(eligible.count()).toBe(1);
    expect(eligibleResponse.content).toContain("Found 6 candidate entries");
    expect(resultIds(eligibleResponse.content)).toEqual(["entry-5", "entry-0"]);

    const firstWindow = { ...firstResult, total: 7 };
    const outside = sequence([firstWindow, secondResult]);
    const outsideResponse = await run(outside.store, enabled, success(["C06"]), () => "key", { text: "query", offset: 5, limit: 2 });
    expect(outside.count()).toBe(2);
    expect(outsideResponse.metadata?.ranking).toEqual({ method: "bm25", status: "skipped", reason: "outside_window" });
    expect(outsideResponse.content).toContain("Found 7 candidate entries");
    expect(resultIds(outsideResponse.content)).toEqual(["entry-0", "entry-1", "entry-2", "entry-3", "entry-4", "entry-5", "entry-6"]);
  });

  test("a page that crosses the candidate window keeps the complete BM25 page", async () => {
    const checkFetch = trapFetch();
    const store = makeStore(100);
    const input = { text: "query", offset: 45, limit: 20 };
    const baseline = await run(store, disabled, undefined, undefined, input);
    const response = await run(store, enabled, success(["C50"]), () => "key", input);
    expect(response.metadata?.ranking).toEqual({ method: "bm25", status: "skipped", reason: "outside_window" });
    expect(response.content).toBe(baseline.content);
    expect((response.content.match(/entry-/g) ?? []).length).toBe(20);
    checkFetch();
  });

  test("only pages entirely within the candidate window rerank", async () => {
    const checkFetch = trapFetch();
    const labels = Array.from({ length: 50 }, (_, i) => `C${String(50 - i).padStart(2, "0")}`);
    const exact = await run(makeStore(100), enabled, success(labels), () => "key", { text: "query", offset: 0, limit: 50 });
    expect(exact.metadata?.ranking.status).toBe("applied");

    const over = await run(makeStore(100), enabled, success(labels), () => "key", { text: "query", offset: 0, limit: 51 });
    expect(over.metadata?.ranking.status).toBe("applied");
    expect((over.content.match(/entry-/g) ?? []).length).toBe(50);
    checkFetch();
  });

  test("missing, empty, or whitespace-only text skips reranking without calling the provider", async () => {
    const checkFetch = trapFetch();
    const store = makeStore(8);
    let calls = 0;
    const request = async (): Promise<RerankOutcome> => {
      calls++;
      return { ok: true, labels: ["C08"] };
    };

    for (const input of [{}, { text: "" }, { text: " \t\n " }]) {
      const baseline = await run(store, disabled, undefined, undefined, input);
      const response = await run(store, enabled, request, () => "key", input);
      expect(response.metadata?.ranking).toEqual({ method: "bm25", status: "skipped", reason: "no_query" });
      expect(response.content).toBe(baseline.content);
    }
    expect(calls).toBe(0);
    checkFetch();
  });

  test.each(noQueryCases)("no-query pagination matches BM25 for text=$text offset=$offset limit=$limit", async ({ text, offset, limit }) => {
    const store = makeStore(100);
    let calls = 0;
    const request = async (): Promise<RerankOutcome> => {
      calls++;
      return { ok: true, labels: ["C100"] };
    };
    const input = { text, offset, limit };
    const baseline = await run(store, disabled, undefined, undefined, input);
    const response = await run(store, enabled, request, () => "key", input);

    expect(resultIds(response.content)).toEqual(resultIds(baseline.content));
    expect(resultTotal(response.content)).toBe(resultTotal(baseline.content));
    expect(response.metadata?.ranking).toMatchObject({ reason: "no_query" });
    expect(calls).toBe(0);
  });

  test("text query positive control still reranks over a 100-entry corpus", async () => {
    let calls = 0;
    const request = async (): Promise<RerankOutcome> => {
      calls++;
      return { ok: true, labels: ["C100"] };
    };
    const response = await run(makeStore(100), enabled, request, () => "key", { text: "query", offset: 0, limit: 5 });
    expect(response.metadata?.ranking.status).toBe("applied");
    expect(calls).toBe(1);
  });

  test("a text-bearing search still reranks", async () => {
    const checkFetch = trapFetch();
    let calls = 0;
    const request = async (): Promise<RerankOutcome> => {
      calls++;
      return { ok: true, labels: ["C08"] };
    };
    const response = await run(makeStore(8), enabled, request, () => "key", { text: "query", limit: 8 });
    expect(response.metadata?.ranking.status).toBe("applied");
    expect(calls).toBe(1);
    checkFetch();
  });

  test.each(["timeout", "malformed_labels", "missing_credential"] as const)("%s failure restores BM25 order", async (reason) => {
    const checkFetch = trapFetch();
    const request = async (): Promise<RerankOutcome> => ({ ok: false, reason });
    const response = await run(makeStore(6), enabled, request, () => "key", { text: "query", limit: 6 });
    expect(response.metadata?.ranking).toEqual({ method: "bm25", status: "fallback", reason });
    expect(response.content.indexOf("entry-0")).toBeLessThan(response.content.indexOf("entry-5"));
    checkFetch();
  });

  test("pagination slices fused candidates and skips beyond the window", async () => {
    const checkFetch = trapFetch();
    const store = makeStore(60);
    const labels = Array.from({ length: 50 }, (_, i) => `C${String(50 - i).padStart(2, "0")}`);
    const page = await run(store, enabled, success(labels), () => "key", { text: "query", offset: 5, limit: 5 });
    expect(page.metadata?.ranking.status).toBe("applied");
    expect((page.content.match(/entry-/g) ?? []).length).toBe(5);
    expect(resultIds(page.content)).toEqual(["entry-47", "entry-3", "entry-46", "entry-4", "entry-45"]);
    const out = await run(store, enabled, success(labels), () => "key", { text: "query", offset: 60, limit: 5 });
    expect(out.metadata?.ranking).toEqual({ method: "bm25", status: "skipped", reason: "outside_window" });
    expect(out.content).toBe("No journal entries found.\nTags in use: include");
    expect(out.content).not.toContain("Found 60");
    checkFetch();
  });

  test("0 and 1 candidates skip; 51 candidates rerank exactly the 50-entry window", async () => {
    const checkFetch = trapFetch();
    for (const count of [0, 1]) {
      const response = await run(makeStore(count), enabled, success([]), () => "key", { text: "query" });
      expect(response.metadata?.ranking).toEqual({ method: "bm25", status: "skipped", reason: "insufficient_candidates" });
    }
    let received: RerankCandidate[] = [];
    const response = await run(makeStore(51), enabled, success(Array.from({ length: 10 }, (_, i) => `C${String(10 - i).padStart(2, "0")}`), received), () => "key", { text: "query", limit: 50 });
    expect(response.metadata?.ranking).toMatchObject({ status: "applied", candidateCount: 50 });
    expect(received).toHaveLength(50);
    checkFetch();
  });

  test("filters apply before candidate-window construction", async () => {
    const checkFetch = trapFetch();
    const base = makeStore(4);
    const search = base.search;
    const store: JournalStore = { ...base, search: async (query) => {
      const result = await search(query);
      const entries = result.entries.map((entry, index) => index === 0 ? { ...entry, project: "/excluded" } : entry);
      const selected = query.project ? entries.filter((entry) => entry.project === query.project) : entries;
      return { ...result, entries: selected, total: selected.length };
    } };
    let received: RerankCandidate[] = [];
    const response = await run(store, enabled, success(["C03", "C02", "C01"], received), () => "key", { text: "query", project: "/p", limit: 5 });
    expect(response.metadata?.ranking.status).toBe("applied");
    expect(received.map((candidate) => candidate.title)).toEqual(["Title 1", "Title 2", "Title 3"]);
    expect(received.map((candidate) => candidate.title)).not.toContain("Title 0");
    checkFetch();
  });

  test("same labels produce deterministic output across calls", async () => {
    const checkFetch = trapFetch();
    const store = makeStore(8);
    const request = success(["C08", "C07", "C06", "C05", "C04", "C03", "C02", "C01"]);
    const first = await run(store, enabled, request, () => "key", { text: "query", limit: 8 });
    const second = await run(store, enabled, request, () => "key", { text: "query", limit: 8 });
    expect(second).toEqual(first);
    checkFetch();
  });
});
