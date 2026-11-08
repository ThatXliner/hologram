// Opt-in taste model: a fixed generic prior plus a shrunk personal residual learned from the
// user's past reviews across shoots. Port of the research recipe "R5" (HologramResearch
// claude-xshoot-08), which beat the pre-review AutoCull ranking on every development shoot.
import { AESTHETIC_BIAS, AESTHETIC_WEIGHTS, CLIP_IQA_BAD, CLIP_IQA_GOOD } from "./tasteModelConstants.ts";
import type { CullFlag } from "./types.ts";

export const TASTE_MODEL_VERSION = "taste-r5-v1";
const LAMBDAS = [0, 0.25, 0.5, 1, 2];
const PCS = 16;
const C = 0.1;
const FIXED_EFFECT_SCALE = 3;

export type TasteRow = {
  id: string;
  shoot: string;
  // Capture family (RAW+JPEG siblings) and capture block (family, visual cluster, or <=2 s apart).
  family: string;
  block: string;
  technical: number;
  clip: number[];
};

export type TasteSignals = { prior: number[]; context: number[][] };

export type TasteModel = {
  lambda: number;
  // Mean leave-one-shoot-out capture AUC per candidate lambda (-1 when not estimable).
  selection: number[];
  shoots: number;
  trainingRows: number;
  generic: GenericStage | null;
  residual: ResidualStage | null;
};

type GenericStage = { mean: number; sd: number; weight: number };
type ResidualStage = { pcaMean: number[]; components: number[][]; mean: number[]; sd: number[]; weights: number[] };
type Signal = (row: TasteRow, clip: number[]) => number;

// Reject/retain from a review: explicit reject always rejects; pick + 1 star conflicts; 1 star
// rejects; 2-5 stars or a pick retain; anything else is unknown and never trains.
export function tasteLabel(flag: CullFlag, rating: number): 1 | 0 | null {
  if (flag === "reject") return 1;
  if (flag === "pick") return rating === 1 ? null : 0;
  if (rating === 1) return 1;
  if (rating >= 2 && rating <= 5) return 0;
  return null;
}

function unit(vector: number[]): number[] {
  const norm = Math.hypot(...vector);
  return norm > 0 ? vector.map((value) => value / norm) : vector.map(() => 0);
}

function dot(left: ArrayLike<number>, right: ArrayLike<number>): number {
  let sum = 0;
  for (let index = 0; index < left.length; index++) sum += left[index] * right[index];
  return sum;
}

function groupIndices(keys: string[]): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  keys.forEach((key, index) => {
    const members = groups.get(key);
    if (members) members.push(index);
    else groups.set(key, [index]);
  });
  return groups;
}

function zWithin(values: number[], shoots: string[]): number[] {
  const out = new Array<number>(values.length).fill(0);
  for (const members of groupIndices(shoots).values()) {
    const mean = members.reduce((sum, index) => sum + values[index], 0) / members.length;
    const sd = Math.sqrt(members.reduce((sum, index) => sum + (values[index] - mean) ** 2, 0) / members.length);
    for (const index of members) out[index] = (values[index] - mean) / (sd + 1e-9);
  }
  return out;
}

const aestheticOf: Signal = (_, clip) => dot(clip, AESTHETIC_WEIGHTS) + AESTHETIC_BIAS;
const badnessOf: Signal = (_, clip) => dot(clip, CLIP_IQA_BAD) - dot(clip, CLIP_IQA_GOOD);

// Generic prior P = z(technical) + z(aesthetic) - z(CLIP-IQA badness), standardized within each
// shoot, plus label-free within-shoot context features.
export function tasteSignals(rows: TasteRow[]): TasteSignals {
  const shoots = rows.map((row) => row.shoot);
  const clips = rows.map((row) => unit(row.clip));
  const aesthetic = rows.map((row, index) => aestheticOf(row, clips[index]));
  const technical = zWithin(rows.map((row) => row.technical), shoots);
  const a = zWithin(aesthetic, shoots);
  const b = zWithin(rows.map((row, index) => badnessOf(row, clips[index])), shoots);
  return { prior: rows.map((_, index) => technical[index] + a[index] - b[index]),
    context: contextFeatures(rows, rows.map((row) => row.technical), aesthetic) };
}

