import { describe, it, expect } from 'vitest';
import { Crew } from './Crew';
import { SlopeWorks, SLOPE_WORKS, slopeWorkDef } from './SlopeWorks';
import { Economy } from './Economy';
import { VoxelField } from '../terrain/VoxelField';
import { HeightIndex, colIdx, SLOPE_WORK_DEG } from '../terrain/HeightIndex';
import { ReposeSystem } from '../terrain/Repose';
import { applyCapsule } from '../terrain/Edit';
import { CELL, NX, NY, NZ, Geo, REPOSE_DEG } from '../terrain/config';
import type { ChunkManager } from '../terrain/ChunkManager';

/**
 * 法面保護工。崩れてから直すのではなく、**掘る前に払って止める**手段。
 *
 * 押さえたいのは 3 つ。
 *   1. 塗った所は安息角ではなく工法の角度で立つこと (工法ごとに違うこと)
 *   2. 前払いで、施工班の順番が来るまでは効かないこと
 *   3. 施工班は支保と共有の 1 班で、押した順に処理されること
 */

const chunks = { markDirtyByAABB(): void {} } as unknown as ChunkManager;
const deg = (t: number): number => (Math.atan(t) * 180) / Math.PI;

const HI = 40;
const LO = 34;
const EDGE_X = 60;

/** 高さ HI の台地が x = EDGE_X で LO へ落ちる垂直な段差。 */
function buildStep(): VoxelField {
  const f = new VoxelField();
  for (let k = 0; k < NZ; k++) {
    for (let i = 0; i < NX; i++) {
      const hh = i * CELL < EDGE_X ? HI : LO;
      const onEdge = i === 0 || i === NX - 1 || k === 0 || k === NZ - 1;
      let idx = i + k * f.strideZ;
      for (let j = 0; j < NY; j++, idx += f.strideY) {
        let d = hh - j * CELL;
        if (d > 8) d = 8;
        else if (d < -8) d = -8;
        if (onEdge || j === 0) d = -1;
        f.density[idx] = d;
        f.material[idx] = Geo.Soil;
      }
    }
  }
  return f;
}

/** 段差まわりをゆるませて整定し、いちばん急な所の角度を返す。 */
function settledFaceDeg(index: HeightIndex, field: VoxelField): number {
  const sys = new ReposeSystem(index);
  for (let k = 1; k < NZ - 1; k++) {
    for (let i = 1; i < NX - 1; i++) index.loosen(colIdx(i, k), 20);
  }
  sys.seedAll();
  sys.settleNow(field, chunks);
  let best = 0;
  const k = NZ >> 1;
  for (let i = 1; i < NX - 2; i++) {
    const a = index.heights[colIdx(i, k)];
    const b = index.heights[colIdx(i + 1, k)];
    best = Math.max(best, Math.abs(a - b) / CELL);
  }
  return deg(best);
}

describe('工法の表', () => {
  it('安息角より必ず急で、レベルが上がるほど立つ', () => {
    expect(SLOPE_WORKS[0].deg).toBeGreaterThan(REPOSE_DEG[Geo.Soil]);
    for (let i = 1; i < SLOPE_WORKS.length; i++) {
      expect(SLOPE_WORKS[i].deg).toBeGreaterThan(SLOPE_WORKS[i - 1].deg);
      expect(SLOPE_WORKS[i].cost).toBeGreaterThan(SLOPE_WORKS[i - 1].cost);
      expect(SLOPE_WORKS[i].hours).toBeGreaterThan(SLOPE_WORKS[i - 1].hours);
    }
  });

  it('terrain 層に写した角度が本体とずれていない', () => {
    // HeightIndex は game 層を import できないので角度だけ写してある。
    // ずれると「崩落の角度」と「HUD の表示」が食い違う。
    for (const w of SLOPE_WORKS) expect(SLOPE_WORK_DEG[w.level]).toBe(w.deg);
    expect(SLOPE_WORK_DEG[0]).toBe(0);
  });
});

describe('塗った所は工法の角度で立つ', () => {
  /** 段差の全面に保護工を入れてから整定する。 */
  function protectedFaceDeg(level: number): number {
    const field = buildStep();
    const index = new HeightIndex();
    index.measureAll(field);
    for (let o = 0; o < index.protect.length; o++) {
      if (index.heights[o] > 0) index.protect[o] = level;
    }
    return settledFaceDeg(index, field);
  }

  it('無処理なら安息角まで寝る', () => {
    const field = buildStep();
    const index = new HeightIndex();
    index.measureAll(field);
    const got = settledFaceDeg(index, field);
    expect(Math.abs(got - REPOSE_DEG[Geo.Soil])).toBeLessThan(1.0);
  });

  it('工法ごとにその角度で立つ', () => {
    // 段差 6 m を 1 セル (0.5 m) で測るので、測れる上限は atan(6/0.5) = 85.2 度。
    // 擁壁 (88 度) はこの物差しでは 85.2 度までしか出ない (格子の分解能であって
    // 実装のずれではない)。工法の角度と分解能の小さいほうと突き合わせる。
    const ceiling = (Math.atan((HI - LO) / CELL) * 180) / Math.PI;
    for (const w of SLOPE_WORKS) {
      const got = protectedFaceDeg(w.level);
      expect(Math.abs(got - Math.min(w.deg, ceiling))).toBeLessThan(1.0);
    }
  });

  it('工法の角度より寝ている斜面を立たせはしない', () => {
    // 保護工は「その角度まで支える」であって「その角度に起こす」ではない。
    // 段差 6 m を吹付 (45°) で守ると 45° で止まるが、
    // もともと平らな所が 45° に変形したりはしない。
    const field = buildStep();
    const index = new HeightIndex();
    index.measureAll(field);
    for (let o = 0; o < index.protect.length; o++) {
      if (index.heights[o] > 0) index.protect[o] = 1;
    }
    settledFaceDeg(index, field);
    const k = NZ >> 1;
    expect(index.heights[colIdx(20, k)]).toBeCloseTo(HI, 6);
    expect(index.heights[colIdx(230, k)]).toBeCloseTo(LO, 6);
  });
});

