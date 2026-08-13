import { CELL, NX, NZ, Geo, LOOSEN_MAX_DEPTH, ROOF_KEEP } from './config';
import { clamp } from './FieldMath';
import { applyColumnHeights, type ColumnHeightWrite, type EditResult } from './Edit';
import { HeightIndex, colIdx, isRimColumn, NO_SURFACE, NO_VOID } from './HeightIndex';
import type { VoxelField } from './VoxelField';
import type { ChunkManager } from './ChunkManager';

/**
 * 安息角。急な法面は自重で崩れ、崩れた土は法尻に溜まる。
 *
 * ---- なぜ高さ場で解くのか ----
 * 求めたいのは「崩れたあとが平面になること」で、それは
 *   |grad h| <= tan(θ)
 * という制約そのもの。高さ場の上で解けば停留点が定義から平面になる。
 * 3 次元の場で「急な所を削って下へ積む」をやると、削る形と積む形の
 * 選び方に答えが依存し、凸凹 (先行実装では「キノコ」) が出る。
 *
 * ---- なぜ角度が 2 つあるのか ----
 * ゆるんだ土砂の安息角ひとつでは**崩落が止まらない**。法尻をひと掘りしたときの
 * 後退量は 法面高さ / (tanθ - tan(自然斜面)) で、自然斜面が安息角に近いほど
 * 発散する (実測: 30 度の斜面で 41 m 後退)。
 * 原地盤には別の (急な) 自立角を与え、掘った所だけを「ゆるんだ土砂」に変える。
 * ゆるんだ土砂は急な原地盤の上に留まれないので流れ落ちて厚みがゼロに戻り、
 * そこから先は原地盤の角度で止まる。**止める規則を書かなくても止まる。**
 * 「掘った所」を旗で覚える方式は駄目で、旗が下流の受け手に伝染して
 * 自分で斜面を塗り上がってしまう (先行実装で確認済み)。
 *
 * ---- なぜ即座なのか ----
 * ゲーム内時間ではなく実時間の予算で回し、収束するまで進める。
 * 時間が止まっていても崩れる。「崩れるのを待つ」は判断にならない。
 */

/**
 * 1 スイープで動いたとみなす最小の高さ [m]。
 * 書き戻しの分解能 (1 mm) よりさらに 1 桁細かい所で切る。ここを 1e-6 まで
 * 追うと、見えない残差を潰すためだけにスイープ数が 1 桁増える。
 */
const MIN_MOVE = 1e-3;

/** 書き戻す価値のある高さ変化 [m]。これ未満の列は密度場に触らない。 */
const MIN_WRITE = 1e-3;

/**
 * ゆるんだ土砂を「出し切った」とみなす厚み [m]。**MIN_MOVE と同じにすること。**
 *
 * これより細かくすると、動かすには薄すぎるが「まだ有る」と判定される
 * 中途半端な残りかすが生じ、その列は永久に原地盤として崩れなくなる。
 * 実測では、それが法面のあちこちに高さ 7 m の柱として残った。
 */
const LOOSE_EPS = MIN_MOVE;

/** 暴走検出。物理的な上限ではなくバグの番人。 */
const MAX_SWEEPS = 6000;

/**
 * 近傍。格子の方向が見えないことがこのプロトタイプの最優先要件なので、
 * 8 近傍 (安定角が方位で 34.0-36.1 度に振れる) ではなくナイト跳びを足した
 * 16 近傍にする (34.0-34.9 度)。距離は chamfer の近似整数ではなく実測値を使う。
 * 整数近似は距離変換を整数演算で回すための工夫で、ここは tan を掛けるので
 * 近似する意味が無い (5:7 は 1:sqrt2 に対して 1% ずれる = 0.4 度)。
 */
const NB_DI = [1, -1, 0, 0, 1, 1, -1, -1, 1, 2, -1, -2, 1, 2, -1, -2];
const NB_DK = [0, 0, 1, -1, 1, -1, 1, -1, 2, 1, 2, 1, -2, -1, -2, -1];
const NB_N = NB_DI.length;
const NB_DIST = NB_DI.map((di, q) => Math.hypot(di, NB_DK[q]) * CELL);

/**
 * 安定な勾配の集合は内接半径 tanθ の正 M 角形なので、素のままだと
 * 軸方向が最小で対角が最大になる。公称値が最小ではなく**真ん中**に来るよう
 * 全体を縮める。M = 16 で 2cos(pi/16)/(1+cos(pi/16)) = 0.9903。
 */
