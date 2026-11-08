// Opt-in AutoCull taste model settings. Off by default; the reject cutoff is the share of each
// shoot (lowest-ranked first) that AutoCull pre-marks as REJECT.
const KEY = "hologram.autocull.tasteModel.v1";

export type TasteSettings = { enabled: boolean; rejectPercent: number };

export const DEFAULT_TASTE_SETTINGS: TasteSettings = { enabled: false, rejectPercent: 10 };
export const MAX_REJECT_PERCENT = 60;

function clampPercent(value: unknown): number {
  const number = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_TASTE_SETTINGS.rejectPercent;
  return Math.min(MAX_REJECT_PERCENT, Math.max(0, Math.round(number)));
}

export function loadTasteSettings(): TasteSettings {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (!value || typeof value !== "object") return { ...DEFAULT_TASTE_SETTINGS };
    const item = value as Partial<TasteSettings>;
    return { enabled: item.enabled === true, rejectPercent: clampPercent(item.rejectPercent) };
  } catch {
    return { ...DEFAULT_TASTE_SETTINGS };
  }
}

export function saveTasteSettings(settings: TasteSettings): TasteSettings {
  const next = { enabled: settings.enabled, rejectPercent: clampPercent(settings.rejectPercent) };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* settings stay in memory */ }
  return next;
}
