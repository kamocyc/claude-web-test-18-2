import * as THREE from 'three';
import {
  CELL, Geo, GEO_SUPPORT_REQ, GEO_NAME_JA, WATER_TABLE_Y,
} from '../terrain/config';
import { applyCapsule } from '../terrain/Edit';
import { coverDepthAt } from '../terrain/raymarch';
import { clamp } from '../terrain/FieldMath';
import type { VoxelField } from '../terrain/VoxelField';
import type { ChunkManager } from '../terrain/ChunkManager';
import { SpatialIndex } from './SpatialIndex';
import { supportDef } from './Support';
import type { Economy } from './Economy';

/**
 * トンネルと支保。
 *
 * タイルが無いので「ここはトンネルである」という判定を自分で作る必要がある。
 * 掘進した中心線を 2 m ごとのセグメントとして記録し、各セグメントについて
 *   - 断面リング上の地質をサンプルして必要支保レベルを決める
 *   - 真上へレイマーチして土被りを測り、浅ければ「切土・坑口」として支保不要にする
 * を評価する。土被りを見ないと、ただ地面に掘った溝にまで支保を要求してしまう。
 *
 * 「崩落は後から地面が変わったときだけ」は SpatialIndex で成立させる。
 * 地形を編集すると Edit.ts が影響 AABB を返すので、それで当たったセグメントだけを
 * 再評価キューに積む。支保済みトンネルの真上を掘って土被りを削れば、
 * 必要レベルが上がって劣化が始まる、という因果がこれで自動的に出る。
 */

/** セグメント長 [m]。実際の掘進のサイクル長に近い刻み。 */
export const SEGMENT_LENGTH = 2.0;

/**
 * 支保が 1 段階不足しているときに崩落するまでの時間 [ゲーム内時間]。
 * 実際の余命は BASE / 不足段階^2 なので、1 段階不足 = 80 時間、3 段階不足 = 8.9 時間。
 *
 * 支保の施工時間 (Support.ts) より十分長く取ること。短いと、掘った先から
 * 崩れていくのに施工が追いつかず、軟弱層のトンネルが原理的に救えなくなる。
 * 逆に長すぎると緊張感が消える。長いトンネルを一気に掘ると
 * 施工班が追いつかず末端から落ちる、くらいが狙い。
 */
const HOURS_TO_FAIL_BASE = 80;

/** 土被りがこの倍率より薄ければトンネル扱いしない (切土・坑口)。 */
const COVER_TUNNEL_MIN = 1.5;
/** 土被りがこの倍率より薄ければ必要支保 +1。 */
const COVER_SHALLOW = 3.0;

const MAX_SEGMENTS = 4000;
/** 1 tick で再評価するセグメント数の上限。大きな掘削で一気に詰まらないように。 */
const REEVAL_PER_TICK = 24;
/** 1 回の更新で処理する崩落の上限。連鎖が止まらなくなるのを防ぐ。 */
const MAX_COLLAPSES_PER_TICK = 3;

export interface TunnelSegment {
  id: number;
  pos: THREE.Vector3;
  dir: THREE.Vector3;
  radius: number;
  /** リング上でいちばん厳しかった地質。 */
  worstGeo: Geo;
  /** 必要支保レベル 0..3。 */
  required: number;
  /** 設置済み支保レベル 0..3。 */
  installed: number;
  /** 健全度 1..0。0 で崩落。 */
  integrity: number;
  /** 土被り [m]。 */
  cover: number;
  belowWater: boolean;
  /** 土被りが足りていて、支保の対象になるか。 */
  isTunnel: boolean;
  collapsed: boolean;
  /** 施工残り時間 [ゲーム内時間]。0 なら施工していない。 */
  installRemaining: number;
  installTarget: number;
}

export interface CollapseEvent {
  pos: THREE.Vector3;
  daylight: boolean;
}

const _u = new THREE.Vector3();
const _v = new THREE.Vector3();
const _p = new THREE.Vector3();

