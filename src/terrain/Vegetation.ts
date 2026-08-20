import * as THREE from 'three';
import { CELL, NX, NZ, Geo, WATER_TABLE_Y, WORLD_Y } from './config';
import { colIdx, isRimColumn, NO_SURFACE, type HeightIndex } from './HeightIndex';

/**
 * 植生 (草地の被覆率)。
 *
 * 木も草も**飾りではなく地面の状態**として持つ。列 (x,z) ごとに 0..1 の被覆率を
 * 1 枚持ち、地形シェーダの色付けも、草の房も、木の位置も、全部そこから引く。
 * 3 つが別々に自分の判断で生えると、掘った跡で色だけ緑が残る、といった食い違いが出る。
 *
 * ---- 生える条件 ----
 * 地質・傾斜・地下水位の 3 つだけ。地質ごとの数値をこれ以上増やさない
 * (企画の「地質が持つ数値は掘進速度・単価・必要支保・安息角だけ」に対して、
 *  植生は**地面の見た目**の側の話なのでここに閉じる)。
 *
 * ---- 消える条件 ----
 * **その列の地表が動いたら消える。** 掘った・盛った・崩れた・道路で切った、の
 * どれであっても、地表高さが記録より 12 cm 動いたら被覆率を 0 に落とす。
 * ゆるみ土砂 (`HeightIndex.loose`) を目印にしないのは、あれが崩れ切ると 0 に
 * 戻るため。「一度でも動いた」を覚えていられるのは高さの記録だけ。
 *
 * ---- 舗装 ----
 * 路面の列は別に印を持つ。切土でも盛土でもない平坦地に道路を通した場合、
 * 地表高さが動かないので「地表が動いたら消える」だけでは草が残り、
 * 舗装の下から草が生えることになる。
 *
 * ---- 戻る条件 ----
 * 種子吹付 (法面保護工 L1) を入れた列だけ、3 日かけて元の被覆率まで戻る。
 * あれは名前のとおり緑化工なので、払った金が景色として返ってくる。
 * 他の工法 (法枠・擁壁) は構造物なので緑は戻らない。
 */

/** 地表がこれだけ動いたら植生が剥がれる [m]。 */
const DISTURB_M = 0.12;

/** 種子吹付が元の被覆率まで戻るのに要するゲーム内時間 [時]。 */
const REGROW_HOURS = 72;

/**
 * 草が生えられる限界の傾斜 [度]。これを超えると裸地。
 *
 * 落ち始めを 28 度、切れるのを 45 度にしてある。土の安息角 34 度が
 * ちょうど真ん中に来るので、**崩れて安息角まで寝た法面は半分ほど薄い**。
 * 掘った跡は高さが動くので被覆がゼロになるが、そのあと年月が経って
 * 種子吹付で戻したときも、平場ほどは濃くならない。急な所ほど土が薄い、
 * という当たり前が絵として出る。
 */
export const GRASS_MAX_DEG = 45;
/** 被覆率が落ち始める傾斜 [度]。 */
const GRASS_FADE_DEG = 28;

/**
 * 木が立てる限界の傾斜 [度]。草より厳しい。
 *
 * 26 度から 33 度へ上げてある。26 度だと、この地形 (尾根と谷) で条件を
 * 満たす候補が 1024 点中 83 点しか残らず、林が一角にしか出ない。
 * 実際の山も 30 度前後の斜面には普通に木が生えている。
 */
export const TREE_MAX_DEG = 33;

/** 地質ごとの生えやすさ。岩の露頭はほぼ裸、軟弱層はまばら。 */
const GEO_FERTILITY: Record<number, number> = {
  [Geo.Soil]: 1.0,
  [Geo.Weak]: 0.55,
  [Geo.Rock]: 0.12,
};

/** 描画側がタイル単位で作り直すための刻み [列]。32 列 = 16 m (チャンクと同じ)。 */
export const VEG_TILE = 32;
export const VEG_TILES_X = Math.ceil(NX / VEG_TILE);
export const VEG_TILES_Z = Math.ceil(NZ / VEG_TILE);

export function vegTileOf(i: number, k: number): number {
  return ((i / VEG_TILE) | 0) + ((k / VEG_TILE) | 0) * VEG_TILES_X;
}

/**
 * その列の地表の傾斜 [度]。
 *
 * 崩落の判定 (`slopeInfoAt`) と違って、**3 セル (1.5 m) 離して測る**。
 * 地表には生成時の 3 次元ノイズが乗っているので、隣同士 (0.5 m) の差分だと
 * 傾斜が列ごとに大きく振れ、被覆率がごま塩になって遠目には汚れて見える。
 * 草木が感じるのは足元 1 cm の凹凸ではなく 1-2 m の地形のほうなので、
 * 物理と物差しを分けても嘘にはならない。
 */
