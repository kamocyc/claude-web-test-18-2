import * as THREE from 'three';
import {
  CELL, Geo, GEO_COUNT, REPOSE_DEG, REPOSE_SATURATED_DROP,
  WATER_TABLE_Y, WORLD_X, WORLD_Y, WORLD_Z,
} from '../terrain/config';
import { applyShape, mergeEdits, type EditResult } from '../terrain/Edit';
import { raycastTerrain, surfaceNormalAt } from '../terrain/raymarch';
import { clamp, smin } from '../terrain/FieldMath';
import type { VoxelField } from '../terrain/VoxelField';
import type { ChunkManager } from '../terrain/ChunkManager';

/**
 * 安息角。急すぎる法面が自重で崩れ、土砂が法尻に溜まる。
 *
 * ---- なぜセルオートマトンにしないか ----
 * 「隣のセルより高ければ土を落とす」式の砂山 CA は、立方格子の上では
 * 安定斜面が格子方向に量子化される。軸方向と対角方向で角度が変わるので、
 * 崩れた山が四角錐になり、**ボクセルの存在がそのまま画面に出る**。
 * このプロジェクトでいちばん壊してはいけない要件なので、この方式は採らない。
 *
 * ---- 代わりに何をしているか ----
 * 「影響球の中の地表を、安息角の平面そのものに均す」を繰り返す。
 *
 *   P   = いちばん急な地表点 (真下向きレイ + PROBE の走査で探す)
 *   g   = 下り方向 = 法線の水平成分 (外向き法線は下り側へ倒れる)
 *   n_r = ŷ cos θr + g sin θr             // 安息角の面の法線
 *   削る = smin( (p-P)·n_r , R - |p-P| )   // 面より上 かつ 球の中 → dig
 *   埋め = smin(-(p-P)·n_r , R - |p-P| )   // 面より下 かつ 球の中 → fill
 *
 * **削りと埋めを同じ球で対にするのが肝。** その球の中の地表は安息角の面
 * そのものになるので、出っ張りが生まれる余地が無い。土が下流へ動くという
 * 性質も保たれる (球の中で上流側が削れて下流側が埋まるため)。
 *
 * 埋めるほうを「法尻に山を積む」形にした版は両方とも駄目だった。
 *  - 球を置く: 地面と交わる所の接線が立ち、置いた端からまた崩落対象になって
 *    土が永久に歩き回る (3600 m^3 動かしても収束しない)
 *  - 安息角の円錐を置く: 収束はするが、山が周りより高い所に取り残されると
 *    「傘の広い上半分 + 細い下半分」が露出して **キノコ**が並ぶ
 * どちらも「点に山を積む」ことが根本原因で、面で均せば両方消える。
 *
 * 使う演算子はプレイヤーの掘削とまったく同じ applyShape なので、
 * 滑らかさは既に実証済みのものがそのまま出る。面の向きは場の勾配から
 * 来る連続量で、格子とは無関係。ここが CA との決定的な違い。
 *
 * ---- 角度が収束する理由 ----
 * 最終的な角度を決めているのは切る形ではなく **判定** のほう。
 * 判定は「P から 1 歩下って落ちた高さ」= その区間の平均勾配で行う。
 * 崩れた後の地表は堆積のつなぎ目で細かく波打っていて、点の法線だけを見ると
 * 全体が寝ていてもいくらでも安息角を超えた所が見つかる。削る操作が
 * 影響半径 R ぶんの大きさを持つのだから、判定も同じ物差しで測る。
 *
 * 面を P 自身に通すのも同じ理由。1 歩下流の Q を支点にすると、急な法面では
 * Q が遥か下になるので毎回削りすぎ、安息角を通り越して寝てしまう。
 *
 * 実測 (高さ 6 m のほぼ垂直な法面が静止するまで):
 *   岩 78 度 → 80.5 度 (動かない) / 土 34 度 → 31.9 度
 *   軟弱 26 度 → 23.5 度 / 軟弱・水位下 18 度 → 18.8 度
 *
 * ---- 暴走しない理由 ----
 *  - 種は編集した AABB からしか撒かない (自然地形は「締まっている」)
 *  - 伝播は hops で数え、MAX_HOPS を超えたら撒かない (= 崩れるのは 15 m 上まで)
 *  - 1 tick に動かせる体積に予算をつける (ゲーム内時間に比例)
 *  - 削りと埋めを対にする (単独の山を置かないので新しい急面が生まれない)
 *  - 削った量 = 埋めた量 + 負債 を恒等式として保つ (土が湧くと永久に崩れ続ける)
 */