/** dir に垂直な正規直交基底を作る。 */
function basis(dir: THREE.Vector3, u: THREE.Vector3, v: THREE.Vector3): void {
  const a = Math.abs(dir.y) < 0.9 ? _p.set(0, 1, 0) : _p.set(1, 0, 0);
  u.crossVectors(dir, a).normalize();
  v.crossVectors(dir, u).normalize();
}

export class TunnelNetwork {
  readonly segments: TunnelSegment[] = [];
  private byId = new Map<number, TunnelSegment>();
  private index = new SpatialIndex(8);
  private pending = new Set<number>();
  private nextId = 1;

  private lastRecord: THREE.Vector3 | null = null;
  /** 施工待ちの列。1 班しかいないので順番に処理する。 */
  private installQueue: number[] = [];

  /** この更新で起きた崩落。演出と警告に使う。 */
  readonly recentCollapses: CollapseEvent[] = [];
  /** 直近の更新でジオメトリが変わったか (描画更新の要否)。 */
  dirtyVisuals = true;

  /** 掘進中に呼ぶ。2 m 進むごとにセグメントを 1 本置く。 */
  recordBore(field: VoxelField, head: THREE.Vector3, dir: THREE.Vector3, radius: number): void {
    if (this.segments.length >= MAX_SEGMENTS) return;
    if (this.lastRecord && this.lastRecord.distanceTo(head) < SEGMENT_LENGTH) return;

    // 地表付近の整地までセグメントにすると邪魔なので、
    // 記録の時点で土被りが無いものは捨てる。
    const cover = coverDepthAt(field, head.x, head.y + radius * 1.05, head.z);
    if (Number.isFinite(cover) && cover < radius * COVER_TUNNEL_MIN) {
      this.lastRecord = head.clone();
      return;
    }

    const seg: TunnelSegment = {
      id: this.nextId++,
      pos: head.clone(),
      dir: dir.clone().normalize(),
      radius,
      worstGeo: Geo.Soil,
      required: 0,
      installed: 0,
      integrity: 1,
      cover: 0,
      belowWater: head.y < WATER_TABLE_Y,
      isTunnel: true,
      collapsed: false,
      installRemaining: 0,
      installTarget: 0,
    };
    this.segments.push(seg);
    this.byId.set(seg.id, seg);
    this.reindex(seg);
    this.evaluate(field, seg);
    this.lastRecord = head.clone();
    this.dirtyVisuals = true;
  }

  /** 掘進ストロークの区切り。次のストロークは新しい起点から数える。 */
  endBore(): void {
    this.lastRecord = null;
  }

  private reindex(seg: TunnelSegment): void {
    // 影響範囲は坑道まわり 2 倍径 + 真上の地表まで。
    // 「真上を掘られたら土被りが減る」を拾うために上方向に広く取る。
    const r = seg.radius * 2;
    const up = Math.min(seg.cover + seg.radius * 2, 40);
    this.index.insert(
      seg.id,
      seg.pos.x - r, seg.pos.y - r, seg.pos.z - r,
      seg.pos.x + r, seg.pos.y + Math.max(r, up), seg.pos.z + r,
    );
  }

  /** セグメント 1 本を評価し直す。地質・土被り・水位から必要支保レベルを決める。 */
  evaluate(field: VoxelField, seg: TunnelSegment): void {
    if (seg.collapsed) return;

    // --- 土被り。坑道の天端から真上へ measure する。 ---
    const coverRaw = coverDepthAt(field, seg.pos.x, seg.pos.y + seg.radius * 1.05, seg.pos.z);
    seg.cover = Number.isFinite(coverRaw) ? coverRaw : 60;
    seg.isTunnel = seg.cover >= seg.radius * COVER_TUNNEL_MIN;
    seg.belowWater = seg.pos.y < WATER_TABLE_Y;

    if (!seg.isTunnel) {
      // 切土・坑口。支保は要らない。
      seg.required = 0;
      seg.worstGeo = field.materialAt(seg.pos.x, seg.pos.y, seg.pos.z);
      return;
    }

    // --- 断面リング上の地質。いちばん厳しいものが効く。 ---
    // 「軟弱層が少しでも掛かっていれば支保が要る」を素直に表す。
    basis(seg.dir, _u, _v);
    let worst = -1;
    let worstGeo: Geo = Geo.Soil;
    const rr = seg.radius * 1.25;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const ca = Math.cos(a) * rr;
      const sa = Math.sin(a) * rr;
      _p.set(
        seg.pos.x + _u.x * ca + _v.x * sa,
        seg.pos.y + _u.y * ca + _v.y * sa,
        seg.pos.z + _u.z * ca + _v.z * sa,
      );
      const g = field.materialAt(_p.x, _p.y, _p.z);
      const req = GEO_SUPPORT_REQ[g];
      if (req > worst) {
        worst = req;
        worstGeo = g;
      }
    }

