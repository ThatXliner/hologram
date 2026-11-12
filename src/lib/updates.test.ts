import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createUpdater, type DownloadEvent, type PendingUpdate, type UpdateStatus } from "./updates.ts";

function harness(check: () => Promise<PendingUpdate | null>) {
  const seen: UpdateStatus[] = [];
  let relaunched = 0;
  const updater = createUpdater(
    { check, relaunch: async () => { relaunched += 1; } },
    (status) => seen.push(status),
  );
  return { updater, seen, relaunches: () => relaunched };
}

function fakeUpdate(events: DownloadEvent[], fail?: Error): PendingUpdate {
  return {
    version: "1.4.0",
    body: "Faster grid",
    async downloadAndInstall(onEvent) {
      for (const event of events) onEvent(event);
      if (fail) throw fail;
    },
  };
}

describe("updater state", () => {
  it("walks available, downloading progress, then relaunches", async () => {
    const update = fakeUpdate([
      { event: "Started", data: { contentLength: 100 } },
      { event: "Progress", data: { chunkLength: 40 } },
      { event: "Progress", data: { chunkLength: 60 } },
      { event: "Finished" },
    ]);
    const h = harness(async () => update);
    await h.updater.checkForUpdates({ silent: true });
    assert.deepEqual(h.seen.at(-1), { kind: "available", version: "1.4.0", notes: "Faster grid" });

    await h.updater.installUpdate();
    assert.ok(h.seen.some((s) => s.kind === "downloading" && s.downloaded === 40 && s.total === 100));
    assert.ok(h.seen.some((s) => s.kind === "downloading" && s.downloaded === 100 && s.total === 100));
    assert.equal(h.seen.at(-1)?.kind, "ready");
    assert.equal(h.relaunches(), 1);
  });

  it("returns to idle when a silent check throws", async () => {
    const h = harness(async () => { throw new Error("offline"); });
    await h.updater.checkForUpdates({ silent: true });
    assert.deepEqual(h.seen.at(-1), { kind: "idle" });
  });

  it("surfaces the error when a manual check throws", async () => {
    const h = harness(async () => { throw new Error("offline"); });
    await h.updater.checkForUpdates({ silent: false });
    assert.deepEqual(h.seen.at(-1), { kind: "error", message: "offline" });
  });

  it("reports upToDate for a manual check with no update, idle for a silent one", async () => {
    const manual = harness(async () => null);
    await manual.updater.checkForUpdates({ silent: false });
    assert.deepEqual(manual.seen.at(-1), { kind: "upToDate" });

    const silent = harness(async () => null);
    await silent.updater.checkForUpdates({ silent: true });
    assert.deepEqual(silent.seen.at(-1), { kind: "idle" });
  });

  it("shows an install failure and does not relaunch", async () => {
    const h = harness(async () => fakeUpdate([{ event: "Started", data: {} }], new Error("bad signature")));
    await h.updater.checkForUpdates({ silent: false });
    await h.updater.installUpdate();
    assert.deepEqual(h.seen.at(-1), { kind: "error", message: "bad signature" });
    assert.equal(h.relaunches(), 0);
  });

  it("ignores a second check while one is running", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = harness(async () => { calls += 1; await gate; return null; });
    const first = h.updater.checkForUpdates({ silent: false });
    await h.updater.checkForUpdates({ silent: false });
    release();
    await first;
    assert.equal(calls, 1);
  });

  it("ignores installUpdate before an update is available", async () => {
    const h = harness(async () => null);
    await h.updater.installUpdate();
    assert.deepEqual(h.seen, []);
  });
});
