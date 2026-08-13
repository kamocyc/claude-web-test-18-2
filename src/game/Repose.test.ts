import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { ReposeSystem, reposeAngleDeg } from './Repose';
import { VoxelField } from '../terrain/VoxelField';
import { applyCapsule } from '../terrain/Edit';
import { raycastTerrain } from '../terrain/raymarch';
import {
  CELL, NX, NY, NZ, Geo, WORLD_Y, REPOSE_DEG, REPOSE_SATURATED_DROP, WATER_TABLE_Y,
} from '../terrain/config';
import type { ChunkManager } from '../terrain/ChunkManager';

/**
 * 安息角。目視では「なんとなく寝た」としか言えないので、
 * 最終的な法面の角度を実測して数値で固定する。
 * ここが崩れると、地上の判断 (岩で遠回りか、軟弱層で用地を食うか) が丸ごと変わる。
 */

/** メッシュ化は要らないので dirty 通知だけ捨てる。 */
const chunks = { markDirtyByAABB() {} } as unknown as ChunkManager;

const SURFACE_Y = 40;

/** 地表 y=40 の一様な地盤。 */
function buildField(geo: Geo): VoxelField {
  const f = new VoxelField();
  for (let k = 0; k < NZ; k++) {
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) {
        const idx = f.idx(i, j, k);
        f.density[idx] = Math.min(8, SURFACE_Y - j * CELL);
        f.material[idx] = geo;
      }
    }
  }
  return f;
}

const _o = new THREE.Vector3();
const _d = new THREE.Vector3(0, -1, 0);

/** (x,z) の地表の標高。地面が無ければ null。 */
function surfaceY(f: VoxelField, x: number, z: number): number | null {
  _o.set(x, WORLD_Y, z);
  const hit = raycastTerrain(f, _o, _d, WORLD_Y + 1);
  return hit ? hit.point.y : null;
}

/**
 * 掘削ブラシで直線の切土 (トレンチ) を掘る。
 * 理想的な垂直壁を手で作るのではなく、**ゲームが実際に作る形**で試す。
 * 現実に出てくる形で成立しないなら意味がない。
 */
function digTrench(f: VoxelField, x: number, radius = 2.6): void {
  // 軸を地表のすぐ下に置いて、確実に地表を割る (深さ約 3 m の開削)
  const axisY = SURFACE_Y - radius * 0.3;
  applyCapsule(f, chunks, x, axisY, 20, x, axisY, 44, radius, 'dig', 0.5, Geo.Soil);
}

/** 静止するまで回す。返り値は掛かった tick 数 (上限に当たったら -1)。 */
function settle(sys: ReposeSystem, f: VoxelField, maxTicks = 4000): number {
  for (let t = 0; t < maxTicks; t++) {
    if (!sys.active) return t;
    sys.update(f, chunks, 0.02); // 実時間 40 ms 相当
  }
  return -1;
}

describe('安息角の値', () => {
  it('地質ごとの表', () => {
    expect(reposeAngleDeg(Geo.Rock, false)).toBe(REPOSE_DEG[Geo.Rock]);
    expect(reposeAngleDeg(Geo.Soil, false)).toBe(REPOSE_DEG[Geo.Soil]);
    expect(reposeAngleDeg(Geo.Weak, false)).toBe(REPOSE_DEG[Geo.Weak]);
    // 岩 > 土 > 軟弱 の順序が企画の判断そのものなので、順序も固定する
    expect(reposeAngleDeg(Geo.Rock, false)).toBeGreaterThan(reposeAngleDeg(Geo.Soil, false));
    expect(reposeAngleDeg(Geo.Soil, false)).toBeGreaterThan(reposeAngleDeg(Geo.Weak, false));
  });

  it('水位より下は飽和して寝る', () => {
    for (const g of [Geo.Soil, Geo.Rock, Geo.Weak]) {
      expect(reposeAngleDeg(g, true)).toBeLessThan(reposeAngleDeg(g, false));
    }
    expect(reposeAngleDeg(Geo.Weak, true)).toBe(REPOSE_DEG[Geo.Weak] - 8);
  });
});

/**
 * 法尻から法肩までの通しの角度 [度]。
 *
 * 1 点ごとの法線の最大値では測らない。崩れ終わった法面にも、法肩の
 * 変曲点のような「高さ 30 cm・傾き 50 度」の局所的な出っ張りは残る。
 * そういう短いこぶは現実にも崩れないし、プレイヤーが法面の角度として
 * 見ているのは法尻から法肩までの通しの傾き。それを測る。
 */
