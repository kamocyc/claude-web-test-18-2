import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { VoxelField } from '../terrain/VoxelField';
import { generate } from '../terrain/Generator';
import { applyCapsule } from '../terrain/Edit';
import { CELL, NX, NY, NZ, Geo, WORLD_X, WORLD_Z } from '../terrain/config';
import type { ChunkManager } from '../terrain/ChunkManager';
import { mulberry32 } from '../util/rng';
import {
  Player, BODY_HEIGHT, BODY_RADIUS, JUMP_SPEED, STEP_UP, bodyBlocked, type MoveInput,
} from './Player';

/**
 * 一人称の身体。
 *
 * 押さえたいのは「気持ちよさ」ではなく**成立していること**。
 *   1. どのフレームでも身体が固体の中に居ない (これが本命)
 *   2. 自分で掘った坑道の中を歩ける (高さ場ではなく密度場に当てている証明)
 *   3. 足元を掘っても崩落に埋まっても、詰まずに地表へ出られる
 *   4. 登れる斜面の限界が工法の角度と噛み合っている
 */

const chunks = { markDirtyByAABB(): void {} } as unknown as ChunkManager;

/** 高さ関数から場を作る。密度は勾配で正規化して距離らしさを保つ。 */
function buildField(h: (x: number, z: number) => number): VoxelField {
  const f = new VoxelField();
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
      let idx = i + k * f.strideZ;
      for (let j = 0; j < NY; j++, idx += f.strideY) {
        let d = (hs[o] - j * CELL) / norm;
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

const still: MoveInput = { forward: 0, strafe: 0, jump: false, run: false };
const ahead: MoveInput = { forward: 1, strafe: 0, jump: false, run: false };

/** 身体が固体と重なっていないか。テストの唯一の合否条件。 */
function clear(field: VoxelField, p: Player): boolean {
  return !bodyBlocked(field, p.pos.x, p.pos.y, p.pos.z);
}

function run(field: VoxelField, p: Player, seconds: number, input: MoveInput): void {
  for (let n = 0; n < Math.round(seconds * 60); n++) p.update(field, 1 / 60, input);
}

describe('立つ・落ちる', () => {
  it('平地に落とすと地表で止まり、接地する', () => {
    const field = buildField(() => 20);
    const p = new Player();
    p.pos.set(30, 30, 30);
    run(field, p, 3, still);
    expect(p.pos.y).toBeCloseTo(20, 1);
    expect(p.onGround).toBe(true);
    expect(Math.abs(p.vel.y)).toBeLessThan(0.1);
  });

  it('placeAt は最上面に立たせる', () => {
    const field = buildField((x) => (x < 40 ? 30 : 12));
    const p = new Player();
    p.placeAt(field, 20, 30);
    expect(p.pos.y).toBeCloseTo(30, 1);
    expect(clear(field, p)).toBe(true);
  });

  it('ジャンプの到達高さが庇 (ROOF_KEEP = 1 m) を越える', () => {
    const field = buildField(() => 20);
    const p = new Player();
    p.placeAt(field, 30, 30);
    const y0 = p.pos.y;
    p.update(field, 1 / 60, { forward: 0, strafe: 0, jump: true, run: false });
    let top = p.pos.y;
    for (let n = 0; n < 120; n++) {
      p.update(field, 1 / 60, still);
      top = Math.max(top, p.pos.y);
    }
    // v^2 / 2g = 6.6^2 / 44 = 0.99 m。刻みぶんの取りこぼしを見て 0.9 m。
    expect(top - y0).toBeGreaterThan(0.9);
    expect(JUMP_SPEED ** 2 / (2 * 22)).toBeGreaterThan(0.95);
    expect(p.pos.y).toBeCloseTo(y0, 1);
  });
});

describe('段差と斜面', () => {
  it('0.5 m の段は歩いて越えられる', () => {
    const field = buildField((x) => (x > 30 ? 20.5 : 20));
    const p = new Player();
    p.placeAt(field, 26, 30);
    p.yaw = -Math.PI / 2; // yaw 0 は -Z 向き。-90 度で +X を向く
    run(field, p, 3, ahead);
    expect(p.pos.x).toBeGreaterThan(32);
    expect(p.pos.y).toBeCloseTo(20.5, 1);
  });

  it('3 m の壁は越えられない', () => {
    const field = buildField((x) => (x > 30 ? 23 : 20));
    const p = new Player();
    p.placeAt(field, 26, 30);
    p.yaw = -Math.PI / 2;
    run(field, p, 3, ahead);
    expect(p.pos.x).toBeLessThan(30);
    expect(p.pos.y).toBeCloseTo(20, 1);
    expect(clear(field, p)).toBe(true);
  });

  it('30 度の斜面は登れて、70 度の斜面は登れない', () => {
    const walk = (deg: number): number => {
      const t = Math.tan((deg * Math.PI) / 180);
      const field = buildField((x) => 20 + Math.max(0, x - 30) * t);
      const p = new Player();
      p.placeAt(field, 26, 30);
      p.yaw = -Math.PI / 2;
      run(field, p, 4, ahead);
      return p.pos.y - 20;
    };
    // 安息角 (34 度) と種子吹付 (45 度) の側は登れる
    expect(walk(30)).toBeGreaterThan(3);
    // 法枠 (65 度)・擁壁 (88 度)・原地盤 (85 度) の側は登れない
    expect(walk(70)).toBeLessThan(0.7);
  });

  it('段差の上限 STEP_UP が 1 セルより大きい (書き戻しの段を跳ばずに歩ける)', () => {
    expect(STEP_UP).toBeGreaterThan(CELL);
  });
});

describe('掘った所を歩く', () => {
  it('自分で掘った坑道の中を歩き抜ける', () => {
    // 高さ 40 m の地山に、標高 20 m の水平な坑道を掘る。
    // 高さ場に当てる実装なら、ここで山の上 (40 m) へ弾き出される。
    const field = buildField(() => 40);
    applyCapsule(field, chunks, 20, 20, 40, 60, 20, 40, 2.6, 'dig', 0.5, Geo.Soil);
    const p = new Player();
    p.pos.set(24, 18.5, 40);
    p.yaw = -Math.PI / 2;
    run(field, p, 1, still);
    expect(p.pos.y).toBeLessThan(22);
    expect(p.onGround).toBe(true);
    run(field, p, 4, ahead);
    // 坑道に沿って進んでいて、天井を抜けて山の上には出ていない
    expect(p.pos.x).toBeGreaterThan(35);
    expect(p.pos.y).toBeLessThan(24);
    expect(clear(field, p)).toBe(true);
  });

  it('足元を掘り抜くと落ちて、底で止まり、埋まらない', () => {
    const field = buildField(() => 30);
    const p = new Player();
    p.placeAt(field, 40, 40);
    // 立っている真下を縦に掘る
    applyCapsule(field, chunks, 40, 30, 40, 40, 18, 40, 3.0, 'dig', 0.5, Geo.Soil);
    run(field, p, 4, still);
    expect(p.pos.y).toBeLessThan(22);
    expect(p.onGround).toBe(true);
    expect(clear(field, p)).toBe(true);
  });

  it('固体の真ん中に埋めても resolve で地表へ出られる', () => {
    const field = buildField(() => 30);
    const p = new Player();
    p.pos.set(40, 12, 40); // 18 m の土被りの下
    p.resolve(field);
    expect(clear(field, p)).toBe(true);
    expect(p.pos.y).toBeGreaterThan(29);
    expect(p.pos.y).toBeLessThan(31);
  });
});

describe('壊れないこと', () => {
  it('実地形の上を 600 フレーム歩き回っても、体の中心と目が地面の中に入らない', () => {
    const field = new VoxelField();
    generate(field);
    const p = new Player();
    p.placeAt(field, WORLD_X * 0.5, WORLD_Z * 0.5);
    const rnd = mulberry32(7);
    const input: MoveInput = { forward: 1, strafe: 0, jump: false, run: true };
    for (let n = 0; n < 600; n++) {
      if (n % 30 === 0) {
        p.yaw += (rnd() - 0.5) * 3;
        input.forward = rnd() < 0.85 ? 1 : -1;
        input.strafe = rnd() < 0.3 ? 1 : 0;
        input.jump = rnd() < 0.2;
      }
      p.update(field, 1 / 60, input);
      // 縁が急な法面へ一瞬刺さるのは許す (押し出しが下側へ流す)。
      // 詰みになるのは中心が埋まったときだけで、そこは絶対に許さない。
      // 目が地中に入るのも駄目 (壁の内側が見えてしまう)。
      expect(field.sample(p.pos.x, p.pos.y + BODY_HEIGHT * 0.5, p.pos.z)).toBeLessThanOrEqual(0);
      expect(field.sample(p.pos.x, p.pos.y + 1.62, p.pos.z)).toBeLessThanOrEqual(0);
    }
    // 最後は立てる所に落ち着いている
    for (let n = 0; n < 120; n++) p.update(field, 1 / 60, still);
    expect(clear(field, p)).toBe(true);
    expect(p.onGround).toBe(true);
  });

  it('ワールドの外へは出ない (外周は密度 -1 の壁なので距離では止まれない)', () => {
    const field = buildField(() => 20);
    const p = new Player();
    p.placeAt(field, 4, 4);
    p.yaw = Math.PI / 2; // -X へ
    run(field, p, 6, { forward: 1, strafe: 0, jump: false, run: true });
    expect(p.pos.x).toBeGreaterThan(0.5);
    expect(p.pos.z).toBeGreaterThan(0.5);
    expect(p.pos.y).toBeGreaterThan(10);
  });

  it('同じ入力を二度流すと同じ位置に来る (決定的)', () => {
    const field = buildField((x, z) => 20 + Math.sin(x * 0.1) * 2 + Math.cos(z * 0.07) * 3);
    const walk = (): THREE.Vector3 => {
      const p = new Player();
      p.placeAt(field, 40, 40);
      p.yaw = 0.7;
      run(field, p, 3, { forward: 1, strafe: 0.5, jump: false, run: false });
      return p.pos.clone();
    };
    const a = walk();
    const b = walk();
    expect(a.x).toBe(b.x);
    expect(a.y).toBe(b.y);
    expect(a.z).toBe(b.z);
  });

  it('身体の太さがカメラの near (0.2 m) より大きい', () => {
    // 壁に押し付けたときに近接クリップで壁の中が見えないための下限
    expect(BODY_RADIUS).toBeGreaterThan(0.2);
    expect(BODY_HEIGHT).toBeGreaterThan(1.6);
  });
});
