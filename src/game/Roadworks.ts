import * as THREE from 'three';
import {
  CELL, NX, NZ, Geo, DIG_COST,
} from '../terrain/config';
import { colIdx, isRimColumn, NO_SURFACE, type HeightIndex } from '../terrain/HeightIndex';
import { applyCapsule, applyColumnHeights, type ColumnHeightWrite } from '../terrain/Edit';
import { ANISO_CENTER, type ReposeSystem } from '../terrain/Repose';
import type { VoxelField } from '../terrain/VoxelField';
import type { ChunkManager } from '../terrain/ChunkManager';
import {
  RoadKind, runsOf, tunnelRadius, boreCenterY,
  type Alignment, type Station, type TerrainProbe, STATION_STEP,
} from './Alignment';
import { coverAtCrown, isTunnelCover, type TunnelNetwork } from './Tunnel';
import {
  BridgeNetwork, planBridge, type BridgePlan, type GeoSampler, type PierSite,
} from './Bridge';
import { Economy } from './Economy';
import type { Crew, CrewJob } from './Crew';

export { tunnelRadius };

/**
 * 道路の施工。線形 (Alignment) を地形に落とし込む所。
 *
 * ---- 回廊は「掘る形」ではなく「切盛のテンプレート」で書く ----
 * 中心線に沿ってブラシで削るやり方も試したが、円筒ブラシは必ず庇を残すし、
 * 路面が刻み幅ぶん波打つ。ここで欲しいのは
 *
 *     路面幅のあいだは計画高そのもの、その外は法面が地山に当たるまで
 *
 * という**断面のテンプレート**なので、素直に高さ場へ書く。
 *   切りエンベロープ  cut[o]  = min_区間 ( 計画高 + max(0, d - 幅/2) * tanθ )
 *   盛りエンベロープ  fill[o] = max_区間 ( 計画高 - max(0, d - 幅/2) * tanθ )
 *   最終の地表        h[o]    = clamp(いまの地表, fill[o], cut[o])
 *
 * これは Repose の書き戻し (`Edit.applyColumnHeights`) がそのまま受けられる形で、
 * 地形の作り方 (正規化ハイトフィールド) とも同じなので、路面も法面も
 * 周りの地形と地続きになり、格子が出ない。
 *
 * ---- 法面を最初から安息角で切る ----
 * 垂直に切って安息角に任せると、崩れた土が路面へ流れ込んで道が埋まる。
 * 最初から `安息角 * ANISO_CENTER` で切っておけば、整定は**何もしない**
 * (min/max が冪等なので厳密に no-op)。「掘ったら崩れる」を回避するために
 * 崩落の規則へ例外を書くのではなく、**崩れない形で作る**。
 * これは現実の切土設計とも同じ順序になっている。
 *
 * 法面保護工が入っている列はその角度を使う。掘り直しで保護が外れる規則
 * (Repose.seedFromEdit) に当たるので、書き戻したあとに入れ直す。塗った面を
 * 切り直したのだから、支えているのは新しい法面のほうだと考える。
 * ここを入れ直さないと、「先に擁壁を塗ってから道路を通す」が
 * 金だけ捨てる操作になる。
 */

/** 路肩の外に見込む余裕 [m]。法面が地山に当たるまでの探索幅の下駄。 */
const REACH_MARGIN = 3;
/** 法面の探索幅の上限 [m]。暴走の歯止め。 */
const MAX_REACH = 34;

/**
 * 設計法面に掛ける安全率。
 * 16 近傍の離散化で安定角は方位により公称値の周りに 0.5 度ほど振れるので、
 * 公称ちょうどで切ると方位によっては 1 セルぶん崩れて路肩が欠ける。
 */
const SLOPE_SAFETY = 0.985;

/**
 * 探索幅を見込むときに使う「いちばん寝る角度」の tan。
 * 水位下の軟弱層 (22 度) より寝ることは無いので、ここまで見ておけば足りる。
 */
