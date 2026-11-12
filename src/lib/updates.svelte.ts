import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { createUpdater, type UpdateStatus } from "./updates.ts";

export type { UpdateStatus } from "./updates.ts";

export const updates = $state<{ status: UpdateStatus }>({ status: { kind: "idle" } });

export const { checkForUpdates, installUpdate } = createUpdater({ check, relaunch }, (status) => {
  updates.status = status;
});