const ANISO_CENTER = (2 * Math.cos(Math.PI / NB_N)) / (1 + Math.cos(Math.PI / NB_N));

export interface ReposeStats {
  sweeps: number;
  pours: number;
  columns: number;
  ms: number;
}

export class ReposeSystem {
  /** 直近の地滑りで動いた土量 [m^3]。 */
  movedThisSlide = 0;
  readonly stats: ReposeStats = { sweeps: 0, pours: 0, columns: 0, ms: 0 };

  private activeList: number[] = [];
  private nextList: number[] = [];
  private inNext = new Uint8Array(NX * NZ);

  /** 書き戻し待ちの列と、書き戻す前の高さ。 */
  private pendingList: number[] = [];
  private pendingOld = new Float64Array(NX * NZ);
  private hasPending = new Uint8Array(NX * NZ);

  /** 前回の書き戻し以降、土を受け取った列。 */
  private gained = new Uint8Array(NX * NZ);

  private scratchLam = new Float64Array(NB_N);
  private scratchOff = new Int32Array(NB_N);

  constructor(readonly index: HeightIndex) {}

  /** まだ崩れ切っていない列が残っているか。 */
  get active(): boolean {
    return this.nextList.length > 0;
  }

  // ------------------------------------------------------------------ 種まき

  /**
   * 編集を受けて種を撒く。列を測り直し、掘った所の原地盤をゆるませる。
   *
   * ゆるませるのは「編集が今の地表まで届いている列」だけ。深いトンネルの
   * 掘削 AABB でゆるませてしまうと、地表を触っていないのに山腹が崩れ出す。
   */
  seedFromEdit(field: VoxelField, min: readonly number[], max: readonly number[]): void {
    const { heights } = this.index;
    this.index.measureAABB(field, min[0], min[2], max[0], max[2]);

    const i0 = Math.max(1, Math.floor(min[0] / CELL));
    const i1 = Math.min(NX - 2, Math.ceil(max[0] / CELL));
    const k0 = Math.max(1, Math.floor(min[2] / CELL));
    const k1 = Math.min(NZ - 2, Math.ceil(max[2] / CELL));

    for (let k = k0; k <= k1; k++) {
      for (let i = i0; i <= i1; i++) {
        const o = colIdx(i, k);
        if (heights[o] === NO_SURFACE) continue;
        if (max[1] >= heights[o] - CELL) {
          this.index.loosen(o, clamp(heights[o] - min[1], 0, LOOSEN_MAX_DEPTH));
        }
        this.activate(o);
      }
    }
  }

  /**
   * 円柱状に種を撒く。陥没孔の縁を寝かせるのに使う。
   * @param loosenDepth ゆるませる厚み [m]。
   */
  seedAround(x: number, z: number, radius: number, loosenDepth = LOOSEN_MAX_DEPTH): void {
    const { heights } = this.index;
    const r2 = radius * radius;
    const i0 = Math.max(1, Math.floor((x - radius) / CELL));
    const i1 = Math.min(NX - 2, Math.ceil((x + radius) / CELL));
    const k0 = Math.max(1, Math.floor((z - radius) / CELL));
    const k1 = Math.min(NZ - 2, Math.ceil((z + radius) / CELL));
    for (let k = k0; k <= k1; k++) {
      for (let i = i0; i <= i1; i++) {
        const dx = i * CELL - x;
        const dz = k * CELL - z;
        if (dx * dx + dz * dz > r2) continue;
        const o = colIdx(i, k);
        if (heights[o] === NO_SURFACE) continue;
        this.index.loosen(o, Math.min(loosenDepth, Math.max(0, heights[o])));
        this.activate(o);
      }
    }
  }

  /** 世界じゅうの列を活性化する。起動時の整定に使う。 */
  seedAll(): void {
    const { heights } = this.index;
    for (let k = 1; k < NZ - 1; k++) {
      for (let i = 1; i < NX - 1; i++) {
        const o = colIdx(i, k);
        if (heights[o] !== NO_SURFACE) this.activate(o);
      }
    }
  }

  // -------------------------------------------------------------------- 整定