const pct = (values: number[]) => {
  const order = values.map((value, index) => [value, index] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(values.length);
  order.forEach(([, index], rank) => { out[index] = (rank + 0.5) / values.length; });
  return out;
};

// Per shoot: relative quality within the shoot and its capture blocks, near-duplicate similarity,
// and whether a better near-duplicate exists. Each column is standardized within the shoot.
export function contextFeatures(rows: TasteRow[], quality: number[], aesthetic: number[]): number[][] {
  const out = rows.map(() => new Array<number>(15).fill(0));
  for (const members of groupIndices(rows.map((row) => row.shoot)).values()) {
    const n = members.length;
    const clips = members.map((index) => Float64Array.from(unit(rows[index].clip)));
    const zq = zWithin(members.map((index) => quality[index]), members.map(() => ""));
    const za = zWithin(members.map((index) => aesthetic[index]), members.map(() => ""));
    const pq = pct(members.map((index) => quality[index]));
    const pa = pct(members.map((index) => aesthetic[index]));
    const family = members.map((index) => rows[index].family);
    const sim = clips.map(() => new Float64Array(n));
    for (let i = 0; i < n; i++) {
      for (let j = i; j < n; j++) sim[i][j] = sim[j][i] = dot(clips[i], clips[j]);
    }
    const local = members.map(() => new Array<number>(15).fill(0));
    for (const block of groupIndices(members.map((index) => rows[index].block)).values()) {
      const families = new Set(block.map((i) => family[i])).size;
      for (const i of block) {
        const f = local[i];
        f[4] = Math.log(families);
        f[7] = families === 1 ? 1 : 0;
        const others = block.filter((j) => family[j] !== family[i]);
        if (!others.length) continue;
        const max = (values: number[]) => Math.max(...values);
        const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
        f[5] = max(others.map((j) => sim[i][j]));
        f[9] = zq[i] - max(others.map((j) => zq[j]));
        f[0] = za[i] - max(others.map((j) => za[j]));
        f[10] = zq[i] - mean(others.map((j) => zq[j]));
        f[1] = za[i] - mean(others.map((j) => za[j]));
        const better = others.filter((j) => zq[j] + za[j] > zq[i] + za[i]);
        f[8] = better.length ? max(better.map((j) => sim[i][j])) : 0;
        f[6] = better.length / others.length;
      }
    }
    for (let i = 0; i < n; i++) {
      const sorted = Float64Array.from(sim[i], (value, j) => (family[j] === family[i] ? -1 : value)).sort();
      local[i][13] = sorted[n - 1];
      local[i][14] = n > 5 ? sorted.slice(-5).reduce((sum, value) => sum + value, 0) / 5 : sorted[n - 1];
      local[i][2] = pa[i];
      local[i][3] = za[i];
      local[i][11] = pq[i];
      local[i][12] = zq[i];
    }
    for (let column = 0; column < 15; column++) {
      const standardized = zWithin(local.map((f) => f[column]), local.map(() => ""));
      members.forEach((index, i) => { out[index][column] = standardized[i]; });
    }
  }
  return out;
}

// Equal weight per shoot, split equally across capture families, normalized to mean 1.
function sampleWeights(rows: TasteRow[], indices: number[]): number[] {
  const weights = new Map<number, number>();
  for (const members of groupIndices(indices.map((index) => rows[index].shoot)).values()) {
    const families = groupIndices(members.map((member) => rows[indices[member]].family));
    for (const family of families.values()) {
      for (const position of family) weights.set(members[position], 1 / (families.size * family.length));
    }
  }
  const raw = indices.map((_, member) => weights.get(member) ?? 0);
  const total = raw.reduce((sum, value) => sum + value, 0);
  return raw.map((value) => value / total * indices.length);
}

function solve(matrix: number[][], vector: number[]): number[] {
  const n = vector.length;
  const a = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < n; column++) {
    let pivot = column;
    for (let row = column + 1; row < n; row++) if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
    [a[column], a[pivot]] = [a[pivot], a[column]];
    const head = a[column][column] || 1e-12;
    for (let row = 0; row < n; row++) {
      if (row === column) continue;
      const factor = a[row][column] / head;
      if (factor !== 0) for (let k = column; k <= n; k++) a[row][k] -= factor * a[column][k];
    }
  }
  return a.map((row, index) => row[n] / (a[index][index] || 1e-12));
}