const FLATTEST_TAN = Math.tan((22 * Math.PI) / 180);

/**
 * 橋台・坑口の面として保護する帯の幅 [m]。
 *
 * 面のすぐ内側の列だけを立たせれば足りる。円盤で塗ると、路面幅ぶんしか
 * 覆えないのに面のほうは法面の幅 (盛土 9 m なら片側 13 m) まで広がっていて、
 * 外側が保護されずにそこから谷へ流れ落ちる (実測: 谷底が 2.4 m 埋まった)。
 */
const CAP_BAND = 1.5;
/** 橋台・坑口に入れる保護の等級。擁壁と同じ 88 度。 */
const CAP_PROTECT_LEVEL = 3;

/**
 * 実物の地形プローブ。線形の分類 (`Alignment.classify`) に渡す。
 *
 * **トンネルかどうかの判定を、掘る側とまったく同じ述語で答えるのが役目。**
 * `Alignment` は何も import しない純粋モジュールなので、terrain と Tunnel を
 * 知っているこちら側で組んでやる。テストは同じ形の合成プローブを渡す。
 */
export function terrainProbe(field: VoxelField, index: HeightIndex): TerrainProbe {
  return {
    groundAt: (x, z) => groundHeightAt(index, x, z),
    tunnelAt: (x, y, z, r) => isTunnelCover(coverAtCrown(field, x, y, z, r), r),
  };
}

/** 列 (x,z) の地盤高を双一次補間で読む。線形は 0.5 m 格子より細かく刻むため。 */
export function groundHeightAt(index: HeightIndex, x: number, z: number): number {
  const gx = x / CELL;
  const gz = z / CELL;
  const i = Math.floor(gx);
  const k = Math.floor(gz);
  const fx = gx - i;
  const fz = gz - k;
  const h = index.heights;

  let sum = 0;
  let w = 0;
  for (let dk = 0; dk <= 1; dk++) {
    for (let di = 0; di <= 1; di++) {
      const ii = i + di;
      const kk = k + dk;
      if (ii < 0 || kk < 0 || ii >= NX || kk >= NZ) continue;
      const v = h[ii + kk * NX];
      if (v === NO_SURFACE) continue;
      const ww = (di ? fx : 1 - fx) * (dk ? fz : 1 - fz);
      sum += v * ww;
      w += ww;
    }
  }
  return w > 0 ? sum / w : 0;
}

// ------------------------------------------------------------------ 回廊の展開

export interface Corridor {
  /** 列 → 目標の地表高 [m]。 */
  target: Map<number, number>;
  /** 列 → 設計に使った法面保護工のレベル。入れ直すために覚えておく。 */
  usedProtect: Map<number, number>;
  cutVolume: number;
  fillVolume: number;
}

/**
 * 中心線に沿った切盛のテンプレートを列の高さに落とす。
 * 橋とトンネルの区間は土工しないので飛ばす。
 *
 * ---- 断面は「いちばん近い区間」ひとつで決める ----
 * 切りと盛りのエンベロープを区間ごとに min / max で重ねると、路面が
 * **刻み幅ぶん波打つ**。勾配 10 % なら隣の測点とは 0.2 m 違うので、
 * 中心線上の列で「切りの下限 = 隣の低いほう」「盛りの上限 = 隣の高いほう」に
 * なり、上限のほうが下限より高くなって路面が常に高いほうへ寄る
 * (実測: 計画高から 0.1998 m ずれた = 勾配 * 刻み幅そのもの)。
 *
 * 最寄りの区間ひとつで断面を決めれば、切りと盛りが必ず同じ区間から出るので
 * この破綻が起きない。断面の中心が中心線に沿って連続に動くので、
 * 区間の継ぎ目でも段にならない。
 *
 * ---- 構造物との境目は垂直に切る (橋台・坑口) ----
 * 区間の端で法面を円錐状に伸ばすと、橋の取付部の盛土が**谷へこぼれ落ちて**
 * 架けたい谷を半分埋める (実測: 深さ 30 m の谷の底が 10 m から 28.8 m へ)。
 * トンネル側はもっと悪く、坑口の切土が尾根へ 18 m 食い込んで土被りを削り、
 * トンネルとして成立しなくなる。
 *
 * 現実にこれを止めているのが橋台と坑口で、どちらも「そこで土をやめる」ための
 * 構造物そのもの。だから構造物に接する端では法面を伸ばさず垂直に切り、
 * その面には擁壁と同じ保護 (88 度) を入れる。費用は橋台とトンネル支保が
 * すでに持っている。
 */
