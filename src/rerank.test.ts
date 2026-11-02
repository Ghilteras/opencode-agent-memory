import { describe, expect, test } from "bun:test";
import {
  buildCandidates,
  buildRequestBody,
  fuseRanks,
  parseLabels,
  RERANK_SYSTEM_PROMPT,
  type RerankCandidate,
} from "./rerank";

const candidate = (label: string): RerankCandidate => ({ label, title: label, excerpt: "" });

describe("rerank core", () => {
  test("builds positional labels and truncates title/excerpt by Unicode code points", () => {
    const title = "😀".repeat(200) + "X";
    const candidates = buildCandidates([{ title, body: "b" }, { title: "second", body: "b" }]);
    expect(candidates.map(({ label }) => label)).toEqual(["C01", "C02"]);
    expect(Array.from(candidates[0]!.title)).toHaveLength(200);
    expect(candidates[0]!.title).toBe("😀".repeat(200));
    expect(candidates[0]!.excerpt).toBe("b");
  });

  test("excludes YAML frontmatter from excerpt", () => {
    const [result] = buildCandidates([{ title: "title", body: "---\ntitle: secret\n---\nactual body" }]);
    expect(result!.excerpt).toBe("actual body");
  });

  test("builds the exact request shape and key order", () => {
    const candidates = [candidate("C01")];
    const body = buildRequestBody({ model: "m", query: "q", candidates, count: 1 });
    expect(JSON.stringify(body)).toBe(`{"model":"m","messages":[{"role":"system","content":${JSON.stringify(RERANK_SYSTEM_PROMPT)}},{"role":"user","content":"{\\"query\\":\\"q\\",\\"count\\":1,\\"candidates\\":[{\\"label\\":\\"C01\\",\\"title\\":\\"C01\\",\\"excerpt\\":\\"\\"}]}"}],"temperature":0,"max_completion_tokens":256,"stream":false}`);
    expect(RERANK_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  test("parses only exact distinct supplied label arrays", () => {
    const candidates = [candidate("C01"), candidate("C02")];
    expect(parseLabels('["C02","C01"]', candidates, 2)).toEqual(["C02", "C01"]);
    for (const invalid of [
      '["C01"]', '["C01","C03"]', '["C01","C01"]', '["C01",1]',
      '```json\n["C01","C02"]\n```', 'labels are ["C01","C02"]', "null", "{}",
    ]) expect(parseLabels(invalid, candidates, 2)).toBeNull();
    expect(parseLabels(null, candidates, 2)).toBeNull();
  });

  test("fuses one-based BM25/model ranks with reciprocal-rank arithmetic", () => {
    const order = [candidate("A"), candidate("B"), candidate("C")];
    expect(fuseRanks(order, ["A", "B", "C"], 10)).toEqual(["A", "B", "C"]);
    expect(fuseRanks(order, ["C"], 10)[0]).toBe("C");
    expect(fuseRanks([candidate("A"), candidate("B")], ["B", "A"], 10)).toEqual(["A", "B"]);
    const input = [candidate("B"), candidate("A")];
    expect(fuseRanks(input, null)).toEqual(["B", "A"]);
    expect(fuseRanks(order, ["A", "B", "C"])).toEqual(order.map((item) => item.label));
  });
});
