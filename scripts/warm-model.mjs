// Downloads the embedding model at build time so the first request does not wait for it.
import { pipeline } from "@huggingface/transformers";
const ex = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "q8" });
await ex(["warm up"], { pooling: "mean", normalize: true });
console.log("embedding model cached");
