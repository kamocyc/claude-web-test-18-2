import { describe, it, expect } from 'vitest';
import { VoxelField } from './VoxelField';
import { HeightIndex, colIdx, NO_SURFACE } from './HeightIndex';
import { ReposeSystem } from './Repose';
import { applyCapsule } from './Edit';
import { generate } from './Generator';
import {
  CELL, NX, NY, NZ, Geo, REPOSE_DEG, INSITU_DEG, REPOSE_SATURATED_DROP, WATER_TABLE_Y,
} from './config';
import type { ChunkManager } from './ChunkManager';

/**
 * 安息角。要求は 2 つで、どちらも数値で押さえる。
 *   1. 急な法面が**即座に**崩れること (ゲーム内時間に依存しないこと)
 *   2. 崩れた跡が**平面**であること — 凸凹が残らないこと
 *
 * 2 は目視で気づきにくいわりに、このプロトタイプの最優先要件
 * (プレイヤーにボクセルを気づかせない) に直結する。角度そのものより
 * 平面性と異方性のほうを厳しく見る。
 */

/** ChunkManager は dirty を積むだけなので、テストでは何もしない差し替えで足りる。 */
const chunks = { markDirtyByAABB(): void {} } as unknown as ChunkManager;

const deg = (t: number): number => (Math.atan(t) * 180) / Math.PI;

/**
 * 高さ h(x,z) の地面で場を埋める。外周と床は Generator と同じく空気にする
 * (ここを閉じないとワールドが薄皮になり、外周の列が地面として測れてしまう)。
 */
function fillHeightField(
  f: VoxelField,
  h: (x: number, z: number) => number,
  geo: (x: number, y: number, z: number) => Geo,
): void {
  for (let k = 0; k < NZ; k++) {
    const z = k * CELL;
    for (let i = 0; i < NX; i++) {
      const x = i * CELL;
      const hh = h(x, z);
      const onEdge = i === 0 || i === NX - 1 || k === 0 || k === NZ - 1;
      let idx = i + k * f.strideZ;
      for (let j = 0; j < NY; j++, idx += f.strideY) {
        const y = j * CELL;
        let d = hh - y;
        if (d > 8) d = 8;
        else if (d < -8) d = -8;
        if (onEdge || j === 0) d = -1;
        f.density[idx] = d;
        f.material[idx] = geo(x, y, z);
      }
    }
  }
}

interface Fixture {
  field: VoxelField;
  index: HeightIndex;
  sys: ReposeSystem;
}

function fixture(
  h: (x: number, z: number) => number,
  geo: (x: number, y: number, z: number) => Geo = () => Geo.Soil,
): Fixture {
  const field = new VoxelField();
  fillHeightField(field, h, geo);
  const index = new HeightIndex();
  index.measureAll(field);
  return { field, index, sys: new ReposeSystem(index) };
}

/** z = 中央 の断面の高さ列。 */
function profile(index: HeightIndex, k = (NZ >> 1)): Float64Array {
  const out = new Float64Array(NX);
  for (let i = 0; i < NX; i++) out[i] = index.heights[colIdx(i, k)];
  return out;
}

/**
 * 断面のいちばん急な所の勾配。
 *
 * 隣り合う 1 セルの差で測る。中心差分だと、安息角が急な地質 (岩 78 度) では
 * 法面が 2-3 セルしか無く、天端と法尻をまたいで平均されて角度が出ない。
 * 整定後は法面が厳密な平面なので、1 セル差の最大値がそのまま安定角になる。
 */
function faceSlope(p: Float64Array): number {
  let best = 0;
  for (let i = 1; i < NX - 2; i++) best = Math.max(best, Math.abs(p[i] - p[i + 1]) / CELL);
  return best;
}

const EDGE_X = 60;
const HI = 40;
const LO = 34;

/** 高さ HI の台地が x = EDGE_X で LO へ落ちる垂直な段差。 */
function step(x: number): number {
  return x < EDGE_X ? HI : LO;
}

describe('安息角の表', () => {
  it('ゆるんだ土砂の安息角より、原地盤の自立角のほうが必ず急', () => {
    for (const g of [Geo.Soil, Geo.Rock, Geo.Weak]) {
      expect(INSITU_DEG[g]).toBeGreaterThan(REPOSE_DEG[g]);
    }
    // 岩 > 土 > 軟弱 の順は「岩を狙って遠回りする」判断の前提
    expect(REPOSE_DEG[Geo.Rock]).toBeGreaterThan(REPOSE_DEG[Geo.Soil]);
    expect(REPOSE_DEG[Geo.Soil]).toBeGreaterThan(REPOSE_DEG[Geo.Weak]);
  });

  it('水位より下は飽和して寝る', () => {
    const { index } = fixture(() => WATER_TABLE_Y - 6, () => Geo.Weak);
    const o = colIdx(80, 80);
    expect(index.reposeDeg(o)).toBeCloseTo(REPOSE_DEG[Geo.Weak] - REPOSE_SATURATED_DROP, 6);
  });
});

