import { CELL, NX, NY, NZ, WORLD_X, WORLD_Y, WORLD_Z, Geo } from './config';
import { clamp } from './FieldMath';

/**
 * ワールド全体の密度場と地質場。
 *
 * **チャンクごとに独立した配列を持たない。** ワールド全体で 1 本の連続配列にし、
 * チャンクはその添字範囲を読むだけにする。こうすると各チャンクが隣接セルの
 * 「真の値」を読めるので、境界の頂点位置が厳密に一致し、継ぎ目が原理的に発生しない。
 *
 * 格納はノード (格子点) 単位。ノード (i,j,k) のワールド座標は (i,j,k) * CELL。
 * 符号の規約は FieldMath と同じで、正 = 固体。
 */
export class VoxelField {
  readonly nx = NX;
  readonly ny = NY;
  readonly nz = NZ;
  readonly cell = CELL;

  /** 密度 (正 = 固体)。長さ NX*NY*NZ。 */
  readonly density: Float32Array;
  /** 地質 ID (Geo)。密度と同じ格子。 */
  readonly material: Uint8Array;

  /** SharedArrayBuffer が使えたか。ワーカーへのゼロコピー可否の判定に使う。 */
  readonly shared: boolean;

  /** 添字ストライド。x が最速で動く。 */
  readonly strideY = NX;
  readonly strideZ = NX * NY;

  constructor() {
    const n = NX * NY * NZ;
    const canShare =
      typeof SharedArrayBuffer !== 'undefined' &&
      typeof globalThis.crossOriginIsolated !== 'undefined' &&
      globalThis.crossOriginIsolated === true;

    if (canShare) {
      this.density = new Float32Array(new SharedArrayBuffer(n * 4));
      this.material = new Uint8Array(new SharedArrayBuffer(n));
      this.shared = true;
    } else {
      this.density = new Float32Array(n);
      this.material = new Uint8Array(n);
      this.shared = false;
    }
  }

  /** ノード添字 → 配列添字。範囲チェックはしない (呼び出し側の責任)。 */
  idx(i: number, j: number, k: number): number {
    return i + j * this.strideY + k * this.strideZ;
  }

  /** 範囲外を安全にクランプして読む。 */
  densityAtNode(i: number, j: number, k: number): number {
    const ci = clamp(i, 0, NX - 1) | 0;
    const cj = clamp(j, 0, NY - 1) | 0;
    const ck = clamp(k, 0, NZ - 1) | 0;
    return this.density[ci + cj * this.strideY + ck * this.strideZ];
  }

  materialAtNode(i: number, j: number, k: number): number {
    const ci = clamp(i, 0, NX - 1) | 0;
    const cj = clamp(j, 0, NY - 1) | 0;
    const ck = clamp(k, 0, NZ - 1) | 0;
    return this.material[ci + cj * this.strideY + ck * this.strideZ];
  }

  /** ワールド座標での三線形補間サンプル。ワールド外は境界値の外挿ではなくクランプ。 */
  sample(x: number, y: number, z: number): number {
    const gx = x / CELL;
    const gy = y / CELL;
    const gz = z / CELL;
    const i = Math.floor(gx);
    const j = Math.floor(gy);
    const k = Math.floor(gz);
    const fx = gx - i;
    const fy = gy - j;
    const fz = gz - k;

    const d000 = this.densityAtNode(i, j, k);
    const d100 = this.densityAtNode(i + 1, j, k);
    const d010 = this.densityAtNode(i, j + 1, k);
    const d110 = this.densityAtNode(i + 1, j + 1, k);
    const d001 = this.densityAtNode(i, j, k + 1);
    const d101 = this.densityAtNode(i + 1, j, k + 1);
    const d011 = this.densityAtNode(i, j + 1, k + 1);
    const d111 = this.densityAtNode(i + 1, j + 1, k + 1);

    const c00 = d000 + (d100 - d000) * fx;
    const c10 = d010 + (d110 - d010) * fx;
    const c01 = d001 + (d101 - d001) * fx;
    const c11 = d011 + (d111 - d011) * fx;
    const c0 = c00 + (c10 - c00) * fy;
    const c1 = c01 + (c11 - c01) * fy;
    return c0 + (c1 - c0) * fz;
  }

  /** ワールド座標が固体の内側か。 */
  isSolid(x: number, y: number, z: number): boolean {
    return this.sample(x, y, z) > 0;
  }

  /** ワールド座標に最も近いノードの地質。 */
  materialAt(x: number, y: number, z: number): Geo {
    const i = Math.round(x / CELL);
    const j = Math.round(y / CELL);
    const k = Math.round(z / CELL);
    return this.materialAtNode(i, j, k) as Geo;
  }

  inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x <= WORLD_X && y <= WORLD_Y && z <= WORLD_Z;
  }
}
