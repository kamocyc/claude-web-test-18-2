import { CELL, NX, NY, NZ, GEO_COUNT, Geo } from './config';
import { capsuleSolid, occupancy, smin, smax, clamp } from './FieldMath';
import type { VoxelField } from './VoxelField';
import type { ChunkManager } from './ChunkManager';

/**
 * 密度場への書き込みは全部ここを通す。
 * ここが唯一の書き込み口なので、
 *   - どのチャンクが dirty になったか
 *   - どの地質を何 m^3 動かしたか
 * を取りこぼさずに集約できる。構造物の再評価もこの出力を種にする。
 */

export interface EditResult {
  /** 地質ごとの掘削体積 [m^3]。盛土のときは負。 */
  volumeByGeo: Float64Array;
  /** 掘削体積の合計 [m^3]。 */
  totalVolume: number;
  /** 実際に値が変わったか。 */
  changed: boolean;
  /** 影響範囲のワールド AABB。構造物の再評価に使う。 */
  min: [number, number, number];
  max: [number, number, number];
  /**
   * 編集した**形そのもの**が届いた高さの上限 [m]。AABB の余白を含まない。
   *
   * max[1] は形を pad (半径 + ブレンド幅 + 2 セル = 4.1 m) ぶん膨らませた値
   * なので、「その列の地表まで掘削が届いたか」の判定には使えない。
   * 4.1 m 高く見えるので、地表を触っていない列まで触ったことにしてしまう。
   * 安息角の整定がこれを使う (Repose.seedFromEdit)。
   */
  reachY: number;
}

const EMPTY: EditResult = {
  volumeByGeo: new Float64Array(GEO_COUNT),
  totalVolume: 0,
  changed: false,
  min: [0, 0, 0],
  max: [0, 0, 0],
  reachY: -Infinity,
};

export type EditMode = 'dig' | 'fill';

const volScratch = new Float64Array(GEO_COUNT);

/**
 * スイープしたカプセルで掘る / 盛る。
 *
 * ブレンド幅 k がこのプロトタイプの肝。単純な max/min で削ると、
 * ブラシの縁と既存地表の交線に鋭い折れ目ができる。その折れ目が格子を
 * 斜めに横切ると、そこだけ階段状に見えてしまう。
 * スムーズ演算で半径 k のフィレットを入れると、斜めのトンネルが
 * 山肌から自然に開口し、ストロークの継ぎ目も消える。
 */
export function applyCapsule(
  field: VoxelField,
  chunks: ChunkManager,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  radius: number,
  mode: EditMode,
  k = 0.45,
  fillGeo: Geo = Geo.Soil,
): EditResult {
  const pad = radius + k + 2 * CELL;
  const minX = Math.min(ax, bx) - pad;
  const minY = Math.min(ay, by) - pad;
  const minZ = Math.min(az, bz) - pad;
  const maxX = Math.max(ax, bx) + pad;
  const maxY = Math.max(ay, by) + pad;
  const maxZ = Math.max(az, bz) + pad;

  const i0 = Math.max(0, Math.floor(minX / CELL));
  const j0 = Math.max(0, Math.floor(minY / CELL));
  const k0 = Math.max(0, Math.floor(minZ / CELL));
  const i1 = Math.min(NX - 1, Math.ceil(maxX / CELL));
  const j1 = Math.min(NY - 1, Math.ceil(maxY / CELL));
  const k1 = Math.min(NZ - 1, Math.ceil(maxZ / CELL));
  if (i0 > i1 || j0 > j1 || k0 > k1) return EMPTY;

  const { density, material } = field;
  const cellVol = CELL * CELL * CELL;
  volScratch.fill(0);
  let total = 0;
  let changed = false;

  for (let kk = k0; kk <= k1; kk++) {
    const z = kk * CELL;
    for (let jj = j0; jj <= j1; jj++) {
      const y = jj * CELL;
      let idx = i0 + jj * field.strideY + kk * field.strideZ;
      for (let ii = i0; ii <= i1; ii++, idx++) {
        const x = ii * CELL;

        const solid = capsuleSolid(x, y, z, ax, ay, az, bx, by, bz, radius);
        const dOld = density[idx];

        // カプセルの外側でも、そこが新しい壁面に近くなったのなら
        // 距離場としては値を下げなければならない。
        // 「カプセルから遠いから触らない」で済ませると、掘った直後のセルの
        // 隣に古い大きな値が残り、エッジ交点の補間位置がずれて
        // 坑口まわりのメッシュがささくれる。
        let dNew: number;
        if (mode === 'dig') {
          if (-solid >= dOld + k) continue;
          dNew = smin(dOld, -solid, k);
        } else {
          if (solid <= dOld - k) continue;
          dNew = smax(dOld, solid, k);
        }
        dNew = clamp(dNew, -8, 8);
        if (dNew === dOld) continue;

        const occOld = occupancy(dOld, CELL);
        const occNew = occupancy(dNew, CELL);
        const dv = (occOld - occNew) * cellVol;

        if (dv > 0) {
          // 削れた: 元々そこにあった地質の勘定
          volScratch[material[idx]] += dv;
          total += dv;
        } else if (dv < 0) {
          // 盛った: 新しく固体になった所は盛土材の地質にする
          volScratch[fillGeo] += dv;
          total += dv;
          if (occNew > 0.5 && occOld <= 0.5) material[idx] = fillGeo;
        }

        density[idx] = dNew;
        changed = true;
      }
    }
  }

  if (!changed) return EMPTY;

  chunks.markDirtyByAABB(minX, minY, minZ, maxX, maxY, maxZ);

  return {
    volumeByGeo: Float64Array.from(volScratch),
    totalVolume: total,
    changed: true,
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    reachY: Math.max(ay, by) + radius,
  };
}