/** 影響球の半径 [m]。CELL の 4 倍以上にすること (格子が見えないための最低条件)。 */
const R = 2.2;

/** サイトの間隔 = 伝播の 1 歩 [m]。 */
const STEP = R;

/** これを超えたら崩す [度]。安息角ちょうどで判定すると境界を往復する。 */
const HYSTERESIS_DEG = 4;

/**
 * 1 歩 (STEP) 下ってこれだけ落ちていなければ崩さない [m]。
 * atan(0.6 / 2.2) = 15 度ぶん。いちばん寝る組み合わせ (軟弱層・水位下で 18 度)
 * より緩くしておかないと、そこだけ安息角に届かなくなる。
 */
const MIN_SCARP = 0.6;

/** 崩落面を標本点よりどれだけ下に通すか [m]。詳細は使用箇所。 */
const PIVOT_DROP = 0.15;

/** 伝播の上限。STEP * MAX_HOPS ≒ 15 m まで後退できる。実際にはたいてい手前で止まる。
 * 触っていない地山は NATURAL_BONUS_DEG ぶん強く、そこで崩落が止まるため。 */
const MAX_HOPS = 7;

/**
 * 崩す速さ [m^3 / ゲーム内時間]。
 * Time.HOURS_PER_SECOND = 0.5 なので、速度 1 では実時間 22 m^3/s。
 * 1 回の切り取りが 5〜15 m^3 なので、0.3 秒に 1 回くらい崩れる。
 * 高さ 3 m の切土法面が実時間 2〜4 秒で落ち着く、が狙い。
 */
const SLUMP_RATE = 90;

/** 1 tick で処理するサイト数の上限。 */
const MAX_SITES_PER_TICK = 6;

/** 待ち行列の上限。大きな掘削で無限に溜まらないように。 */
const MAX_QUEUE = 600;

/** 崩落のブレンド幅 [m]。掘削 (0.5) より広く取って法面をなだらかに見せる。 */
const BLEND = 0.7;

/** 影響球の縁を丸める幅 [m]。ここを 0 にすると地形が低ポリゴンに見える。 */
const RIM_BLEND = 0.6;

/** 体積の帳尻合わせで安息角面を上下させられる幅 [m]。詳細は使用箇所。 */
const MAX_LIFT = 0.5;

/** これ未満しか削れなければ「動かせなかった」とみなす [m^3]。 */
const MIN_CUT_VOL = 0.02;

/** サイトの量子化幅 [m]。近い種をまとめる粒度。 */
const KEY_CELL = 0.7;

/**
 * 人が触っていない地山に与える上乗せ [度]。
 *
 * 安息角は「ほぐれた土が自然に積もる角度」であって、締まって根の張った
 * 地山がその角度でしか立てないわけではない。生成される自然地形には
 * 45 度前後の斜面が普通にあるので、上乗せが無いと斜面のどこを 1 回掘っても
 * 周囲 15 m がまとめて崩れる。実測で、深さ 5 m の切土 1 本 (掘削 250 m³) に対して
 * **6300 m³** が動いていた。掘るたびに山が半分無くなるのは明らかに行き過ぎ。
 *
 * 触った所は本来の安息角、触っていない所はこの分だけ強い、とする。
 * 「掘った所の周辺だけが崩れる」という方針をそのまま角度で表したもの。
 */
const NATURAL_BONUS_DEG = 14;

/** 触った範囲を覚えておく粒度 [m]。 */
const DISTURB_CELL = 2.0;

