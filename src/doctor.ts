import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as yaml from "js-yaml";
import { z } from "zod";
import { EMBEDDING_DIMENSION, embeddingModelName } from "./embeddings";
import { splitFrontmatter } from "./frontmatter";
import { EntryFrontmatterSchema } from "./journal";

export type JournalFinding = { path: string; code: string; severity: "error" | "warning" };
export type JournalDiagnosticReport = {
  complete: boolean;
  counts: { files: number; errors: number; warnings: number };
  findings: JournalFinding[];
};
type FileSystem = Pick<typeof fs, "readdir" | "readFile" | "stat">;

export async function diagnoseJournal(configDir?: string, fileSystem: FileSystem = fs): Promise<JournalDiagnosticReport> {
  const root = path.resolve(configDir ?? path.join(os.homedir(), ".config", "opencode"), "journal");
  const findings: JournalFinding[] = [];
  let complete = true;
  const add = (file: string, code: string, severity: JournalFinding["severity"]) => findings.push({ path: file, code, severity });
  let entries: import("node:fs").Dirent[];
  try { entries = await fileSystem.readdir(root, { withFileTypes: true }); }
  catch { add(".", "root_unreadable", "error"); complete = false; entries = []; }

  const inventory = entries.filter((entry) => entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".embedding"))).map((entry) => entry.name).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const files = inventory.filter((name) => name.endsWith(".md"));
  const sidecars = inventory.filter((name) => name.endsWith(".embedding"));
  const sidecarSet = new Set(sidecars);
  for (const name of files) {
    const relative = name;
    let raw: string | undefined;
    try { raw = await fileSystem.readFile(path.join(root, name), "utf8"); }
    catch { add(relative, "file_unreadable", "error"); complete = false; }
    if (raw !== undefined) {
      const { frontmatterText } = splitFrontmatter(raw);
      if (frontmatterText === undefined) add(relative, "frontmatter_missing_or_malformed", "error");
      else {
        let value: unknown;
        try { value = yaml.load(frontmatterText); }
        catch { add(relative, "yaml_malformed", "error"); value = undefined; }
        {
          const parsed = EntryFrontmatterSchema.safeParse(value);
          if (!parsed.success) {
            const fields = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? "document")))].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
            for (const field of fields) add(relative, `frontmatter_${field}_invalid`, "error");
          } else {
            if (parsed.data.created === undefined) add(relative, "created_missing", "warning");
            else if (!Number.isFinite(new Date(parsed.data.created).getTime())) add(relative, "created_invalid", "error");
          }
        }
      }
    }
  }

  for (const sidecar of sidecars) {
    const associatedMarkdown = `${sidecar.slice(0, -".embedding".length)}.md`;
    if (!files.includes(associatedMarkdown)) add(sidecar, "embedding_orphan", "warning");
    try {
      const content = await fileSystem.readFile(path.join(root, sidecar), "utf8");
      let value: unknown;
      try { value = JSON.parse(content); } catch { add(sidecar, "embedding_json_malformed", "error"); continue; }
      let vector: unknown; let dimension: unknown; let model: unknown; let legacy = false;
      if (Array.isArray(value)) { vector = value; dimension = value.length; legacy = true; }
      else if (value && typeof value === "object") {
        const envelope = z.object({ v: z.literal(2), model: z.string(), dimension: z.number().int().positive(), vector: z.array(z.number().finite()).min(1) }).safeParse(value);
        if (!envelope.success) { add(sidecar, "embedding_invalid", "error"); continue; }
        ({ vector, dimension, model } = envelope.data);
      } else { add(sidecar, "embedding_invalid", "error"); continue; }
      if (!Array.isArray(vector) || vector.length === 0 || !vector.every((n) => typeof n === "number" && Number.isFinite(n)) || vector.length !== dimension) {
        add(sidecar, "embedding_invalid", "error"); continue;
      }
      if (legacy) add(sidecar, "embedding_model_unknown", "warning");
      if (vector.length !== EMBEDDING_DIMENSION || (!legacy && model !== embeddingModelName())) add(sidecar, "embedding_incompatible", "warning");
    } catch (error) {
      add(sidecar, "embedding_unreadable", "error"); complete = false;
    }
  }
  for (const name of files) {
    const expectedSidecar = `${name.slice(0, -".md".length)}.embedding`;
    if (!sidecarSet.has(expectedSidecar)) add(expectedSidecar, "embedding_missing", "warning");
  }
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  findings.sort((a, b) => compare(a.path, b.path) || compare(a.code, b.code) || compare(a.severity, b.severity));
  return { complete, counts: { files: files.length, errors: findings.filter((f) => f.severity === "error").length, warnings: findings.filter((f) => f.severity === "warning").length }, findings };
}
