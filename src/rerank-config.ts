import * as fs from "node:fs/promises";
import * as path from "node:path";

import { loadConfig } from "./journal";

export type RerankRequestConfig = { headers?: Record<string, string>; body?: Record<string, string | number | boolean> };
export type RerankConfig = { enabled: true; baseURL: string; model: string; request?: RerankRequestConfig } | { enabled: false };

export type RerankConfigLoad =
  | { status: "disabled" }
  | { status: "invalid"; reason: string }
  | { status: "enabled"; config: { baseURL: string; model: string; request?: RerankRequestConfig } };

const forbiddenHeaders = new Set(["authorization", "content-type", "host", "content-length", "content-encoding", "transfer-encoding"]);
const forbiddenBodyKeys = new Set(["model", "messages", "stream"]);

function validateRequest(value: unknown): { valid: true; request?: RerankRequestConfig } | { valid: false } {
  if (value === undefined) return { valid: true };
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { valid: false };
  const request = value as Record<string, unknown>;
  if (Object.keys(request).some((key) => key !== "headers" && key !== "body")) return { valid: false };
  const result: RerankRequestConfig = {};
  if (request.headers !== undefined) {
    if (request.headers === null || typeof request.headers !== "object" || Array.isArray(request.headers)) return { valid: false };
    const headers = request.headers as Record<string, unknown>;
    const entries = Object.entries(headers);
    if (entries.length > 10) return { valid: false };
    const output: Record<string, string> = {};
    for (const [key, item] of entries) {
      if (!/^[A-Za-z0-9-]+$/.test(key) || forbiddenHeaders.has(key.toLowerCase()) || typeof item !== "string" ||
        item.length === 0 || item.length > 1024 || /[\r\n\0]/.test(item)) return { valid: false };
      output[key] = item;
    }
    result.headers = output;
  }
  if (request.body !== undefined) {
    if (request.body === null || typeof request.body !== "object" || Array.isArray(request.body)) return { valid: false };
    const body = request.body as Record<string, unknown>;
    const entries = Object.entries(body);
    if (entries.length > 10) return { valid: false };
    const output: Record<string, string | number | boolean> = Object.create(null) as Record<string, string | number | boolean>;
    for (const [key, item] of entries) {
      if (!/^[A-Za-z0-9_.-]+$/.test(key) || forbiddenBodyKeys.has(key) ||
        !(typeof item === "string" || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) ||
        (typeof item === "string" && item.length > 1024)) return { valid: false };
      output[key] = item;
    }
    result.body = output;
  }
  return { valid: true, ...(Object.keys(result).length ? { request: result } : {}) };
}

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
  if (Object.keys(config).some((key) => !["enabled", "baseURL", "model", "request"].includes(key))) {
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
  const request = validateRequest(config.request);
  if (!request.valid) return { status: "invalid", reason: "request must contain valid headers and body" };
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
  return { status: "enabled", config: { baseURL, model: config.model, ...(request.request ? { request: request.request } : {}) } };
}
