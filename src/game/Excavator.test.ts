import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { Excavator } from './Excavator';
import { TunnelNetwork } from './Tunnel';
import { VoxelField } from '../terrain/VoxelField';
import { HeightIndex, colIdx } from '../terrain/HeightIndex';
import { ReposeSystem } from '../terrain/Repose';
import { raycastTerrain, overburdenAt } from '../terrain/raymarch';
import { applyCapsule } from '../terrain/Edit';
import { CELL, NX, NY, NZ, Geo } from '../terrain/config';
import type { ChunkManager } from '../terrain/ChunkManager';

/**
 * 斜面にトンネルを掘る、を通しで回す。
 *
 * 安息角を入れた直後、これができなくなっていた。原因は 2 つとも
 * 「掘削と崩落のつなぎ方」で、崩落の計算そのものは正しかったので、
 * Repose の単体テスト (等高線に沿った溝を 1 回掘って整定する) では
 * まったく引っかからなかった。**毎フレーム掘って毎フレーム崩す**
 * ループを回さないと出ない類のバグなので、ここで押さえる。
 *
 *  1. ゆるませる厚みを編集 AABB の深さで決めていたので、掘っていない
 *     上流の斜面まで一斉にゆるんで坑口へ流れ込んだ
 *  2. 埋め戻されると狙点が手前へ戻り、ヘッドが山から後退しながら掘って、
 *     法尻の崩積土を削り返して崩落を呼び直した
 */

const chunks = { markDirtyByAABB(): void {} } as unknown as ChunkManager;

/** x が大きいほど低い 30 度の斜面。地下水位 (17.5 m) より上に置く。 */
const SLOPE_T = Math.tan((30 * Math.PI) / 180);
const surf = (x: number): number => Math.max(22, 58 - SLOPE_T * (x - 20));

function buildSlope(): VoxelField {
  const f = new VoxelField();
  for (let k = 0; k < NZ; k++) {
    for (let i = 0; i < NX; i++) {
      const hh = surf(i * CELL);
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

interface BoreResult {
  /** 最終的な土被り [m]。 */
  cover: number;
  /** ヘッドが山側へ進んだ距離 [m] (x が減った量)。 */
  penetration: number;
  /** 途中でいちばん大きく後退した量 [m]。 */
  worstRetreat: number;
  /** 掘削体積 [m^3]。 */
  dug: number;
  /** 崩落で動いた土量の合計 [m^3]。 */
  moved: number;
  /** 記録されたトンネル区間の数。 */
  segments: number;
  index: HeightIndex;
  before: Float64Array;
  portalX: number;
}

/** 斜面へ向かって FRAMES ぶん掘り続ける。毎フレーム整定する。 */
function bore(frames = 600): BoreResult {
  const field = buildSlope();
  const index = new HeightIndex();
  index.measureAll(field);
  const before = Float64Array.from(index.heights);
  const repose = new ReposeSystem(index);
  const excavator = new Excavator();
  const tunnels = new TunnelNetwork();

  // 谷側から山腹をやや見上げる向き。山側 (-x) へ、少しだけ下向きに掘る。
  const origin = new THREE.Vector3(104, 40, 64);
  const aim = new THREE.Vector3(60, surf(60) - 1, 64);
  const rayDir = aim.clone().sub(origin).normalize();

  const first = raycastTerrain(field, origin, rayDir);
  expect(first).not.toBeNull();
  const portalX = first!.point.x;
  excavator.begin(first!, rayDir);

  const dt = 1 / 60;
  let dug = 0;
  let moved = 0;
  let deepestX = excavator.headPosition.x;
  let worstRetreat = 0;

  for (let n = 0; n < frames; n++) {
    const hit = raycastTerrain(field, origin, rayDir);
    const res = excavator.update(field, chunks, dt, hit, rayDir);
    if (res && res.changed) {
      dug += res.totalVolume;
      tunnels.markDirtyByAABB(res.min[0], res.min[1], res.min[2], res.max[0], res.max[1], res.max[2]);
      tunnels.recordBore(field, excavator.headPosition, rayDir, excavator.radius);
      repose.seedFromEdit(field, res);
    }
    if (repose.update(field, chunks, 4)) moved += repose.movedThisSlide;

    const hx = excavator.headPosition.x;
    if (hx < deepestX) deepestX = hx;
    else worstRetreat = Math.max(worstRetreat, hx - deepestX);
  }
  tunnels.endBore();

  const head = excavator.headPosition;
  return {
    cover: overburdenAt(field, head.x, head.y + excavator.radius, head.z, excavator.radius),
    penetration: portalX - deepestX,
    worstRetreat,
    dug,
    moved,
    segments: tunnels.status().tunnels,
    index, before, portalX,
  };
}

describe('斜面にトンネルを掘る', () => {
  const r = bore();

  it('掘り進める — 崩落で押し戻されない', () => {
    // 30 度の斜面では、土被りがつくまで数 m 山側へ入る必要がある
    expect(r.penetration).toBeGreaterThan(5);
    // 埋め戻されて狙点が手前へ戻っても、ヘッドは山から押し出されない
    expect(r.worstRetreat).toBeLessThan(1.0);
  });

  it('トンネルとして成立する', () => {
    // COVER_TUNNEL_MIN * radius = 1.2 * 2.6 = 3.12 m
    expect(r.cover).toBeGreaterThan(3.12);
    expect(r.segments).toBeGreaterThan(0);
  });

  it('崩れる範囲が有限で止まる', () => {
    // 坑道は z = 64 に沿って掘っている。坑口の切り欠き (幅 5.2 m) が
    // 深さぶん寝るので、横へは 2.6 + 深さ/tan(34 度) ≒ 10 m まで動く。
    // その外は掘っていない原地盤なので動かないこと。
    // ゆるみ厚を編集 AABB の深さで決めていたときは、際限なく広がっていた。
    let worst = 0;
    for (let k = 2; k < NZ - 2; k++) {
      if (Math.abs(k * CELL - 64) <= 14) continue;
      for (let i = 2; i < NX - 2; i++) {
        const o = colIdx(i, k);
        worst = Math.max(worst, Math.abs(r.index.heights[o] - r.before[o]));
      }
    }
    expect(worst).toBeLessThan(0.02);
  });

  it('動いた土量が掘った量とかけ離れない', () => {
    expect(r.dug).toBeGreaterThan(20);
    // AABB 由来のゆるみでは掘削量の 7 倍が armed になっていた。
    // 実測の地表低下量で測れば同じ桁に収まる。
    expect(r.moved).toBeLessThan(r.dug * 3);
  });
});

describe('土被りの下', () => {
  it('地表が動かない掘削は地山をゆるませない', () => {
    const field = buildSlope();
    const index = new HeightIndex();
    index.measureAll(field);
    const repose = new ReposeSystem(index);

    // 地表下 6 m を等高線に沿って掘る (坑道)。地表は動かない。
    const TX = 64;
    const TY = surf(TX) - 6;
    const res = applyCapsule(field, chunks, TX, TY, 30, TX, TY, 98, 2.6, 'dig', 0.5, Geo.Soil);
    expect(res.changed).toBe(true);

    repose.seedFromEdit(field, res);
    for (let k = 55; k < 200; k++) {
      for (let i = 118; i < 140; i++) {
        expect(index.loose[colIdx(i, k)]).toBe(0);
      }
    }
  });
});
