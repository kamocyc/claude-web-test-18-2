import {
  CELL, NX, NY, NZ, Geo, GEO_COUNT, ROOF_KEEP,
  REPOSE_DEG, INSITU_DEG, REPOSE_SATURATED_DROP, WATER_TABLE_Y,
} from './config';
import type { VoxelField } from './VoxelField';

/**
 * 法面保護工が支える角度 [度]。添字は工法のレベル (0 = 無処理)。
 * 本体の定義は `src/game/SlopeWorks.ts`。角度だけここに写してあるのは、
 * terrain 層が game 層を import しないため (依存の向きを保つ)。
 * 値がずれると崩落の角度と表示が食い違うので、SlopeWorks.test.ts で突き合わせる。
 */
export const SLOPE_WORK_DEG = [0, 45, 65, 88];

/**
 * 密度場を「列 (x,z) ごとの地表高さ」として読む索引。
 *
 * 安息角の整定はこの 2 次元の高さ場の上で解く。3 次元の場で直接
 * 「急な所を削って下に積む」をやると、削る形と積む形の選び方に
 * 答えが依存してしまい、凸凹が残る (先行実装がそうだった)。
 * 高さ場なら停留点が |∇h| <= tan(θ) そのもの、つまり**平面**になる。
 *
 * 生成直後の地形は実測でオーバーハングが 1 列も無い (65025 列中 0)。
 * オーバーハングを作るのはプレイヤーの掘削と崩落だけなので、
 * そこは voidTop で「最上面の下の空洞」を持っておいて避ける。
 */

/** 地表が無い列 (ワールドの外周)。整定には参加させない。 */
export const NO_SURFACE = -1e9;

/** 空洞が無い列の voidTop。 */
export const NO_VOID = -1e9;

/** 列 (i,k) → 配列添字。Generator の 2 次元マップと同じ並び。 */
export function colIdx(i: number, k: number): number {
  return i + k * NX;
}

/** ワールドの外周の列か。ここは Generator が d = -1 に固定した垂直な壁。 */
export function isRimColumn(i: number, k: number): boolean {
  return i <= 0 || i >= NX - 1 || k <= 0 || k >= NZ - 1;
}

function tanOf(deg: number): number {
  return Math.tan((deg * Math.PI) / 180);
}

/**
 * 角度表を tan にして先に展開しておく。[乾いた地質..., 飽和した地質...]。
 * 整定は 1 列 1 スイープごとにここを引くので、Math.tan を毎回呼ぶと
 * それだけで実測 2 倍近く遅くなる。
 */
function tanTable(table: Record<number, number>): Float64Array {
  const out = new Float64Array(GEO_COUNT * 2);
  for (let g = 0; g < GEO_COUNT; g++) {
    out[g] = tanOf(table[g]);
    out[GEO_COUNT + g] = tanOf(Math.max(5, table[g] - REPOSE_SATURATED_DROP));
  }
  return out;
}

const REPOSE_TAN = tanTable(REPOSE_DEG);
const INSITU_TAN = tanTable(INSITU_DEG);

/**
 * 法面保護工が支える角度の tan。添字は工法のレベル (0 = 無処理)。
 * 保護工は構造物なので、地質にも水位にも依存しない。
 */
const PROTECT_TAN = (() => {
  const out = new Float64Array(SLOPE_WORK_DEG.length);
  for (let i = 0; i < SLOPE_WORK_DEG.length; i++) out[i] = tanOf(SLOPE_WORK_DEG[i]);
  return out;
})();

