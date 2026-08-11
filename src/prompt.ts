import type { MemoryBlock } from "./memory";
import { MEMORY_INSTRUCTIONS } from "./letta";

const LINE_NUMBER_WARNING =
  "# NOTE: Line numbers shown below (with arrows like '1→') are to help during editing. Do NOT include line number prefixes in your memory edit tool calls.";

export function renderMemoryBlocks(blocks: MemoryBlock[]): string {
  if (blocks.length === 0) {
    return "";
  }

  const parts: string[] = [
    MEMORY_INSTRUCTIONS,
    "",
    "<memory_blocks>",
    "The following memory blocks are currently engaged in your core memory unit:",
    "",
  ];

  for (const block of blocks) {
    // escape xml
    const desc = block.description
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");

    const numberedValue = block.value
      ? block.value.split("\n").map((line, i) => `${i + 1}→ ${line}`).join("\n")
      : "";

    const memoryBlock = `<${block.label}>
<description>
${desc}
</description>
<metadata>
${[
  `- chars_current=${block.value.length}`,
  `- chars_limit=${block.limit}`,
  `- read_only=${block.readOnly}`,
  `- scope=${block.scope}`,
  `- last_modified=${block.lastModified.toISOString()}`,
].join("\n")}
</metadata>
<warning>
${LINE_NUMBER_WARNING}
</warning>
<value>
${numberedValue}
</value>
</${block.label}>`;

    parts.push(memoryBlock);
  }

  parts.push("</memory_blocks>");

  return parts.join("\n");
}
