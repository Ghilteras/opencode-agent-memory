import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { diagnoseJournal } from "./doctor";

const roots: string[] = [];
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "journal-doctor-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "journal"));
  return path.join(root, "journal");
}
async function entry(dir: string, name: string, yamlText?: string, sidecar?: string) {
  await fs.writeFile(path.join(dir, `${name}.md`), yamlText === undefined ? "plain text" : `---\n${yamlText}\n---\nbody\n`);
  if (sidecar !== undefined) await fs.writeFile(path.join(dir, `${name}.embedding`), sidecar);
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

test("classifies frontmatter, created values, sidecars and multiple findings deterministically", async () => {
  const dir = await fixture();
  const valid = 'title: Good\ncreated: "2025-01-01T00:00:00Z"';
  await entry(dir, "00-valid", valid, JSON.stringify({ v: 2, model: "wrong-model", dimension: 2, vector: [0.1, 0.2] }));
  await entry(dir, "01-missing-title", "created: \"2025-01-01\"");
  await entry(dir, "02-empty-title", 'title: ""');
  await entry(dir, "03-wrong-title", "title: 42");
  await entry(dir, "04-missing-created", "title: Present", "[1,2]");
  await entry(dir, "05-date-only", "title: Present\ndate: \"2025-01-01\"");
  await entry(dir, "06-invalid-created", 'title: Present\ncreated: "not a date"');
  await entry(dir, "07-wrong-created", "title: Present\ncreated: 42");
  await entry(dir, "08-yaml-timestamp", "title: Present\ncreated: 2025-01-01T00:00:00Z");
  await entry(dir, "09-bad-yaml", "title: [broken");
  await entry(dir, "10-no-frontmatter");
  await entry(dir, "11-malformed-json", valid, "{");
  await entry(dir, "12-vector-type", valid, '{"v":2,"model":"m","dimension":1,"vector":["x"]}');
  await entry(dir, "13-empty-vector", valid, '{"v":2,"model":"m","dimension":0,"vector":[]}');
  await entry(dir, "14-vector-dimension", valid, '{"v":2,"model":"m","dimension":3,"vector":[1,2]}');
  await entry(dir, "15-legacy", valid, "[1,2]");
  await entry(dir, "16-legacy-invalid", valid, '[1,"x"]');
  await entry(dir, "17-missing-sidecar", valid);

  const inventory = async () => Promise.all((await fs.readdir(dir)).sort().map(async (f) => [f, await fs.readFile(path.join(dir, f)), (await fs.stat(path.join(dir, f))).mtimeMs] as const));
  const before = await inventory();
  const report = await diagnoseJournal(path.dirname(dir));
  expect(await diagnoseJournal(path.dirname(dir))).toEqual(report);
  expect(report.counts.files).toBe(18);
  const codes = (name: string) => report.findings.filter((f) => f.path.startsWith(name)).map((f) => f.code);
  expect(codes("01-missing-title")).toContain("frontmatter_title_invalid");
  expect(codes("02-empty-title")).toContain("frontmatter_title_invalid");
  expect(codes("03-wrong-title")).toContain("frontmatter_title_invalid");
  expect(codes("04-missing-created")).toContain("created_missing");
  expect(codes("05-date-only")).toContain("created_missing");
  expect(codes("06-invalid-created")).toContain("created_invalid");
  expect(codes("07-wrong-created")).toContain("frontmatter_created_invalid");
  expect(codes("08-yaml-timestamp")).toContain("frontmatter_created_invalid");
  expect(codes("09-bad-yaml")).toContain("yaml_malformed");
  expect(codes("10-no-frontmatter")).toContain("frontmatter_missing_or_malformed");
  expect(codes("11-malformed-json")).toContain("embedding_json_malformed");
  for (const name of ["12-vector-type", "13-empty-vector", "14-vector-dimension", "16-legacy-invalid"]) expect(codes(name)).toContain("embedding_invalid");
  expect(codes("00-valid")).toContain("embedding_incompatible");
  expect(codes("15-legacy")).toContain("embedding_model_unknown");
  expect(codes("17-missing-sidecar")).toContain("embedding_missing");
  expect(codes("04-missing-created")).toEqual(expect.arrayContaining(["created_missing", "embedding_model_unknown"]));
  expect(report.findings).toEqual([...report.findings].sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code) || a.severity.localeCompare(b.severity)));
  expect(report.findings.some((f) => /broken|Good|Present|not a date/.test(JSON.stringify(f)))).toBe(false);
  expect(await inventory()).toEqual(before);
});