/** 1 列ぶんの書き戻し指示。 */
export interface ColumnHeightWrite {
  i: number;
  k: number;
  /** 書き戻す前の地表の高さ [m]。 */
  hOld: number;
  /** 書き戻したあとの地表の高さ [m]。 */
  hNew: number;
  /** 1/sqrt(1 + |grad h|^2)。**整定後**の高さ場から作る。 */
  inv: number;
  /** この高さより下のノードには一切書かない [m]。空洞の天端 + 余裕。 */
  floor: number;
  /** 新しく固体になったノードに入れる地質 (運ばれてきた土の地質)。 */
  geo: Geo;
  /**
   * 削るときに上端をここまで伸ばす [m]。地表として採らなかった薄い庇の上端。
   * 庇を残すと、その列だけ高く取り残されて柱になる。
   */
  ceil: number;
}

/** 地表の上下に余分に書き直す幅 [m]。ここで古い値と繋がる。 */
const COLUMN_MARGIN = 3 * CELL;

/**
 * 列ごとの地表高さの変化を密度場へ書き戻す。安息角の整定の出口。
 *
 * 書く形は `d = (h - y) / sqrt(1 + |grad h|^2)`、つまり **Generator が初期地形を
 * 作るのに使っているのと同じ正規化ハイトフィールド**。だから整定した斜面は
 * 厳密な平面になり、周りの地形とも地続きになる。|grad d| が 1 に揃うので、
 * ブラシのブレンド幅 k の意味も場所によって変わらない。
 *
 * ---- なぜ smin/smax ではなく素の min/max なのか ----
 * `smin(a, a, k)` は `a - k/4`。k = 0.45 なら**一回かけるたびに 11 cm 沈む**ので、
 * 毎フレーム走る整定にスムーズ演算を使うと地面がじりじり削れ続ける。
 * 素の min/max は冪等 (`min(min(a,b),b) = min(a,b)`) なので、
 * 整定済みの世界にもう一度整定をかけても何も起きない。
 * ここで折れ目の心配が要らないのは、書く形がブラシのような塊ではなく
 * 列の中の**総入れ替え**だから。applyCapsule の smin とは事情が違う。
 *
 * ---- 空洞を埋めないための規則 ----
 *  - 削る側は min しか使わない。min は値を下げるだけなので、下に坑道があっても
 *    絶対に埋まらない。
 *  - 積む側は floor より下へ書かない。floor は最上面の下にある最初の空洞の
 *    天端 + ROOF_KEEP なので、坑道の天端に届く手前で止まる。
 */
