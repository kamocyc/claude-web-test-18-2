import { describe, it, expect } from 'vitest';
import { surfaceNets } from './surfaceNets';
import { VoxelField } from '../VoxelField';
import { CELL, NX, NY, NZ, CHUNK, Geo } from '../config';

/**
 * 継ぎ目のテスト。
 *
 * 隣り合うチャンクは、共有する境界セルの頂点をそれぞれ独立に計算する。
 * 入力も演算順序も同じなので結果はビット単位で一致するはずで、
 * 一致しなくなった瞬間に地形に割れと法線の段差が出る。
 * ここが壊れたことに描画を見て気づくのは難しいので、数値で押さえておく。
 */

/**
 * y = 20 m あたりを通る、格子軸と揃わない向きに傾いたうねった面を作る。
 * 軸に揃えると境界の不一致が偶然隠れてしまうので、わざと傾ける。
 * cy = 1 のチャンク (y = 16..32 m) には必ず表面が来る。
 */
function fillWavyPlane(field: VoxelField): void {
  for (let k = 0; k < NZ; k++) {
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) {
        const x = i * CELL;
        const y = j * CELL;
        const z = k * CELL;
        const wob = 1.4 * Math.sin(x * 0.21) * Math.cos(z * 0.17) + 0.8 * Math.sin(z * 0.13);
        field.density[field.idx(i, j, k)] = 18 + 0.09 * x + 0.06 * z + wob - y;
        field.material[field.idx(i, j, k)] = y < 12 ? Geo.Rock : y < 20 ? Geo.Weak : Geo.Soil;
      }
    }
  }
}

describe('surfaceNets', () => {
  const field = new VoxelField();
  fillWavyPlane(field);
  // 表面が通るチャンク段 (y = 16..32 m)
  const CY = CHUNK;

  it('隣接チャンクの共有境界の頂点が厳密に一致する', () => {
    // X 方向に隣り合う 2 チャンク。重なるのは境界セル 1 層分。
    const a = surfaceNets(field, 0, CY, 0, CHUNK);
    const b = surfaceNets(field, CHUNK, CY, 0, CHUNK);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();

    // a のローカルセル ci = CHUNK は、b のローカルセル ci = 0 と同じ格子セル。
    // 位置はワールド座標に直して最近傍で対応づける。
    // 位置そのものを厳密比較しないのは、原点の取り方が違うぶん
    // (32+fx)*CELL と fx*CELL + 32*CELL の丸めが 1 ulp ずれうるため。
    // 1 ulp = 約 1e-6 m なので描画上は無意味。逆に、法線と地質重みは
    // 同じ入力に同じ演算をしているだけなのでビット単位で一致しなければならない。
    const aShared: number[] = [];
    for (let v = 0; v < a!.vertexCount; v++) {
      const lx = a!.positions[v * 3];
      if (lx >= CHUNK * CELL && lx <= (CHUNK + 1) * CELL) aShared.push(v);
    }
    expect(aShared.length).toBeGreaterThan(20);

    let matched = 0;
    for (let v = 0; v < b!.vertexCount; v++) {
      const lx = b!.positions[v * 3];
      if (lx > CELL) continue;

      const bx = lx + CHUNK * CELL;
      const by = b!.positions[v * 3 + 1];
      const bz = b!.positions[v * 3 + 2];

      let best = -1;
      let bestD = Infinity;
      for (const av of aShared) {
        const dx = a!.positions[av * 3] - bx;
        const dy = a!.positions[av * 3 + 1] - by;
        const dz = a!.positions[av * 3 + 2] - bz;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = av;
        }
      }
      // 対応する頂点が 1 ミクロン以内に必ず居る = 割れていない
      expect(Math.sqrt(bestD)).toBeLessThan(1e-5);
      for (let c = 0; c < 3; c++) {
        expect(b!.normals[v * 3 + c]).toBe(a!.normals[best * 3 + c]);
        expect(b!.matWeights[v * 3 + c]).toBe(a!.matWeights[best * 3 + c]);
      }
      matched++;
    }
    expect(matched).toBeGreaterThan(20);
  });

  it('法線が正規化されていて、固体の外を向く', () => {
    const m = surfaceNets(field, 2 * CHUNK, CY, 2 * CHUNK, CHUNK);
    expect(m).not.toBeNull();
    for (let v = 0; v < m!.vertexCount; v++) {
      const nx = m!.normals[v * 3];
      const ny = m!.normals[v * 3 + 1];
      const nz = m!.normals[v * 3 + 2];
      expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 5);
      // 法線方向に少し進むと空気側になっているはず
      const px = m!.positions[v * 3] + 2 * CHUNK * CELL;
      const py = m!.positions[v * 3 + 1] + CY * CELL;
      const pz = m!.positions[v * 3 + 2] + 2 * CHUNK * CELL;
      const outside = field.sample(px + nx * 0.4, py + ny * 0.4, pz + nz * 0.4);
      const inside = field.sample(px - nx * 0.4, py - ny * 0.4, pz - nz * 0.4);
      expect(outside).toBeLessThan(inside);
    }
  });

  it('地質の重みは合計 1', () => {
    const m = surfaceNets(field, CHUNK, CY, CHUNK, CHUNK);
    expect(m).not.toBeNull();
    for (let v = 0; v < m!.vertexCount; v++) {
      const s = m!.matWeights[v * 3] + m!.matWeights[v * 3 + 1] + m!.matWeights[v * 3 + 2];
      expect(s).toBeCloseTo(1, 5);
    }
  });

  it('全部固体・全部空気なら null', () => {
    const solid = new VoxelField();
    solid.density.fill(5);
    expect(surfaceNets(solid, 0, 0, 0, CHUNK)).toBeNull();
    solid.density.fill(-5);
    expect(surfaceNets(solid, 0, 0, 0, CHUNK)).toBeNull();
  });
});