function rasterizeCorridor(index: HeightIndex, al: Alignment): Corridor {
  const { heights } = index;
  const half = al.std.width / 2;
  const usedProtect = new Map<number, number>();

  /** 列 → 最寄り区間から決めた断面。 */
  const near = new Map<number, { d: number; cut: number; fill: number }>();

  const earth = (st: Station): boolean =>
    st.kind === RoadKind.Flat || st.kind === RoadKind.Cut || st.kind === RoadKind.Fill;

  /** 土工する区間の連なりを拾う。 */
  const runs: [number, number][] = [];
  for (let i = 0; i < al.stations.length; ) {
    if (!earth(al.stations[i])) { i++; continue; }
    let j = i;
    while (j < al.stations.length && earth(al.stations[j])) j++;
    runs.push([i, j]);
    i = j;
  }

  for (const [runA, runB] of runs) {
    // 構造物に挟まれている端か (= 橋台 / 坑口を立てる端か)。
    // そこから先へは土をこぼさない。半空間で切るので、端の 1 区間だけを
    // 見るのでは足りない (手前の区間の円錐が端を越えて伸びる)。
    const caps: { px: number; pz: number; ux: number; uz: number }[] = [];
    if (runA > 0) {
      const t = al.stations[runA];
      caps.push({ px: t.x, pz: t.z, ux: -t.dirX, uz: -t.dirZ });
    }
    if (runB < al.stations.length) {
      const t = al.stations[runB - 1];
      caps.push({ px: t.x, pz: t.z, ux: t.dirX, uz: t.dirZ });
    }

    for (let n = runA; n + 1 < runB; n++) {
      const a = al.stations[n];
      const b = al.stations[n + 1];

      // 法面が地山に当たるまでの探索幅。差が大きいほど広く見る。
      // 地盤高は**索引から直に読む**。線形が持っている ground は線形を引いた
      // 時点の値なので、そこと食い違うと探索幅が足りず、法面が寝きる前に
      // 打ち切られて垂直な壁が残る (実測 85 度)。
      const drop = Math.max(
        Math.abs(a.y - groundHeightAt(index, a.x, a.z)),
        Math.abs(b.y - groundHeightAt(index, b.x, b.z)),
      );
      const reach = Math.min(MAX_REACH, half + REACH_MARGIN + drop / FLATTEST_TAN);

      const abx = b.x - a.x;
      const abz = b.z - a.z;
      const abLen2 = abx * abx + abz * abz;

      const i0 = Math.max(1, Math.floor((Math.min(a.x, b.x) - reach) / CELL));
      const i1 = Math.min(NX - 2, Math.ceil((Math.max(a.x, b.x) + reach) / CELL));
      const k0 = Math.max(1, Math.floor((Math.min(a.z, b.z) - reach) / CELL));
      const k1 = Math.min(NZ - 2, Math.ceil((Math.max(a.z, b.z) + reach) / CELL));

      for (let k = k0; k <= k1; k++) {
        for (let i = i0; i <= i1; i++) {
          if (isRimColumn(i, k)) continue;
          const o = colIdx(i, k);
          if (heights[o] === NO_SURFACE) continue;

          const px = i * CELL;
          const pz = k * CELL;

          // 構造物に接する端の外側は触らない = そこで垂直に切る。
          // 面のすぐ内側は擁壁と同じ保護で立たせる (= 橋台 / 坑口)。
          let capped = false;
          let onCap = false;
          for (const c of caps) {
            const s = (px - c.px) * c.ux + (pz - c.pz) * c.uz;
            if (s > 0) { capped = true; break; }
            if (s > -CAP_BAND) onCap = true;
          }
          if (capped) continue;

          const traw = abLen2 > 1e-9
            ? ((px - a.x) * abx + (pz - a.z) * abz) / abLen2
            : 0;
          const t = traw < 0 ? 0 : traw > 1 ? 1 : traw;
          const cx = a.x + abx * t;
          const cz = a.z + abz * t;
          const d = Math.hypot(px - cx, pz - cz);
          if (d > reach) continue;
          const prev = near.get(o);
          if (prev && prev.d <= d) continue;

          const y = a.y + (b.y - a.y) * t;
          const out = Math.max(0, d - half);

          // 法面の角度。保護工が入っていればそちらが勝つ (Repose.pourColumn と同じ規約)。
          const repose = index.reposeTan(o);
          const guard = index.protectTan(o);
          const talus = Math.max(repose, guard) * ANISO_CENTER * SLOPE_SAFETY;
          if (guard > repose && out > 0) {
            const lv = index.protect[o];
            if ((usedProtect.get(o) ?? 0) < lv) usedProtect.set(o, lv);
          }
          if (onCap && (usedProtect.get(o) ?? 0) < CAP_PROTECT_LEVEL) {
            usedProtect.set(o, CAP_PROTECT_LEVEL);
          }

          near.set(o, { d, cut: y + out * talus, fill: y - out * talus });
        }
      }
    }
  }

  const target = new Map<number, number>();
  let cutVolume = 0;
  let fillVolume = 0;
  const area = CELL * CELL;
  for (const [o, sec] of near) {
    const hOld = heights[o];
    let hNew = hOld;
    if (hNew > sec.cut) hNew = sec.cut;
    if (hNew < sec.fill) hNew = sec.fill;
    if (Math.abs(hNew - hOld) < 1e-3) continue;
    target.set(o, hNew);
    if (hNew < hOld) cutVolume += (hOld - hNew) * area;
    else fillVolume += (hNew - hOld) * area;
  }
  return { target, usedProtect, cutVolume, fillVolume };
}

