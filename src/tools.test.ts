import { describe, expect, test } from "bun:test";

import { JournalRead, JournalSearch, JournalWrite } from "./tools";
import type { JournalContext } from "./tools";
import type { JournalStore, JournalTag } from "./journal";

// Minimal mock store — tests only check description strings, not execute.
const mockStore: JournalStore = {
  write: async () => {
    throw new Error("not implemented");
  },
  read: async () => {
    throw new Error("not implemented");
  },
  search: async () => {
    throw new Error("not implemented");
  },
};

const mockCtx: JournalContext = {
  directory: "/tmp/test",
  model: "test-model",
  provider: "test-provider",
};

// ─── Tool description tests ───────────────────────────────────────────────
// These assert semantic properties of the description strings: that guidance
// content is present, that stale/hallucinated text is absent, and that structural
// invariants hold.  They use substring/regex assertions, so intra-sentence
// rewording is tolerated; only content-level regressions trip them.

const WRITE_DESC_NO_TAGS = JournalWrite(mockStore, mockCtx).description;
const WRITE_DESC_WITH_TAGS = JournalWrite(mockStore, mockCtx, [
  { name: "perf", description: "Performance optimization" },
  { name: "debug", description: "Debugging sessions" },
]).description;
const READ_DESC = JournalRead(mockStore).description;
const SEARCH_TOOL = JournalSearch(mockStore);
const SEARCH_DESC = SEARCH_TOOL.description;

describe("journal_write description", () => {
  test("mentions append-only semantics", () => {
    expect(WRITE_DESC_NO_TAGS).toContain("append-only");
  });

  test("explains that entries cannot be edited", () => {
    expect(WRITE_DESC_NO_TAGS).toMatch(/never edit|cannot be (edited|modified)/i);
  });

  test("documents tag format", () => {
    expect(WRITE_DESC_NO_TAGS).toMatch(/tags/i);
    expect(WRITE_DESC_NO_TAGS).toMatch(/comma.separated/i);
  });

  test("contains no dynamic or timestamped content", () => {
    // A static description must not embed a date or ISO timestamp
    expect(WRITE_DESC_NO_TAGS).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  test("mentions the journal is for recording insights", () => {
    expect(WRITE_DESC_NO_TAGS).toMatch(/insight|discovery|decision|observation/i);
  });

  test("does not include suggested tags when none provided", () => {
    expect(WRITE_DESC_NO_TAGS).not.toMatch(/suggested tags/i);
  });

  test("includes suggested tags when provided", () => {
    expect(WRITE_DESC_WITH_TAGS).toMatch(/suggested tags/i);
    expect(WRITE_DESC_WITH_TAGS).toContain("perf");
    expect(WRITE_DESC_WITH_TAGS).toContain("debug");
  });

  test("suggested tags are tag names only, not descriptions", () => {
    expect(WRITE_DESC_WITH_TAGS).toContain("perf");
    expect(WRITE_DESC_WITH_TAGS).toContain("debug");
    // Tag descriptions should NOT appear in the tool description
    expect(WRITE_DESC_WITH_TAGS).not.toContain("Performance optimization");
    expect(WRITE_DESC_WITH_TAGS).not.toContain("Debugging sessions");
  });
});

describe("journal_read description", () => {
  test("mentions reading a specific entry by ID", () => {
    expect(READ_DESC).toMatch(/by.*ID/i);
  });

  test("does not contain write-only guidance", () => {
    // Write-scoping guidance (append-only, cannot be edited) belongs only in
    // journal_write's description.  An agent with read-but-not-write would
    // see this guidance without the ability to act on it.
    expect(READ_DESC).not.toMatch(/append.only|cannot be (edited|modified)/i);
  });

  test("contains no dynamic or timestamped content", () => {
    expect(READ_DESC).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});

describe("journal_search description", () => {
  test("mentions searching semantically", () => {
    expect(SEARCH_DESC).toMatch(/semantic|similarity|meaning/i);
  });

  test("mentions that filters can be combined", () => {
    expect(SEARCH_DESC).toMatch(/filter/i);
  });

  test("documents the project filter argument", () => {
    // The project filter is documented via the tool's args schema, not the
    // description prose.  Assert the arg exists so a schema regression is caught.
    expect(SEARCH_TOOL.args).toBeDefined();
    expect(SEARCH_TOOL.args!.project).toBeDefined();
  });

  test("mentions pagination (offset)", () => {
    expect(SEARCH_DESC).toMatch(/offset|paginate/i);
  });

  test("mentions the journal is global across projects", () => {
    expect(SEARCH_DESC).toMatch(/global.*project|across.*project/i);
  });

  test("advises searching before complex tasks", () => {
    expect(SEARCH_DESC).toMatch(/complex task|before start/i);
  });

  test("contains no dynamic or timestamped content", () => {
    expect(SEARCH_DESC).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});

// ─── Cross-tool invariants ───────────────────────────────────────────────────

describe("cross-tool invariants", () => {
  test("no description mentions another journal tool by name", () => {
    const toolNames = ["journal_search", "journal_read", "journal_write"];
    for (const name of toolNames) {
      const desc =
        name === "journal_write"
          ? WRITE_DESC_NO_TAGS
          : name === "journal_read"
            ? READ_DESC
            : SEARCH_DESC;
      const others = toolNames.filter((n) => n !== name);
      for (const other of others) {
        expect(desc).not.toContain(other);
      }
    }
  });

  test("all descriptions are non-empty strings", () => {
    expect(typeof WRITE_DESC_NO_TAGS).toBe("string");
    expect(WRITE_DESC_NO_TAGS.length).toBeGreaterThan(0);
    expect(typeof READ_DESC).toBe("string");
    expect(READ_DESC.length).toBeGreaterThan(0);
    expect(typeof SEARCH_DESC).toBe("string");
    expect(SEARCH_DESC.length).toBeGreaterThan(0);
  });

  test("no description contains the retired invitation phrase", () => {
    const retired = "record thoughts, discoveries, and decisions as you work";
    expect(WRITE_DESC_NO_TAGS).not.toContain(retired);
    expect(READ_DESC).not.toContain(retired);
    expect(SEARCH_DESC).not.toContain(retired);
  });
});
