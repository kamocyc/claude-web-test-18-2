import { describe, it, expect } from 'vitest';
import { VoxelField } from './VoxelField';
import { HeightIndex, colIdx } from './HeightIndex';
import { applyCapsule } from './Edit';
import { Vegetation, GRASS_MAX_DEG, columnSlopeDeg } from './Vegetation';
import { CELL, NX, NY, NZ, Geo, WATER_TABLE_Y } from './config';
import type { ChunkManager } from './ChunkManager';

/**
 * 植生。飾りではなく**地面の状態**なので、押さえるのは見た目ではなく整合。
 *   1. 生える条件が地質・傾斜・水位だけで決まり、決定的であること
 *   2. 地表が動いた列から必ず消えること (掘った・崩れた・盛った)
 *   3. 種子吹付を入れた列だけが、時間をかけて戻ること
 *   4. 範囲の通知が無くても、総なめが同じ結論に追いつくこと
 */

const chunks = { markDirtyByAABB(): void {} } as unknown as ChunkManager;
const ALL = NX * NZ;

/** 高さ関数と地質から場を作る。 */
function build(
  h: (x: number, z: number) => number,
  geo: (x: number, z: number, y: number) => Geo = () => Geo.Soil,
): { field: VoxelField; index: HeightIndex } {
  const field = new VoxelField();
  const hs = new Float64Array(NX * NZ);
  for (let k = 0; k < NZ; k++) {
    for (let i = 0; i < NX; i++) hs[i + k * NX] = h(i * CELL, k * CELL);
  }
  for (let k = 0; k < NZ; k++) {
    for (let i = 0; i < NX; i++) {
      const o = i + k * NX;
      const gx = (hs[Math.min(NX - 1, i + 1) + k * NX] - hs[Math.max(0, i - 1) + k * NX]) / (2 * CELL);
      const gz = (hs[i + Math.min(NZ - 1, k + 1) * NX] - hs[i + Math.max(0, k - 1) * NX]) / (2 * CELL);
      const norm = Math.sqrt(1 + gx * gx + gz * gz);
      const onEdge = i === 0 || i === NX - 1 || k === 0 || k === NZ - 1;
      let idx = i + k * field.strideZ;
      for (let j = 0; j < NY; j++, idx += field.strideY) {
        let d = (hs[o] - j * CELL) / norm;
        if (d > 8) d = 8;
        else if (d < -8) d = -8;
        if (onEdge || j === 0) d = -1;
        field.density[idx] = d;
        field.material[idx] = geo(i * CELL, k * CELL, j * CELL);
      }
    }
  }
  const index = new HeightIndex();
  index.measureAll(field);
  return { field, index };
}

/** 平らな台地。水位より十分上。 */
function plateau(): { field: VoxelField; index: HeightIndex } {
  return build(() => 30);
}

describe('生える条件', () => {
  it('同じ地形からは必ず同じ被覆になる (決定的)', () => {
    const { index } = plateau();
    const a = new Vegetation();
    const b = new Vegetation();
    a.seedAll(index);
    b.seedAll(index);
    expect(Array.from(a.cover)).toEqual(Array.from(b.cover));
  });

  it('平らな土の上は一面に生える', () => {
    const { index } = plateau();
    const veg = new Vegetation();
    veg.seedAll(index);
    expect(veg.cover[colIdx(60, 60)]).toBeCloseTo(1, 5);
  });

  it('岩の露頭には生えない', () => {
    const { index } = build(() => 30, (x) => (x > 40 ? Geo.Rock : Geo.Soil));
    const veg = new Vegetation();
    veg.seedAll(index);
    expect(veg.cover[colIdx(20, 60)]).toBeCloseTo(1, 5);
    // 岩は 0.12 まで落ちる。露岩が緑で隠れたら「色を見れば分かる」が壊れる。
    expect(veg.cover[colIdx(120, 60)]).toBeLessThan(0.2);
  });

  it('地下水位より下は裸地 (湿地)', () => {
    const { index } = build(() => WATER_TABLE_Y - 3);
    const veg = new Vegetation();
    veg.seedAll(index);
    expect(veg.cover[colIdx(60, 60)]).toBe(0);
  });

  it('急な法面ほど薄くなり、限界を超えると裸になる', () => {
    // 斜面は x = 30..50 m の間だけ。世界の天井 (64 m) に当たると
    // 高さが頭打ちになって、測った傾斜が指定より寝てしまう。
    const at = (deg: number): number => {
      const t = Math.tan((deg * Math.PI) / 180);
      const { index } = build((x) => 25 + Math.min(Math.max(0, x - 30), 20) * t);
      const veg = new Vegetation();
      veg.seedAll(index);
      const i = Math.round(40 / CELL);
      // 作った傾斜が意図どおりか、まず場のほうを確かめる
      expect(columnSlopeDeg(index, i, 120)).toBeCloseTo(deg, 0);
      return veg.cover[colIdx(i, 120)];
    };
    expect(at(10)).toBeCloseTo(1, 3);
    // 安息角 (34 度) の法面は目に見えて薄い (裸ではない)
    expect(at(34)).toBeLessThan(0.85);
    expect(at(34)).toBeGreaterThan(0.2);
    expect(at(GRASS_MAX_DEG + 5)).toBe(0);
  });
});