export function columnSlopeDeg(index: HeightIndex, i: number, k: number): number {
  const h = index.heights;
  const o = colIdx(i, k);
  const span = 3;
  const at = (ii: number, kk: number): number => {
    if (isRimColumn(ii, kk)) return h[o];
    const v = h[ii + kk * NX];
    return v === NO_SURFACE ? h[o] : v;
  };
  const gx = (at(i + span, k) - at(i - span, k)) / (2 * span * CELL);
  const gz = (at(i, k + span) - at(i, k - span)) / (2 * span * CELL);
  return (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export class Vegetation {
  /** 列ごとの被覆率 [0..1]。 */
  readonly cover = new Float32Array(NX * NZ);
  /** 被覆率を評価したときの地表高さ [m]。ここから動いたら剥がれる。 */
  private baseline = new Float32Array(NX * NZ);
  /** その列を最後に見たゲーム内時刻 [時]。生え戻りの積算に使う。 */
  private lastSeen = new Float32Array(NX * NZ);
  /** 舗装された列。地表が動かない平坦地の道路でも緑を止める。 */
  readonly paved = new Uint8Array(NX * NZ);

  /**
   * 地形シェーダへ渡す被覆率マップ。
   *   R = 被覆率、G = その列の地表高さ / WORLD_Y
   * 高さも入れるのは、**坑道の床を緑に塗らない**ため。上を向いた面かどうかだけでは
   * 坑道の床 (法線はほぼ真上) を弾けない。地表からどれだけ下かで切る。
   */
  readonly maskTexture: THREE.DataTexture;
  private mask: Uint8Array<ArrayBuffer>;
  private maskDirty = true;

  /** 描画を作り直すべきタイル。 */
  readonly dirtyTiles = new Set<number>();

  /** 掘削などで即座に見直したい列。 */
  private queue: number[] = [];
  private queued = new Uint8Array(NX * NZ);
  /** 総なめの現在位置。全列を数フレームかけて 1 周する。 */
  private cursor = 0;
  private hours = 0;

  constructor() {
    this.mask = new Uint8Array(new ArrayBuffer(NX * NZ * 2));
    this.maskTexture = new THREE.DataTexture(this.mask, NX, NZ, THREE.RGFormat);
    this.maskTexture.minFilter = THREE.LinearFilter;
    this.maskTexture.magFilter = THREE.LinearFilter;
    this.maskTexture.wrapS = THREE.ClampToEdgeWrapping;
    this.maskTexture.wrapT = THREE.ClampToEdgeWrapping;
    // 幅 257 x 2 バイト = 514 バイト/行。既定の 4 バイト境界のままだと
    // 行ごとに 2 バイトずれて、被覆が斜めに流れる。
    this.maskTexture.unpackAlignment = 1;
    // 中身は色ではなく数値。sRGB 復号を掛けられると被覆率が歪む。
    this.maskTexture.colorSpace = THREE.NoColorSpace;
    this.maskTexture.needsUpdate = true;
  }

  /** その列に生えうる被覆率 [0..1]。地質・傾斜・水位だけで決まる。 */
  potentialAt(index: HeightIndex, i: number, k: number): number {
    if (isRimColumn(i, k)) return 0;
    const o = colIdx(i, k);
    const h = index.heights[o];
    if (h === NO_SURFACE) return 0;
    // 地下水位より下は水面下か湿地。裸地にしておくと、水位の線が地表でも読める。
    if (h < WATER_TABLE_Y + 0.5) return 0;
    if (this.paved[o]) return 0;
    const geo = GEO_FERTILITY[index.surfaceMat(o)] ?? 0;
    if (geo <= 0) return 0;
    const deg = columnSlopeDeg(index, i, k);
    return geo * (1 - smoothstep(GRASS_FADE_DEG, GRASS_MAX_DEG, deg));
  }

  /** 生成直後の地形に一面の植生を置く。 */
  seedAll(index: HeightIndex): void {
    for (let k = 0; k < NZ; k++) {
      for (let i = 0; i < NX; i++) {
        const o = colIdx(i, k);
        this.cover[o] = this.potentialAt(index, i, k);
        this.baseline[o] = index.heights[o];
        this.lastSeen[o] = 0;
      }
    }
    this.writeMaskAll(index);
    for (let t = 0; t < VEG_TILES_X * VEG_TILES_Z; t++) this.dirtyTiles.add(t);
  }

  /**
   * 路面の列に印を付ける。中心線に沿って呼ぶ。
   * 一度舗装した列は剥がさない (道路を消す手段がそもそも無い)。
   */
  paveDisc(x: number, z: number, radius: number): void {
    const i0 = Math.max(0, Math.floor((x - radius) / CELL));
    const i1 = Math.min(NX - 1, Math.ceil((x + radius) / CELL));
    const k0 = Math.max(0, Math.floor((z - radius) / CELL));
    const k1 = Math.min(NZ - 1, Math.ceil((z + radius) / CELL));
    const r2 = radius * radius;
    for (let k = k0; k <= k1; k++) {
      const dz = k * CELL - z;
      for (let i = i0; i <= i1; i++) {
        const dx = i * CELL - x;
        if (dx * dx + dz * dz > r2) continue;
        const o = colIdx(i, k);
        if (this.paved[o]) continue;
        this.paved[o] = 1;
        if (this.queued[o]) continue;
        this.queued[o] = 1;
        this.queue.push(o);
      }
    }
  }

  /** 地形が動いた範囲を、次の update で必ず見直す。 */
  markDirtyByAABB(minX: number, minZ: number, maxX: number, maxZ: number): void {
    const i0 = Math.max(0, Math.floor(minX / CELL));
    const i1 = Math.min(NX - 1, Math.ceil(maxX / CELL));
    const k0 = Math.max(0, Math.floor(minZ / CELL));
    const k1 = Math.min(NZ - 1, Math.ceil(maxZ / CELL));
    for (let k = k0; k <= k1; k++) {
      for (let i = i0; i <= i1; i++) {
        const o = colIdx(i, k);
        if (this.queued[o]) continue;
        this.queued[o] = 1;
        this.queue.push(o);
      }
    }
  }

  /**
   * 見直しを進める。
   *
   * 積んだ列を先に片付け、そのあと**全列を数フレームで 1 周する総なめ**を進める。
   * 総なめがあるので、地形を動かした側が知らせ忘れても 0.3 秒で追いつく。
   * 道路の着工のように何千列も一度に動かす経路へ、いちいち通知を差し込まなくてよい。
   *
   * @param gameDelta 前フレームからのゲーム内時間 [時]
   */
  update(index: HeightIndex, gameDelta: number, budget = 4096): void {
    this.hours += gameDelta;

    for (let n = this.queue.length; n > 0; n--) {
      const o = this.queue.pop()!;
      this.queued[o] = 0;
      this.visit(index, o);
    }

    const total = NX * NZ;
    for (let n = 0; n < budget; n++) {
      const o = this.cursor;
      this.cursor = this.cursor + 1 >= total ? 0 : this.cursor + 1;
      if (this.queued[o]) continue;
      this.visit(index, o);
    }

    if (this.maskDirty) {
      this.maskDirty = false;
      this.maskTexture.needsUpdate = true;
    }
  }

  /** 1 列を見直す。 */
  private visit(index: HeightIndex, o: number): void {
    const i = o % NX;
    const k = (o / NX) | 0;
    const h = index.heights[o];
    const before = this.cover[o];
    const dtH = this.hours - this.lastSeen[o];
    this.lastSeen[o] = this.hours;

    let c = before;
    if (h === NO_SURFACE) {
      c = 0;
    } else {
      if (Math.abs(h - this.baseline[o]) > DISTURB_M) {
        // 地表が動いた = 掘られた・盛られた・崩れた。植生は剥がれる。
        this.baseline[o] = h;
        c = 0;
      }
      const pot = this.potentialAt(index, i, k);
      if (c > pot) c = pot;
      // 種子吹付だけが緑を連れて戻る
      if (index.protect[o] === 1 && c < pot && dtH > 0) {
        c = Math.min(pot, c + (dtH / REGROW_HOURS) * Math.max(pot, 0.2));
      }
    }

    if (c !== before) {
      this.cover[o] = c;
      // 描画のしきい値をまたいだときだけタイルを作り直す。毎フレーム
      // 全タイルを作り直すと、生え戻りの間じゅう 60 fps が出ない。
      if (Math.abs(c - before) > 0.02) this.dirtyTiles.add(vegTileOf(i, k));
    }
    this.writeMask(o, c, h);
  }

  private writeMask(o: number, c: number, h: number): void {
    const r = (Math.max(0, Math.min(1, c)) * 255) | 0;
    const g = h === NO_SURFACE ? 0 : (Math.max(0, Math.min(1, h / WORLD_Y)) * 255) | 0;
    if (this.mask[o * 2] === r && this.mask[o * 2 + 1] === g) return;
    this.mask[o * 2] = r;
    this.mask[o * 2 + 1] = g;
    this.maskDirty = true;
  }

  private writeMaskAll(index: HeightIndex): void {
    for (let o = 0; o < NX * NZ; o++) this.writeMask(o, this.cover[o], index.heights[o]);
    this.maskTexture.needsUpdate = true;
    this.maskDirty = false;
  }
}
