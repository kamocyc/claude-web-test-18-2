import * as THREE from 'three';
import { Geo, GEO_BEARING, GEO_NAME_JA } from '../terrain/config';
import { SpatialIndex } from './SpatialIndex';
import { Crew, type CrewJob } from './Crew';

/**
 * 橋。**耐力 vs 荷重**。
 *
 * トンネルが「土被りと地質が必要支保を決める」なら、橋は
 * 「橋脚の足元の地質が架けられる支間を決める」。どちらも
 * 「地面を見てから構造を決める」という同じ形にしてある。
 *
 * ---- 支持力をなぜ調和平均で採るのか ----
 * 基礎を半径 2.6 m の円盤とみなして地質をサンプルし、GEO_BEARING の
 * **調和平均**を採る。算術平均ではない。
 *
 * 岩 3.0 / 土 2.0 / 軟弱 0.05 MPa なので、footing の 1/4 が軟弱層に掛かると
 *   算術平均 2.26 MPa (ほぼ無傷)
 *   調和平均 0.19 MPa (1/16 に急落)
 * になる。急落するほうが正しい。基礎の下の一部だけが柔らかいとき、
 * 沈下を決めるのは**いちばん柔らかい所**で、そこだけ沈めば不同沈下になって
 * 上部工が保たない。直列ばねと同じで、柔らかいばねが全体の変位を支配する。
 * 算術平均 (並列ばね) にすると「半分軟弱層でも半分岩なら建つ」になり、
 * 谷底の軟弱層がまったく判断に効かなくなる。
 *
 * ---- 支間表が意思決定になる理由 ----
 * 支間を伸ばせば橋脚の本数が減り、**橋脚の落ちる位置が変わる**。
 * 軟弱層の谷は、短支間の安い橋では橋脚が立たず、長支間の高い橋でしか
 * 渡れない。あるいは深礎で岩まで下ろす。この 3 択が支間表の役目で、
 * 「どこに何があるか」を知るにはボーリング (Survey) が要る。
 *
 * ---- 橋台の支持力は見ない ----
 * 見るのは橋脚だけ。橋台は橋の**両端**、つまり路面が地山に取り付く所に立つので、
 * そこは必ず切盛の回廊が均した地面になっている。橋台まで判定に入れると、
 * 「谷を渡りたいのに、渡り始める場所が悪くて架けられない」という、
 * 線形を動かしても直せない行き止まりが増えるだけで、判断が 1 つも増えない。
 */

/** 基礎 (フーチング) の半径 [m]。この円盤で地質をサンプルする。 */
export const FOOTING_RADIUS = 2.6;
const FOOTING_AREA = Math.PI * FOOTING_RADIUS * FOOTING_RADIUS;

/**
 * 上部工の荷重 [kN/m^2]。死荷重 + 活荷重をまとめた 1 つの値。
 * 支間で変えていないのは、支間が伸びたぶんは**負担面積**として
 * すでに効いているため。二重に効かせると支間表が読めなくなる。
 */
const DECK_LOAD = 24;

/** 橋脚の自重 [kN/m]。高い橋脚ほど足元が苦しくなる。 */
const PIER_SELF_LOAD = 90;

/** 安全率。耐力がこの倍だけ荷重を上回っていないと建てない。 */
const SAFETY = 1.5;

/** 深礎で下ろせる限界 [m]。ここまで下ろして支持層が無ければ橋脚は立たない。 */
export const MAX_FOUNDATION_DEPTH = 24;

/** 深礎の刻み [m]。 */
const FOUNDATION_STEP = 1;

export interface BridgeType {
  id: string;
  name: string;
  /** 最大支間長 [m]。 */
  maxSpan: number;
  /** 床版単価 [円/m^2]。 */
  deckCost: number;
  /** 床版の施工時間 [ゲーム内時間/m^2]。 */
  deckHours: number;
  /** 桁高 [m]。路面から桁下まで。橋脚の高さと見た目に効く。 */
  deckDepth: number;
  color: number;
}

/**
 * 支間表。**メートルで持つ** (セル数やセグメント数ではない)。
 * 支間が伸びるほど床版が高くつき、そのぶん橋脚が減る。
 * どちらが得かは足元の地質でしか決まらない。
 */