/**
 * サイトの中で「いちばん急な所」を探す小さな走査 [m]。
 *
 * これが要る理由。ブラシで掘った切土の壁は、真下向きレイで見ると
 * **急な帯が 0.3 m ほどしかない**。円柱の一番太い所は接線が垂直なので、
 * 水平方向にはほとんど幅を持たないため。キーの位置をそのまま標本にすると
 * 帯をまたいで平らな所ばかり拾い、「掘ったのに崩れない」になる。
 * セル (0.5 m) より細かく見れば取りこぼさない。場にそれ以上細かい形は無い。
 */
const PROBE = 0.35;
const PROBE_OFFSETS: readonly (readonly [number, number])[] = [
  [0, 0], [PROBE, 0], [-PROBE, 0], [0, PROBE], [0, -PROBE],
];


const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _origin = new THREE.Vector3();
const DOWN = new THREE.Vector3(0, -1, 0);

/** 安息角 [度]。水位より下は飽和して寝る。 */
export function reposeAngleDeg(geo: Geo, belowWater: boolean): number {
  const base = REPOSE_DEG[geo] ?? REPOSE_DEG[Geo.Soil];
  return belowWater ? Math.max(5, base - REPOSE_SATURATED_DROP) : base;
}

/** (x,z) の真上から降ろしたレイが最初に当たる地表。無ければ null。 */
function surfaceAt(field: VoxelField, x: number, z: number, out: THREE.Vector3): boolean {
  if (x < 0 || z < 0 || x > WORLD_X || z > WORLD_Z) return false;
  _origin.set(x, WORLD_Y, z);
  const hit = raycastTerrain(field, _origin, DOWN, WORLD_Y + 1);
  if (!hit) return false;
  out.copy(hit.point);
  return true;
}

export interface SlopeInfo {
  geo: Geo;
  /** 現在の斜度 [度]。 */
  slopeDeg: number;
  /** その地質・その深さでの安息角 [度]。 */
  reposeDeg: number;
  y: number;
}

/**
 * カーソル下の斜度と安息角。HUD 用。
 * 地面が勝手に動く理由をプレイヤーに見せるために要る。
 */
export function slopeInfoAt(field: VoxelField, x: number, z: number): SlopeInfo | null {
  if (!surfaceAt(field, x, z, _p)) return null;
  surfaceNormalAt(field, _p.x, _p.y, _p.z, _n);
  const geo = field.materialAt(_p.x, _p.y, _p.z);
  return {
    geo,
    slopeDeg: (Math.acos(clamp(_n.y, -1, 1)) * 180) / Math.PI,
    reposeDeg: reposeAngleDeg(geo, _p.y < WATER_TABLE_Y),
    y: _p.y,
  };
}

/** 量子化した XZ から整数キー。ワールドは 128 m なので 1024 刻みで足りる。 */
function keyOf(x: number, z: number): number {
  const qi = Math.round(x / KEY_CELL);
  const qk = Math.round(z / KEY_CELL);
  return qi * 1024 + qk;
}

/**
 * キーから決まるジッタ [-0.5, 0.5)。
 * サイトを量子化したまま使うと標本点が格子に並ぶ。幾何そのものは
 * 実測した地表点と連続な法線から来るので格子は出ないのだが、
 * 崩す順序に規則性が出ると鱗のような模様に見えることがある。
 * 決定的なハッシュなのでテストは再現する (Math.random は使わない)。
 */