describe('地形が動いたら消える', () => {
  it('掘った列の緑は剥がれる', () => {
    const { field, index } = plateau();
    const veg = new Vegetation();
    veg.seedAll(index);
    const o = colIdx(80, 80);
    expect(veg.cover[o]).toBeGreaterThan(0.9);

    const x = 80 * CELL;
    const z = 80 * CELL;
    const res = applyCapsule(field, chunks, x, 30, z, x, 26, z, 3, 'dig', 0.5, Geo.Soil);
    index.measureAABB(field, res.min[0], res.min[2], res.max[0], res.max[2]);
    veg.markDirtyByAABB(res.min[0], res.min[2], res.max[0], res.max[2]);
    veg.update(index, 0, ALL);

    expect(veg.cover[o]).toBe(0);
    // 掘っていない所は残る
    expect(veg.cover[colIdx(20, 20)]).toBeGreaterThan(0.9);
  });

  it('範囲の通知が無くても、総なめが同じ結論に追いつく', () => {
    const { field, index } = plateau();
    const hinted = new Vegetation();
    const swept = new Vegetation();
    hinted.seedAll(index);
    swept.seedAll(index);

    const x = 60 * CELL;
    const z = 60 * CELL;
    const res = applyCapsule(field, chunks, x, 30, z, x, 25, z, 4, 'dig', 0.5, Geo.Soil);
    index.measureAABB(field, res.min[0], res.min[2], res.max[0], res.max[2]);

    hinted.markDirtyByAABB(res.min[0], res.min[2], res.max[0], res.max[2]);
    hinted.update(index, 0, ALL);
    // こちらは何も知らせずに 1 周させるだけ
    swept.update(index, 0, ALL);

    expect(Array.from(swept.cover)).toEqual(Array.from(hinted.cover));
  });

  it('二度目の update は何も動かさない (冪等)', () => {
    const { index } = plateau();
    const veg = new Vegetation();
    veg.seedAll(index);
    veg.update(index, 0, ALL);
    veg.dirtyTiles.clear();
    const before = Array.from(veg.cover);
    veg.update(index, 0, ALL);
    expect(Array.from(veg.cover)).toEqual(before);
    expect(veg.dirtyTiles.size).toBe(0);
  });

  it('舗装した列は緑を止める (地表が動かない平坦地の道路)', () => {
    const { index } = plateau();
    const veg = new Vegetation();
    veg.seedAll(index);
    const o = colIdx(50, 50);
    expect(veg.cover[o]).toBeGreaterThan(0.9);
    veg.paveDisc(50 * CELL, 50 * CELL, 3);
    veg.update(index, 0, ALL);
    expect(veg.cover[o]).toBe(0);
    // 何日経っても戻らない
    for (let n = 0; n < 12; n++) veg.update(index, 12, ALL);
    expect(veg.cover[o]).toBe(0);
  });
});

describe('種子吹付だけが緑を戻す', () => {
  it('3 日かけて元の被覆まで戻り、途中は単調に増える', () => {
    const { index } = plateau();
    const veg = new Vegetation();
    veg.seedAll(index);
    const o = colIdx(70, 70);
    const pot = veg.cover[o];

    // 掘った扱いにして剥がす
    index.heights[o] -= 1;
    veg.markDirtyByAABB(70 * CELL, 70 * CELL, 70 * CELL, 70 * CELL);
    veg.update(index, 0, ALL);
    expect(veg.cover[o]).toBe(0);

    index.protect[o] = 1; // 種子吹付
    let prev = -1;
    for (let n = 0; n < 9; n++) {
      veg.update(index, 8, ALL); // 合計 72 時間
      expect(veg.cover[o]).toBeGreaterThanOrEqual(prev);
      prev = veg.cover[o];
    }
    expect(veg.cover[o]).toBeCloseTo(pot, 2);
  });

  it('法枠や擁壁では戻らない (構造物であって緑化工ではない)', () => {
    const { index } = plateau();
    const veg = new Vegetation();
    veg.seedAll(index);
    const o = colIdx(70, 70);
    index.heights[o] -= 1;
    veg.markDirtyByAABB(70 * CELL, 70 * CELL, 70 * CELL, 70 * CELL);
    veg.update(index, 0, ALL);
    index.protect[o] = 3; // 擁壁
    for (let n = 0; n < 12; n++) veg.update(index, 12, ALL);
    expect(veg.cover[o]).toBe(0);
  });
});

describe('地形シェーダへ渡すマップ', () => {
  it('被覆率と地表高さがそのまま入っている', () => {
    const { index } = build(() => 32);
    const veg = new Vegetation();
    veg.seedAll(index);
    const o = colIdx(64, 64);
    const data = veg.maskTexture.image.data as Uint8Array;
    expect(data[o * 2] / 255).toBeCloseTo(veg.cover[o], 2);
    // G は高さ / WORLD_Y。ここを間違えると坑道の床が緑になる。
    expect((data[o * 2 + 1] / 255) * 64).toBeCloseTo(index.heights[o], 0);
  });
});
