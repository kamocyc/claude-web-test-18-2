/**
 * 符号付き距離場の基本演算。
 *
 * 符号の規約: **正 = 固体 (地面の中)、負 = 空気**、等値面は d = 0。
 * 値の単位はおおむねメートル (真の距離場ではなく近似)。
 *
 * この規約での CSG:
 *   union(a,b)     = max(a,b)
 *   intersect(a,b) = min(a,b)
 *   subtract(a,b)  = min(a, -b)   // a から b を削り取る
 */

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * 多項式スムーズ min (iq)。k はブレンド幅 [m]。
 * 指数版より安く、距離の歪みも小さい。
 */
export function smin(a: number, b: number, k: number): number {
  if (k <= 0) return a < b ? a : b;
  const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
  return mix(b, a, h) - k * h * (1 - h);
}

/** 多項式スムーズ max。 */
export function smax(a: number, b: number, k: number): number {
  return -smin(-a, -b, k);
}

/**
 * 掘る: 固体場 d から、固体場 solid を滑らかに削り取る。
 * 引数の solid は「正 = 固体」の規約であることに注意。
 */
export function smoothSubtract(d: number, solid: number, k: number): number {
  return smin(d, -solid, k);
}

/** 盛る: 固体場 d に、固体場 solid を滑らかに足す。 */
export function smoothUnion(d: number, solid: number, k: number): number {
  return smax(d, solid, k);
}

/**
 * カプセル (線分 + 半径) の固体場。正 = 内側。
 * ブラシの基本形状。フレーム間をスイープするのでカーブが途切れない。
 */
export function capsuleSolid(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  r: number,
): number {
  const pax = px - ax;
  const pay = py - ay;
  const paz = pz - az;
  const bax = bx - ax;
  const bay = by - ay;
  const baz = bz - az;
  const baLen2 = bax * bax + bay * bay + baz * baz;
  const h = baLen2 > 1e-12 ? clamp((pax * bax + pay * bay + paz * baz) / baLen2, 0, 1) : 0;
  const dx = pax - bax * h;
  const dy = pay - bay * h;
  const dz = paz - baz * h;
  return r - Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** 球の固体場。正 = 内側。 */
export function sphereSolid(
  px: number, py: number, pz: number,
  cx: number, cy: number, cz: number,
  r: number,
): number {
  const dx = px - cx;
  const dy = py - cy;
  const dz = pz - cz;
  return r - Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * 密度からセルの固体占有率 [0,1] を求める。
 * 掘削体積を格子より細かい精度で積算するために使う。
 * 45 度の切り込みがセルの半分だけ課金される、という挙動になる。
 */
export function occupancy(d: number, cell: number): number {
  return clamp(0.5 + d / cell, 0, 1);
}