function jitter(key: number, salt: number): number {
  let h = (key ^ (salt * 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296 - 0.5;
}

export class ReposeSystem {
  /** キー → hops。Map の挿入順がそのまま処理順になる。 */
  private sites = new Map<number, number>();
  /** プレイヤーが触った所 (2 m 刻み)。ここだけ本来の安息角で崩れる。 */
  private disturbed = new Set<number>();
  /** まだ法尻に置いていない土砂 [m^3]。 */
  private debt = 0;
  /** 未消化の体積予算 [m^3]。 */
  private budget = 0;

  /** この tick で動いた体積 [m^3]。警告のスロットルと HUD に使う。 */
  movedThisTick = 0;
  /** 累計で動かした体積 [m^3]。検証用。 */
  movedTotal = 0;
  /** 累計で法尻に置いた体積 [m^3]。検証用。 */
  depositedTotal = 0;

  get pending(): number {
    return this.sites.size;
  }

  /** まだ置いていない土砂 [m^3]。削った量 = 置いた量 + これ、が常に成り立つ。 */
  get debtRemaining(): number {
    return this.debt;
  }

  /** 崩れている最中か。 */
  get active(): boolean {
    return this.sites.size > 0;
  }

  reset(): void {
    this.sites.clear();
    this.disturbed.clear();
    this.debt = 0;
    this.budget = 0;
    this.movedTotal = 0;
    this.depositedTotal = 0;
  }

  private seed(x: number, z: number, hops: number): void {
    if (hops > MAX_HOPS) return;
    if (x < 0 || z < 0 || x > WORLD_X || z > WORLD_Z) return;
    if (this.sites.size >= MAX_QUEUE) return;
    const key = keyOf(x, z);
    const prev = this.sites.get(key);
    // 既にあるなら、より若い hops を残す (伝播の余力を殺さない)
    if (prev !== undefined && prev <= hops) return;
    this.sites.delete(key);
    this.sites.set(key, hops);
  }

  /** その XZ が「触った所」か。触っていない地山は上乗せぶん強い。 */
  private isDisturbed(x: number, z: number): boolean {
    return this.disturbed.has(
      Math.round(x / DISTURB_CELL) * 4096 + Math.round(z / DISTURB_CELL),
    );
  }

  /** 触った範囲として覚える。 */
  private markDisturbed(x: number, z: number): void {
    if (x < 0 || z < 0 || x > WORLD_X || z > WORLD_Z) return;
    this.disturbed.add(
      Math.round(x / DISTURB_CELL) * 4096 + Math.round(z / DISTURB_CELL),
    );
  }

  /** 編集した AABB の footprint に候補を撒く。掘削のたびに呼ぶ。 */
  seedFromEdit(min: readonly number[], max: readonly number[]): void {
    // 触った範囲そのもの (種を撒く範囲より狭い) を覚える
    for (let z = min[2]; z <= max[2] + DISTURB_CELL; z += DISTURB_CELL) {
      for (let x = min[0]; x <= max[0] + DISTURB_CELL; x += DISTURB_CELL) {
        this.markDisturbed(x, z);
      }
    }

    const x0 = min[0] - STEP;
    const z0 = min[2] - STEP;
    const x1 = max[0] + STEP;
    const z1 = max[2] + STEP;

    // 巨大な AABB (テスト用の一括掘削など) でキューを溢れさせない
    const nx = Math.ceil((x1 - x0) / STEP);
    const nz = Math.ceil((z1 - z0) / STEP);
    const stride = Math.max(1, Math.ceil(Math.sqrt((nx * nz) / 256)));

    for (let iz = 0; iz <= nz; iz += stride) {
      for (let ix = 0; ix <= nx; ix += stride) {
        this.seed(x0 + ix * STEP, z0 + iz * STEP, 0);
      }
    }
  }

  /** 1 点まわりに撒く。トンネルの陥没孔の縁を寝かせるのに使う。 */
  seedAround(pos: THREE.Vector3, radius: number): void {
    for (let z = -radius; z <= radius; z += DISTURB_CELL) {
      for (let x = -radius; x <= radius; x += DISTURB_CELL) {
        this.markDisturbed(pos.x + x, pos.z + z);
      }
    }
    const n = Math.max(1, Math.ceil(radius / STEP));
    for (let iz = -n; iz <= n; iz++) {
      for (let ix = -n; ix <= n; ix++) {
        this.seed(pos.x + ix * STEP, pos.z + iz * STEP, 0);
      }
    }
  }

  /**
   * 1 tick 分進める。動いたら EditResult (まとめたもの) を返す。
   * 呼び出し側はこれを tunnels.markDirtyByAABB に流すこと。
   * **法面が崩れて土被りが減れば必要支保が上がる**、がそれで自動的につながる。
   *
   * @param gameDelta ゲーム内時間の経過 [時]
   */
  update(field: VoxelField, chunks: ChunkManager, gameDelta: number): EditResult | null {
    this.movedThisTick = 0;
    if (gameDelta <= 0 || this.sites.size === 0) return null;

    this.budget += SLUMP_RATE * gameDelta;
    // 溜め込むと、しばらく崩れなかった後に一気にごっそり落ちる。
    // 上限をつけて「常に少しずつ」に寄せる。
    this.budget = Math.min(this.budget, SLUMP_RATE * 0.25);

    let merged: EditResult | null = null;
    let processed = 0;

    while (this.budget > 0 && processed < MAX_SITES_PER_TICK && this.sites.size > 0) {
      const it = this.sites.entries().next();
      if (it.done) break;
      const [key, hops] = it.value;
      this.sites.delete(key);
      processed++;

      const res = this.stepSite(field, chunks, key, hops);
      if (!res) continue;

      this.budget -= res.moved;
      this.movedThisTick += res.moved;
      merged = merged ? mergeEdits(merged, res.edit) : res.edit;
    }

    this.movedTotal += this.movedThisTick;
    return merged;
  }

  /**
   * サイト 1 個の処理。安定していれば何もせず、サイトは消える。
   * 崩したら、上流と左右に種を撒き、自分自身も撒き直して再判定させる。
   */
  private stepSite(
    field: VoxelField,
    chunks: ChunkManager,
    key: number,
    hops: number,
  ): { edit: EditResult; moved: number } | null {
    const qi = Math.floor(key / 1024);
    const qk = key - qi * 1024;
    const sx = qi * KEY_CELL + jitter(key, 1) * KEY_CELL;
    const sz = qk * KEY_CELL + jitter(key, 2) * KEY_CELL;

    // --- 1) いちばん急な地表点を探す (PROBE のコメント参照) ---
    let px = 0;
    let py = 0;
    let pz = 0;
    let theta = -1;
    let nx = 0;
    let nz = 0;

    for (const [ox, oz] of PROBE_OFFSETS) {
      if (!surfaceAt(field, sx + ox, sz + oz, _p)) continue;
      surfaceNormalAt(field, _p.x, _p.y, _p.z, _n);
      const t = Math.acos(clamp(_n.y, -1, 1));
      if (t <= theta) continue;
      theta = t;
      px = _p.x;
      py = _p.y;
      pz = _p.z;
      nx = _n.x;
      nz = _n.z;
    }
    if (theta < 0) return null; // どこにも地面が無い

    const geo = field.materialAt(px, py, pz);
    // 触っていない地山は上乗せぶん強い (NATURAL_BONUS_DEG のコメント参照)
    const reposeDeg = reposeAngleDeg(geo, py < WATER_TABLE_Y)
      + (this.isDisturbed(px, pz) ? 0 : NATURAL_BONUS_DEG);
    const thetaR = (reposeDeg * Math.PI) / 180;

    // 1 点の法線が安息角以下なら確実に安定。下流のレイを撃つ前に落とす。
    if (theta <= thetaR) return null;

    // --- 2) 下り方向 ---
    // 外向き法線の水平成分は **下り側** を向く (斜面の外へ倒れるので)。
    // 符号を逆にすると Q が必ず自分より高くなり、どこも崩れなくなる。
    let gx = nx;
    let gz = nz;
    const gl = Math.hypot(gx, gz);
    if (gl < 1e-3) return null; // 水平。ここまで来ないはずだが念のため
    gx /= gl;
    gz /= gl;

    // --- 3) 法尻側の支点 ---
    //
    // 1 歩ぶんだけを見てはいけない。狭い切土だと 1 歩で溝を跨いで
    // **向こう側の法面**に着地してしまい、そこは自分より高いので
    // 「下っていない = 崩れない」と誤判定する。幅の狭い掘り方をすると
    // いつまでも垂直の壁が残る、という形で出る。
    // 基本は 1 歩ぴったり先の地表点。判定に使う物差しを 1 つに固定しておかないと、
    // 「一番急な所」「一番低い所」のような採り方になり、波打った地表の局所的な
    // 凹凸を拾って安息角を通り越して削り続けてしまう (どちらも試して確認した)。
    if (!surfaceAt(field, px + gx * STEP, pz + gz * STEP, _p)) return null;
    let qy = _p.y;
    let bestDist = STEP;

    // ただし狭い切土だけは例外。1 歩で溝を跨いで **向こう側の法面** に着地すると
    // そこは自分より高いので「下っていない = 崩れない」と誤判定し、
    // 幅の狭い掘り方をするといつまでも垂直の壁が残る。
    // 跨いだと分かったときだけ、半歩で測り直す。
    if (qy >= py && surfaceAt(field, px + gx * STEP * 0.5, pz + gz * STEP * 0.5, _p)) {
      qy = _p.y;
      bestDist = STEP * 0.5;
    }
    const bestGrad = (py - qy) / bestDist;

    // --- 崩すかどうかは「1 歩ぶんの平均勾配」で決める ---
    //
    // 1 点の法線で決めてはいけない。崩れた後の地表は堆積のつなぎ目で細かく
    // 波打っているので、全体が寝ていても局所的な法線はいくらでも安息角を超える。
    // 実際、点の法線で判定していたときは土も軟弱層も地質によらず 20 度まで
    // 削り続けていた (止めていたのは MIN_SCARP のほうで、安息角は効いていなかった)。
    // 削る操作が影響半径 R ぶんの大きさを持つのだから、判定も同じ物差しで測る。
    //
    // MIN_SCARP はそれとは別に、高さ数十 cm のこぶを無視するための下限。
    // 現実にも小さなこぶは崩れないし、これが無いと堆積のつなぎ目を
    // 延々と削っては積み直して静止しない。
    if (bestGrad <= Math.tan(thetaR + (HYSTERESIS_DEG * Math.PI) / 180)) return null;
    if (bestGrad * bestDist < MIN_SCARP) return null;

    // --- 4) 安息角の面 ∩ 影響球 で削る ---
    const sinR = Math.sin(thetaR);
    const cosR = Math.cos(thetaR);
    // 面の法線。上を向きつつ下り方向へ傾く。
    const nrx = gx * sinR;
    const nry = cosR;
    const nrz = gz * sinR;

    // 面は **P 自身** を通す。1 歩下流の地表点 Q を支点にすると、急な法面では
    // Q が遥か下になるので面が低すぎる所に来て、毎回必要以上に削ってしまう。
    // 結果、安息角を通り越して寝すぎる (土で 34 度の狙いが 26 度になっていた)。
    // P を通せば「P から上を安息角で寝かせる」だけになり、削りすぎない。
    // わずかに下げてあるのは、階段状に取り残さず確実に食い込ませるため。
    //
    // lift は体積の帳尻合わせ。削りが勝って土が余っていれば面を少し持ち上げ、
    // 次の操作で埋めが増えるようにする。面の高さ 1 本で収支を操作できる。
    const lift = clamp(this.debt / (Math.PI * R * R), -MAX_LIFT, MAX_LIFT);
    const ay = py - PIVOT_DROP + lift;

    const lo = -R - BLEND - 2 * CELL;
    const hi = R + BLEND + 2 * CELL;
    /** 安息角面より上か (正 = 上)。 */
    const above = (x: number, y: number, z: number) =>
      (x - px) * nrx + (y - ay) * nry + (z - pz) * nrz;
    /** 影響球の中か (正 = 中)。 */
    const ball = (x: number, y: number, z: number) =>
      R - Math.hypot(x - px, y - py, z - pz);

    // 面より上を削り、**同じ球の中で面より下を埋める**。
    //
    // 埋めるほうを別の場所に山として置いてはいけない。円錐にすると、置いた山が
    // 周りの地面より高い所に取り残されたときに「傘の広い上半分 + 細い下半分」が
    // そのまま露出して **キノコ**に見える。球にすると地面と交わる所の接線が立って
    // 永久に崩れ続ける。どちらも「点に山を積む」ことが根本の原因。
    //
    // 同じ球の中で上を削って下を埋めれば、その球の中の地表は安息角の面そのものに
    // なる。出っ張りが生まれる余地が無く、隣の球とも同じ向きの面でつながる。
    // 土が下流へ動くという性質も保たれる (球の中で上流側を削り下流側を埋めるので)。
    const cut = applyShape(
      field, chunks,
      px + lo, py + lo, pz + lo, px + hi, py + hi, pz + hi,
      // 積集合 (正 = 内側なので min)。**素の min にしないこと。**
      // 素で取ると球の縁に沿って鋭い折れ目ができ、隣り合う崩落の面どうしが
      // 稜線で交わって、地形が低ポリゴンの割れた岩のように見える。
      (x, y, z) => smin(above(x, y, z), ball(x, y, z), RIM_BLEND),
      'dig', BLEND, Geo.Soil,
    );

    if (!cut.changed || cut.totalVolume < MIN_CUT_VOL) {
      // 削れなかった = この形では動かせない。伝播だけさせて次へ。
      this.seed(px - gx * STEP, pz - gz * STEP, hops + 1);
      return null;
    }

    // 崩れた土砂は元の地質のまま。Geo.Weak に変えると、崩れるたびに
    // 安息角が下がって同じ斜面が延々と崩れ続ける。
    let fallenGeo: Geo = geo;
    let bestVol = -Infinity;
    for (let g = 0; g < GEO_COUNT; g++) {
      if (cut.volumeByGeo[g] > bestVol) {
        bestVol = cut.volumeByGeo[g];
        fallenGeo = g as Geo;
      }
    }

    this.debt += cut.totalVolume;
    let edit = cut;

    // --- 5) 同じ球の中で、面より下を埋める ---
    const fill = applyShape(
      field, chunks,
      px + lo, py + lo, pz + lo, px + hi, py + hi, pz + hi,
      (x, y, z) => smin(-above(x, y, z), ball(x, y, z), RIM_BLEND),
      'fill', BLEND, fallenGeo,
    );
    if (fill.changed) {
      const added = -fill.totalVolume; // fill なので totalVolume は負
      // 負債は負にもする。多く埋めてしまっても、その分だけ次から面が下がって
      // 帳尻が合う。0 で止めると差額がそのまま「湧いた土」になる。
      // これで 削った量 = 埋めた量 + 負債 が恒等式として常に成り立つ。
      this.debt -= added;
      this.depositedTotal += added;
      edit = mergeEdits(edit, fill);
    }

    // ここで「崩れた跡も緩んだ地山だ」として markDisturbed してはいけない。
    // 崩落が自分の進む先を次々と緩い扱いにしていくので、地滑りが自分で道を
    // 塗りながら斜面を登り続ける。実測で、掘削 250 m³ に対し 3900 m³ が動いていた。
    // 触っていない地山の強さは触っていないまま残す。そうすると崩落は
    // 「掘った範囲を安息角まで寝かせて、そのすぐ外で止まる」に落ち着く。

    // --- 6) 伝播 ---
    // 自分の再判定は **キーの位置** で撒く。走査で見つけた px は最大 PROBE
    // ずれているので、そちらで撒き直すと同じ hops のままサイトが少しずつ
    // 移動できてしまい、15 m の打ち切りをすり抜けて山を登っていく。
    this.seed(sx, sz, hops);
    this.seed(px - gx * STEP, pz - gz * STEP, hops + 1);        // 上流
    this.seed(px - gz * STEP, pz + gx * STEP, hops + 1);        // 左右
    this.seed(px + gz * STEP, pz - gx * STEP, hops + 1);

    return { edit, moved: cut.totalVolume };
  }

}