// Minimizes C * sum(w * logloss(offset + X b)) + 0.5 * |b[penalized]|^2 with Newton steps.
function logistic(x: number[][], y: number[], w: number[], offset: number[], penalized: boolean[]): number[] {
  const d = penalized.length;
  let beta = new Array<number>(d).fill(0);
  for (let iteration = 0; iteration < 50; iteration++) {
    const gradient = beta.map((value, j) => (penalized[j] ? value : 0));
    const hessian = Array.from({ length: d }, (_, j) => Array.from({ length: d }, (_, k) => (j === k && penalized[j] ? 1 : 0)));
    for (let i = 0; i < x.length; i++) {
      const p = 1 / (1 + Math.exp(-(offset[i] + dot(x[i], beta))));
      const g = C * w[i] * (p - y[i]);
      const h = C * w[i] * Math.max(p * (1 - p), 1e-10);
      for (let j = 0; j < d; j++) {
        gradient[j] += g * x[i][j];
        for (let k = 0; k <= j; k++) hessian[j][k] += h * x[i][j] * x[i][k];
      }
    }
    for (let j = 0; j < d; j++) for (let k = 0; k < j; k++) hessian[k][j] = hessian[j][k];
    const step = solve(hessian, gradient);
    beta = beta.map((value, j) => value - step[j]);
    if (Math.max(...step.map(Math.abs)) < 1e-9) break;
  }
  return beta;
}

function shootColumns(rows: TasteRow[], indices: number[]): number[][] {
  const shoots = [...new Set(indices.map((index) => rows[index].shoot))].sort();
  return indices.map((index) => shoots.map((shoot) => (rows[index].shoot === shoot ? FIXED_EFFECT_SCALE : 0)));
}

function fitGeneric(rows: TasteRow[], prior: number[], labels: number[], indices: number[]) {
  const values = indices.map((index) => prior[index]);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const sd = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length) + 1e-9;
  const effects = shootColumns(rows, indices);
  const x = indices.map((_, member) => [(values[member] - mean) / sd, ...effects[member], 1]);
  const penalized = [true, ...effects[0].map(() => true), false];
  const beta = logistic(x, indices.map((index) => labels[index]), sampleWeights(rows, indices), new Array(indices.length).fill(0), penalized);
  return { stage: { mean, sd, weight: beta[0] }, decision: x.map((row) => dot(row, beta)) };
}

function genericScore(stage: GenericStage, prior: number): number {
  return (prior - stage.mean) / stage.sd * stage.weight;
}