// ------------------------------------------------------------------ 見積り

export interface RoadPlan {
  al: Alignment;
  corridor: Corridor;
  bridges: BridgePlan[];
  /** トンネル区間の [開始, 終了) 添字。 */
  tunnelRuns: [number, number][];
  tunnelLength: number;
  tunnelVolume: number;

  cutVolume: number;
  fillVolume: number;
  earthCost: number;
  tunnelCost: number;
  bridgeCost: number;
  paveCost: number;
  totalCost: number;
  /** 施工班に積む総時間 [ゲーム内時間]。土工は即時なので含めない。 */
  hours: number;

  /** 施工できない理由。空なら着工できる。 */
  problems: string[];
  ok: boolean;
}

/** 掘削量から費用と残土収支を見積もる。Economy.chargeExcavation と同じ勘定。 */
function estimateEarthCost(
  field: VoxelField,
  index: HeightIndex,
  corridor: Corridor,
  spoilOnHand: number,
): number {
  const area = CELL * CELL;
  let cost = 0;
  let spoil = spoilOnHand;
  let need = 0;
  for (const [o, hNew] of corridor.target) {
    const hOld = index.heights[o];
    const i = o % NX;
    const k = (o / NX) | 0;
    const vol = Math.abs(hNew - hOld) * area;
    if (hNew < hOld) {
      const g = field.materialAt(i * CELL, (hOld + hNew) * 0.5, k * CELL);
      cost += vol * DIG_COST[g];
      spoil += vol;
    } else {
      need += vol;
    }
  }
  const fromSpoil = Math.min(spoil, need);
  cost += (need - fromSpoil) * Economy.IMPORT_COST;
  return cost;
}