  /**
   * 予算内で回す。収束していなくても、動いたぶんはそのフレームで書き戻す。
   * @param budgetMs 実時間の予算 [ms]。ゲーム内時間には一切依存しない。
   */
  update(field: VoxelField, chunks: ChunkManager | null, budgetMs = 4): EditResult | null {
    if (this.nextList.length === 0) return null;
    this.run(budgetMs);
    return this.writeBack(field, chunks);
  }

  /** 収束するまで回す。起動時・デバッグ API・テスト用。 */
  settleNow(field: VoxelField, chunks: ChunkManager | null): EditResult | null {
    if (this.nextList.length === 0) return null;
    this.run(Infinity);
    return this.writeBack(field, chunks);
  }

  private run(budgetMs: number): void {
    const t0 = performance.now();
    const { heights } = this.index;
    this.stats.sweeps = 0;
    this.stats.pours = 0;
    this.movedThisSlide = 0;

    while (this.nextList.length > 0) {
      // 次スイープ待ちを今スイープの対象に移す
      const swap = this.activeList;
      this.activeList = this.nextList;
      this.nextList = swap;
      this.nextList.length = 0;
      for (const o of this.activeList) this.inNext[o] = 0;

      // 高い列から順に処理する。1 スイープの中で土が斜面を最後まで
      // 流れ落ちるので、拡散的に均すより桁で速く収まる。
      // 同高の並びは添字で決めておく (V8 のソートの実装に依存させない)。
      this.activeList.sort((a, b) => heights[b] - heights[a] || a - b);

      for (const o of this.activeList) {
        const i = o % NX;
        const k = (o / NX) | 0;
        const moved = this.pourColumn(o, i, k);
        if (moved > MIN_MOVE) {
          this.stats.pours++;
          this.movedThisSlide += moved * CELL * CELL;
          this.activateNeighbours(i, k, heights[o]);
          this.activate(o);
        }
      }

      if (++this.stats.sweeps >= MAX_SWEEPS) {
        console.warn(`[repose] ${MAX_SWEEPS} スイープで収束しなかった。打ち切る。`);
        for (const o of this.nextList) this.inNext[o] = 0;
        this.nextList.length = 0;
        break;
      }
      if (performance.now() - t0 > budgetMs) break;
    }

    this.stats.ms = performance.now() - t0;
  }

  /**
   * 1 列ぶん、水位合わせ (water-filling) で土を配る。
   *
   * 素朴な「超過分の半分を隣に渡す」だと制約面へ漸近するだけで、
   * 途中で止めた形が波打つ。ここでは
   *     h[c] - h[n] <= t*d   を全近傍について**同時に**満たす位置へ 1 回で落とす。
   * 落とし先はその列の制約集合への射影そのものなので、触った瞬間に平面に乗る。
   * (実測: 同じ切土で 34.3 万 演算 / 平面性の残差 4e-4 m。
   *  半分渡す方式は 1000 万演算でも残差 0.53 m)
   *
   * @returns 出て行った高さ [m]
   */
  private pourColumn(o: number, i: number, k: number): number {
    const { heights, loose, looseMat, topMat } = this.index;
    const H0 = heights[o];
    if (H0 === NO_SURFACE) return 0;

    let budget = H0 - this.floorLimit(o, i, k);
    if (budget <= MIN_MOVE) return 0;

    let moved = 0;

    // --- 1) ゆるんだ土砂は安息角で流れる。動かせるのはその厚みまで ---
    const looseAvail = Math.min(loose[o], budget);
    if (looseAvail > MIN_MOVE) {
      const m = this.gather(i, k, this.index.reposeTan(o) * ANISO_CENTER);
      const got = m > 0 ? this.discharge(o, m, looseAvail, looseMat[o]) : 0;
      if (got > 0) {
        loose[o] = Math.max(0, loose[o] - got);
        moved += got;
        budget -= got;
      }
    }

    // 動かすには薄すぎる残りかすは「無い」ものとして畳む。
    // 残しておくと、原地盤として崩れる道 (2) が永久に塞がれる。
    if (loose[o] < LOOSE_EPS) loose[o] = 0;

    // --- 2) 土砂を出し切って原地盤が露出したら、原地盤の角度まで崩れる ---
    // 崩れた分は下流でゆるんだ土砂になる = 崩積土。
    if (loose[o] <= 0 && budget > MIN_MOVE) {
      const m = this.gather(i, k, this.index.insituTan(o) * ANISO_CENTER);
      const got = m > 0 ? this.discharge(o, m, budget, topMat[o]) : 0;
      if (got > 0) moved += got;
    }

    return moved;
  }


