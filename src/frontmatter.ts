import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import * as yaml from "js-yaml";

const fileLocks = new Map<string, Promise<unknown>>();

export function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath);
  const prior = fileLocks.get(key) ?? Promise.resolve();
  const result = prior.then(fn, fn);           // run fn whatever the prior outcome was
  const settled = result.then(() => undefined, () => undefined);  // never rejects
  fileLocks.set(key, settled);
  settled.then(() => {
    if (fileLocks.get(key) === settled) fileLocks.delete(key);
  });
  return result;
}

export function splitFrontmatter(text: string): {
  frontmatterText: string | undefined;
  body: string;
} {
  if (!text.startsWith("---\n")) {
    return { frontmatterText: undefined, body: text };
  }

  const endIndex = text.indexOf("\n---\n", 4);
  if (endIndex === -1) {
    return { frontmatterText: undefined, body: text };
  }

  const frontmatterText = text.slice(4, endIndex);
  const body = text.slice(endIndex + "\n---\n".length);
  return { frontmatterText, body };
}

export function buildFrontmatterDocument(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const frontmatterYaml = yaml.dump(frontmatter, {
    lineWidth: 120,
    noRefs: true,
    sortKeys: true,
  });

  return `---\n${frontmatterYaml}---\n${body.trim()}\n`;
}

export async function atomicWriteFile(
  filePath: string,
  content: string,
): Promise<void> {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(tempPath, content, "utf-8");
    await fs.rename(tempPath, filePath);
  } catch (err) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
}