/** 測点の列から距離 s の位置を線形補間で引く。橋脚を置く位置に使う。 */
function siteAt(al: Alignment, s: number, index: HeightIndex): PierSite {
  const sts = al.stations;
  let i = Math.min(sts.length - 2, Math.max(0, Math.floor(s / STATION_STEP)));
  while (i + 1 < sts.length - 1 && sts[i + 1].s < s) i++;
  const a = sts[i];
  const b = sts[Math.min(sts.length - 1, i + 1)];
  const span = Math.max(1e-6, b.s - a.s);
  const t = Math.max(0, Math.min(1, (s - a.s) / span));
  const x = a.x + (b.x - a.x) * t;
  const z = a.z + (b.z - a.z) * t;
  return {
    s, x, z,
    deckY: a.y + (b.y - a.y) * t,
    groundY: groundHeightAt(index, x, z),
  };
}

/**
 * 着工前の見積り。制御点を動かすたびに呼ばれるので、
 * 回廊の展開 (実測 2-6 ms) が一番重い。UI 側で間引くこと。
 *
 * @param geoAt 支持力を読むサンプラ。プレビューでは**既知の情報だけ**を
 *              返すものを渡す (§5「分からないものは見せない」)。
 */
export function planRoad(
  field: VoxelField,
  index: HeightIndex,
  al: Alignment,
  economy: Economy,
  geoAt: GeoSampler,
): RoadPlan {
  const corridor = rasterizeCorridor(index, al);
  const earthCost = estimateEarthCost(field, index, corridor, economy.spoil);

  // --- 橋 ---
  const bridges: BridgePlan[] = [];
  let bridgeCost = 0;
  let bridgeHours = 0;
  for (const [from, to] of runsOf(al, RoadKind.Bridge)) {
    const s0 = al.stations[from].s;
    const s1 = al.stations[Math.min(to, al.stations.length - 1)].s;
    const plan = planBridge(
      geoAt, from, to, s0, s1,
      (s) => siteAt(al, s, index),
      al.std.width,
    );
    bridges.push(plan);
    bridgeCost += plan.cost;
    bridgeHours += plan.hours;
  }

  // --- トンネル ---
  const tunnelRuns = runsOf(al, RoadKind.Tunnel);
  const r = tunnelRadius(al.std);
  let tunnelLength = 0;
  let tunnelVolume = 0;
  let tunnelCost = 0;
  for (const [from, to] of tunnelRuns) {
    const len = (to - from) * STATION_STEP;
    tunnelLength += len;
    const vol = Math.PI * r * r * len;
    tunnelVolume += vol;
    // 軸上の地質で単価を代表させる。断面のばらつきまでは見ない。
    let cost = 0;
    let n = 0;
    for (let i = from; i < to; i++) {
      const st = al.stations[i];
      cost += DIG_COST[field.materialAt(st.x, boreCenterY(st.y, r), st.z)];
      n++;
    }
    tunnelCost += (vol * cost) / Math.max(1, n);
  }

  // --- 舗装 ---
  const paveArea = al.length * al.std.width;
  const paveCost = paveArea * al.std.paveCost;
  const paveHours = paveArea * al.std.paveHours;

  const totalCost = earthCost + tunnelCost + bridgeCost + paveCost;

  const problems: string[] = [];
  if (!al.ok) {
    problems.push(
      `規格外 — 最小半径 ${al.minRadius === Infinity ? '∞' : al.minRadius.toFixed(0)} m ` +
      `/ 最大勾配 ${(al.maxGrade * 100).toFixed(1)} %`,
    );
  }
  for (const b of bridges) if (!b.ok) problems.push(b.reason);
  if (totalCost > economy.money) {
    problems.push(`資金が足りない (あと ¥${Math.round(totalCost - economy.money).toLocaleString()})`);
  }

  return {
    al, corridor, bridges, tunnelRuns, tunnelLength, tunnelVolume,
    cutVolume: corridor.cutVolume,
    fillVolume: corridor.fillVolume,
    earthCost, tunnelCost, bridgeCost, paveCost, totalCost,
    hours: bridgeHours + paveHours,
    problems,
    ok: problems.length === 0,
  };
}

