import { afterEach, describe, expect, test } from "bun:test";
import type { JournalEntry, JournalStore } from "./journal";
import { JournalSearch } from "./tools";
import type { RerankCandidate } from "./rerank";
import type { RerankOutcome } from "./rerank-transport";

const now = new Date("2026-01-01T00:00:00.000Z");
function makeEntry(index: number, project = "/p", tags = ["include"]): JournalEntry {
  return { id: `entry-${index}`, title: `Title ${index}`, project, model: "m", provider: "p", agent: "a", sessionId: "s", created: new Date(now.getTime() + index), tags, body: `Body ${index}`, filePath: `/tmp/${index}.md` };
}
function makeStore(count: number): JournalStore {
  const all = Array.from({ length: count }, (_, i) => makeEntry(i));
  return {
    write: async () => all[0]!,
    read: async () => all[0]!,
    search: async (query) => {
      const filtered = all.filter((entry) => (!query.project || entry.project === query.project) && (!query.tags?.length || query.tags.every((tag) => entry.tags.includes(tag))));
      const limit = Math.min(Math.max(query.limit ?? 20, 1), 50);
      const offset = Math.max(query.offset ?? 0, 0);
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
const run = (store: JournalStore, loadConfig: typeof enabled | typeof disabled, request?: typeof success extends (...args: any[]) => infer R ? R : never, env?: (name: string) => string | undefined, input: Record<string, unknown> = {}) => JournalSearch(store, { loadConfig, request, env }).execute(input, {} as any);

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
    expect(response.ranking).toEqual({ method: "bm25+llm-rrf", status: "applied", candidateCount: 50, labelCount: 10, k: 10 });
    expect(response.content).toContain("Found 50 candidate entries");
    expect(response.content.indexOf("entry-49")).toBeLessThan(response.content.indexOf("entry-0"));
    expect((response.content.match(/entry-/g) ?? []).length).toBe(50);
    checkFetch();
  });

  test("a page that crosses the candidate window keeps the complete BM25 page", async () => {
    const checkFetch = trapFetch();
    const store = makeStore(100);
    const input = { text: "query", offset: 45, limit: 20 };
    const baseline = await run(store, disabled, undefined, undefined, input);
    const response = await run(store, enabled, success(["C50"]), () => "key", input);
    expect(response.ranking).toEqual({ method: "bm25", status: "skipped", reason: "outside_window" });
    expect(response.content).toBe(baseline.content);
    expect((response.content.match(/entry-/g) ?? []).length).toBe(20);
    checkFetch();
  });

  test("only pages entirely within the candidate window rerank", async () => {
    const checkFetch = trapFetch();
    const labels = Array.from({ length: 50 }, (_, i) => `C${String(50 - i).padStart(2, "0")}`);
    const exact = await run(makeStore(100), enabled, success(labels), () => "key", { text: "query", offset: 0, limit: 50 });
    expect(exact.ranking?.status).toBe("applied");

    const over = await run(makeStore(100), enabled, success(labels), () => "key", { text: "query", offset: 0, limit: 51 });
    expect(over.ranking).toEqual({ method: "bm25", status: "skipped", reason: "outside_window" });
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
      expect(response.ranking).toEqual({ method: "bm25", status: "skipped", reason: "no_query" });
      expect(response.content).toBe(baseline.content);
    }
    expect(calls).toBe(0);
    checkFetch();
  });

  test("a text-bearing search still reranks", async () => {
    const checkFetch = trapFetch();
    let calls = 0;
    const request = async (): Promise<RerankOutcome> => {
      calls++;
      return { ok: true, labels: ["C08"] };
    };
    const response = await run(makeStore(8), enabled, request, () => "key", { text: "query", limit: 8 });
    expect(response.ranking?.status).toBe("applied");
    expect(calls).toBe(1);
    checkFetch();
  });

  test.each(["timeout", "malformed_labels", "missing_credential"] as const)("%s failure restores BM25 order", async (reason) => {
    const checkFetch = trapFetch();
    const request = async (): Promise<RerankOutcome> => ({ ok: false, reason });
    const response = await run(makeStore(6), enabled, request, () => "key", { text: "query", limit: 6 });
    expect(response.ranking).toEqual({ method: "bm25", status: "fallback", reason });
    expect(response.content.indexOf("entry-0")).toBeLessThan(response.content.indexOf("entry-5"));
    checkFetch();
  });

  test("pagination slices fused candidates and skips beyond the window", async () => {
    const checkFetch = trapFetch();
    const store = makeStore(60);
    const labels = Array.from({ length: 50 }, (_, i) => `C${String(50 - i).padStart(2, "0")}`);
    const page = await run(store, enabled, success(labels), () => "key", { text: "query", offset: 5, limit: 5 });
    expect(page.ranking?.status).toBe("applied");
    expect((page.content.match(/entry-/g) ?? []).length).toBe(5);
    const out = await run(store, enabled, success(labels), () => "key", { text: "query", offset: 60, limit: 5 });
    expect(out.ranking).toEqual({ method: "bm25", status: "skipped", reason: "outside_window" });
    expect(out.content).toBe("No journal entries found.\nTags in use: include");
    expect(out.content).not.toContain("Found 60");
    checkFetch();
  });

  test("0 and 1 candidates skip; 51 candidates rerank exactly the 50-entry window", async () => {
    const checkFetch = trapFetch();
    for (const count of [0, 1]) {
      const response = await run(makeStore(count), enabled, success([]), () => "key", { text: "query" });
      expect(response.ranking).toEqual({ method: "bm25", status: "skipped", reason: "insufficient_candidates" });
    }
    let received: RerankCandidate[] = [];
    const response = await run(makeStore(51), enabled, success(Array.from({ length: 10 }, (_, i) => `C${String(10 - i).padStart(2, "0")}`), received), () => "key", { text: "query", limit: 50 });
    expect(response.ranking).toMatchObject({ status: "applied", candidateCount: 50 });
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
    await run(store, enabled, success(["C03", "C02", "C01"], received), () => "key", { text: "query", project: "/p", limit: 10 });
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