export const BRIDGE_TYPES: BridgeType[] = [
  { id: 'rc', name: 'RC 桁橋', maxSpan: 20, deckCost: 190, deckHours: 0.010, deckDepth: 1.2, color: 0xb9bcc0 },
  { id: 'pc', name: 'PC 箱桁', maxSpan: 45, deckCost: 340, deckHours: 0.018, deckDepth: 2.2, color: 0xc8bfa8 },
  { id: 'truss', name: '鋼トラス', maxSpan: 90, deckCost: 620, deckHours: 0.030, deckDepth: 3.4, color: 0x8fa6bd },
];

/** 橋脚 1 基の基本費用。 */
const PIER_BASE_COST = 5_000;
/** 橋脚の高さ 1 m あたり [円]。 */
const PIER_COST_PER_M = 700;
/** 深礎 1 m あたり [円]。岩まで下ろすのは高い。 */
const CAISSON_COST_PER_M = 2_400;
/** 橋台 1 基 [円]。 */
const ABUTMENT_COST = 12_000;
/** 橋脚 1 基の施工時間 [ゲーム内時間]。深礎はさらに 1 m につき 0.25 時間。 */
const PIER_HOURS = 1.6;
const CAISSON_HOURS_PER_M = 0.25;

/** 地質サンプラ。真の場を読むか、既知の情報だけで読むかを呼び出し側が選ぶ。 */
export type GeoSampler = (x: number, y: number, z: number) => Geo;

export interface BearingSample {
  /** 調和平均した支持力 [MPa]。 */
  bearing: number;
  /** 円盤の中でいちばん弱かった地質。表示に使う。 */
  worstGeo: Geo;
}

/**
 * 基礎の円盤で支持力をサンプルする。中心 + 内輪 6 点 + 外輪 12 点の 19 点。
 * 外周ほど点を多く取るのは、面積が外周ほど大きいから (等面積に近い配置)。
 */
export function sampleBearing(
  geoAt: GeoSampler,
  x: number, y: number, z: number,
  radius = FOOTING_RADIUS,
): BearingSample {
  let inv = 0;
  let n = 0;
  let worstGeo: Geo = Geo.Rock;
  let worst = Infinity;

  const take = (px: number, pz: number): void => {
    const g = geoAt(px, y, pz);
    const b = Math.max(1e-4, GEO_BEARING[g]);
    inv += 1 / b;
    n++;
    if (b < worst) {
      worst = b;
      worstGeo = g;
    }
  };

  take(x, z);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    take(x + Math.cos(a) * radius * 0.5, z + Math.sin(a) * radius * 0.5);
  }
  for (let i = 0; i < 12; i++) {
    const a = ((i + 0.5) / 12) * Math.PI * 2;
    take(x + Math.cos(a) * radius, z + Math.sin(a) * radius);
  }

  return { bearing: n / inv, worstGeo };
}

/** その支持力の円盤が受けられる荷重 [kN]。 */
export function capacityOf(bearing: number): number {
  // MPa = N/mm^2 = 1000 kN/m^2
  return bearing * 1000 * FOOTING_AREA;
}

export interface PierPlan {
  /** 起点からの距離 [m]。 */
  s: number;
  x: number;
  z: number;
  /** 路面高 [m]。 */
  deckY: number;
  /** 地盤高 [m]。 */
  groundY: number;
  /** 橋脚の高さ (地盤から桁下まで) [m]。 */
  height: number;
  /** 負担支間長 [m]。両隣の支間の半分ずつ。 */
  tributary: number;
  /** 足元に掛かる荷重 [kN]。 */
  load: number;
  /** 基礎を下ろす深さ [m]。0 なら直接基礎。 */
  foundDepth: number;
  /** その深さでの支持力 [MPa]。 */
  bearing: number;
  /** 受けられる荷重 [kN]。 */
  capacity: number;
  worstGeo: Geo;
  /** 立つか。深礎の限界まで下ろしても足りなければ false。 */
  ok: boolean;
  cost: number;
  hours: number;
}