// ------------------------------------------------------------------ 施工

export interface BuiltRoad {
  id: number;
  al: Alignment;
  /** 舗装が終わって供用しているか。 */
  paved: boolean;
}

/**
 * 道路の台帳と施工。
 *
 * 土工は**着工した瞬間に地形へ入る**。舗装と橋は施工班の列に並ぶ。
 * 土工だけ即時なのは、掘ったぶんが Economy を通って残土になり、
 * 盛土に回るという既存の勘定がそこで閉じるため。時間で分割すると
 * 「途中まで掘れた地形」を保持することになり、Edit.ts の 1 箇所書き込みが崩れる。
 */
export class RoadNetwork {
  readonly roads: BuiltRoad[] = [];
  private nextId = 1;
  dirtyVisuals = true;

  constructor(private crew: Crew) {}

  /**
   * 着工する。
   * @returns 施工した道路。着工できなければ null。
   */
  build(
    field: VoxelField,
    chunks: ChunkManager,
    index: HeightIndex,
    repose: ReposeSystem,
    tunnels: TunnelNetwork,
    bridgeNet: BridgeNetwork,
    economy: Economy,
    plan: RoadPlan,
  ): BuiltRoad | null {
    if (!plan.ok) return null;
    const al = plan.al;

    // --- 1) 土工。列の高さで書くので路面も法面も地形と地続きになる ---
    this.applyEarthwork(field, chunks, index, repose, tunnels, bridgeNet, economy, plan);

    // --- 2) トンネルを掘る。既存の TunnelNetwork がそのまま引き受ける ---
    this.boreTunnels(field, chunks, repose, tunnels, bridgeNet, economy, plan);

    // --- 3) 橋を架ける (施工班の列に並ぶ) ---
    for (const bp of plan.bridges) {
      const path: THREE.Vector3[] = [];
      for (let i = bp.from; i < bp.to; i++) {
        const st = al.stations[i];
        path.push(new THREE.Vector3(st.x, st.y, st.z));
      }
      if (path.length < 2) continue;
      economy.spend(bp.cost);
      bridgeNet.add(bp, path, al.std.width);
    }

    // --- 4) 舗装 ---
    const road: BuiltRoad = { id: this.nextId++, al, paved: false };
    const area = al.length * al.std.width;
    economy.spend(area * al.std.paveCost);
    const job: CrewJob = {
      hours: area * al.std.paveHours,
      label: `舗装 ${al.length.toFixed(0)} m`,
      alive: () => true,
      finish: () => {
        road.paved = true;
        this.dirtyVisuals = true;
      },
    };
    this.crew.push(job);

    this.roads.push(road);
    this.dirtyVisuals = true;
    return road;
  }