  /**
   * その列を削ってよい下限 [m]。
   *
   * 坑道の天端には ROOF_KEEP を残す。ただし守るべきなのは**閉じた空洞**だけ。
   * ブラシは円筒なので、切土のふちには必ず庇 (オーバーハング) が残り、
   * その下も「空洞」に見える。これを坑道と同じに守ると、切土のふちが
   * 厚さ 1 m の庇で凍りついて、法尻に垂直な壁が立ったままになる (実測 83.8 度)。
   *
   * 見分け方は「横に開いているか」。隣の列の地表がその空洞の天端より低ければ、
   * その空洞は外へ通じている ＝ 切土そのものであって坑道ではない。
   * そのときは庇を削り落として、空洞の底 (切土の床) までは下がってよい。
   */
  private floorLimit(o: number, i: number, k: number): number {
    const { heights, voidTop, voidBottom } = this.index;
    const vt = voidTop[o];
    if (vt === NO_VOID) return 0;

    for (let q = 0; q < NB_N; q++) {
      const ni = i + NB_DI[q];
      const nk = k + NB_DK[q];
      if (isRimColumn(ni, nk)) continue;
      const hn = heights[ni + nk * NX];
      if (hn !== NO_SURFACE && hn < vt) return voidBottom[o];
    }
    return heights[o] - vt >= ROOF_KEEP ? vt + ROOF_KEEP : vt;
  }

  /**
   * 近傍ごとの「配り始める水位」λ_q = h[n] + t*d を集めて昇順に並べる。
   * ワールド外周は近傍として**存在しない**扱いにする。隣にしてしまうと
   * 世界の縁の垂直な壁から土が無限に流れ落ちる。
   */
  private gather(i: number, k: number, talus: number): number {
    const { heights } = this.index;
    const lam = this.scratchLam;
    const off = this.scratchOff;
    let m = 0;
    for (let q = 0; q < NB_N; q++) {
      const ni = i + NB_DI[q];
      const nk = k + NB_DK[q];
      if (isRimColumn(ni, nk)) continue;
      const no = ni + nk * NX;
      const hn = heights[no];
      if (hn === NO_SURFACE) continue;
      const v = hn + talus * NB_DIST[q];
      // 挿入ソート (m <= 16)
      let p = m;
      while (p > 0 && lam[p - 1] > v) {
        lam[p] = lam[p - 1];
        off[p] = off[p - 1];
        p--;
      }
      lam[p] = v;
      off[p] = no;
      m++;
    }
    return m;
  }

  /**
   * gather() の結果に対して水位を解き、実際に配る。
   * @param maxAmount 出せる量の上限 [m]。ゆるみ厚や天端までの余裕で決まる。
   * @returns 実際に出した量 [m]
   */
  private discharge(o: number, m: number, maxAmount: number, mat: number): number {
    const { heights, loose, looseMat } = this.index;
    const lam = this.scratchLam;
    const off = this.scratchOff;
    const H = heights[o];

    // 制約を満たす水位を解く: H - λ = Σ_{λ_q < λ} (λ - λ_q)
    let sum = 0;
    let level = H;
    for (let n = 0; n < m; n++) {
      if (level <= lam[n]) break;
      sum += lam[n];
      level = (H + sum) / (n + 2);
    }
    let amount = H - level;
    if (amount <= MIN_MOVE) return 0;

    if (amount > maxAmount) {
      // 出せる量が足りない。決まった量だけ流したときの水位を解き直す。
      amount = maxAmount;
      sum = 0;
      level = lam[0] + amount;
      for (let n = 0; n < m; n++) {
        sum += lam[n];
        level = (amount + sum) / (n + 1);
        if (n + 1 >= m || level <= lam[n + 1]) break;
      }
    }

    this.note(o);
    heights[o] = H - amount;

    for (let n = 0; n < m; n++) {
      const got = level - lam[n];
      if (got <= 0) continue;
      const no = off[n];
      this.note(no);
      // 新しく来た土のほうが多ければ、表層の地質はそちらになる
      if (got > loose[no]) looseMat[no] = mat;
      heights[no] += got;
      loose[no] += got;
      this.gained[no] = 1;
      this.activate(no);
    }
    return amount;
  }

  // ------------------------------------------------------------ 書き戻し