function faceAngle(f: VoxelField, x0: number, z: number, maxDx = 16): number | null {
  let toeDx: number | null = null;
  let toeY = Infinity;
  for (let dx = 0; dx <= maxDx; dx += 0.25) {
    const y = surfaceY(f, x0 + dx, z);
    if (y !== null && y < toeY) {
      toeY = y;
      toeDx = dx;
    }
  }
  if (toeDx === null) return null;

  for (let dx = toeDx; dx <= maxDx; dx += 0.25) {
    const y = surfaceY(f, x0 + dx, z);
    if (y !== null && y >= SURFACE_Y - 0.15) {
      const run = dx - toeDx;
      if (run < 0.1) return 90;
      return (Math.atan((y - toeY) / run) * 180) / Math.PI;
    }
  }
  return null;
}

// --- 開けた法面の試験体 ---
// x = 59 に高さ 6 m のほぼ垂直な法面がある段差。下流に土砂が広がる余地がある。
// 溝 (トレンチ) だと両側の法面から落ちた土が真ん中で混ざり、
// 「法尻がどこか」が定まらないので角度の物差しにならない。
const EDGE = 59;
const DROP = 6;
const RAMP = 8; // 1 m あたり 8 m 落ちる ≒ 83 度

function buildStep(geo: Geo, top: number): VoxelField {
  const bot = top - DROP;
  const f = new VoxelField();
  const hAt = (x: number) => Math.max(bot, Math.min(top, top - (x - EDGE) * RAMP));
  for (let k = 0; k < NZ; k++) {
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) {
        const x = i * CELL;
        const inRamp = x > EDGE && x < EDGE + DROP / RAMP;
        // 距離場として正しい傾きにする (生成器と同じ正規化)
        const inv = inRamp ? 1 / Math.sqrt(1 + RAMP * RAMP) : 1;
        const idx = f.idx(i, j, k);
        f.density[idx] = Math.max(-8, Math.min(8, (hAt(x) - j * CELL) * inv));
        f.material[idx] = geo;
      }
    }
  }
  return f;
}

/** 段差の法肩から法尻までの通しの角度 [度]。 */
function stepFaceAngle(f: VoxelField, z: number, top: number): number {
  const bot = top - DROP;
  let crestX = EDGE;
  let crestY = top;
  for (let x = EDGE - 20; x <= EDGE + 30; x += 0.25) {
    const y = surfaceY(f, x, z);
    if (y !== null && y >= top - 0.15) {
      crestX = x;
      crestY = y;
    }
  }
  for (let x = crestX; x <= EDGE + 30; x += 0.25) {
    const y = surfaceY(f, x, z);
    if (y !== null && y <= bot + 0.15) {
      const run = x - crestX;
      return run < 0.1 ? 90 : (Math.atan((crestY - y) / run) * 180) / Math.PI;
    }
  }
  return NaN;
}

/** 段差を崩し切って、法面の通し角度の中央値を返す。 */
function settleStep(geo: Geo, top: number): number {
  const f = buildStep(geo, top);
  const sys = new ReposeSystem();
  sys.seedFromEdit([EDGE - 2, 0, 40], [EDGE + 3, top + 2, 88]);
  for (let t = 0; t < 20000 && sys.active; t++) sys.update(f, chunks, 0.02);
  const a = [52, 58, 64, 70, 76].map((z) => stepFaceAngle(f, z, top)).sort((p, q) => p - q);
  return a[Math.floor(a.length / 2)];
}