export class HeightIndex {
  /** 最上面の高さ [m]。外周は NO_SURFACE。 */
  readonly heights = new Float64Array(NX * NZ);
  /** 最上面のすぐ下にある最初の空洞の天端 [m]。無ければ NO_VOID。 */
  readonly voidTop = new Float32Array(NX * NZ);
  /** その空洞の底 (下で地面が戻る高さ) [m]。底まで空気なら 0。 */
  readonly voidBottom = new Float32Array(NX * NZ);
  /** 最上面の地質。安息角と、崩れて運ばれる土の地質を決める。 */
  readonly topMat = new Uint8Array(NX * NZ);
  /**
   * 表層にあるゆるんだ土砂の厚み [m]。
   * これが残っている間は安息角で流れ、出し切ると原地盤の角度に戻る。
   * 崩積土がそこに留まれない急な原地盤の上では自然にゼロへ戻るので、
   * 「掘った跡」を旗で覚えておく必要が無い (旗方式は自分で上流へ塗り広がる)。
   */
  readonly loose = new Float64Array(NX * NZ);
  /**
   * ゆるんだ土砂の地質。原地盤の地質 (topMat) とは別に持つ。
   *
   * 一緒にすると、岩の急斜面に土が薄く乗っただけでその列が「土」になり、
   * 岩の崖が丸ごと 34 度まで崩れてしまう。載っているのは土でも、
   * その下で支えているのは岩、というのが正しい。
   */
  readonly looseMat = new Uint8Array(NX * NZ);
  /**
   * 地表として採らなかった**薄い庇**の上端 [m]。無ければ heights と同じ。
   *
   * 円筒ブラシは切土のふちに必ずオーバーハングを残す。その薄い板を地表と
   * して採ると、天端を守る規則 (ROOF_KEEP) に引っかかって二度と動かせず、
   * 実測で高さ 9 m の柱として立ち尽くした。地表は板の**下の地面**で採り、
   * 板は「その列を削るときにいっしょに削り落とすもの」として覚えておく。
   */
  readonly lipTop = new Float64Array(NX * NZ);
  /**
   * その列に入っている法面保護工のレベル [0..3]。
   * 入っていれば、ゆるみ土砂だろうと原地盤だろうとその角度で立つ。
   */
  readonly protect = new Uint8Array(NX * NZ);

  constructor() {
    this.voidTop.fill(NO_VOID);
  }

  /**
   * 1 列を測り直す。
   * @param hint その列の地表のおおよその高さ [m]。上から総なめするより速い。
   */
  measureColumn(field: VoxelField, i: number, k: number, hint = Number.NaN): void {
    const o = colIdx(i, k);
    if (isRimColumn(i, k)) {
      this.heights[o] = NO_SURFACE;
      this.lipTop[o] = NO_SURFACE;
      this.voidTop[o] = NO_VOID;
      this.voidBottom[o] = 0;
      this.loose[o] = 0;
      return;
    }

    const { density, strideY, strideZ } = field;
    const base = i + k * strideZ;

    // 走査開始点。hint があればその少し上から。密度は ±8 でクランプされているので
    // hint + 8 より上に地表が来ることは無い……のだが、盛土で上がっている
    // ことはあるので、開始点が固体だったら素直に上から測り直す。
    let jTop = NY - 1;
    if (Number.isFinite(hint)) {
      const jh = Math.min(NY - 1, Math.ceil((hint + 8.5) / CELL));
      if (jh >= 1 && density[base + jh * strideY] <= 0) jTop = jh;
    }

    // 最初の固体を探す。ただし ROOF_KEEP より薄い庇は地表として採らず、
    // その下の地面まで降りる (上端は lipTop に控える)。
    let j = jTop;
    let idx = base + j * strideY;
    let lip = -Infinity;
    const minRun = Math.max(2, Math.ceil(ROOF_KEEP / CELL));
    for (;;) {
      while (j >= 1 && density[idx] <= 0) {
        j--;
        idx -= strideY;
      }
      if (j < 1) break;
      // 固体が何ノード続くか
      let run = 0;
      let jr = j;
      let ir = idx;
      while (jr >= 1 && density[ir] > 0) {
        run++;
        jr--;
        ir -= strideY;
      }
      if (run >= minRun || jr < 1) break;
      // 薄い庇。上端を覚えて下の地面へ降りる。
      if (lip === -Infinity) lip = j * CELL + CELL * 0.5;
      j = jr;
      idx = ir;
    }

    if (j < 1) {
      // 列がまるごと空気。床 (j = 0 は Generator が常に空気) を地面とみなす。
      this.heights[o] = 0;
      this.lipTop[o] = lip === -Infinity ? 0 : lip;
      this.voidTop[o] = NO_VOID;
      this.voidBottom[o] = 0;
      this.topMat[o] = field.materialAtNode(i, 1, k);
      this.loose[o] = 0;
      return;
    }

    const dSolid = density[idx];
    if (j >= NY - 1) {
      this.heights[o] = j * CELL;
    } else {
      const dAir = density[idx + strideY];
      // surfaceNets の t = da/(da-db) と同じ規約。ずらすとメッシュと高さが食い違う。
      this.heights[o] = j * CELL + (CELL * dSolid) / (dSolid - dAir);
    }
    this.topMat[o] = field.materialAtNode(i, j, k);
    this.lipTop[o] = lip === -Infinity ? this.heights[o] : lip;

    // --- 最上面の下の最初の空洞 (天端と底) ---
    // j = 0 の床は Generator が常に空気にしているだけで、空洞ではない。
    // ここを空洞に数えると全列が「天端を持つ列」になり、坑道と地面の
    // 区別がつかなくなる。
    let jv = j;
    let iv = idx;
    while (jv >= 2) {
      jv--;
      iv -= strideY;
      if (density[iv] <= 0) {
        const dA = density[iv];
        const dS = density[iv + strideY];
        this.voidTop[o] = jv * CELL + (CELL * -dA) / (dS - dA);
        // その空洞の底 = 下で地面が戻る高さ
        let jb = jv;
        let ib = iv;
        while (jb >= 2 && density[ib] <= 0) {
          jb--;
          ib -= strideY;
        }
        if (jb < 1) {
          this.voidBottom[o] = 0;
        } else {
          const dS2 = density[ib];
          const dA2 = density[ib + strideY];
          this.voidBottom[o] = jb * CELL + (CELL * dS2) / (dS2 - dA2);
        }
        return;
      }
    }
    this.voidTop[o] = NO_VOID;
    this.voidBottom[o] = 0;
  }

