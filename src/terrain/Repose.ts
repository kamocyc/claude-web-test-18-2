import { CELL, NX, NZ, Geo, LOOSEN_MAX_DEPTH, ROOF_KEEP } from './config';
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

  /** ゆるみを横へ広げるときの作業列。 */
  private looseQueue: number[] = [];
  private inLooseQueue = new Uint8Array(NX * NZ);

  /** その列の地表まで掘削が届いた高さの、これまでの最大値 [m]。 */
  private reachMax = new Float64Array(NX * NZ).fill(-Infinity);

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
   * **ゆるませる厚みは「実際にその列の地表が動いた量」で決める。**
   * 編集の AABB の深さで決めてはいけない。AABB はカプセルを等方に 4.1 m
   * 膨らませたものなので、
   *   - 1 m^3 も減っていない横の列にも同じ厚みが入る
   *   - 厚みが「地表がボア軸より上にある高さ」に比例してしまい、
   *     掘っていない上流ほど厚くゆるむという逆立ちした式になる
   * 実測で、1 フレームに掘れる 50 m^3 に対して 330 m^3 が原地盤 (58 度) から
   * ゆるみ土砂 (34 度) に書き換わっていた。斜面にトンネルを掘ろうとすると
   * 坑口の上 4-6 m 山側までが一斉にゆるんで坑口へ流れ込み、掘れなくなる。
   *
   * 地表の低下量で測れば、土被りの下を抜けた坑道 (地表が動かない) は
   * ゼロになる。坑口の切り欠きだけが安息角まで寝て、その上の斜面は
   * 原地盤として立ったままになる。
   */
  seedFromEdit(field: VoxelField, res: EditResult): void {
    const { min, max } = res;
    const { heights, loose } = this.index;

    const i0 = Math.max(1, Math.floor(min[0] / CELL));
    const i1 = Math.min(NX - 2, Math.ceil(max[0] / CELL));
    const k0 = Math.max(1, Math.floor(min[2] / CELL));
    const k1 = Math.min(NZ - 2, Math.ceil(max[2] / CELL));

    for (let k = k0; k <= k1; k++) {
      for (let i = i0; i <= i1; i++) {
        const o = colIdx(i, k);
        const hPrev = heights[o];
        this.index.measureColumn(field, i, k);
        if (heights[o] === NO_SURFACE) continue;
        if (res.reachY > this.reachMax[o]) this.reachMax[o] = res.reachY;

        // 1 フレームぶんの低下は数 cm なので、最大値ではなく**積算**する。
        // 最大値だと総掘削深さを取りこぼし、深い切土でも法面が寝ない。
        // 絶対値なのは盛土のため。置いた土はそれ自体がゆるみ土砂。
        if (hPrev !== NO_SURFACE) {
          const moved = Math.abs(hPrev - heights[o]);
          if (moved > 0) {
            this.index.loosen(o, Math.min(loose[o] + moved, LOOSEN_MAX_DEPTH));
            if (!this.inLooseQueue[o]) {
              this.inLooseQueue[o] = 1;
              this.looseQueue.push(o);
            }
          }
        }
        this.activate(o);
      }
    }
    this.spreadLoose();
  }

  /**
   * ゆるみを横へ広げる。`loose[n] >= loose[o] - 距離 * tan(安息角)`。
   *
   * 掘って地表が下がるのは**掘った穴の底**だが、寝てほしいのはその**壁**で、
   * 壁の列は地表が下がっていないので、低下量だけを見ているとゆるまない。
   * 実測: 深さ 6 m の開削の法面が 87 度で立ったままになった。
   *
   * 広げる距離は「その深さの法面が安息角で寝るのに要る幅」= 深さ/tan(安息角)
   * そのものなので、任意の半径を決め打ちする必要が無い。深さ 5 m の切土なら
   * 7.4 m まで。そこから先は原地盤なので動かない。**有限で止まる。**
   *
   * 「掘った所」を旗にして隣へ伝染させる方式とは別物であることに注意。
   * あれは受け手が旗を貰って上流へ塗り広がるので止まらない。こちらは
   * 掘った深さから決まる円錐を 1 回置くだけで、崩れても広がらない。
   *
   * **天端を持つ列 (下に空洞がある = 坑道の上) には広げない。** 坑口の
   * 開いた区間と、その奥の坑道は形としては同じ「深い溝」なので、
   * 区別できるのは「上に地山が架かっているかどうか」だけ。ここで広げると
   * 坑道の真上の地山がゆるみ、土被りが付く前に天端が消える
   * (実測: 15 m 掘り進んでも土被り 0、動いた土量が掘削量の 20 倍)。
   *
   * 広げてよいのは、**過去に一度でも掘削がその列の地表まで届いた**列だけ
   * (reachMax)。届いていない列は、これから坑道になる地山であって切土の
   * 法面ではない。この蓋が無いと、坑口の溝から出た円錐が掘削ヘッドより
   * 先へ伸びて、土被りが付く前に前方の地山を寝かせてしまう
   * (実測: 15 m 掘り進んでも土被り 0)。
   *
   * 「過去に一度でも」なのは、深い切土は何度も掘り下げるから。今の掘削の
   * 上端だけを見ると、2 回目以降は法面の天端より下になり、壁が原地盤のまま
   * 垂直に立ち尽くす (実測 80 度)。reachMax は掘削の形からしか立たないので、
   * 崩落で伝染することはない。
   */
  private spreadLoose(): void {
    const { heights, loose, looseMat, voidTop } = this.index;
    const queue = this.looseQueue;
    for (let head = 0; head < queue.length; head++) {
      const o = queue[head];
      this.inLooseQueue[o] = 0;
      const i = o % NX;
      const k = (o / NX) | 0;
      const t = this.index.reposeTan(o);
      const src = loose[o];
      for (let q = 0; q < NB_N; q++) {
        const ni = i + NB_DI[q];
        const nk = k + NB_DK[q];
        if (isRimColumn(ni, nk)) continue;
        const no = ni + nk * NX;
        if (heights[no] === NO_SURFACE) continue;
        if (voidTop[no] !== NO_VOID) continue;
        if (this.reachMax[no] < heights[no] - CELL) continue;
        const v = Math.min(src - t * NB_DIST[q], heights[no], LOOSEN_MAX_DEPTH);
        if (v <= loose[no] + MIN_MOVE) continue;
        if (loose[no] <= 0) looseMat[no] = looseMat[o];
        loose[no] = v;
        this.activate(no);
        if (!this.inLooseQueue[no]) {
          this.inLooseQueue[no] = 1;
          queue.push(no);
        }
      }
    }
    queue.length = 0;
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
        this.reachMax[o] = Infinity;
        this.activate(o);
        if (!this.inLooseQueue[o]) {
          this.inLooseQueue[o] = 1;
          this.looseQueue.push(o);
        }
      }
    }
    this.spreadLoose();
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

    let budget = H0 - this.floorLimit(o);
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
   * その列を削ってよい下限 [m]。空洞の天端には必ず ROOF_KEEP を残す。
   *
   * ここで「横に開いている空洞は坑道ではないので庇ごと削ってよい」という
   * 例外を持たせてはいけない。一度そう判定すると、削られた列は
   * 「空洞を持たない低い地面」になって隣の列を同じ判定へ引きずり込む。
   * 判定が坑道の奥へ**伝染**し、天端が入口から順に剥がされて坑道が空に抜ける。
   * 実測: 斜面へ 15 m 掘り進んでも土被りが 0 のまま、掘削 1536 m^3 に対して
   * 6292 m^3 が動き、山腹が 11 m 下がった。隣が「空洞を持たない地面」で
   * あることを要求しても伝染は止まらない (削られた列がまさにそれになる)。
   *
   * 代わりに払う代償は、切土のふちに残るブラシ由来の庇。円筒ブラシは
   * 必ずオーバーハングを作るので、そこが厚さ 1 m の板で凍って小さな段になる。
   * 局所的な見た目の粗であって、掘れなくなるような不具合ではない。
   *
   * 「もともと ROOF_KEEP より薄い庇は削ってよい」という逃げ道も置かない。
   * それも同じ伝染を起こす。薄い天端を削ると、その列は空洞を持たない
   * 低い地面になり、次の列の天端が薄く見えて、また削られる。坑口の薄い
   * 天端から順に剥がれて、結局坑道が空に抜ける。
   * ROOF_KEEP より薄い天端の列は、削れないまま凍る。それでよい。
   * 天端が薄いこと自体は Tunnel 側が土被りとして読み、必要支保を上げる。
   */
  private floorLimit(o: number): number {
    const vt = this.index.voidTop[o];
    return vt === NO_VOID ? 0 : vt + ROOF_KEEP;
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
        floor: this.floorLimit(o),
        geo: (gained ? looseMat[o] : topMat[o]) as Geo,
        ceil: this.index.lipTop[o],
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
