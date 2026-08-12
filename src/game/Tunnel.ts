import * as THREE from 'three';
import {
  CELL, Geo, GEO_SUPPORT_REQ, GEO_NAME_JA, WATER_TABLE_Y,
} from '../terrain/config';
import { applyCapsule } from '../terrain/Edit';
import { overburdenAt } from '../terrain/raymarch';
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

/**
 * 土被りがこの倍率より薄ければトンネル扱いしない (切土・坑口)。
 * 半径 2.6 m のブラシなら 3.1 m。溝を掘っただけの所を除くには十分で、
 * これ以上厳しくすると坑口からトンネル成立まで掘り進む距離が長くなりすぎる。
 */
const COVER_TUNNEL_MIN = 1.2;
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
  /** 支保不足をすでに警告したか。支保が足りたら降ろして、再発時にまた出す。 */
  warned: boolean;
}

export interface CollapseEvent {
  pos: THREE.Vector3;
  daylight: boolean;
}

const _u = new THREE.Vector3();
const _v = new THREE.Vector3();
const _p = new THREE.Vector3();
const _pp = new THREE.Vector3();

/**
 * 支保不足の区間から地表へ伸ばす警告柱の高さ [m]。
 * 描画 (TunnelView) と当たり判定 (nearestToRay) で必ず同じ値を使うこと。
 * ずれると「見えている柱を狙っても取れない」が起きる。
 */
export function beamHeight(seg: TunnelSegment): number {
  return seg.cover + seg.radius * 2 + 4;
}

/**
 * レイと「A から真上へ h 伸びる線分」との最短距離、およびレイ上の位置。
 *
 * 区間の中心点との距離で判定すると、警告柱は根元しか押せない
 * (拾い半径ぶんの高さまでしか届かない)。柱を線分として扱えば、
 * 見えている柱のどこを狙っても、その下の区間が取れる。
 */
function rayToVertical(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  ax: number, ay: number, az: number,
  h: number,
): { dist: number; t: number } {
  // レイ P(t) = O + t*D (|D| = 1, t >= 0)、線分 Q(s) = A + s*(0,1,0) (0 <= s <= h)
  const wx = ox - ax;
  const wy = oy - ay;
  const wz = oz - az;
  const b = dy;                          // D·U
  const d = dx * wx + dy * wy + dz * wz; // D·w
  const e = wy;                          // U·w
  const denom = 1 - b * b;

  let s = denom > 1e-6 ? (e - b * d) / denom : 0;
  if (s < 0) s = 0;
  else if (s > h) s = h;

  let t = s * b - d;
  if (t < 0) t = 0;

  const px = ox + dx * t - (ax);
  const py = oy + dy * t - (ay + s);
  const pz = oz + dz * t - (az);
  return { dist: Math.sqrt(px * px + py * py + pz * pz), t };
}

/** dir に垂直な正規直交基底を作る。 */
function basis(dir: THREE.Vector3, u: THREE.Vector3, v: THREE.Vector3): void {
  const a = Math.abs(dir.y) < 0.9 ? _p.set(0, 1, 0) : _p.set(1, 0, 0);
  u.crossVectors(dir, a).normalize();
  v.crossVectors(dir, u).normalize();
}