describe('崩落', () => {
  /** 段差をゆるませて収束まで整定する。 */
  function settleStep(geo: Geo, hFn: (x: number) => number = step): Fixture {
    const fx = fixture((x) => hFn(x), () => geo);
    // 掘ってできた法面を模す: 段差まわりをゆるんだ土砂にする
    for (let k = 1; k < NZ - 1; k++) {
      for (let i = 1; i < NX - 1; i++) fx.index.loosen(colIdx(i, k), 20);
    }
    fx.sys.seedAll();
    fx.sys.settleNow(fx.field, chunks);
    return fx;
  }

  it('ゆるんだ土砂は安息角まで寝る', () => {
    for (const geo of [Geo.Soil, Geo.Weak, Geo.Rock]) {
      const fx = settleStep(geo);
      const got = deg(faceSlope(profile(fx.index)));
      // 軸方向は異方性の中心合わせのぶんだけ公称よりわずかに寝る
      expect(Math.abs(got - REPOSE_DEG[geo])).toBeLessThan(1.0);
    }
  });

  it('崩れた跡が平面である — 凸凹が残らない', () => {
    const fx = settleStep(Geo.Soil);
    const p = profile(fx.index);
    const t = Math.tan((REPOSE_DEG[Geo.Soil] * Math.PI) / 180);

    // 法面の内側だけを見る (天端と法尻の折れは平面の切れ目であって凸凹ではない)
    const face: number[] = [];
    for (let i = 2; i < NX - 2; i++) {
      if (Math.abs(p[i + 1] - p[i - 1]) / (2 * CELL) > t * 0.5) face.push(i);
    }
    expect(face.length).toBeGreaterThan(8);

    let worst = 0;
    for (const i of face.slice(1, -1)) {
      // 平面なら 2 階差分はゼロ
      worst = Math.max(worst, Math.abs(p[i + 1] - 2 * p[i] + p[i - 1]));
    }
    expect(worst).toBeLessThan(0.01);

    // どこにも安息角を超える勾配が残っていないこと
    let maxSlope = 0;
    for (let i = 2; i < NX - 2; i++) {
      maxSlope = Math.max(maxSlope, Math.abs(p[i + 1] - p[i - 1]) / (2 * CELL));
    }
    expect(maxSlope).toBeLessThan(t * 1.02);
  });

  it('密度場が高さ場と一致する — 書き戻しが効いている', () => {
    const fx = settleStep(Geo.Soil);
    const check = new HeightIndex();
    check.measureAll(fx.field);
    let worst = 0;
    for (let k = 2; k < NZ - 2; k += 7) {
      for (let i = 2; i < NX - 2; i += 3) {
        const o = colIdx(i, k);
        worst = Math.max(worst, Math.abs(check.heights[o] - fx.index.heights[o]));
      }
    }
    // 交点の補間の丸めぶん。1 セルの 1/10 以内なら見た目に出ない
    expect(worst).toBeLessThan(CELL * 0.1);
  });

  it('体積が保存する', () => {
    const fx = fixture(step);
    let before = 0;
    for (let k = 1; k < NZ - 1; k++) {
      for (let i = 1; i < NX - 1; i++) before += fx.index.heights[colIdx(i, k)];
    }
    for (let k = 1; k < NZ - 1; k++) {
      for (let i = 1; i < NX - 1; i++) fx.index.loosen(colIdx(i, k), 20);
    }
    fx.sys.seedAll();
    fx.sys.settleNow(fx.field, chunks);

    let after = 0;
    for (let k = 1; k < NZ - 1; k++) {
      for (let i = 1; i < NX - 1; i++) after += fx.index.heights[colIdx(i, k)];
    }
    expect(Math.abs(after - before)).toBeLessThan(1e-6 * Math.max(1, before));
    expect(fx.sys.movedThisSlide).toBeGreaterThan(0);
  });

  it('有限で止まり、二度目は何も起きない (冪等)', () => {
    const fx = settleStep(Geo.Soil);
    expect(fx.sys.stats.sweeps).toBeLessThan(6000);
    expect(fx.sys.active).toBe(false);

    fx.sys.seedAll();
    const res = fx.sys.settleNow(fx.field, chunks);
    expect(fx.sys.stats.pours).toBe(0);
    expect(res).toBeNull();
  });

  it('岩は立ち、軟弱はいちばん寝る', () => {
    const moved = (geo: Geo): number => settleStep(geo).sys.movedThisSlide;
    const rock = moved(Geo.Rock);
    const soil = moved(Geo.Soil);
    const weak = moved(Geo.Weak);
    expect(rock).toBeLessThan(soil);
    expect(soil).toBeLessThan(weak);
  });

  it('ワールドの外周が崩れない', () => {
    const fx = settleStep(Geo.Soil);
    // 外周の列は地面として測らない = 隣にもならない
    expect(fx.index.heights[colIdx(0, 40)]).toBe(NO_SURFACE);
    expect(fx.index.heights[colIdx(NX - 1, 40)]).toBe(NO_SURFACE);
    // その内側は段差から遠いので初期高さのまま (縁から流れ落ちていない)
    for (const [i, k] of [[1, 40], [1, 200], [NX - 2, 40], [40, 1], [200, NZ - 2]]) {
      expect(fx.index.heights[colIdx(i, k)]).toBeCloseTo(step(i * CELL), 6);
    }
    // 外周の密度は Generator が入れた -1 のまま
    expect(fx.field.density[fx.field.idx(0, 60, 40)]).toBe(-1);
  });
});