export interface BridgePlan {
  /** 測点の添字範囲 [from, to)。 */
  from: number;
  to: number;
  type: BridgeType;
  length: number;
  /** 径間数。 */
  spans: number;
  spanLength: number;
  piers: PierPlan[];
  deckArea: number;
  cost: number;
  hours: number;
  ok: boolean;
  /** 立たないときの理由。HUD にそのまま出す。 */
  reason: string;
}

export interface PierSite {
  s: number;
  x: number;
  z: number;
  deckY: number;
  groundY: number;
}

/**
 * 橋脚 1 基を検討する。直接基礎で足りなければ、支持層に届くまで深礎を下ろす。
 *
 * 深さを 1 m ずつ下げながら調べるのは、支持層の**上端**で止めたいから。
 * 二分探索にすると、途中に薄い硬い層 (谷底に取り残された岩塊) を挟んだときに
 * その下まで無駄に下ろす。上から順に見れば、最初に足りた所で止まる。
 */
export function planPier(
  geoAt: GeoSampler,
  site: PierSite,
  tributary: number,
  width: number,
  type: BridgeType,
): PierPlan {
  const height = Math.max(0, site.deckY - type.deckDepth - site.groundY);
  const load = tributary * width * DECK_LOAD + height * PIER_SELF_LOAD;
  const need = load * SAFETY;

  let foundDepth = 0;
  let best = sampleBearing(geoAt, site.x, site.groundY - 0.5, site.z);
  let capacity = capacityOf(best.bearing);

  if (capacity < need) {
    for (let d = FOUNDATION_STEP; d <= MAX_FOUNDATION_DEPTH; d += FOUNDATION_STEP) {
      const s = sampleBearing(geoAt, site.x, site.groundY - 0.5 - d, site.z);
      const c = capacityOf(s.bearing);
      if (c > capacity) {
        best = s;
        capacity = c;
        foundDepth = d;
      }
      if (c >= need) break;
    }
  }

  const cost =
    PIER_BASE_COST + height * PIER_COST_PER_M + foundDepth * CAISSON_COST_PER_M;
  const hours = PIER_HOURS + foundDepth * CAISSON_HOURS_PER_M;

  return {
    s: site.s, x: site.x, z: site.z,
    deckY: site.deckY, groundY: site.groundY,
    height, tributary, load,
    foundDepth, bearing: best.bearing, capacity,
    worstGeo: best.worstGeo,
    ok: capacity >= need,
    cost, hours,
  };
}

/**
 * 1 つの橋 (連続した橋区間) を組む。
 *
 * 支間表を**安い順に試す**。安い橋で橋脚が立つならそれでよく、
 * 立たないときだけ支間を伸ばす。支間を伸ばすと橋脚の本数が減り、
 * **落ちる位置も動く**ので、軟弱層を跨げることがある。
 * これが「支間表が意思決定になる」ということ。
 *
 * @param sites 橋脚を置ける候補を返す関数。距離 s を渡すとその位置の
 *              路面高と地盤高を返す。
 */
export function planBridge(
  geoAt: GeoSampler,
  from: number,
  to: number,
  s0: number,
  s1: number,
  siteAt: (s: number) => PierSite,
  width: number,
): BridgePlan {
  const length = Math.max(0.001, s1 - s0);
  let fallback: BridgePlan | null = null;

  for (const type of BRIDGE_TYPES) {
    const spans = Math.max(1, Math.ceil(length / type.maxSpan));
    const spanLength = length / spans;
    const piers: PierPlan[] = [];
    for (let i = 1; i < spans; i++) {
      piers.push(planPier(geoAt, siteAt(s0 + spanLength * i), spanLength, width, type));
    }

    const deckArea = length * width;
    let cost = deckArea * type.deckCost + ABUTMENT_COST * 2;
    let hours = deckArea * type.deckHours;
    for (const p of piers) {
      cost += p.cost;
      hours += p.hours;
    }

    const bad = piers.find((p) => !p.ok);
    const plan: BridgePlan = {
      from, to, type, length, spans, spanLength, piers,
      deckArea, cost, hours,
      ok: !bad,
      reason: bad
        ? `橋脚が立たない (${GEO_NAME_JA[bad.worstGeo]} / 支持力 ${bad.bearing.toFixed(2)} MPa)`
        : '',
    };
    if (plan.ok) return plan;
    if (!fallback) fallback = plan;
  }

  // どの支間でも立たない。いちばん安い案を理由つきで返す。
  return fallback!;
}

