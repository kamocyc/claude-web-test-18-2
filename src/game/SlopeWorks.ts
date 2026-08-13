import { CELL, NX, NZ } from '../terrain/config';
import { colIdx, isRimColumn, NO_SURFACE, type HeightIndex } from '../terrain/HeightIndex';
import type { Economy } from './Economy';
import type { Crew, CrewJob } from './Crew';

/**
 * 法面保護工。支保と対になる、**崩れる前に払って止める**手段。
 *
 * 安息角を入れたことで、掘れば法面は必ず安息角まで寝るようになった。
 * 土なら 34 度、軟弱層なら 26 度。深い切土ほど横へ広く用地を食う。
 * それを受け入れるしかない状態だと、崩落はただの理不尽になる。
 * ブラシで地表を塗っておくと、その列は保護工の角度で立つ。
 *
 * 支保と同じ形にしてある。
 *   - 3 段階。安いほど寝て用地を食い、高いほど垂直に切れる
 *   - 費用は押した瞬間に前払い
 *   - **施工班は支保と同じ 1 班**。押した順に並ぶので、
 *     「トンネルを急ぐか、法面を押さえるか」が選択になる
 *   - 色 = 工法 / 中間色 = 手配済みだが未着 (支保のリングと同じ規約)
 *
 * 費用と時間は m^2 あたり。支保はセグメント 1 本 (2 m) あたりなので単位が違う。
 * ブラシ 1 回 (半径 2.6 m = 21 m^2) で 850 / 3800 / 10500 円になり、
 * 支保 (900 / 4200 / 11000 円) と同じ桁に揃えてある。
 */

export interface SlopeWorkDef {
  level: number;
  name: string;
  /** その工法が支える角度 [度]。 */
  deg: number;
  /** 1 m^2 あたりの費用。 */
  cost: number;
  /** 1 m^2 あたりの施工時間 [ゲーム内時間]。 */
  hours: number;
  color: number;
}

export const SLOPE_WORKS: SlopeWorkDef[] = [
  { level: 1, name: '種子吹付', deg: 45, cost: 40, hours: 0.006, color: 0x6f9c52 },
  { level: 2, name: '法枠', deg: 65, cost: 180, hours: 0.02, color: 0xb0aa9c },
  { level: 3, name: '擁壁', deg: 88, cost: 500, hours: 0.06, color: 0x93a0ad },
];

export function slopeWorkDef(level: number): SlopeWorkDef | null {
  return SLOPE_WORKS.find((s) => s.level === level) ?? null;
}

export function slopeWorkName(level: number): string {
  if (level <= 0) return '無処理';
  return slopeWorkDef(level)?.name ?? `L${level}`;
}

/** 1 列ぶんの面積 [m^2]。 */
const COLUMN_AREA = CELL * CELL;

export interface PaintPreview {
  /** 実際に施工する列数。すでに同等以上が入っている列は数えない。 */
  columns: number;
  area: number;
  cost: number;
  hours: number;
}

export class SlopeWorks {
  /** 施工待ちの列 → 予約中のレベル。中間色で描くのに使う。 */
  readonly pending = new Map<number, number>();
  /** 見た目を作り直すべきか。 */
  dirtyVisuals = false;

  constructor(
    private index: HeightIndex,
    private crew: Crew,
  ) {}

  /** その円の中で、まだそのレベルが入っていない列を集める。 */
  private targets(x: number, z: number, radius: number, level: number, out: number[]): number[] {
    out.length = 0;
    const { heights, protect } = this.index;
    const r2 = radius * radius;
    const i0 = Math.max(1, Math.floor((x - radius) / CELL));
    const i1 = Math.min(NX - 2, Math.ceil((x + radius) / CELL));
    const k0 = Math.max(1, Math.floor((z - radius) / CELL));
    const k1 = Math.min(NZ - 2, Math.ceil((z + radius) / CELL));
    for (let k = k0; k <= k1; k++) {
      for (let i = i0; i <= i1; i++) {
        if (isRimColumn(i, k)) continue;
        const dx = i * CELL - x;
        const dz = k * CELL - z;
        if (dx * dx + dz * dz > r2) continue;
        const o = colIdx(i, k);
        if (heights[o] === NO_SURFACE) continue;
        // すでに同等以上が入っている / 手配済みなら二度払いさせない
        if (protect[o] >= level) continue;
        if ((this.pending.get(o) ?? 0) >= level) continue;
        out.push(o);
      }
    }
    return out;
  }

  private scratch: number[] = [];
  /** 直前に積んだジョブ。ドラッグ中はここへ足していく。 */
  private lastJob: { job: CrewJob; level: number; cols: number[] } | null = null;

  /** 塗る前の見積もり。HUD が費用と時間を出すのに使う。 */
  preview(x: number, z: number, radius: number, level: number): PaintPreview {
    const def = slopeWorkDef(level);
    const cols = def ? this.targets(x, z, radius, level, this.scratch).length : 0;
    const area = cols * COLUMN_AREA;
    return {
      columns: cols,
      area,
      cost: def ? area * def.cost : 0,
      hours: def ? area * def.hours : 0,
    };
  }

  /**
   * 塗る。費用は前払いで、効くのは施工班の順番が来てから。
   * @returns 実際に予約できたか
   */
  paint(x: number, z: number, radius: number, level: number, economy: Economy): boolean {
    const def = slopeWorkDef(level);
    if (!def) return false;
    const cols = this.targets(x, z, radius, level, this.scratch);
    if (cols.length === 0) return false;

    const area = cols.length * COLUMN_AREA;
    const cost = area * def.cost;
    if (economy.money < cost) return false;
    economy.spend(cost);

    for (const o of cols) this.pending.set(o, level);
    this.dirtyVisuals = true;

    // ドラッグ中は毎フレーム呼ばれる。1 塗り 1 ジョブにすると列が数百件になり、
    // 「施工待ち 475 件」という読めない表示になるうえ ETA の計算も重い。
    // まだ着工していない同じ工法のジョブがあれば、そこへ足す。
    const last = this.lastJob;
    if (last && last.level === level && this.crew.eta(last.job) !== null) {
      last.job.hours += area * def.hours;
      for (const o of cols) last.cols.push(o);
      return true;
    }

    const owned = cols.slice();
    const job: CrewJob = {
      hours: area * def.hours,
      label: def.name,
      alive: () => true,
      finish: () => {
        const { protect, heights } = this.index;
        for (const o of owned) {
          // 施工待ちのあいだに掘り崩された列は施工できない
          if (heights[o] === NO_SURFACE) continue;
          if (this.pending.get(o) === level) this.pending.delete(o);
          if (protect[o] < level) protect[o] = level;
        }
        this.dirtyVisuals = true;
      },
    };
    this.crew.push(job);
    this.lastJob = { job, level, cols: owned };
    return true;
  }

  /** その列に効いている工法のレベル。0 なら無処理。 */
  levelAt(x: number, z: number): number {
    const i = Math.round(x / CELL);
    const k = Math.round(z / CELL);
    if (isRimColumn(i, k)) return 0;
    return this.index.protect[colIdx(i, k)];
  }

  /** 施工待ちを含めたレベル。HUD 用。 */
  plannedAt(x: number, z: number): number {
    const i = Math.round(x / CELL);
    const k = Math.round(z / CELL);
    if (isRimColumn(i, k)) return 0;
    const o = colIdx(i, k);
    return Math.max(this.index.protect[o], this.pending.get(o) ?? 0);
  }
}