// Top principal axes by subspace iteration on the covariance matrix.
function principalComponents(data: number[][], count: number): { mean: number[]; components: number[][] } {
  const dims = data[0].length;
  const mean = Array.from({ length: dims }, (_, j) => data.reduce((sum, row) => sum + row[j], 0) / data.length);
  const centered = data.map((row) => row.map((value, j) => value - mean[j]));
  const covariance = Array.from({ length: dims }, () => new Float64Array(dims));
  for (const row of centered) {
    for (let j = 0; j < dims; j++) {
      const value = row[j];
      if (value === 0) continue;
      const target = covariance[j];
      for (let k = j; k < dims; k++) target[k] += value * row[k];
    }
  }
  for (let j = 0; j < dims; j++) for (let k = 0; k < j; k++) covariance[j][k] = covariance[k][j];
  const multiply = (vector: Float64Array) => {
    const next = new Float64Array(dims);
    for (let j = 0; j < dims; j++) next[j] = dot(covariance[j], vector);
    return next;
  };
  // Oversample the block so the top `count` axes converge at the gap to axis count+10, not count+1.
  const block = Math.min(dims, count + 10);
  let basis = Array.from({ length: block }, (_, c) => Float64Array.from({ length: dims }, (_, j) => Math.sin((c + 1) * (j + 1))));
  for (let iteration = 0; iteration < 40; iteration++) {
    basis = basis.map(multiply);
    for (let c = 0; c < block; c++) {
      const vector = basis[c];
      for (let previous = 0; previous < c; previous++) {
        const projection = dot(vector, basis[previous]);
        for (let j = 0; j < dims; j++) vector[j] -= projection * basis[previous][j];
      }
      const norm = Math.sqrt(dot(vector, vector)) || 1;
      for (let j = 0; j < dims; j++) vector[j] /= norm;
    }
  }
  // Rayleigh-Ritz: rotate to exact eigenvectors within the converged subspace.
  const images = basis.map(multiply);
  const projected = basis.map((left) => images.map((right) => dot(left, right)));
  const rotation = symmetricEigenvectors(projected);
  return { mean, components: rotation.slice(0, count).map((weights) => Array.from({ length: dims }, (_, j) =>
    weights.reduce((sum, weight, c) => sum + weight * basis[c][j], 0))) };
}

// Eigenvectors of a small symmetric matrix (cyclic Jacobi), ordered by descending eigenvalue.
function symmetricEigenvectors(input: number[][]): number[][] {
  const n = input.length;
  const a = input.map((row) => [...row]);
  const v: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] ** 2;
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return Array.from({ length: n }, (_, i) => i).sort((i, j) => a[j][j] - a[i][i]).map((i) => v.map((row) => row[i]));
}

function residualDesign(stage: Pick<ResidualStage, "pcaMean" | "components">, clip: number[], context: number[]): number[] {
  const centered = clip.map((value, j) => value - stage.pcaMean[j]);
  return [...context, ...stage.components.map((component) => dot(component, centered))];
}

function fitResidual(rows: TasteRow[], context: number[][], labels: number[], indices: number[], offset: number[]): ResidualStage {
  const count = Math.min(PCS, indices.length - 1, rows[0].clip.length);
  const { mean: pcaMean, components } = principalComponents(indices.map((index) => rows[index].clip), count);
  const design = indices.map((index) => residualDesign({ pcaMean, components }, rows[index].clip, context[index]));
  const mean = design[0].map((_, c) => design.reduce((sum, row) => sum + row[c], 0) / design.length);
  const sd = design[0].map((_, c) => Math.sqrt(design.reduce((sum, row) => sum + (row[c] - mean[c]) ** 2, 0) / design.length) + 1e-9);
  const effects = shootColumns(rows, indices);
  const x = design.map((row, member) => [...row.map((value, c) => (value - mean[c]) / sd[c]), ...effects[member]]);
  const beta = logistic(x, indices.map((index) => labels[index]), sampleWeights(rows, indices), offset, x[0].map(() => true));
  return { pcaMean, components, mean, sd, weights: beta.slice(0, mean.length) };
}

function residualScore(stage: ResidualStage, clip: number[], context: number[]): number {
  return residualDesign(stage, clip, context).reduce((sum, value, c) => sum + (value - stage.mean[c]) / stage.sd[c] * stage.weights[c], 0);
}

function hasBothClasses(labels: number[], indices: number[]): boolean {
  const reject = indices.some((index) => labels[index] === 1);
  const retain = indices.some((index) => labels[index] === 0);
  return reject && retain;
}