describe('施工', () => {
  function setup(): { works: SlopeWorks; crew: Crew; index: HeightIndex; economy: Economy } {
    const field = buildStep();
    const index = new HeightIndex();
    index.measureAll(field);
    const crew = new Crew();
    return { works: new SlopeWorks(index, crew), crew, index, economy: new Economy() };
  }

  it('費用は前払いで、順番が来るまで効かない', () => {
    const { works, crew, index, economy } = setup();
    const before = economy.money;
    const pv = works.preview(30, 64, 2.6, 3);
    expect(pv.columns).toBeGreaterThan(50);

    expect(works.paint(30, 64, 2.6, 3, economy)).toBe(true);
    // 金は押した瞬間に引かれる
    expect(before - economy.money).toBeCloseTo(pv.cost, 6);
    // まだ効いていない
    expect(index.protect[colIdx(60, 128)]).toBe(0);
    expect(crew.length).toBe(1);

    // 施工時間の半分では、まだ効かない
    crew.update(pv.hours * 0.5);
    expect(index.protect[colIdx(60, 128)]).toBe(0);

    // 使い切ると効く
    crew.update(pv.hours);
    expect(index.protect[colIdx(60, 128)]).toBe(3);
    expect(crew.length).toBe(0);
  });

  it('資金が足りなければ予約できない', () => {
    const { works, crew, economy } = setup();
    economy.money = 10;
    expect(works.paint(30, 64, 2.6, 3, economy)).toBe(false);
    expect(crew.length).toBe(0);
    expect(economy.money).toBe(10);
  });

  it('同じ所を二度塗っても二度払わない', () => {
    const { works, crew, economy } = setup();
    works.paint(30, 64, 2.6, 2, economy);
    crew.update(999);
    const after = economy.money;
    // 同じレベルはもう要らない
    expect(works.paint(30, 64, 2.6, 2, economy)).toBe(false);
    expect(economy.money).toBe(after);
    // 上の工法へは足せる
    expect(works.paint(30, 64, 2.6, 3, economy)).toBe(true);
  });

  it('施工班は 1 班 — 支保と同じ列に押した順で並ぶ', () => {
    const { works, crew, economy } = setup();
    const order: string[] = [];
    // 支保のジョブを模して先に積む
    crew.push({ hours: 2, label: '木枠', alive: () => true, finish: () => order.push('支保') });
    works.paint(30, 64, 2.6, 1, economy);
    const total = crew.totalHours;
    expect(crew.length).toBe(2);

    // 先に積んだほうが先に終わる
    crew.update(2.0);
    expect(order).toEqual(['支保']);
    crew.update(total);
    expect(crew.length).toBe(0);
  });

  it('余った時間は次のジョブへ繰り越す', () => {
    const crew = new Crew();
    const done: number[] = [];
    for (let n = 0; n < 4; n++) {
      crew.push({ hours: 0.1, label: `j${n}`, alive: () => true, finish: () => done.push(n) });
    }
    // 1 回の update で 4 本とも終わること (1 フレーム 1 本しか進まないと
    // 面積の小さい保護工がいつまでも捌けない)
    crew.update(1.0);
    expect(done).toEqual([0, 1, 2, 3]);
  });
});

describe('掘り崩したら保護工も消える', () => {
  it('塗った所を掘り抜くと、掘った列だけ保護が外れる', () => {
    const field = buildStep();
    const index = new HeightIndex();
    index.measureAll(field);
    const crew = new Crew();
    const works = new SlopeWorks(index, crew);
    const economy = new Economy();
    const repose = new ReposeSystem(index);

    // 台地の上を広めに塗って、施工まで済ませる
    works.paint(30, 64, 8, 3, economy);
    crew.update(999);
    const k = NZ >> 1;
    expect(index.protect[colIdx(60, k)]).toBe(3);
    const asideBefore = index.protect[colIdx(46, k)];
    expect(asideBefore).toBe(3);

    // その真ん中を掘り抜く
    const res = applyCapsule(field, chunks, 30, HI - 2, 64, 30, HI - 2, 64, 2.6, 'dig', 0.5, Geo.Soil);
    expect(res.changed).toBe(true);
    repose.seedFromEdit(field, res);

    // 掘った列は保護が消え、少し離れた列は残る
    expect(index.protect[colIdx(60, k)]).toBe(0);
    expect(index.protect[colIdx(46, k)]).toBe(3);
  });
});

describe('費用の桁', () => {
  it('ブラシ 1 回の費用が支保と同じ桁に収まっている', () => {
    // 桁がずれると、どちらか一方だけが実質的に選べなくなる
    const area = Math.PI * 2.6 * 2.6;
    for (const w of SLOPE_WORKS) {
      const cost = area * w.cost;
      expect(cost).toBeGreaterThan(300);
      expect(cost).toBeLessThan(30000);
    }
    expect(slopeWorkDef(9)).toBeNull();
  });
});
