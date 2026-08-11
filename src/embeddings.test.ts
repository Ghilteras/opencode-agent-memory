import { describe, expect, test } from "bun:test";

import {
  EMBEDDING_DIMENSION,
  cosineSimilarity,
  embeddingModelName,
  getEmbeddingDimension,
} from "./embeddings";

describe("embeddings", () => {
  test("getEmbeddingDimension returns 384", () => {
    expect(getEmbeddingDimension()).toBe(384);
    expect(EMBEDDING_DIMENSION).toBe(384);
  });

  test("embeddingModelName returns the multilingual model", () => {
    expect(embeddingModelName()).toBe(
      "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    );
  });

  test("cosineSimilarity throws on dimension mismatch", () => {
    expect(() => cosineSimilarity([1, 2, 3], [1, 2, 3, 4])).toThrow(
      /dimension mismatch/i,
    );
  });

  test("versioned embedding round-trip serializes and parses back", () => {
    const vector = Array.from(
      { length: EMBEDDING_DIMENSION },
      (_, i) => Math.sin(i),
    );
    const serialized = JSON.stringify({
      v: 2,
      model: embeddingModelName(),
      dimension: EMBEDDING_DIMENSION,
      vector,
    });

    const parsed = JSON.parse(serialized);
    expect(parsed.v).toBe(2);
    expect(parsed.model).toBe(embeddingModelName());
    expect(parsed.dimension).toBe(EMBEDDING_DIMENSION);
    expect(parsed.vector).toEqual(vector);
    expect(parsed.vector.length).toBe(EMBEDDING_DIMENSION);
  });
});