// ------------------------------------------------------------------ 施工済みの橋

export interface Bridge {
  id: number;
  plan: BridgePlan;
  /** 中心線 (路面) の折れ線。描画と当たり判定に使う。 */
  path: THREE.Vector3[];
  width: number;
  /** 健全度 1..0。耐力が荷重を割ると落ちていく。 */
  integrity: number;
  /** 施工が終わって供用しているか。 */
  built: boolean;
  collapsed: boolean;
  /** 支持力不足をすでに警告したか。 */
  warned: boolean;
}

/**
 * 支持力が荷重を割ってから落橋するまでの時間 [ゲーム内時間]。
 * トンネルの HOURS_TO_FAIL_BASE (80) と同じ桁。不足の度合い (荷重/耐力) の
 * 2 乗で縮むのも同じ規約にしてある。
 */
const HOURS_TO_FAIL_BASE = 60;

export interface BridgeCollapse {
  pos: THREE.Vector3;
  bridge: Bridge;
}

/**
 * 架かっている橋の台帳。
 *
 * トンネルとまったく同じ形にしてある。編集の AABB で SpatialIndex を引き、
 * 当たった**橋脚だけ**を再評価キューに積む。橋脚の足元を掘れば支持力が
 * 落ちて落橋に向かう、という因果がこれで自動的に出る。特別扱いは書いていない。
 */
export class BridgeNetwork {
  readonly bridges: Bridge[] = [];
  private byId = new Map<number, Bridge>();
  private index = new SpatialIndex(8);
  private pending = new Set<number>();
  private nextId = 1;
  private crew: Crew = new Crew();

  readonly recentCollapses: BridgeCollapse[] = [];
  /** この更新で新たに支持力不足になった橋。掘った瞬間に警告するために使う。 */
  readonly newlyAtRisk: Bridge[] = [];
  dirtyVisuals = true;

  useCrew(crew: Crew): void {
    this.crew = crew;
  }

  /** 施工を始める。費用は前払い、供用は施工班の順番が来てから。 */
  add(plan: BridgePlan, path: THREE.Vector3[], width: number): Bridge {
    const b: Bridge = {
      id: this.nextId++,
      plan, path, width,
      integrity: 1,
      built: false,
      collapsed: false,
      warned: false,
    };
    this.bridges.push(b);
    this.byId.set(b.id, b);
    this.reindex(b);
    this.dirtyVisuals = true;

    const job: CrewJob = {
      hours: plan.hours,
      label: `${plan.type.name} (${plan.spans} 径間)`,
      alive: () => !b.collapsed,
      finish: () => {
        b.built = true;
        this.dirtyVisuals = true;
      },
    };
    this.crew.push(job);
    return b;
  }

  private reindex(b: Bridge): void {
    // 影響範囲は橋脚の足元。桁は宙に浮いているので地形の変化とは関係がない。
    // 橋脚が 1 基も無い単径間の橋は橋台だけなので、両端で登録する。
    const pts = b.plan.piers.length > 0
      ? b.plan.piers.map((p) => new THREE.Vector3(p.x, p.groundY, p.z))
      : [b.path[0], b.path[b.path.length - 1]];
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    const r = FOOTING_RADIUS * 1.5;
    for (const p of pts) {
      minX = Math.min(minX, p.x - r); maxX = Math.max(maxX, p.x + r);
      minZ = Math.min(minZ, p.z - r); maxZ = Math.max(maxZ, p.z + r);
      // 足元は深礎ぶん下まで、上は桁まで
      minY = Math.min(minY, p.y - MAX_FOUNDATION_DEPTH);
      maxY = Math.max(maxY, p.y + 4);
    }
    this.index.insert(b.id, minX, minY, minZ, maxX, maxY, maxZ);
  }

