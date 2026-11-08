import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fixture from "./tasteModel.fixture.json" with { type: "json" };
import {
  captureLabels, contextFeatures, fitTasteModel, fitWithSignals, scoreTasteModel, scoreWithSignals, tasteLabel, type TasteRow,
} from "./tasteModel.ts";

function pearson(left: number[], right: number[]): number {
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const a = mean(left);
  const b = mean(right);
  let numerator = 0;
  let leftSquares = 0;
  let rightSquares = 0;
  left.forEach((value, index) => {
    numerator += (value - a) * (right[index] - b);
    leftSquares += (value - a) ** 2;
    rightSquares += (right[index] - b) ** 2;
  });
  return numerator / Math.sqrt(leftSquares * rightSquares);
}

function rows() {
  const data: TasteRow[] = fixture.rows.map((row, index) => ({ id: String(index), shoot: row.shoot, family: row.family,
    block: row.block, technical: row.technical, clip: row.clip }));
  const context = contextFeatures(data, fixture.rows.map((row) => row.technical), fixture.rows.map((row) => row.aesthetic));
  return { rows: data, prior: fixture.rows.map((row) => row.prior), context, labels: fixture.rows.map((row) => row.label) };
}

describe("taste model", () => {
  it("maps reviews to reject/retain like the research label contract", () => {
    assert.equal(tasteLabel("reject", 4), 1);
    assert.equal(tasteLabel("pick", 1), null);
    assert.equal(tasteLabel("pick", 0), 0);
    assert.equal(tasteLabel("none", 1), 1);
    assert.equal(tasteLabel("none", 3), 0);
    assert.equal(tasteLabel("none", 0), null);
  });

  it("keeps a capture whenever any of its files was kept", () => {
    const capture = [{ family: "a" }, { family: "a" }, { family: "b" }] as TasteRow[];
    assert.deepEqual(captureLabels(capture, [1, 0, 1]), [0, 0, 1]);
  });

  it("computes the research context features exactly", () => {
    const { context } = rows();
    const maxError = Math.max(...context.flatMap((row, i) => row.map((value, j) => Math.abs(value - fixture.context[i][j]))));
    assert.ok(maxError < 1e-6, `max error ${maxError}`);
  });

  it("matches the Python reference implementation on a synthetic fixture", () => {
    const { rows: data, prior, context, labels } = rows();
    const n = fixture.train;
    const model = fitWithSignals(data.slice(0, n), { prior: prior.slice(0, n), context: context.slice(0, n) }, labels.slice(0, n));
    assert.equal(model.lambda, fixture.lam);
    const scores = scoreWithSignals(model, data.slice(n), { prior: prior.slice(n), context: context.slice(n) });
    assert.ok(pearson(scores, fixture.expected) > 0.999, `parity ${pearson(scores, fixture.expected)}`);
    const maxError = Math.max(...scores.map((score, index) => Math.abs(score - fixture.expected[index])));
    assert.ok(maxError < 0.05, `max error ${maxError}`);
  });

  it("falls back to the generic prior without enough history", () => {
    const clip = (seed: number) => Array.from({ length: 512 }, (_, j) => Math.sin(seed * (j + 1)));
    const target = [0, 1, 2].map((seed) => ({ id: String(seed), shoot: "now", family: String(seed), block: "b", technical: seed / 2, clip: clip(seed + 1) }));
    const model = fitTasteModel([], []);
    assert.equal(model.generic, null);
    const scores = scoreTasteModel(model, target);
    assert.equal(scores.length, 3);
    assert.ok(scores.every(Number.isFinite));
  });
});