// Capture-level AUC: one score per family (mean), one label per family.
function captureAuc(rows: TasteRow[], labels: number[], indices: number[], scores: number[]): number | null {
  const families = groupIndices(indices.map((index) => rows[index].family));
  const units = [...families.values()].map((members) => ({
    label: labels[indices[members[0]]],
    score: members.reduce((sum, member) => sum + scores[member], 0) / members.length,
  }));
  const positives = units.filter((item) => item.label === 1);
  const negatives = units.filter((item) => item.label === 0);
  if (!positives.length || !negatives.length) return null;
  let wins = 0;
  for (const positive of positives) {
    for (const negative of negatives) wins += positive.score > negative.score ? 1 : positive.score === negative.score ? 0.5 : 0;
  }
  return wins / (positives.length * negatives.length);
}

// Capture families are rejected only when every reviewed file in them is a reject.
export function captureLabels(rows: TasteRow[], fileLabels: number[]): number[] {
  const labels = [...fileLabels];
  for (const members of groupIndices(rows.map((row) => row.family)).values()) {
    const label = members.every((index) => fileLabels[index] === 1) ? 1 : 0;
    for (const index of members) labels[index] = label;
  }
  return labels;
}

function fitPair(rows: TasteRow[], signals: TasteSignals, labels: number[], indices: number[]) {
  const generic = fitGeneric(rows, signals.prior, labels, indices);
  return { generic: generic.stage, residual: fitResidual(rows, signals.context, labels, indices, generic.decision) };
}

// rows: labelled history (fileLabels: 1 reject, 0 retain). Falls back to the generic prior alone
// when there is too little history to learn from.
export function fitTasteModel(rows: TasteRow[], fileLabels: number[]): TasteModel {
  return fitWithSignals(rows, tasteSignals(rows), fileLabels);
}

export function fitWithSignals(rows: TasteRow[], signals: TasteSignals, fileLabels: number[]): TasteModel {
  const prior = signals.prior;
  const all = rows.map((_, index) => index);
  const shoots = [...new Set(rows.map((row) => row.shoot))].sort();
  const empty: TasteModel = { lambda: 0, selection: [], shoots: shoots.length, trainingRows: rows.length, generic: null, residual: null };
  if (rows.length < 8) return empty;
  const labels = captureLabels(rows, fileLabels);
  if (!hasBothClasses(labels, all)) return empty;
  const auc = new Map(LAMBDAS.map((lambda) => [lambda, [] as number[]]));
  for (const held of shoots) {
    const query = all.filter((index) => rows[index].shoot === held);
    const train = all.filter((index) => rows[index].shoot !== held);
    if (train.length < 8 || !hasBothClasses(labels, train) || !hasBothClasses(labels, query)) continue;
    const pair = fitPair(rows, signals, labels, train);
    const g = query.map((index) => genericScore(pair.generic, prior[index]));
    const r = query.map((index) => residualScore(pair.residual, rows[index].clip, signals.context[index]));
    for (const lambda of LAMBDAS) {
      const value = captureAuc(rows, labels, query, g.map((value, i) => value + lambda * r[i]));
      if (value !== null) auc.get(lambda)!.push(value);
    }
  }
  const means = LAMBDAS.map((lambda) => {
    const values = auc.get(lambda)!;
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : -1;
  });
  const best = Math.max(...means);
  const lambda = best < 0 ? 0 : LAMBDAS[means.findIndex((value) => value >= best - 1e-12)];
  const pair = fitPair(rows, signals, labels, all);
  return { lambda, selection: means, shoots: shoots.length, trainingRows: rows.length, generic: pair.generic, residual: lambda > 0 ? pair.residual : null };
}

// Higher = more likely a reject. Rows must all come from one shoot (the one being culled); prior
// standardization uses only that shoot's own photos.
export function scoreTasteModel(model: TasteModel, rows: TasteRow[]): number[] {
  return scoreWithSignals(model, rows, tasteSignals(rows.map((row) => ({ ...row, shoot: "target" }))));
}

export function scoreWithSignals(model: TasteModel, rows: TasteRow[], signals: TasteSignals): number[] {
  return rows.map((row, index) => {
    const generic = model.generic ? genericScore(model.generic, signals.prior[index]) : -signals.prior[index];
    return generic + (model.residual ? model.lambda * residualScore(model.residual, row.clip, signals.context[index]) : 0);
  });
}
