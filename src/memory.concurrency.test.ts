import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";

import { createMemoryStore } from "./memory";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(tmpdir(), "mem-race-"));
}

describe("concurrent block edits", () => {
  test("two concurrent replaceInBlock calls both survive", async () => {
    const dir = await mkTmpDir();
    const store = createMemoryStore(dir);
    await store.ensureSeed();
    await store.setBlock("project", "project", "AAA bbb CCC ddd", { limit: 5000 });

    await Promise.all([
      store.replaceInBlock("project", "project", "AAA", "111"),
      store.replaceInBlock("project", "project", "CCC", "333"),
    ]);

    const block = await store.getBlock("project", "project");
    expect(block.value).toContain("111");
    expect(block.value).toContain("333");
    expect(block.value).toContain("bbb");
    expect(block.value).toContain("ddd");

    // No leftover temp files
    const memDir = path.join(dir, ".opencode", "memory");
    const files = await fs.readdir(memDir);
    const tmpFiles = files.filter((f) => f.includes(".tmp"));
    expect(tmpFiles).toEqual([]);
  });

  test("10 concurrent setBlock calls produce valid frontmatter", async () => {
    const dir = await mkTmpDir();
    const store = createMemoryStore(dir);
    await store.ensureSeed();

    const ops = Array.from({ length: 10 }, (_, i) =>
      store.setBlock("project", `project`, `iteration ${i} ${"x".repeat(50)}`, { limit: 5000 }),
    );
    await Promise.all(ops);

    // File must parse as valid frontmatter
    const block = await store.getBlock("project", "project");
    expect(block.value).toMatch(/iteration \d+/);

    // No leftover temp files
    const memDir = path.join(dir, ".opencode", "memory");
    const files = await fs.readdir(memDir);
    const tmpFiles = files.filter((f) => f.includes(".tmp"));
    expect(tmpFiles).toEqual([]);
  });
});
