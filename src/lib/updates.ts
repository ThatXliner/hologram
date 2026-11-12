export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "upToDate" }
  | { kind: "available"; version: string; notes?: string }
  | { kind: "downloading"; downloaded: number; total?: number }
  | { kind: "ready" }
  | { kind: "error"; message: string };

export type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

export interface PendingUpdate {
  version: string;
  body?: string;
  downloadAndInstall(onEvent: (event: DownloadEvent) => void): Promise<void>;
}

export interface UpdaterDeps {
  check(): Promise<PendingUpdate | null>;
  relaunch(): Promise<void>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `setStatus` is the only sink, so the Svelte wrapper can back it with `$state`. */
export function createUpdater(deps: UpdaterDeps, setStatus: (status: UpdateStatus) => void) {
  let current: UpdateStatus = { kind: "idle" };
  let pending: PendingUpdate | null = null;

  const set = (status: UpdateStatus) => {
    current = status;
    setStatus(status);
  };

  async function checkForUpdates({ silent }: { silent: boolean }): Promise<void> {
    if (current.kind === "checking" || current.kind === "downloading" || current.kind === "ready") return;
    const previous = current;
    set({ kind: "checking" });
    try {
      const update = await deps.check();
      pending = update;
      if (update) set({ kind: "available", version: update.version, notes: update.body });
      else set(silent ? { kind: "idle" } : { kind: "upToDate" });
    } catch (error) {
      if (!silent) set({ kind: "error", message: messageOf(error) });
      // A failed background re-check must not hide an update found earlier.
      else set(previous.kind === "available" ? previous : { kind: "idle" });
    }
  }

  async function installUpdate(): Promise<void> {
    if (!pending || current.kind !== "available") return;
    const update = pending;
    let downloaded = 0;
    let total: number | undefined;
    set({ kind: "downloading", downloaded, total });
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength;
        else if (event.event === "Progress") downloaded += event.data.chunkLength;
        set({ kind: "downloading", downloaded, total });
      });
      set({ kind: "ready" });
      await deps.relaunch();
    } catch (error) {
      set({ kind: "error", message: messageOf(error) });
    }
  }

  return { checkForUpdates, installUpdate };
}