  /** 高さを動かす直前に、書き戻し用の元の値を控える。 */
  private note(o: number): void {
    if (this.hasPending[o]) return;
    this.hasPending[o] = 1;
    this.pendingOld[o] = this.index.heights[o];
    this.pendingList.push(o);
  }

  private activate(o: number): void {
    if (this.inNext[o]) return;
    this.inNext[o] = 1;
    this.nextList.push(o);
  }

  /**
   * 土を出した列のまわりを次スイープに積む。
   *
   * 積むのは**その列より高い**近傍だけでよい。低い近傍は、
   * 受け取ったのならその場で activate 済みだし、受け取っていないなら
   * この列が下がったことで新たに破れることはない (差が縮むだけ)。
   * 全部積むと活性集合が実測で 2 倍以上に膨らみ、大半が空振りになる。
   */
  private activateNeighbours(i: number, k: number, h: number): void {
    const { heights } = this.index;
    for (let q = 0; q < NB_N; q++) {
      const ni = i + NB_DI[q];
      const nk = k + NB_DK[q];
      if (isRimColumn(ni, nk)) continue;
      const no = ni + nk * NX;
      const hn = heights[no];
      if (hn !== NO_SURFACE && hn > h) this.activate(no);
    }
  }

  private writeBack(field: VoxelField, chunks: ChunkManager | null): EditResult | null {
    if (this.pendingList.length === 0) return null;
    const { heights, looseMat, topMat } = this.index;

    const cols: ColumnHeightWrite[] = [];
    for (const o of this.pendingList) {
      this.hasPending[o] = 0;
      const hOld = this.pendingOld[o];
      const hNew = heights[o];
      const gained = this.gained[o];
      this.gained[o] = 0;
      if (Math.abs(hNew - hOld) < MIN_WRITE) continue;
      const i = o % NX;
      const k = (o / NX) | 0;

      // 正規化係数は**整定後**の高さ場から。Generator の slope[] と同じ量。
      const gx = (this.h(i + 1, k, hNew) - this.h(i - 1, k, hNew)) / (2 * CELL);
      const gz = (this.h(i, k + 1, hNew) - this.h(i, k - 1, hNew)) / (2 * CELL);
      const inv = 1 / Math.sqrt(1 + gx * gx + gz * gz);

      // 新しく固体になったノードに入れる地質は「運ばれてきた土」のもの。
      // topMat (原地盤の地質) はここでは書き換えない。書き換えると、
      // 土が薄く乗っただけで岩の崖が土の角度で崩れ出す。
      // 密度場の material は下で書かれるので、次に測り直したときに拾われる。
      cols.push({
        i, k, hOld, hNew, inv,
        floor: this.floorLimit(o, i, k),
        geo: (gained ? looseMat[o] : topMat[o]) as Geo,
      });
    }
    this.pendingList.length = 0;
    this.stats.columns = cols.length;
    if (cols.length === 0) return null;

    const res = applyColumnHeights(field, chunks, cols);
    return res.changed ? res : null;
  }

  /** 高さの参照。ワールド外周は自分の値で代用して勾配を立てない。 */
  private h(i: number, k: number, fallback: number): number {
    if (isRimColumn(i, k)) return fallback;
    const v = this.index.heights[i + k * NX];
    return v === NO_SURFACE ? fallback : v;
  }
}

/** HUD 用。掘る前に「この地質はここまでしか立たない」を出すために使う。 */
export function slopeInfoAt(
  index: HeightIndex,
  x: number,
  z: number,
): { slopeDeg: number; reposeDeg: number; insituDeg: number; loose: boolean } | null {
  const i = Math.round(x / CELL);
  const k = Math.round(z / CELL);
  if (isRimColumn(i, k)) return null;
  const o = colIdx(i, k);
  const { heights } = index;
  if (heights[o] === NO_SURFACE) return null;

  const at = (ii: number, kk: number): number => {
    if (isRimColumn(ii, kk)) return heights[o];
    const v = heights[ii + kk * NX];
    return v === NO_SURFACE ? heights[o] : v;
  };
  const gx = (at(i + 1, k) - at(i - 1, k)) / (2 * CELL);
  const gz = (at(i, k + 1) - at(i, k - 1)) / (2 * CELL);

  return {
    slopeDeg: (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI,
    reposeDeg: index.reposeDeg(o),
    insituDeg: index.insituDeg(o),
    loose: index.loose[o] > LOOSE_EPS,
  };
}
