// CLIP ViT-B/32 image embeddings for the opt-in taste model. fp32 on purpose: the 8-bit export
// drifts to ~0.93 cosine from the PyTorch embeddings the model was validated on (fp32: ~0.98).
import type { Photo } from "./types.ts";

export const CLIP_MODEL_ID = "Xenova/clip-vit-base-patch32";
const MODEL_TIMEOUT_MS = 120_000;
const INFERENCE_TIMEOUT_MS = 15_000;
const MAX_SOURCE_SIDE = 640;
const MEMORY_LIMIT = 4_000;

type ClipRunner = (canvas: HTMLCanvasElement) => Promise<number[] | null>;

const memory = new Map<string, number[]>();
let runnerPromise: Promise<ClipRunner | null> | null = null;
let dbPromise: Promise<IDBDatabase | null> | null = null;

export function clipCacheKey(photo: Pick<Photo, "file_path" | "file_size" | "modified_at">): string {
  return `${CLIP_MODEL_ID}|${photo.file_path}|${photo.file_size}|${photo.modified_at}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), timeoutMs); })])
    .finally(() => { if (timer) clearTimeout(timer); });
}

function normalize(vector: number[]): number[] | null {
  const norm = Math.hypot(...vector);
  return norm > 0 && vector.every(Number.isFinite) ? vector.map((value) => value / norm) : null;
}

async function loadRunner(): Promise<ClipRunner | null> {
  runnerPromise ??= (async () => {
    try {
      const { env, AutoProcessor, CLIPVisionModelWithProjection, RawImage } = await import("@huggingface/transformers");
      env.allowRemoteModels = true;
      env.useBrowserCache = true;
      const processor = await AutoProcessor.from_pretrained(CLIP_MODEL_ID);
      const model = await CLIPVisionModelWithProjection.from_pretrained(CLIP_MODEL_ID, { dtype: "fp32" });
      return async (canvas: HTMLCanvasElement) => {
        const { image_embeds } = await model(await processor(RawImage.fromCanvas(canvas)));
        return normalize(Array.from(image_embeds.data as Float32Array, Number));
      };
    } catch {
      runnerPromise = null;
      return null;
    }
  })();
  return runnerPromise;
}

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  dbPromise ??= new Promise((resolve) => {
    try {
      const request = indexedDB.open("hologram-autocull-clip", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("embeddings");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbPromise;
}

async function readStored(key: string): Promise<number[] | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const request = db.transaction("embeddings", "readonly").objectStore("embeddings").get(key);
      request.onsuccess = () => {
        const value: unknown = request.result;
        resolve(Array.isArray(value) && value.length === 512 && value.every((item) => typeof item === "number") ? value : null);
      };
      request.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function store(key: string, embedding: number[]): Promise<void> {
  if (memory.size >= MEMORY_LIMIT) memory.delete(memory.keys().next().value!);
  memory.set(key, embedding);
  const db = await openDb();
  if (!db) return;
  try { db.transaction("embeddings", "readwrite").objectStore("embeddings").put(embedding, key); } catch { /* cache only */ }
}

function sourceCanvas(image: HTMLImageElement): HTMLCanvasElement {
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const scale = Math.min(1, MAX_SOURCE_SIDE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// The CLIP processor resizes the short side to 224 and center-crops, as in the research pipeline,
// so the source keeps its aspect ratio here.
export async function clipEmbedding(photo: Photo, image: () => Promise<HTMLImageElement>): Promise<number[] | null> {
  const key = clipCacheKey(photo);
  const cached = memory.get(key) ?? await readStored(key);
  if (cached) {
    memory.set(key, cached);
    return cached;
  }
  if (typeof document === "undefined") return null;
  try {
    const runner = await withTimeout(loadRunner(), MODEL_TIMEOUT_MS, null);
    if (!runner) return null;
    const embedding = await withTimeout(runner(sourceCanvas(await image())), INFERENCE_TIMEOUT_MS, null);
    if (embedding) await store(key, embedding);
    return embedding;
  } catch {
    return null;
  }
}