test("empty, missing, and injected unreadable roots/files have explicit incomplete semantics", async () => {
  const missing = await diagnoseJournal("/path/that/does/not/exist");
  expect(missing.complete).toBe(false);
  expect(missing.findings[0]?.code).toBe("root_unreadable");
  const dir = await fixture();
  expect((await diagnoseJournal(path.dirname(dir))).complete).toBe(true);
  await entry(dir, "a", "title: A"); await entry(dir, "b", "title: B");
  const failingRead = { ...fs, readFile: async (p: Parameters<typeof fs.readFile>[0], ...args: any[]) => {
    if (String(p).endsWith("a.md")) throw new Error("injected");
    return fs.readFile(p, ...(args as [any]));
  } } as unknown as typeof fs;
  const report = await diagnoseJournal(path.dirname(dir), failingRead);
  expect(report.complete).toBe(false);
  expect(report.findings.some((f) => f.path === "a.md" && f.code === "file_unreadable")).toBe(true);
  expect(report.findings.some((f) => f.path === "b.md" && f.code === "created_missing")).toBe(true);
});

test("CLI emits exact bytes and exit codes for clean, warning, error, incomplete and bad invocation", async () => {
  const dir = await fixture();
  const cli = path.resolve(import.meta.dir, "journal-doctor.ts");
  const invoke = (...args: string[]) => Bun.spawnSync([process.execPath, "run", cli, ...args], { stdout: "pipe", stderr: "pipe" });
  const assertCli = (result: ReturnType<typeof invoke>, stdout: string, stderr: string, exitCode: number) =>
    expect({ stdout: result.stdout.toString(), stderr: result.stderr.toString(), exitCode: result.exitCode }).toEqual({ stdout, stderr, exitCode });
  assertCli(invoke(path.dirname(dir)), '{"complete":true,"counts":{"files":0,"errors":0,"warnings":0},"findings":[]}\n', "", 0);

  await entry(dir, "warning", 'title: Warn\ncreated: "2025-01-01"');
  assertCli(invoke(path.dirname(dir)), '{"complete":true,"counts":{"files":1,"errors":0,"warnings":1},"findings":[{"path":"warning.embedding","code":"embedding_missing","severity":"warning"}]}\n', "", 0);

  await entry(dir, "invalid", "title: 12");
  assertCli(invoke(path.dirname(dir)), '{"complete":true,"counts":{"files":2,"errors":1,"warnings":2},"findings":[{"path":"invalid.embedding","code":"embedding_missing","severity":"warning"},{"path":"invalid.md","code":"frontmatter_title_invalid","severity":"error"},{"path":"warning.embedding","code":"embedding_missing","severity":"warning"}]}\n', "", 1);

  assertCli(invoke("/path/that/does/not/exist"), '{"complete":false,"counts":{"files":0,"errors":1,"warnings":0},"findings":[{"path":".","code":"root_unreadable","severity":"error"}]}\n', "", 2);
  assertCli(invoke(path.dirname(dir), "extra"), "", "usage: bun run journal:doctor [config-dir]\n", 2);
});

test("inventories orphan and associated sidecars independently and emits stable full report", async () => {
  const dir = await fixture();
  const valid = 'title: Good\ncreated: "2025-01-01T00:00:00Z"';
  await entry(dir, "A", valid);
  await entry(dir, "a", valid, "{");
  await fs.writeFile(path.join(dir, "_.embedding"), "{");
  const expected = { complete: true, counts: { files: 2, errors: 2, warnings: 2 }, findings: [
    { path: "A.embedding", code: "embedding_missing", severity: "warning" },
    { path: "_.embedding", code: "embedding_json_malformed", severity: "error" },
    { path: "_.embedding", code: "embedding_orphan", severity: "warning" },
    { path: "a.embedding", code: "embedding_json_malformed", severity: "error" },
  ] };
  const report = await diagnoseJournal(path.dirname(dir));
  expect(JSON.stringify(report)).toBe(JSON.stringify(expected));
  const cli = path.resolve(import.meta.dir, "journal-doctor.ts");
  const result = Bun.spawnSync([process.execPath, "run", cli, path.dirname(dir)], { stdout: "pipe", stderr: "pipe" });
  expect({ stdout: result.stdout.toString(), stderr: result.stderr.toString(), exitCode: result.exitCode }).toEqual({ stdout: `${JSON.stringify(expected)}\n`, stderr: "", exitCode: 1 });
});

