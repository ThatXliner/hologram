import type { CullFlag } from "./types.ts";

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const shortcutMod = isMac ? "⌘" : "Ctrl+";
export const shortcutAlt = isMac ? "⌥" : "Alt+";

export function ariaKeys(label: string): string {
  return label.replace("⌘", "Meta+").replace("Ctrl+", "Control+").replace("⌥", "Alt+").replace("⇧", "Shift+");
}

export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return !!element && (element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName));
}

export function keepsNativeActivation(event: KeyboardEvent): boolean {
  const element = event.target as HTMLElement | null;
  return (event.key === "Enter" || event.key === " ") && !!element && ["BUTTON", "A", "SUMMARY"].includes(element.tagName);
}

export function shouldIgnoreShortcut(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  return event.defaultPrevented || isTypingTarget(target) || !!target?.closest?.("dialog[open]");
}

export function hasCommandModifier(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey;
}

/** Matches event.code, not event.key: macOS Option rewrites event.key (Option+1 is "¡"). */
export function altDigit(event: KeyboardEvent): number | null {
  if (!event.altKey || hasCommandModifier(event) || event.shiftKey) return null;
  const match = /^Digit([0-9])$/.exec(event.code);
  return match ? Number(match[1]) : null;
}

export interface ShortcutSection {
  title: string;
  items: { keys: string; action: string }[];
}

export const SHORTCUT_SECTIONS: ShortcutSection[] = [
  {
    title: "Anywhere",
    items: [
      { keys: `${shortcutMod}1 / 2 / 3`, action: "Library / AutoCull / Export" },
      { keys: `${shortcutMod},`, action: "Settings" },
      { keys: `${shortcutMod}O`, action: "Open a photo folder" },
      { keys: "?", action: "Show keyboard shortcuts" },
      { keys: "Esc", action: "Close a dialog, panel or field" },
    ],
  },
  {
    title: "Library",
    items: [
      { keys: "← ↑ ↓ →", action: "Move between photos" },
      { keys: "Home / End", action: "First / last photo" },
      { keys: "Space / Enter", action: "Open the selected photo" },
      { keys: "P / X / U", action: "Pick / reject / clear" },
      { keys: "0–5", action: "Set star rating" },
      { keys: `/ or ${shortcutMod}F`, action: "Search" },
      { keys: "F", action: "Show or hide filters" },
      { keys: "G / T", action: "Grid / timeline" },
      { keys: "+ / −", action: "Larger / smaller thumbnails" },
      { keys: `${shortcutAlt}1–4`, action: "All / picks / rejects / unmarked" },
      { keys: "H", action: "Hide rejected photos" },
      { keys: `${shortcutMod}S`, action: "Save this search" },
    ],
  },
  {
    title: "AutoCull",
    items: [
      { keys: "Enter", action: "Summary: start review · Review: finish stack" },
      { keys: "A", action: "Apply AutoCull (summary)" },
      { keys: "← →", action: "Previous / next frame" },
      { keys: "↑ ↓", action: "Previous / next stack" },
      { keys: "P / X / U", action: "Keep / reject / clear" },
      { keys: "0–5", action: "Set star rating" },
      { keys: "S", action: "Keep the suggested frame" },
      { keys: "⇧P", action: "Keep this frame, reject the undecided rest" },
      { keys: "⇧X", action: "Reject the whole stack" },
      { keys: "N", action: "Skip to the next stack" },
      { keys: "Space", action: "Open the loupe" },
      { keys: "I", action: "Show or hide details" },
      { keys: "R", action: "Refresh analysis" },
      { keys: `${shortcutAlt}1–3`, action: "All / to review / issues" },
      { keys: `${shortcutMod}E`, action: "Export keepers" },
      { keys: `${shortcutMod}Z`, action: "Undo" },
      { keys: "Esc", action: "Back to the summary" },
    ],
  },
  {
    title: "Photo viewer",
    items: [
      { keys: "← → / ↑ ↓", action: "Previous / next photo" },
      { keys: "Home / End", action: "First / last photo" },
      { keys: "P / X / U", action: "Pick / reject / clear" },
      { keys: "0–5", action: "Set star rating" },
      { keys: "A", action: "Toggle auto advance" },
      { keys: "+ / − / F", action: "Zoom in / out / fit" },
      { keys: "R", action: "Switch RAW / JPEG" },
      { keys: "D", action: "Compare" },
      { keys: "E", action: "Adjust" },
      { keys: "O", action: "Open in the system viewer" },
      { keys: "T", action: "Add a tag" },
      { keys: "Enter", action: "AutoCull loupe: finish stack" },
      { keys: "⇧X", action: "AutoCull loupe: reject the whole stack" },
      { keys: "Space / Esc", action: "Close the viewer" },
    ],
  },
  {
    title: "Export",
    items: [
      { keys: `${shortcutMod}Enter`, action: "Start the export" },
    ],
  },
];

export interface CullKey {
  flag?: CullFlag;
  rating?: number;
  advance: boolean;
}

export function cullKeyAction(event: KeyboardEvent): CullKey | null {
  if (event.shiftKey || event.altKey || hasCommandModifier(event)) return null;
  const key = event.key.toLowerCase();
  if (/^[0-5]$/.test(key)) return { rating: Number(key), advance: Number(key) > 0 };
  if (key === "p") return { flag: "pick", advance: true };
  if (key === "x") return { flag: "reject", advance: true };
  if (key === "u") return { flag: "none", rating: 0, advance: false };
  return null;
}
