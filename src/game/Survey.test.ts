import { describe, it, expect, beforeAll } from 'vitest';
import { SurveySystem, BORING_COST_PER_M, BORING_INFLUENCE } from './Survey';
import { Economy } from './Economy';
import { VoxelField } from '../terrain/VoxelField';
import { CELL, NX, NY, NZ, Geo } from '../terrain/config';

/**
 * 調査の裏付け。
 * 「どこまでが分かっていることになるのか」がぶれると、
 * 企画の「調査に金をかけるか、勘で掘って事故るか」が意味を失う。
 */

const SURFACE_Y = 50;

/** 地表 y=50。上から 土 10m / 軟弱 6m / 岩 という水平な層。 */
function buildField(): VoxelField {
  const f = new VoxelField();
  for (let k = 0; k < NZ; k++) {
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) {
        const y = j * CELL;
        const idx = f.idx(i, j, k);
        f.density[idx] = SURFACE_Y - y;
        f.material[idx] = y > SURFACE_Y - 10 ? Geo.Soil : y > SURFACE_Y - 16 ? Geo.Weak : Geo.Rock;
      }
    }
  }
  return f;
}

describe('ボーリング調査', () => {
  let field: VoxelField;

  beforeAll(() => {
    field = buildField();
  });

  it('孔口の標高を見つけ、費用を前払いする', () => {
    const s = new SurveySystem();
    const econ = new Economy();
    const before = econ.money;
    const b = s.start(field, 40, 40, econ, 20);
    expect(b).not.toBeNull();
    expect(b!.surfaceY).toBeCloseTo(SURFACE_Y, 0);
    expect(before - econ.money).toBeCloseTo(20 * BORING_COST_PER_M, 5);
  });

  it('資金が足りなければ開始しない', () => {
    const s = new SurveySystem();
    const econ = new Economy();
    econ.money = 100;
    expect(s.start(field, 40, 40, econ, 20)).toBeNull();
    expect(econ.money).toBe(100);
    expect(s.borings.length).toBe(0);
  });

  it('掘進した深さぶんだけ層序が出る', () => {
    const s = new SurveySystem();
    const econ = new Economy();
    const b = s.start(field, 40, 40, econ, 24)!;

    // 8 m まで掘る → 土だけのはず
    s.update(field, 8 / 3.5);
    expect(b.drilled).toBeCloseTo(8, 1);
    expect(b.layers.every((l) => l.geo === Geo.Soil)).toBe(true);

    // 最後まで掘る → 土 → 軟弱 → 岩 の 3 層
    for (let i = 0; i < 20; i++) s.update(field, 1);
    expect(b.done).toBe(true);
    expect(b.drilled).toBeCloseTo(24, 5);
    expect(b.layers.map((l) => l.geo)).toEqual([Geo.Soil, Geo.Weak, Geo.Rock]);
    // 層の境界がだいたい合っていること
    expect(b.layers[0].bottom).toBeCloseTo(SURFACE_Y - 10, 0);
    expect(b.layers[1].bottom).toBeCloseTo(SURFACE_Y - 16, 0);
  });

  it('信頼度は孔から離れるほど下がり、到達していない深さでは 0', () => {
    const s = new SurveySystem();
    const econ = new Economy();
    const b = s.start(field, 40, 40, econ, 20)!;
    for (let i = 0; i < 20; i++) s.update(field, 1);
    expect(b.done).toBe(true);

    const onHole = s.confidenceAt(40, SURFACE_Y - 10, 40);
    const near = s.confidenceAt(40 + BORING_INFLUENCE * 0.5, SURFACE_Y - 10, 40);
    const far = s.confidenceAt(40 + BORING_INFLUENCE * 4, SURFACE_Y - 10, 40);

    expect(onHole).toBeCloseTo(1, 3);
    expect(near).toBeLessThan(onHole);
    expect(near).toBeGreaterThan(0.5);
    expect(far).toBeLessThan(0.01);

    // 掘った深さより下は、真上に孔があっても分からない
    expect(s.confidenceAt(40, SURFACE_Y - 20 - 5, 40)).toBe(0);
    // 孔口より上も対象外
    expect(s.confidenceAt(40, SURFACE_Y + 5, 40)).toBe(0);
  });

  it('孔が無ければ何も裏付けられていない', () => {
    const s = new SurveySystem();
    expect(s.confidenceAt(40, 30, 40)).toBe(0);
  });
});
