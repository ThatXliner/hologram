import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { rankAutoCullPhotosWithTaste, tasteCaptureGroups, type AutoCullPreferenceRefinement, type PixelFeatures } from "./autocull.ts";
import type { Photo } from "./types.ts";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

beforeEach(() => Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true }));

function photo(shoot: string, index: number, overrides: Partial<Photo> = {}): Photo {
  const id = `${shoot}-${index}`;
  return { id, file_path: `/photos/${shoot}/${id}.jpg`, file_name: `${id}.jpg`, file_type: "JPEG", file_size: 1,
    created_at: "2026-01-01", modified_at: "2026-01-01", exif: {}, ...overrides };
}

// Embeddings carry a "taste" direction: rejects lean one way regardless of shoot.
function clip(seed: number, reject: boolean): number[] {
  return Array.from({ length: 512 }, (_, j) => Math.sin(seed * 12.9898 + j * 78.233) * 0.3 + (j < 8 ? (reject ? 1 : -1) : 0));
}

function features(photos: Photo[]): Map<string, PixelFeatures> {
  return new Map(photos.map((item, index) => [item.id, { embedding: [1, index / 100 + 0.1], technicalScore: 0.6, backend: "fixture" }]));
}

function review(item: Photo, rating: number): AutoCullPreferenceRefinement {
  return { photo_id: item.id, flag: "none", rating, confidence: 1, source: "manual_decision", updated_at: "2026-01-01" };
}

describe("taste model ranking", () => {
  it("groups RAW+JPEG siblings, visual clusters and captures within two seconds", () => {
    const at = (seconds: number) => ({ exif: { date_taken: `2026-01-01T00:00:${String(seconds).padStart(2, "0")}` } });
    const items = [photo("s", 0, { paired_with: "s-1", ...at(0) }), photo("s", 1, { paired_with: "s-0", ...at(0) }),
      photo("s", 2, at(1)), photo("s", 3, at(30)), photo("s", 4, at(50)), photo("s", 5, at(55))];
    const groups = tasteCaptureGroups(items, [{ id: "c", kind: "similar", confidence: 1, photo_ids: ["s-4", "s-5"], top_pick_id: "s-4", pick_margin: 0 }]);
    assert.equal(groups.get("s-0")!.family, groups.get("s-1")!.family);
    assert.equal(groups.get("s-0")!.block, groups.get("s-2")!.block);
    assert.notEqual(groups.get("s-2")!.block, groups.get("s-3")!.block);
    assert.equal(groups.get("s-4")!.block, groups.get("s-5")!.block);
  });

  it("learns rejects from past shoots and ranks a new shoot before any review", async () => {
    const refinements: AutoCullPreferenceRefinement[] = [];
    const truth = new Map<string, boolean>();
    for (const shoot of ["a", "b"]) {
      const items = Array.from({ length: 16 }, (_, index) => photo(shoot, index));
      items.forEach((item, index) => truth.set(item.id, index % 2 === 0));
      const reviews = items.map((item) => review(item, truth.get(item.id) ? 1 : 3));
      refinements.push(...reviews);
      await rankAutoCullPhotosWithTaste(items, features(items), [], refinements, true, new Set(), new Map(), new Set(),
        new Set(reviews.map((item) => item.photo_id)), 0.1, () => {}, () => true, async (item) => clip(item.id.length + Number(item.id.split("-")[1]), truth.get(item.id)!));
    }
    const target = Array.from({ length: 10 }, (_, index) => photo("c", index));
    target.forEach((item, index) => truth.set(item.id, index < 3));
    const session = await rankAutoCullPhotosWithTaste(target, features(target), [], refinements, true, new Set(), new Map(), new Set(),
      new Set(refinements.map((item) => item.photo_id)), 0.2, () => {}, () => true,
      async (item) => clip(100 + Number(item.id.split("-")[1]), truth.get(item.id)!));
    assert.equal(session.learner?.engine, "taste");
    assert.ok(session.learner?.engine === "taste" && session.learner.training_rows === 32 && session.learner.shoots === 2);
    const rejected = session.photos.filter((item) => item.recommendation === "REJECT").map((item) => item.photo_id);
    assert.equal(rejected.length, 2);
    assert.ok(rejected.every((id) => truth.get(id)), `rejected ${rejected}`);
    assert.ok(session.photos.every((item) => item.final_score > 0 && item.final_score < 1));
  });

  it("never overrides an explicit pick", async () => {
    const target = Array.from({ length: 6 }, (_, index) => photo("d", index, index === 0 ? { flag: "pick" } : {}));
    const session = await rankAutoCullPhotosWithTaste(target, features(target), [], [], false, new Set(), new Map(), new Set(),
      new Set(), 0.5, () => {}, () => true, async (item) => clip(Number(item.id.split("-")[1]), item.id === "d-0"));
    assert.equal(session.photos.find((item) => item.photo_id === "d-0")?.recommendation, "SELECT");
  });
});