  private applyEarthwork(
    field: VoxelField,
    chunks: ChunkManager,
    index: HeightIndex,
    repose: ReposeSystem,
    tunnels: TunnelNetwork,
    bridgeNet: BridgeNetwork,
    economy: Economy,
    plan: RoadPlan,
  ): void {
    const { target, usedProtect } = plan.corridor;
    if (target.size === 0) return;
    const { heights } = index;

    /** 書き戻し後の高さ。正規化係数 inv をここから作る。 */
    const after = (i: number, k: number, fallback: number): number => {
      if (isRimColumn(i, k)) return fallback;
      const o = colIdx(i, k);
      const t = target.get(o);
      if (t !== undefined) return t;
      const h = heights[o];
      return h === NO_SURFACE ? fallback : h;
    };

    const cols: ColumnHeightWrite[] = [];
    for (const [o, hNew] of target) {
      const i = o % NX;
      const k = (o / NX) | 0;
      const gx = (after(i + 1, k, hNew) - after(i - 1, k, hNew)) / (2 * CELL);
      const gz = (after(i, k + 1, hNew) - after(i, k - 1, hNew)) / (2 * CELL);
      cols.push({
        i, k,
        hOld: heights[o],
        hNew,
        inv: 1 / Math.sqrt(1 + gx * gx + gz * gz),
        floor: index.voidTop[o] > -1e8 ? index.voidTop[o] + 1 : 0,
        // 盛土は**転圧して造る構造物**なので、崩れて積もった崩積土 (軟弱層) とは
        // 別物として「土」で置く。そのぶん費用と施工時間を払っている。
        geo: Geo.Soil,
        ceil: index.lipTop[o],
      });
    }

    const res = applyColumnHeights(field, chunks, cols);
    if (!res.changed) return;

    economy.chargeExcavation(res.volumeByGeo);
    tunnels.markDirtyByAABB(res.min[0], res.min[1], res.min[2], res.max[0], res.max[1], res.max[2]);
    bridgeNet.markDirtyByAABB(res.min[0], res.min[1], res.min[2], res.max[0], res.max[1], res.max[2]);
    repose.seedFromEdit(field, res);

    // 保護工を入れ直す。seedFromEdit は「1 セル以上下がった列の保護は外れる」と
    // するので、設計でその角度を当てにした法面がここで丸ごと無防備になる。
    // 塗った面を切り直したのだから、支えているのは新しい法面のほうだと考える。
    for (const [o, lv] of usedProtect) {
      if (index.heights[o] === NO_SURFACE) continue;
      if (index.protect[o] < lv) index.protect[o] = lv;
    }
  }

  private boreTunnels(
    field: VoxelField,
    chunks: ChunkManager,
    repose: ReposeSystem,
    tunnels: TunnelNetwork,
    bridgeNet: BridgeNetwork,
    economy: Economy,
    plan: RoadPlan,
  ): void {
    const al = plan.al;
    const r = tunnelRadius(al.std);
    const dir = new THREE.Vector3();
    const head = new THREE.Vector3();

    for (const [from, to] of plan.tunnelRuns) {
      // 坑口は回廊の切土に繋げたいので、前後 1 測点ぶん食い込ませる
      const i0 = Math.max(0, from - 1);
      const i1 = Math.min(al.stations.length - 1, to);
      for (let i = i0; i < i1; i++) {
        const a = al.stations[i];
        const b = al.stations[i + 1];
        const ay = boreCenterY(a.y, r);
        const by = boreCenterY(b.y, r);
        const res = applyCapsule(
          field, chunks,
          a.x, ay, a.z, b.x, by, b.z,
          r, 'dig', 0.5, Geo.Soil,
        );
        if (!res.changed) continue;
        economy.chargeExcavation(res.volumeByGeo);
        tunnels.markDirtyByAABB(
          res.min[0], res.min[1], res.min[2], res.max[0], res.max[1], res.max[2],
        );
        bridgeNet.markDirtyByAABB(
          res.min[0], res.min[1], res.min[2], res.max[0], res.max[1], res.max[2],
        );
        dir.set(b.x - a.x, by - ay, b.z - a.z).normalize();
        head.set(b.x, by, b.z);
        // 既存のトンネル台帳へ渡す。支保も崩落もこれで既存の規則に乗る。
        tunnels.recordBore(field, head, dir, r);
        repose.seedFromEdit(field, res);
      }
      tunnels.endBore();
    }
  }

  /** 供用中の道路の総延長 [m]。 */
  get totalLength(): number {
    let m = 0;
    for (const r of this.roads) m += r.al.length;
    return m;
  }
}
