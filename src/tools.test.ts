import { describe, expect, test } from "bun:test";
import { JournalRead, JournalSearch, JournalWrite } from "./tools";
import type { JournalContext } from "./tools";
import type { JournalEntry, JournalStore } from "./journal";

const context: JournalContext = { directory: "/tmp/project", model: "m", provider: "p" };
function entry(): JournalEntry {
  return { id: "20260101-000000-000", title: "Title", project: "/tmp", model: "m", provider: "p", agent: "a", sessionId: "s", created: new Date("2026-01-01T00:00:00.000Z"), tags: ["tag"], body: "Body", filePath: "/tmp/entry.md" };
}
const baseStore: JournalStore = {
  write: async () => entry(),
  read: async () => entry(),
  search: async () => ({ entries: [entry()], total: 1, allTags: ["tag"] }),
};

function valid(schema: any, value: any): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (schema.additionalProperties === false && Object.keys(value).some((key) => !(key in schema.properties))) return false;
  if (schema.required?.some((key: string) => !(key in value))) return false;
  for (const [key, field] of Object.entries<any>(schema.properties)) {
    if (!(key in value)) continue;
    const actual = value[key];
    if (field.type === "string" && typeof actual !== "string") return false;
    if (field.type === "integer" && (!Number.isInteger(actual) || actual < (field.minimum ?? -Infinity))) return false;
  }
  return true;
}

describe("v2 journal tools", () => {
  test("preserves the recognizable names and descriptions", () => {
    expect([JournalWrite(baseStore, context).name, JournalRead(baseStore).name, JournalSearch(baseStore).name]).toEqual(["journal_write", "journal_read", "journal_search"]);
    expect(JournalWrite(baseStore, context).description).toContain("append-only");
    expect(JournalRead(baseStore).description).toContain("by its ID");
    expect(JournalSearch(baseStore).description).toContain("semantic similarity");
  });

  test("journal_write description preserves its behavioral guidance", () => {
    const description = JournalWrite(baseStore, context).description;
    expect(description).toMatch(/insights.*discoveries|discoveries.*decisions/i);
    expect(description).toMatch(/insights.*technical discoveries.*design decisions.*observations/i);
    expect(description).toMatch(/never edit old ones/i);
    expect(description).toMatch(/comma-separated/i);
    expect(description).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(description).not.toContain("Suggested tags:");
    const tagged = JournalWrite(baseStore, context, [{ name: "focus", description: "private detail" }]).description;
    expect(tagged).toContain("Suggested tags: focus.");
    expect(tagged).not.toContain("private detail");
  });

  test("read and search descriptions retain their distinct contracts", () => {
    const read = JournalRead(baseStore).description;
    expect(read).not.toMatch(/append.only|cannot be (edited|modified)/i);
    expect(read).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    const search = JournalSearch(baseStore);
    expect(search.description).toMatch(/filters are optional/i);
    expect(search.description).toMatch(/global across all projects/i);
    expect(search.input.properties).toHaveProperty("project");
    expect(search.input.properties).toHaveProperty("offset");
    expect(search.description).toMatch(/paginate/i);
  });

  test("descriptions are nonempty and do not name sibling tools", () => {
    const descriptions = [JournalWrite(baseStore, context).description, JournalRead(baseStore).description, JournalSearch(baseStore).description];
    expect(descriptions.every((description) => description.trim().length > 0)).toBe(true);
    for (const [index, description] of descriptions.entries()) {
      for (const [otherIndex, name] of ["journal_write", "journal_read", "journal_search"].entries()) {
        if (index !== otherIndex) expect(description).not.toContain(name);
      }
    }
  });

  test("uses JSON schemas, rejects malformed and unknown arguments", () => {
    const write = JournalWrite(baseStore, context).input as any;
    const read = JournalRead(baseStore).input as any;
    const search = JournalSearch(baseStore).input as any;
    expect(write.type).toBe("object");
    expect(valid(write, { title: "t", body: "b" })).toBe(true);
    expect(valid(write, { title: 4, body: "b" })).toBe(false);
    expect(valid(write, { title: "t", body: "b", extra: true })).toBe(false);
    expect(valid(read, {})).toBe(false);
    expect(valid(read, { id: "id", extra: 1 })).toBe(false);
    expect(valid(search, { limit: 0 })).toBe(false);
    expect(valid(search, { offset: 1.5 })).toBe(false);
    expect(valid(search, { unexpected: true })).toBe(false);
    expect(valid(search, { tags: "a,b", limit: 2, offset: 0 })).toBe(true);
  });

  test("all execute methods return the v2 {content} result", async () => {
    const writeResult = await JournalWrite(baseStore, context).execute({ title: "t", body: "b" }, { agent: "a", sessionID: "s" });
    const readResult = await JournalRead(baseStore).execute({ id: "entry" }, {} as any);
    const searchResult = await JournalSearch(baseStore).execute({}, {} as any);
    for (const result of [writeResult, readResult, searchResult]) {
      expect(Object.keys(result)).toEqual(["content"]);
      expect(typeof result.content).toBe("string");
    }
    expect(writeResult.content).toContain("Journal entry created:");
    expect(readResult.content).toContain("Body");
    expect(searchResult.content).toContain("Found 1 entries");
  });

  test("retains bounded tag inventory output formatting", async () => {
    const populated: JournalStore = { ...baseStore, search: async () => ({ entries: [entry()], total: 1, allTags: ["alpha", "beta"] }) };
    expect((await JournalSearch(populated).execute({}, {} as any)).content).toContain("Tags in use: alpha, beta");
    const empty: JournalStore = { ...baseStore, search: async () => ({ entries: [], total: 0, allTags: [] }) };
    expect((await JournalSearch(empty).execute({}, {} as any)).content).toBe("No journal entries found.");
    const store: JournalStore = { ...baseStore, search: async () => ({ entries: [], total: 0, allTags: Array.from({ length: 21 }, (_, i) => `tag-${i}`) }) };
    const result = await JournalSearch(store).execute({}, {} as any);
    expect(result.content).toBe("No journal entries found.\nTags in use: 21 (filter with tags=...)");
  });

  test("journal_read formats metadata before the body", async () => {
    const result = await JournalRead(baseStore).execute({ id: "entry" }, {} as any);
    expect(result.content).toBe("title: Title\ncreated: 2026-01-01T00:00:00.000Z\nproject: /tmp\nmodel: m\nprovider: p\nagent: a\nsession: s\ntags: tag\n\nBody");
  });
});