describe('崩落の伝播', () => {
  /** x が大きいほど低い 30 度の斜面。地下水位 (17.5 m) より上に置く。 */
  const SLOPE_T = Math.tan((30 * Math.PI) / 180);
  const slope = (x: number): number => Math.max(22, 58 - SLOPE_T * (x - 20));

  it('自然斜面の裾を掘っても、崩れは掘った所の近くで止まる', () => {
    const fx = fixture(slope);
    const before = profile(fx.index).slice();

    // 裾に垂直な切土を入れる (ゲームが実際に作る形で = ブラシで掘る)
    const cutX = 70;
    const res = applyCapsule(
      fx.field, chunks,
      cutX, slope(cutX) - 3, 20,
      cutX, slope(cutX) - 3, 108,
      2.6, 'dig', 0.5, Geo.Soil,
    );
    expect(res.changed).toBe(true);

    fx.sys.seedFromEdit(fx.field, res);
    fx.sys.settleNow(fx.field, chunks);

    const after = profile(fx.index);
    // 掘った所より 12 m 以上山側は、まったく動いていないこと
    let worstUp = 0;
    for (let i = 2; i * CELL < cutX - 12; i++) {
      worstUp = Math.max(worstUp, Math.abs(after[i] - before[i]));
    }
    expect(worstUp).toBeLessThan(1e-6);

    // 動いた範囲そのものも有限であること
    let far = 0;
    for (let i = 2; i < NX - 2; i++) {
      if (Math.abs(after[i] - before[i]) > 0.02) far = Math.max(far, Math.abs(i * CELL - cutX));
    }
    expect(far).toBeLessThan(20);
  });

  it('掘った法面は安息角、その奥の原地盤は自立角で止まる', () => {
    const fx = fixture(slope);
    const cutX = 70;
    const res = applyCapsule(
      fx.field, chunks,
      cutX, slope(cutX) - 3, 20,
      cutX, slope(cutX) - 3, 108,
      2.6, 'dig', 0.5, Geo.Soil,
    );
    fx.sys.seedFromEdit(fx.field, res);
    fx.sys.settleNow(fx.field, chunks);

    const got = deg(faceSlope(profile(fx.index)));
    // どこにも原地盤の自立角より急な所は残らない
    expect(got).toBeLessThan(INSITU_DEG[Geo.Soil] + 1);
    // ゆるんだ土砂の安息角より急な法面は残っている (背面は原地盤なので立つ)
    expect(got).toBeGreaterThan(REPOSE_DEG[Geo.Soil] + 2);
  });
});