export function applyColumnHeights(
  field: VoxelField,
  chunks: ChunkManager | null,
  cols: readonly ColumnHeightWrite[],
): EditResult {
  if (cols.length === 0) return EMPTY;

  const { density, material, strideY, strideZ } = field;
  const cellVol = CELL * CELL * CELL;
  volScratch.fill(0);
  let total = 0;
  let changed = false;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let reachY = -Infinity;

  for (const c of cols) {
    const { i, k, hOld, hNew, inv, floor, geo } = c;

    if (i < 1 || i > NX - 2 || k < 1 || k > NZ - 2) continue;
    if (hNew === hOld) continue;
    const erode = hNew < hOld;

    // 書き直す帯。削る側は下へ、積む側は上へ伸ばす。
    const yLo = erode
      ? hNew - COLUMN_MARGIN
      : Math.max(hOld - COLUMN_MARGIN, floor);
    const yHi = (erode ? Math.max(hOld, c.ceil) : hNew) + COLUMN_MARGIN;

    // j = 0 は Generator が常に空気にしている床。触ると世界の底が抜ける。
    const j0 = Math.max(1, Math.ceil(yLo / CELL));
    const j1 = Math.min(NY - 1, Math.floor(yHi / CELL));
    if (j0 > j1) continue;

    let touched = false;
    let idx = i + j0 * strideY + k * strideZ;
    for (let j = j0; j <= j1; j++, idx += strideY) {
      const y = j * CELL;
      const dOld = density[idx];
      const dPlane = clamp((hNew - y) * inv, -8, 8);
      const dNew = erode
        ? (dPlane < dOld ? dPlane : dOld)
        : (dPlane > dOld ? dPlane : dOld);
      if (dNew === dOld) continue;

      const occOld = occupancy(dOld, CELL);
      const occNew = occupancy(dNew, CELL);
      const dv = (occOld - occNew) * cellVol;
      if (dv > 0) {
        volScratch[material[idx]] += dv;
        total += dv;
      } else if (dv < 0) {
        volScratch[geo] += dv;
        total += dv;
        if (occNew > 0.5 && occOld <= 0.5) material[idx] = geo;
      }

      density[idx] = dNew;
      touched = true;
    }

    if (!touched) continue;
    changed = true;
    const x = i * CELL;
    const z = k * CELL;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
    if (j0 * CELL < minY) minY = j0 * CELL;
    if (j1 * CELL > maxY) maxY = j1 * CELL;
    if (hOld > reachY) reachY = hOld;
    if (hNew > reachY) reachY = hNew;
  }

  if (!changed) return EMPTY;

  // 境界の頂点は隣の列にも依存するので 1 セル膨らませて報告する
  minX -= CELL; minY -= CELL; minZ -= CELL;
  maxX += CELL; maxY += CELL; maxZ += CELL;

  chunks?.markDirtyByAABB(minX, minY, minZ, maxX, maxY, maxZ);

  return {
    volumeByGeo: Float64Array.from(volScratch),
    totalVolume: total,
    changed: true,
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    reachY,
  };
}

/**
 * 1 フレーム内で複数回 applyCapsule したときに結果をまとめる。
 * 呼び出し側 (Excavator) が 1 フレーム = 1 件として経済と構造物再評価に流せるようにする。
 */
export function mergeEdits(a: EditResult, b: EditResult): EditResult {
  const v = new Float64Array(GEO_COUNT);
  for (let g = 0; g < GEO_COUNT; g++) v[g] = a.volumeByGeo[g] + b.volumeByGeo[g];
  return {
    volumeByGeo: v,
    totalVolume: a.totalVolume + b.totalVolume,
    changed: a.changed || b.changed,
    min: [
      Math.min(a.min[0], b.min[0]),
      Math.min(a.min[1], b.min[1]),
      Math.min(a.min[2], b.min[2]),
    ],
    max: [
      Math.max(a.max[0], b.max[0]),
      Math.max(a.max[1], b.max[1]),
      Math.max(a.max[2], b.max[2]),
    ],
    reachY: Math.max(a.reachY, b.reachY),
  };
}
