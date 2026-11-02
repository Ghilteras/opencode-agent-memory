import * as fs from "node:fs/promises";
import * as path from "node:path";

import { loadConfig } from "./journal";

export type RerankConfig = { enabled: true; baseURL: string; model: string } | { enabled: false };

export type RerankConfigLoad =
  | { status: "disabled" }
  | { status: "invalid"; reason: string }
  | { status: "enabled"; config: { baseURL: string; model: string } };

function duplicateTopLevelKey(raw: string): string | undefined {
  const keys = new Set<string>();
  let objectDepth = 0;
  let arrayDepth = 0;
  for (let i = 0; i < raw.length;) {
    const char = raw[i]!;
    if (char === '"') {
      const start = i++;
      let escaped = false;
      while (i < raw.length) {
        const current = raw[i++]!;
        if (escaped) escaped = false;
        else if (current === "\\") escaped = true;
        else if (current === '"') break;
      }
      if (objectDepth === 1 && arrayDepth === 0) {
        let next = i;
        while (/\s/.test(raw[next] ?? "")) next++;
        if (raw[next] === ":") {
          const key = JSON.parse(raw.slice(start, i)) as string;
          if (keys.has(key)) return key;
          keys.add(key);
        }
      }
      continue;
    }
    if (char === "{") objectDepth++;
    else if (char === "}") objectDepth--;
    else if (char === "[") arrayDepth++;
    else if (char === "]") arrayDepth--;
    i++;
  }
  return undefined;
}

export async function loadRerankConfig(configDir?: string): Promise<RerankConfigLoad> {
  const existingConfig = await loadConfig(configDir);
  const configPath = path.resolve(path.dirname(existingConfig.configPath), "agent-memory-rerank.json");

  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
    return code === "ENOENT" ? { status: "disabled" } : { status: "invalid", reason: `read failed (${code})` };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { status: "invalid", reason: "malformed JSON" };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { status: "invalid", reason: "config must be an object" };
  }

  const duplicate = duplicateTopLevelKey(raw);
  if (duplicate !== undefined) return { status: "invalid", reason: `duplicate config key: ${duplicate}` };

  const config = value as Record<string, unknown>;
  if (Object.keys(config).some((key) => !["enabled", "baseURL", "model"].includes(key))) {
    return { status: "invalid", reason: "unknown config field" };
  }
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
    return { status: "invalid", reason: "enabled must be a boolean" };
  }
  if (config.baseURL !== undefined && typeof config.baseURL !== "string") {
    return { status: "invalid", reason: "baseURL must be a string" };
  }
  if (config.model !== undefined && typeof config.model !== "string") {
    return { status: "invalid", reason: "model must be a string" };
  }
  if (config.enabled !== true) return { status: "disabled" };
  if (typeof config.baseURL !== "string" || typeof config.model !== "string" || config.model.trim().length === 0) {
    return { status: "invalid", reason: "enabled config requires baseURL and non-empty model" };
  }

  let url: URL;
  try {
    url = new URL(config.baseURL);
  } catch {
    return { status: "invalid", reason: "baseURL must be an absolute HTTPS URL" };
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    return { status: "invalid", reason: "baseURL must be HTTPS without credentials, query, or fragment" };
  }
  const baseURL = config.baseURL.replace(/\/+$/, "");
  if (!baseURL) return { status: "invalid", reason: "baseURL is invalid" };
  return { status: "enabled", config: { baseURL, model: config.model } };
}
