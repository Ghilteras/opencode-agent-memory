import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";

// Guards the two-process test split in package.json: every test file in
// src/ must be listed in exactly one group, or it silently never runs.
const CORE = ["doctor.test.ts", "embeddings.test.ts", "journal.test.ts", "test-suite.test.ts", "tools.test.ts"];
const PLUGIN = ["plugin-disabled.test.ts", "plugin.test.ts"];

test("every test file is covered by the test:core/test:plugin split", async () => {
  const files = (await fs.readdir(import.meta.dir))
    .filter((f) => f.endsWith(".test.ts"))
    .sort();
  const covered = [...CORE, ...PLUGIN].sort();
  expect(files).toEqual(covered);
});