/** preview() 用の使い回しセグメント。毎フレーム呼ばれるので確保し直さない。 */
const PREVIEW: TunnelSegment = {
  id: -1,
  pos: new THREE.Vector3(),
  dir: new THREE.Vector3(0, 0, 1),
  radius: 1,
  worstGeo: Geo.Soil,
  required: 0,
  installed: 0,
  integrity: 1,
  cover: 0,
  belowWater: false,
  isTunnel: false,
  collapsed: false,
  installRemaining: 0,
  installTarget: 0,
  warned: false,
};

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
  /**
   * この更新で新たに支保不足になった区間。掘った瞬間に警告を出すために使う。
   * recentCollapses ともども **次の update() の先頭で捨てられる**ので、
   * update() を呼んだ側が同じフレームのうちに読むこと。
   * 二重に update() を呼ぶと、あいだのイベントは誰にも読まれずに消える。
   */
  readonly newlyAtRisk: TunnelSegment[] = [];
  /** 直近の更新でジオメトリが変わったか (描画更新の要否)。 */
  dirtyVisuals = true;

  /** 掘進中に呼ぶ。2 m 進むごとにセグメントを 1 本置く。 */
  recordBore(field: VoxelField, head: THREE.Vector3, dir: THREE.Vector3, radius: number): void {
    // ここが掘り返されたなら、古い崩落マーカーはもう意味がない。
    // 残したままにすると、再開通した坑道の中に崩落済みの暗いリングが浮き、
    // 掘り直すたびに区間が増え続ける (崩落区間は再評価されないので自然には消えない)。
    //
    // 下の早期 return より前に置くこと。地表まで抜けた崩落 (陥没) の跡は
    // 土被りが無くなっているので、後ろに置くと cover 判定で弾かれて
    // いつまでも片付かない。掘り返した事実は土被りの有無とは無関係。
    for (let i = this.segments.length - 1; i >= 0; i--) {
      const old = this.segments[i];
      if (!old.collapsed) continue;
      if (old.pos.distanceTo(head) > SEGMENT_LENGTH * 1.2) continue;
      this.segments.splice(i, 1);
      this.byId.delete(old.id);
      this.index.remove(old.id);
      this.dirtyVisuals = true;
    }

    if (this.segments.length >= MAX_SEGMENTS) return;
    if (this.lastRecord && this.lastRecord.distanceTo(head) < SEGMENT_LENGTH) return;

    // 地表付近の整地までセグメントにすると邪魔なので、
    // 記録の時点で土被りが無いものは捨てる。
    const cover = overburdenAt(field, head.x, head.y + radius, head.z, radius);
    if (cover < radius * COVER_TUNNEL_MIN) {
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
      warned: false,
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

    // --- 土被り。天端から測る (残った空洞は overburdenAt が抜けてくれる) ---
    seg.cover = overburdenAt(
      field, seg.pos.x, seg.pos.y + seg.radius, seg.pos.z, seg.radius,
    );
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

  /**
   * 掘る前の下見。「ここを掘ったらトンネルになるのか、支保は何が要るのか」を
   * セグメントを作らずに評価して返す。返り値は使い回しなので保持しないこと。
   *
   * これが無いと、地表すれすれを削っているだけなのか本当に潜れているのかが
   * プレイヤーに分からない。斜面を下りながら掘ると地形のほうが速く落ちて
   * いつまでも土被りがつかず、「掘っているのに何も起きない」に見えてしまう。
   */
  preview(
    field: VoxelField,
    pos: THREE.Vector3,
    dir: THREE.Vector3,
    radius: number,
  ): TunnelSegment {
    const s = PREVIEW;
    s.pos.copy(pos);
    s.dir.copy(dir).normalize();
    s.radius = radius;
    s.collapsed = false;
    s.installed = 0;
    s.integrity = 1;
    this.evaluate(field, s);
    return s;
  }

  /**
   * この向きに掘り進んだら、どこでトンネルになるか。
   *
   * 坑口では土被りが 0 なのが当たり前なので、カーソル位置だけを見ても
   * 「切土」としか出ず何の役にも立たない。知りたいのは
   * 「このまま押し込んだら潜れるのか、潜れたとして何が要るのか」なので、
   * 掘進方向へ進みながら最初にトンネル成立する所を探して返す。
   *
   * @returns found=false なら、その向きでは maxDist 進んでも潜れない
   */
  previewBore(
    field: VoxelField,
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    radius: number,
    maxDist = 34,
  ): { found: boolean; dist: number; seg: TunnelSegment } {
    const step = 1.5;
    let last = PREVIEW;
    for (let d = radius; d <= maxDist; d += step) {
      _pp.copy(dir).multiplyScalar(d).add(origin);
      last = this.preview(field, _pp, dir, radius);
      if (last.isTunnel) return { found: true, dist: d, seg: last };
    }
    return { found: false, dist: maxDist, seg: last };
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
   * その区間の支保が実際に入るまでの見込み時間 [ゲーム内時間]。
   * 予約していなければ null。
   *
   * 施工班は 1 班しかいないので、列の前に積まれた区間の施工時間を全部足す。
   * 押した瞬間に金だけ減って見た目が変わらないので、
   * これを出さないと「効いていないのでは」と思われる。
   */
  installEta(seg: TunnelSegment): number | null {
    const idx = this.installQueue.indexOf(seg.id);
    if (idx < 0) return null;
    let h = 0;
    for (let i = 0; i <= idx; i++) {
      const s = this.byId.get(this.installQueue[i]);
      if (s) h += Math.max(0, s.installRemaining);
    }
    return h;
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
    this.newlyAtRisk.length = 0;

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

    // --- 支保不足の検出は時間が止まっていても走らせる ---
    // 健全度が目に見えて落ちてから知らせたのでは遅い。
    // 不足しているという事実は掘った (あるいは土被りが減った) 瞬間に確定するので、
    // その時点で警告する。1 段階不足なら余命 80 時間あり、まだ十分間に合う。
    for (const seg of this.segments) {
      if (seg.collapsed || !seg.isTunnel) continue;
      const short = seg.installed < seg.required;
      if (short && !seg.warned) {
        seg.warned = true;
        this.newlyAtRisk.push(seg);
      } else if (!short && seg.warned) {
        // 支保が足りたら警告を降ろす。後でまた足りなくなったら出し直す。
        seg.warned = false;
      }
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

  /**
   * 崩落までの残り時間 [ゲーム内時間]。足りていれば Infinity。
   * 割合より「あと何時間」のほうが、支保を入れるか掘り進むかの判断に直結する。
   */
  static hoursToFailure(seg: TunnelSegment): number {
    const deficit = seg.required - seg.installed;
    if (deficit <= 0 || seg.collapsed || !seg.isTunnel) return Infinity;
    return (Math.max(0, seg.integrity) * HOURS_TO_FAIL_BASE) / (deficit * deficit);
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

  /**
   * カーソルのレイが貫く区間のうち、手前のもの。支保ツールの狙いに使う。
   *
   * 地表のヒット点からの距離で選んではいけない。山の外から狙うと
   * ヒット点は地表にあり、坑道までは土被りぶん (5〜15 m) 離れているので
   * 何も選べない。警告柱が外から見えているのに押せない、という状態になる。
   * レイとの距離で選べば、柱を狙えばその下の区間が取れる。
   *
   * @param dir 正規化済みであること
   * @param maxPerp レイからこの距離までの区間を拾う [m]
   */
  nearestToRay(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    maxPerp: number,
    wantLevel = 0,
  ): TunnelSegment | null {
    // 「まだその支保を入れられる区間」と「そうでない区間」を別々に持つ。
    // 手前だけを見ると、既に手当て済みの区間が奥の未処置の区間を覆い隠して
    // いつまでも奥に届かない。まだ入れられるものがあればそちらを優先する。
    let bestOpen: TunnelSegment | null = null;
    let bestOpenT = Infinity;
    let bestAny: TunnelSegment | null = null;
    let bestAnyT = Infinity;

    for (const s of this.segments) {
      if (s.collapsed || !s.isTunnel) continue;

      // 支保不足の区間は警告柱ぶんの高さまで当たり判定を伸ばす
      const h = s.installed < s.required ? beamHeight(s) : 0;
      const r = rayToVertical(
        origin.x, origin.y, origin.z,
        dir.x, dir.y, dir.z,
        s.pos.x, s.pos.y, s.pos.z,
        h,
      );
      if (r.dist > maxPerp || r.t <= 0) continue;

      if (r.t < bestAnyT) {
        bestAnyT = r.t;
        bestAny = s;
      }
      const open = wantLevel > 0
        && s.required > 0
        && s.installed < wantLevel
        && s.installTarget < wantLevel;
      if (open && r.t < bestOpenT) {
        bestOpenT = r.t;
        bestOpen = s;
      }
    }
    return bestOpen ?? bestAny;
  }

  /** カーソル位置に最も近いセグメント。 */
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
