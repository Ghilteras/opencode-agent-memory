export const MODEL_NAME = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
export const EMBEDDING_DIMENSION = 384;
const MODEL_DTYPE = "q8";

export function getEmbeddingDimension(): number {
  return EMBEDDING_DIMENSION;
}

export function embeddingModelName(): string {
  return MODEL_NAME;
}

let pipelinePromise: Promise<any> | undefined;

async function getPipeline(cacheDir?: string) {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      return pipeline("feature-extraction", MODEL_NAME, {
        dtype: MODEL_DTYPE,
        cache_dir: cacheDir,
      });
    })();
  }
  return pipelinePromise;
}

export async function generateEmbedding(
  text: string,
  cacheDir?: string,
): Promise<number[]> {
  const pipe = await getPipeline(cacheDir);
  const output = await pipe(text, { pooling: "mean", normalize: true });
  const out = Array.from(output.data as Float32Array) as number[];
  if (out.length !== EMBEDDING_DIMENSION) {
    throw new Error(
      `Embedding dimension mismatch: expected ${EMBEDDING_DIMENSION}, got ${out.length}`,
    );
  }
  return out;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `Embedding dimension mismatch: ${a.length} vs ${b.length}`,
    );
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dotProduct += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;
  return dotProduct / denominator;
}
