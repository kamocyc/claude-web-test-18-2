import * as THREE from 'three';
import { CELL, WORLD_X, WORLD_Y, WORLD_Z } from './config';
import type { VoxelField } from './VoxelField';

/**
 * 密度場そのものへのレイキャスト。
 *
 * 200 個近いチャンクメッシュに THREE.Raycaster を向けるのは無駄が多いうえ、
 * 掘った直後の (まだ再メッシュされていない) 形には当たらない。
 * 場を直接歩けば常に最新の形に当たるし、桁違いに速い。
 */

export interface RayHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
}

/** 三線形場の勾配。正 = 固体なので、外向き法線は -normalize(grad)。 */
export function gradientAt(field: VoxelField, x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
  const h = CELL;
  out.set(
    field.sample(x + h, y, z) - field.sample(x - h, y, z),
    field.sample(x, y + h, z) - field.sample(x, y - h, z),
    field.sample(x, y, z + h) - field.sample(x, y, z - h),
  );
  return out;
}

export function surfaceNormalAt(field: VoxelField, x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
  gradientAt(field, x, y, z, out);
  const len = out.length();
  if (len < 1e-9) return out.set(0, 1, 0);
  return out.multiplyScalar(-1 / len);
}

/** レイとワールド AABB の交差区間。外れていれば null。 */
function boxRange(o: THREE.Vector3, d: THREE.Vector3): [number, number] | null {
  let t0 = 0;
  let t1 = Infinity;
  const lo = [0, 0, 0];
  const hi = [WORLD_X, WORLD_Y, WORLD_Z];
  const oc = [o.x, o.y, o.z];
  const dc = [d.x, d.y, d.z];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(dc[a]) < 1e-9) {
      if (oc[a] < lo[a] || oc[a] > hi[a]) return null;
      continue;
    }
    const inv = 1 / dc[a];
    let ta = (lo[a] - oc[a]) * inv;
    let tb = (hi[a] - oc[a]) * inv;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return null;
  }
  return [t0, t1];
}

const _p = new THREE.Vector3();

/**
 * 最初に固体へ入る点を返す。
 * 半セル刻みで歩いて符号の変化を見つけ、二分で詰める。
 * 100 m のレイでも 400 歩程度なので毎フレーム投げてよい。
 */
export function raycastTerrain(
  field: VoxelField,
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  maxDist = 400,
): RayHit | null {
  const range = boxRange(origin, dir);
  if (!range) return null;
  const [tStart, tEndRaw] = range;
  const tEnd = Math.min(tEndRaw, maxDist);
  if (tStart > tEnd) return null;

  const step = CELL * 0.5;
  let tPrev = tStart;
  _p.copy(dir).multiplyScalar(tPrev).add(origin);
  let dPrev = field.sample(_p.x, _p.y, _p.z);
  if (dPrev > 0) {
    // 開始点が既に地中。カメラが地中に入っている場合など。
    const hit: RayHit = {
      point: _p.clone(),
      normal: surfaceNormalAt(field, _p.x, _p.y, _p.z, new THREE.Vector3()),
      distance: tPrev,
    };
    return hit;
  }

  for (let t = tStart + step; t <= tEnd; t += step) {
    _p.copy(dir).multiplyScalar(t).add(origin);
    const d = field.sample(_p.x, _p.y, _p.z);
    if (d > 0) {
      // 二分で交点を詰める
      let lo = tPrev;
      let hi = t;
      for (let it = 0; it < 12; it++) {
        const mid = (lo + hi) * 0.5;
        _p.copy(dir).multiplyScalar(mid).add(origin);
        if (field.sample(_p.x, _p.y, _p.z) > 0) hi = mid;
        else lo = mid;
      }
      _p.copy(dir).multiplyScalar(hi).add(origin);
      return {
        point: _p.clone(),
        normal: surfaceNormalAt(field, _p.x, _p.y, _p.z, new THREE.Vector3()),
        distance: hi,
      };
    }
    tPrev = t;
    dPrev = d;
  }
  void dPrev;
  return null;
}

/**
 * 坑道の真上にある地山の厚み (土被り) を測る。
 *
 * 呼び出し側は坑道の**天端** (中心 + 半径) を y に渡す。
 * ただしそこを起点にいきなり測ると、まだ坑道の中に入っていることがある。
 * スムーズ差のブレンド幅ぶん、空洞が名目半径より少し広がるためで、
 * 素朴に測るとすぐ空気に当たって土被り 0 と誤判定し、
 * ちゃんと地中を掘っていてもトンネルとして登録されなくなる。
 *
 * そこで 3 段階で測る:
 *   1. 残っている空洞を上へ抜ける
 *      (抜けきる前に maxVoid を超えたら、空に開いている = 土被り 0)
 *   2. 最初に固体に当たった高さを地山の下端とする
 *   3. 固体が続く間を数える。その厚みが土被り
 *
 * 起点が最初から固体なら 1 は素通りするので、まだ掘っていない地山にも
 * そのまま使える。掘る前の下見と掘った後の判定が同じ物差しになるのが大事で、
 * ここがずれると「下見ではトンネルと言っていたのに掘ったらならない」が起きる。
 *
 * @param maxVoid 天端から上に許容する空洞の高さ [m]。ブレンド幅の食い込みを
 *                吸収するためのもので、これを超えたら空に開いているとみなす。
 */
export function overburdenAt(
  field: VoxelField,
  x: number, y: number, z: number,
  maxVoid: number,
  maxUp = 80,
): number {
  const step = CELL * 0.5;

  // 1) 空洞を抜ける
  let t = 0;
  while (t <= maxVoid) {
    if (y + t > WORLD_Y) return 0;
    if (field.sample(x, y + t, z) > 0) break;
    t += step;
  }
  if (t > maxVoid) return 0; // 天井が無い = 空に開いている

  // 2) 地山の下端
  const base = t;

  // 3) 固体が続く厚みを測る
  while (t < maxUp) {
    t += step;
    if (y + t > WORLD_Y) return t - base;
    if (field.sample(x, y + t, z) <= 0) {
      // 二分で詰める
      let lo = t - step;
      let hi = t;
      for (let it = 0; it < 10; it++) {
        const mid = (lo + hi) * 0.5;
        if (field.sample(x, y + mid, z) <= 0) hi = mid;
        else lo = mid;
      }
      return hi - base;
    }
  }
  return maxUp - base;
}