describe('崩落', () => {
  /**
   * 本命。企画の中心的な判断 (岩を狙って遠回りするか、軟弱層で用地を食うか) は
   * この 4 つの角度そのものなので、実測値を数値で固定する。
   * 目視では「なんとなく寝た」としか言えない。
   *
   * 実測 (高さ 6 m・傾き 81 度の法面が静止するまで):
   *   岩 78 度 → 80.5 / 土 34 度 → 29.8 / 軟弱 26 度 → 23.7 / 軟弱・水位下 18 度 → 18.9
   *
   * 中間の角度で 4〜5 度ほど寝すぎるのは、法尻から法肩までの通しで測っているため。
   * 崩れた土砂が法尻に薄く広がって裾を伸ばすぶん、通しの角度は本来の法面より
   * 緩く出る。法面の上半分だけで測る手もあるが、法肩の後退が階段状に進む途中を
   * 拾ってしまい ±12 度も振れるので、通しのほうが安定した物差しになる。
   */
  it('地質ごとの安息角に収束する', () => {
    const cases: [string, Geo, number, number][] = [
      ['岩', Geo.Rock, SURFACE_Y, REPOSE_DEG[Geo.Rock]],
      ['土', Geo.Soil, SURFACE_Y, REPOSE_DEG[Geo.Soil]],
      ['軟弱層', Geo.Weak, SURFACE_Y, REPOSE_DEG[Geo.Weak]],
      // 水位より下は飽和して寝る
      ['軟弱・水位下', Geo.Weak, WATER_TABLE_Y - 1,
        REPOSE_DEG[Geo.Weak] - REPOSE_SATURATED_DROP],
    ];
    const got: Record<string, number> = {};
    for (const [name, geo, top, target] of cases) {
      const a = settleStep(geo, top);
      got[name] = a;
      // 掘った直後は 81 度。そこから目標の ±6 度に入ること。
      expect(Math.abs(a - target), `${name}: ${a.toFixed(1)}° (目標 ${target}°)`)
        .toBeLessThan(6);
    }
    // 順序も固定する。ここが入れ替わると判断が丸ごと逆になる。
    expect(got['岩']).toBeGreaterThan(got['土']);
    expect(got['土']).toBeGreaterThan(got['軟弱層']);
    expect(got['軟弱層']).toBeGreaterThan(got['軟弱・水位下']);
  });

  it('土の切土は安息角まで寝る', () => {
    const f = buildField(Geo.Soil);
    const sys = new ReposeSystem();
    const X = 60;

    digTrench(f, X);
    // 掘った直後は安息角より明らかに急なはず (そうでないと試験にならない)
    const before = faceAngle(f, X, 32)!;
    expect(before).toBeGreaterThan(REPOSE_DEG[Geo.Soil] + 12);

    sys.seedFromEdit([X - 6, 0, 14], [X + 6, SURFACE_Y + 2, 50]);
    expect(settle(sys, f)).toBeGreaterThan(0);

    // 法面が寝ていること。寝すぎ (掘った所が全部埋まる) も困るので下限も押さえる。
    //
    // 段差の試験より緩い上限にしてある。溝は崩れた土砂が自分の中に溜まって
    // 底が上がるので、最後には高さ 1.5 m 程度の短い法面が残る。判定は
    // 1 歩 (2.2 m) ぶんの平均勾配で見ているから、それより背の低い法面は
    // 局所的に 45 度あっても「崩れない」と判定される。これは意図した挙動で、
    // 現実にも背の低い切土は立つ。角度そのものは段差の試験のほうで押さえている。
    const angles = [26, 29, 32, 35, 38].map((z) => faceAngle(f, X, z));
    for (const a of angles) expect(a).not.toBeNull();
    const sorted = angles.map((a) => a!).sort((p, q) => p - q);
    const median = sorted[Math.floor(sorted.length / 2)];
    expect(median).toBeLessThan(REPOSE_DEG[Geo.Soil] + 6);
    expect(median).toBeGreaterThan(REPOSE_DEG[Geo.Soil] - 14);
    // 掘った直後 (48 度) から確実に寝ていること。
    // 断面によっては高さ 2 m 級の急な段が残る。その段の前後 2.2 m の平均勾配は
    // 安息角を下回っているので、判定としては正しく「安定」と見ている。
    expect(median).toBeLessThan(before - 8);
  });

  it('岩は立ったまま', () => {
    const f = buildField(Geo.Rock);
    const sys = new ReposeSystem();
    const X = 60;

    digTrench(f, X);
    const before = faceAngle(f, X, 32)!;

    sys.seedFromEdit([X - 6, 0, 14], [X + 6, SURFACE_Y + 2, 50]);
    settle(sys, f);

    const after = faceAngle(f, X, 32)!;
    // 岩の安息角 (78 度) は掘った直後の法面より緩いこともあるので、
    // 「1 mm も動かない」ではなく「ほとんど寝ない」で押さえる
    expect(after).toBeGreaterThan(before - 5);
    expect(sys.movedTotal).toBeLessThan(10);
  });

  it('ブラシで掘った切土も地質の順に崩れる', () => {
    // 角度そのものは段差の試験で押さえてある。ここは「実際にブラシで掘った形でも
    // 地質の差が出るか」を見る。溝は浅くて法面が短いので、角度は ±10 度も振れて
    // 物差しにならない。動いた土量なら安定して差が出る。
    const moved: Record<string, number> = {};
    for (const [name, geo] of [
      ['rock', Geo.Rock], ['soil', Geo.Soil], ['weak', Geo.Weak],
    ] as const) {
      const f = buildField(geo);
      const sys = new ReposeSystem();
      const X = 60;
      digTrench(f, X);
      sys.seedFromEdit([X - 6, 0, 14], [X + 6, SURFACE_Y + 2, 50]);
      settle(sys, f);
      moved[name] = sys.movedTotal;
    }
    // 企画の中心的な判断 (岩で遠回りか、軟弱層で用地を食うか) がこの順序で決まる
    expect(moved.rock).toBeLessThan(10);          // 岩はほぼ動かない
    expect(moved.soil).toBeGreaterThan(moved.rock * 5);
    expect(moved.weak).toBeGreaterThan(moved.soil);
  });

  it('体積が保存する (削った量 ≒ 積んだ量)', () => {
    const f = buildField(Geo.Soil);
    const sys = new ReposeSystem();
    const X = 60;
    digTrench(f, X);
    sys.seedFromEdit([X - 6, 0, 14], [X + 6, SURFACE_Y + 2, 50]);
    settle(sys, f);

    expect(sys.movedTotal).toBeGreaterThan(5);
    // 削った量 = 積んだ量 + まだ置いていない分。これは恒等式なので厳密に合う。
    expect(sys.movedTotal - sys.depositedTotal - sys.debtRemaining).toBeCloseTo(0, 6);
    // そのうえで、置き残しが溜まりっぱなしになっていないこと
    expect(Math.abs(sys.debtRemaining) / sys.movedTotal).toBeLessThan(0.1);
  });

  it('有限の tick で止まる', () => {
    const f = buildField(Geo.Soil);
    const sys = new ReposeSystem();
    const X = 60;
    digTrench(f, X);
    sys.seedFromEdit([X - 6, 0, 14], [X + 6, SURFACE_Y + 2, 50]);
    // ヒステリシスが無いと境界を往復して永久に止まらない。その検出器。
    expect(settle(sys, f)).toBeGreaterThan(0);
  });

  it('伝播は 15 m ほどで打ち切られる', () => {
    const f = new VoxelField();
    const sys = new ReposeSystem();

    // x = 30..74 が 45 度の一様斜面 (土の安息角 34 度より急)。
    // 打ち切りが無ければ、1 点の種から斜面の端まで崩れていく。
    const hAt = (x: number) => Math.max(6, Math.min(50, 50 - (x - 30)));
    for (let k = 0; k < NZ; k++) {
      for (let j = 0; j < NY; j++) {
        for (let i = 0; i < NX; i++) {
          const x = i * CELL;
          const inv = x > 30 && x < 74 ? Math.SQRT1_2 : 1;
          const d = (hAt(x) - j * CELL) * inv;
          f.density[f.idx(i, j, k)] = Math.max(-8, Math.min(8, d));
          f.material[f.idx(i, j, k)] = Geo.Soil;
        }
      }
    }

    // 斜面の下のほうに 1 点だけ種を撒く。伝播は上流 (-x) へ向かう。
    const SEED_X = 68;
    sys.seedAround(new THREE.Vector3(SEED_X, 0, 64), 0.1);
    settle(sys, f, 8000);

    // 種の近くは実際に動いていること (試験が空振りしていないことの確認)。
    // 削りと埋めを同じ球の中で相殺させているので、1 点あたりの高さの変化は
    // 大きくない。上流の未変化ぶんとの比で見る。
    const near = Math.abs(surfaceY(f, SEED_X - 4, 64)! - hAt(SEED_X - 4));
    expect(near).toBeGreaterThan(0.15);

    // 15 m + 影響半径を大きく超えた上流は動いていないこと
    for (const x of [SEED_X - 24, SEED_X - 30, SEED_X - 36]) {
      const y = surfaceY(f, x, 64);
      expect(y).not.toBeNull();
      const far = Math.abs(y! - hAt(x));
      expect(far).toBeLessThan(0.4);
      expect(far).toBeLessThan(near * 0.6);
    }
  });
});
