import { fitTasteModel, type TasteRow } from "./tasteModel.ts";

self.onmessage = (event: MessageEvent<{ rows: TasteRow[]; labels: number[] }>) => {
  try {
    self.postMessage({ model: fitTasteModel(event.data.rows, event.data.labels) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