    let required = worst < 0 ? 0 : worst;
    if (seg.belowWater) required += 1;
    if (seg.cover < seg.radius * COVER_SHALLOW) required += 1;

    seg.required = clamp(required, 0, 3);
    seg.worstGeo = worstGeo;
  }

  /** 地形が変わった範囲のセグメントを再評価キューに積む。 */
  markDirtyByAABB(
    minX: number, minY: number, minZ: number,
    maxX: number, maxY: number, maxZ: number,
  ): void {
    this.index.query(minX, minY, minZ, maxX, maxY, maxZ, this.pending);
  }

  /** 施工を予約する。費用は前払い。 */
  queueInstall(seg: TunnelSegment, level: number, economy: Economy): boolean {
    if (seg.collapsed || !seg.isTunnel) return false;
    // 岩で無支保のまま持つ区間に支保を入れても金と施工班の時間を捨てるだけ。
    // 1 班しかいないので、無駄な予約は他の区間の崩落に直結する。
    if (seg.required === 0) return false;
    if (seg.installed >= level) return false;
    if (seg.installTarget >= level) return false;
    const def = supportDef(level);
    if (!def) return false;
    if (economy.money < def.cost) return false;

    economy.spend(def.cost);
    seg.installTarget = level;
    seg.installRemaining = def.hours;
    if (!this.installQueue.includes(seg.id)) this.installQueue.push(seg.id);
    this.dirtyVisuals = true;
    return true;
  }

  get queueLength(): number {
    return this.installQueue.length;
  }

  /**
   * 毎フレーム呼ぶ。再評価 → 施工 → 劣化 → 崩落 の順。
   * @param gameDelta ゲーム内時間の経過 [時]
   */
  update(
    field: VoxelField,
    chunks: ChunkManager,
    gameDelta: number,
  ): void {
    this.recentCollapses.length = 0;

    // --- 地形変化を受けたセグメントの再評価 (件数に上限をつける) ---
    if (this.pending.size > 0) {
      let n = 0;
      for (const id of this.pending) {
        this.pending.delete(id);
        const seg = this.byId.get(id);
        if (seg && !seg.collapsed) {
          this.evaluate(field, seg);
          this.reindex(seg);
        }
        if (++n >= REEVAL_PER_TICK) break;
      }
      this.dirtyVisuals = true;
    }

    if (gameDelta <= 0) return;

    // --- 施工 (1 班なので先頭から順に) ---
    while (this.installQueue.length > 0) {
      const seg = this.byId.get(this.installQueue[0]);
      if (!seg || seg.collapsed) {
        this.installQueue.shift();
        continue;
      }
      seg.installRemaining -= gameDelta;
      if (seg.installRemaining > 0) break;
      seg.installed = seg.installTarget;
      seg.installRemaining = 0;
      this.installQueue.shift();
      this.dirtyVisuals = true;
    }

    // --- 劣化と崩落 ---
    let collapses = 0;
    for (const seg of this.segments) {
      if (seg.collapsed || !seg.isTunnel) continue;

      if (seg.installed >= seg.required) {
        // 足りていれば健全度は回復する。後から支保を足せば助かる、という筋を通す。
        if (seg.integrity < 1) {
          seg.integrity = Math.min(1, seg.integrity + gameDelta / 10);
          this.dirtyVisuals = true;
        }
        continue;
      }

      const deficit = seg.required - seg.installed;
      seg.integrity -= (deficit * deficit * gameDelta) / HOURS_TO_FAIL_BASE;
      this.dirtyVisuals = true;

      if (seg.integrity <= 0 && collapses < MAX_COLLAPSES_PER_TICK) {
        this.collapse(field, chunks, seg);
        collapses++;
      }
    }
  }

  /**
   * 崩落。SDF への操作 2 つで表現できる。
   *  - 坑道を土砂 (軟弱層) で埋め戻す
   *  - 土被りが薄ければ、真上に陥没孔を開けて地表を陥没させる
   * どちらも Edit.ts を通るので、その AABB から他の構造物の再評価が連鎖する。
   */
  private collapse(field: VoxelField, chunks: ChunkManager, seg: TunnelSegment): void {
    seg.collapsed = true;
    seg.integrity = 0;
    this.dirtyVisuals = true;

    const r = seg.radius;
    const half = seg.dir.clone().multiplyScalar(SEGMENT_LENGTH * 0.5);
    const a = seg.pos.clone().sub(half);
    const b = seg.pos.clone().add(half);

    // 坑道を土砂で埋める
    const fillRes = applyCapsule(
      field, chunks,
      a.x, a.y, a.z, b.x, b.y, b.z,
      r * 1.15, 'fill', 0.6, Geo.Weak,
    );

    // 土被りが薄ければ地表まで抜ける (陥没)
    const daylight = seg.cover < r * 5;
    if (daylight) {
      const top = seg.pos.y + seg.cover + r * 1.2;
      applyCapsule(
        field, chunks,
        seg.pos.x, seg.pos.y, seg.pos.z,
        seg.pos.x, top, seg.pos.z,
        r * 0.75, 'dig', 0.7, Geo.Weak,
      );
    }

    this.recentCollapses.push({ pos: seg.pos.clone(), daylight });

    // 崩落そのものが地形変化なので、周囲の構造物を再評価させる
    if (fillRes.changed) {
      this.markDirtyByAABB(
        fillRes.min[0] - CELL, fillRes.min[1] - CELL, fillRes.min[2] - CELL,
        fillRes.max[0] + CELL, fillRes.max[1] + CELL, fillRes.max[2] + CELL,
      );
    }
    this.index.remove(seg.id);
  }

  /** 支保が足りていないセグメントの数と、いちばん危ないものを返す。 */
  status(): { atRisk: number; worst: TunnelSegment | null; tunnels: number; collapsed: number } {
    let atRisk = 0;
    let tunnels = 0;
    let collapsed = 0;
    let worst: TunnelSegment | null = null;
    for (const s of this.segments) {
      if (s.collapsed) {
        collapsed++;
        continue;
      }
      if (!s.isTunnel) continue;
      tunnels++;
      if (s.installed < s.required) {
        atRisk++;
        if (!worst || s.integrity < worst.integrity) worst = s;
      }
    }
    return { atRisk, worst, tunnels, collapsed };
  }

  /** カーソル位置に最も近いセグメント (支保設置ツール用)。 */
  nearest(p: THREE.Vector3, maxDist: number): TunnelSegment | null {
    let best: TunnelSegment | null = null;
    let bestD = maxDist * maxDist;
    for (const s of this.segments) {
      if (s.collapsed || !s.isTunnel) continue;
      const d = s.pos.distanceToSquared(p);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }

  /** 一定距離内のセグメント (ドラッグでまとめて支保を入れる用)。 */
  within(p: THREE.Vector3, dist: number, out: TunnelSegment[]): TunnelSegment[] {
    const d2 = dist * dist;
    for (const s of this.segments) {
      if (s.collapsed || !s.isTunnel) continue;
      if (s.pos.distanceToSquared(p) <= d2) out.push(s);
    }
    return out;
  }

  static describe(seg: TunnelSegment): string {
    return (
      `${GEO_NAME_JA[seg.worstGeo]} / 土被り ${seg.cover.toFixed(1)} m` +
      (seg.belowWater ? ' / 水位下' : '')
    );
  }
}
