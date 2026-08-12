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
}

const EMPTY: EditResult = {
  volumeByGeo: new Float64Array(GEO_COUNT),
  totalVolume: 0,
  changed: false,
  min: [0, 0, 0],
  max: [0, 0, 0],
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
  };
}
