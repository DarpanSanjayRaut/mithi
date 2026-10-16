import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

// Local sentence embeddings (all-MiniLM-L6-v2, 384 dims). No API key, runs on CPU.
export const EMBED_DIM = 384;

const g = globalThis as unknown as { __embedder?: Promise<FeatureExtractionPipeline> };

function embedder() {
  if (!g.__embedder) {
    g.__embedder = pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
      dtype: "q8",
    }) as Promise<FeatureExtractionPipeline>;
  }
  return g.__embedder;
}

export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const ex = await embedder();
  const out = await ex(texts, { pooling: "mean", normalize: true });
  return out.tolist() as number[][];
}

export async function embedOne(text: string): Promise<number[]> {
  return (await embed([text]))[0];
}