describe('格子を見せない', () => {
  it('崩した山の安定角が方位で変わらない (円錐が八角形にならない)', () => {
    const CX = 64;
    const CZ = 64;
    const H0 = 36;
    const BASE = 24;
    // 平地に立てた円柱。崩れると円錐になる。
    const fx = fixture((x, z) => {
      const r = Math.hypot(x - CX, z - CZ);
      return r < 6 ? H0 : BASE;
    });
    for (let k = 1; k < NZ - 1; k++) {
      for (let i = 1; i < NX - 1; i++) fx.index.loosen(colIdx(i, k), 40);
    }
    fx.sys.seedAll();
    fx.sys.settleNow(fx.field, chunks);

    /** 高さ場の双一次補間。列にスナップすると方位ごとに標本間隔がずれて測れない。 */
    const hAt = (x: number, z: number): number => {
      const gx = x / CELL;
      const gz = z / CELL;
      const i = Math.floor(gx);
      const k = Math.floor(gz);
      const fxr = gx - i;
      const fzr = gz - k;
      const a = fx.index.heights[colIdx(i, k)];
      const b = fx.index.heights[colIdx(i + 1, k)];
      const c = fx.index.heights[colIdx(i, k + 1)];
      const d = fx.index.heights[colIdx(i + 1, k + 1)];
      return (a + (b - a) * fxr) * (1 - fzr) + (c + (d - c) * fxr) * fzr;
    };

    /** その方位で高さが level を切る半径 [m]。 */
    const radiusAt = (ux: number, uz: number, level: number): number => {
      let prev = 0;
      let prevH = hAt(CX, CZ);
      for (let s = 0.05; s < 30; s += 0.05) {
        const h = hAt(CX + ux * s, CZ + uz * s);
        if (h < level) return prev + (0.05 * (prevH - level)) / (prevH - h);
        prev = s;
        prevH = h;
      }
      return 30;
    };

    /** 円錐の腹の安定角。2 つの等高線の半径差から出すので標本化に鈍い。 */
    const angleAlong = (dx: number, dz: number): number => {
      const len = Math.hypot(dx, dz);
      const ux = dx / len;
      const uz = dz / len;
      const r1 = radiusAt(ux, uz, BASE + 1.5);
      const r2 = radiusAt(ux, uz, BASE + 4.5);
      return (Math.atan(3 / (r1 - r2)) * 180) / Math.PI;
    };

    const dirs: [number, number][] = [
      [1, 0], [0, 1], [1, 1], [1, -1], [2, 1], [1, 2], [-2, 1], [-1, 2],
    ];
    const angles = dirs.map(([a, b]) => angleAlong(a, b));
    // 16 近傍なら安定角の方位差は理論上 0.9 度。格子の向きは見えない。
    expect(Math.max(...angles) - Math.min(...angles)).toBeLessThan(1.5);
    for (const a of angles) expect(Math.abs(a - REPOSE_DEG[Geo.Soil])).toBeLessThan(1.5);
  });
});

describe('トンネル', () => {
  it('法面が崩れても坑道は埋まらない', () => {
    // 30 度の斜面の下 6 m に水平な坑道を通し、その真上に切土を入れる
    const SLOPE_T = Math.tan((30 * Math.PI) / 180);
    const surf = (x: number): number => Math.max(22, 58 - SLOPE_T * (x - 20));
    const fx = fixture(surf);

    const TX = 64;
    const TY = surf(TX) - 12;
    const R = 2.6;
    applyCapsule(fx.field, chunks, TX, TY, 24, TX, TY, 104, R, 'dig', 0.5, Geo.Soil);
    fx.index.measureAll(fx.field);

    // 坑道の真上を掘って土被りを削る
    const res = applyCapsule(
      fx.field, chunks,
      TX, surf(TX) - 1.2, 40, TX, surf(TX) - 1.2, 88,
      2.6, 'dig', 0.5, Geo.Soil,
    );
    fx.sys.seedFromEdit(fx.field, res);
    fx.sys.settleNow(fx.field, chunks);

    // 坑道の中心線はまだ空気であること
    for (let z = 30; z <= 98; z += 2) {
      expect(fx.field.sample(TX, TY, z)).toBeLessThan(0);
    }
  });
});

describe('生成直後の世界', () => {
  it('原地盤の自立角で整定しても、地形の意図が保たれる', () => {
    const field = new VoxelField();
    const maps = generate(field);
    const index = new HeightIndex();
    index.measureAll(field, maps.height);

    const before = Float64Array.from(index.heights);
    const sys = new ReposeSystem(index);
    sys.seedAll();
    sys.settleNow(field, chunks);

    let moved = 0;
    let ridgeDrop = 0;
    for (let k = 1; k < NZ - 1; k++) {
      for (let i = 1; i < NX - 1; i++) {
        const o = colIdx(i, k);
        if (Math.abs(index.heights[o] - before[o]) > 0.02) moved++;
        // 尾根 (x = 93 付近) はトンネルを通す所。土被りが痩せると困る
        if (Math.abs(i * CELL - 93) < 6) {
          ridgeDrop = Math.max(ridgeDrop, before[o] - index.heights[o]);
        }
      }
    }
    // 大半の列は動かない = 谷も尾根もそのまま残る
    expect(moved / ((NX - 2) * (NZ - 2))).toBeLessThan(0.1);
    expect(ridgeDrop).toBeLessThan(1.5);

    // 整定後の世界に、原地盤の自立角を超える所は残らない
    const sys2 = new ReposeSystem(index);
    sys2.seedAll();
    sys2.settleNow(field, chunks);
    expect(sys2.stats.pours).toBe(0);
  });
});