test("sidecar validation survives markdown read failure; listed sidecar disappearance is incomplete", async () => {
  const dir = await fixture();
  await entry(dir, "a", 'title: Good\ncreated: "2025-01-01T00:00:00Z"', "{");
  const failingRead = { ...fs, readFile: async (p: Parameters<typeof fs.readFile>[0], ...args: any[]) => {
    if (String(p).endsWith("a.md")) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return fs.readFile(p, ...(args as [any]));
  } } as unknown as typeof fs;
  const failed = await diagnoseJournal(path.dirname(dir), failingRead);
  expect(failed.complete).toBe(false);
  expect(failed.findings.map((f) => f.code)).toEqual(expect.arrayContaining(["file_unreadable", "embedding_json_malformed"]));

  let removed = false;
  const disappearing = { ...fs, readFile: async (p: Parameters<typeof fs.readFile>[0], ...args: any[]) => {
    if (String(p).endsWith("a.embedding") && !removed) { removed = true; throw Object.assign(new Error("gone"), { code: "ENOENT" }); }
    return fs.readFile(p, ...(args as [any]));
  } } as unknown as typeof fs;
  const gone = await diagnoseJournal(path.dirname(dir), disappearing);
  expect(gone.complete).toBe(false);
  expect(gone.findings.some((f) => f.path === "a.embedding" && f.code === "embedding_unreadable")).toBe(true);
});

test("diagnosis never initializes model pipeline or fetches, while warmup activates trap in child", async () => {
  const dir = await fixture();
  await entry(dir, "a", 'title: Good\ncreated: "2025-01-01T00:00:00Z"');
  const childCode = `
    import { mock } from "bun:test";
    let pipelines = 0, fetches = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (...args) => { fetches++; throw new Error("FETCH_SENTINEL"); };
    mock.module("@huggingface/transformers", () => ({ pipeline: async () => { pipelines++; throw new Error("PIPELINE_SENTINEL"); } }));
    const { diagnoseJournal } = await import(${JSON.stringify(path.resolve(import.meta.dir, "doctor.ts"))});
    const { warmupEmbedder } = await import(${JSON.stringify(path.resolve(import.meta.dir, "embeddings.ts"))});
    await diagnoseJournal(${JSON.stringify(path.dirname(dir))});
    if (pipelines !== 0 || fetches !== 0) throw new Error("diagnosis activated model/fetch trap");
    try { await warmupEmbedder(); throw new Error("pipeline sentinel was not caught"); } catch (error) { if (!String(error).includes("PIPELINE_SENTINEL")) throw error; }
    if (pipelines !== 1 || fetches !== 0) throw new Error("pipeline trap count mismatch");
    globalThis.fetch = originalFetch;
    console.log(JSON.stringify({ pipelines, fetches }));
  `;
  const result = Bun.spawnSync([process.execPath, "-e", childCode], { stdout: "pipe", stderr: "pipe" });
  expect({ stdout: result.stdout.toString(), stderr: result.stderr.toString(), exitCode: result.exitCode }).toEqual({ stdout: '{"pipelines":1,"fetches":0}\n', stderr: "", exitCode: 0 });
});

test("only flat regular inventory files are read and each sidecar is read once", async () => {
  const dir = await fixture();
  await entry(dir, "a", 'title: Good\ncreated: "2025-01-01T00:00:00Z"', "[1]");
  await fs.mkdir(path.join(dir, "nested"));
  await fs.writeFile(path.join(dir, "nested", "hidden.md"), "bad");
  await fs.writeFile(path.join(dir, "nested", "hidden.embedding"), "{");
  await fs.writeFile(path.join(dir, "ignored.txt"), "bad");
  await fs.symlink(path.join(dir, "a.md"), path.join(dir, "linked.md"));
  const reads = new Map<string, number>();
  const counting = { ...fs, readFile: async (p: Parameters<typeof fs.readFile>[0], ...args: any[]) => {
    const name = path.basename(String(p)); reads.set(name, (reads.get(name) ?? 0) + 1);
    return fs.readFile(p, ...(args as [any]));
  } } as unknown as typeof fs;
  const report = await diagnoseJournal(path.dirname(dir), counting);
  expect(report.counts.files).toBe(1);
  expect([...reads.entries()].sort()).toEqual([["a.embedding", 1], ["a.md", 1]]);
  expect(report.findings.map((f) => f.path)).toEqual(["a.embedding", "a.embedding"]);
});