  markDirtyByAABB(
    minX: number, minY: number, minZ: number,
    maxX: number, maxY: number, maxZ: number,
  ): void {
    this.index.query(minX, minY, minZ, maxX, maxY, maxZ, this.pending);
  }

  /**
   * 橋脚を測り直す。地盤が下がっていれば橋脚は伸び、足元の地質が変われば
   * 支持力が変わる。どちらも「掘ったせいで橋が危なくなる」を素直に表す。
   */
  evaluate(b: Bridge, geoAt: GeoSampler, groundAt: (x: number, z: number) => number): void {
    if (b.collapsed) return;
    for (const p of b.plan.piers) {
      p.groundY = groundAt(p.x, p.z);
      p.height = Math.max(0, p.deckY - b.plan.type.deckDepth - p.groundY);
      p.load = p.tributary * b.width * DECK_LOAD + p.height * PIER_SELF_LOAD;
      const s = sampleBearing(geoAt, p.x, p.groundY - 0.5 - p.foundDepth, p.z);
      p.bearing = s.bearing;
      p.worstGeo = s.worstGeo;
      p.capacity = capacityOf(s.bearing);
      p.ok = p.capacity >= p.load * SAFETY;
    }
    this.dirtyVisuals = true;
  }

  /** いちばん苦しい橋脚の 荷重/耐力。1 を超えていたら落橋に向かう。 */
  static worstRatio(b: Bridge): number {
    let worst = 0;
    for (const p of b.plan.piers) worst = Math.max(worst, p.load / Math.max(1e-6, p.capacity));
    return worst;
  }

  /** 落橋までの残り時間 [ゲーム内時間]。保っていれば Infinity。 */
  static hoursToFailure(b: Bridge): number {
    const r = BridgeNetwork.worstRatio(b);
    if (r <= 1 || b.collapsed) return Infinity;
    return (Math.max(0, b.integrity) * HOURS_TO_FAIL_BASE) / ((r - 1) * (r - 1) + 0.05);
  }

  /**
   * 毎フレーム呼ぶ。再評価 → 劣化 → 落橋。
   * トンネルと同じく、**支持力不足の検出は時間が止まっていても走らせる**。
   */
  update(
    geoAt: GeoSampler,
    groundAt: (x: number, z: number) => number,
    gameDelta: number,
  ): void {
    this.recentCollapses.length = 0;
    this.newlyAtRisk.length = 0;

    if (this.pending.size > 0) {
      for (const id of this.pending) {
        const b = this.byId.get(id);
        if (b && !b.collapsed) this.evaluate(b, geoAt, groundAt);
      }
      this.pending.clear();
    }

    for (const b of this.bridges) {
      if (b.collapsed) continue;
      const short = BridgeNetwork.worstRatio(b) > 1;
      if (short && !b.warned) {
        b.warned = true;
        this.newlyAtRisk.push(b);
      } else if (!short && b.warned) {
        b.warned = false;
      }
    }

    if (gameDelta <= 0) return;

    for (const b of this.bridges) {
      if (b.collapsed) continue;
      const r = BridgeNetwork.worstRatio(b);
      if (r <= 1) {
        if (b.integrity < 1) {
          b.integrity = Math.min(1, b.integrity + gameDelta / 12);
          this.dirtyVisuals = true;
        }
        continue;
      }
      b.integrity -= (((r - 1) * (r - 1) + 0.05) * gameDelta) / HOURS_TO_FAIL_BASE;
      this.dirtyVisuals = true;
      if (b.integrity <= 0) {
        b.collapsed = true;
        b.integrity = 0;
        this.index.remove(b.id);
        const mid = b.path[Math.floor(b.path.length / 2)];
        this.recentCollapses.push({ pos: mid.clone(), bridge: b });
      }
    }
  }

  status(): { built: number; atRisk: number; collapsed: number } {
    let built = 0, atRisk = 0, collapsed = 0;
    for (const b of this.bridges) {
      if (b.collapsed) { collapsed++; continue; }
      if (b.built) built++;
      if (BridgeNetwork.worstRatio(b) > 1) atRisk++;
    }
    return { built, atRisk, collapsed };
  }
}