  /** 全列を測る。hint には Generator の height マップを渡すと速い。 */
  measureAll(field: VoxelField, hint?: Float32Array): void {
    for (let k = 0; k < NZ; k++) {
      for (let i = 0; i < NX; i++) {
        this.measureColumn(field, i, k, hint ? hint[i + k * NX] : Number.NaN);
      }
    }
  }

  /** ワールド AABB (XZ) に掛かる列だけ測り直す。編集のあとに呼ぶ。 */
  measureAABB(field: VoxelField, minX: number, minZ: number, maxX: number, maxZ: number): void {
    const i0 = Math.max(0, Math.floor(minX / CELL));
    const i1 = Math.min(NX - 1, Math.ceil(maxX / CELL));
    const k0 = Math.max(0, Math.floor(minZ / CELL));
    const k1 = Math.min(NZ - 1, Math.ceil(maxZ / CELL));
    for (let k = k0; k <= k1; k++) {
      for (let i = i0; i <= i1; i++) this.measureColumn(field, i, k);
    }
  }

  /** その列にゆるんだ土砂を足す。掘削が原地盤をゆるませるときに呼ぶ。 */
  loosen(o: number, depth: number): void {
    if (this.heights[o] === NO_SURFACE) return;
    if (depth <= this.loose[o]) return;
    if (this.loose[o] <= 0) this.looseMat[o] = this.topMat[o];
    this.loose[o] = depth;
  }

  /** その列の表層の地質。ゆるんだ土砂が乗っていればそちら。 */
  surfaceMat(o: number): Geo {
    return (this.loose[o] > 0 ? this.looseMat[o] : this.topMat[o]) as Geo;
  }

  /** ゆるんだ土砂の安息角の tan。 */
  reposeTan(o: number): number {
    const g = this.loose[o] > 0 ? this.looseMat[o] : this.topMat[o];
    return REPOSE_TAN[this.heights[o] < WATER_TABLE_Y ? GEO_COUNT + g : g];
  }

  /** 法面保護工が支える角度の tan。無処理なら 0。 */
  protectTan(o: number): number {
    return PROTECT_TAN[this.protect[o]];
  }

  /** 表示用。その列の保護工が支える角度 [度]。無処理なら 0。 */
  protectDeg(o: number): number {
    return SLOPE_WORK_DEG[this.protect[o]];
  }

  /** 原地盤が自立できる角度の tan。支えているのは原地盤なので topMat を使う。 */
  insituTan(o: number): number {
    const g = this.topMat[o];
    return INSITU_TAN[this.heights[o] < WATER_TABLE_Y ? GEO_COUNT + g : g];
  }

  private angleDeg(table: Record<number, number>, geo: Geo, o: number): number {
    const base = table[geo];
    // 水位より下は飽和して寝る。地表が水位より下にある列だけ。
    return this.heights[o] < WATER_TABLE_Y ? Math.max(5, base - REPOSE_SATURATED_DROP) : base;
  }

  /** 表示用。その列の安息角 [度]。 */
  reposeDeg(o: number): number {
    return this.angleDeg(REPOSE_DEG, this.surfaceMat(o), o);
  }

  /** 表示用。その列の原地盤の自立角 [度]。 */
  insituDeg(o: number): number {
    return this.angleDeg(INSITU_DEG, this.topMat[o] as Geo, o);
  }
}
