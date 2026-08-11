import { CELL, GEO_COUNT } from '../config';
import { occupancy } from '../FieldMath';
import type { VoxelField } from '../VoxelField';

/**
 * Naive Surface Nets。
 *
 * セルごとに頂点を 1 個、そのセル内のエッジ交点の重心に置き、
 * 符号が変わるノード辺の周りの 4 セルを四角形で結ぶ。
 * Marching Cubes と違って針状三角形が出ず、格子由来の模様も残りにくい。
 *
 * ---- 継ぎ目をゼロにする仕掛け ----
 * チャンク (原点セル o、一辺 S) が担当するのは:
 *   - 頂点:  セル [o, o+S] (両端含む。S+1 個。正側に 1 セルはみ出す)
 *   - 四角形: ノード n の各成分が [o+1, o+S] の範囲にある辺
 * こうすると全チャンクの和が全ノード辺をちょうど 1 回ずつ覆う (穴も重複も無い)。
 * はみ出したセルの頂点は隣チャンクも計算するが、入力も演算順序も同一なので
 * ビット単位で同じ値になり、割れも法線の段差も生じない。
 *
 * ---- 法線 ----
 * 頂点位置で密度を中心差分するのではなく、**ノードで勾配を求めてから
 * 三線形補間する**。三線形場の勾配はセル境界で不連続なので、頂点位置で
 * 直接差分すると格子状の陰影の筋が出てしまう。ノード勾配の補間なら
 * 連続で、しかもチャンクをまたいでも決定的。
 */

export interface ChunkMesh {
  /** チャンク原点からの相対位置 */
  positions: Float32Array;
  normals: Float32Array;
  /** vec3: (土, 岩, 軟弱) の重み。合計 1。 */
  matWeights: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
}

// 立方体の頂点番号: c = dx | dy<<1 | dz<<2
const CORNER_DX = [0, 1, 0, 1, 0, 1, 0, 1];
const CORNER_DY = [0, 0, 1, 1, 0, 0, 1, 1];
const CORNER_DZ = [0, 0, 0, 0, 1, 1, 1, 1];

// 12 辺 (頂点番号の組)
const EDGES: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [2, 3], [4, 5], [6, 7], // X
  [0, 2], [1, 3], [4, 6], [5, 7], // Y
  [0, 4], [1, 5], [2, 6], [3, 7], // Z
];

/** 使い回すスクラッチ領域。チャンクサイズごとにキャッシュする。 */
interface Scratch {
  S: number;
  W: number; // ウィンドウのノード数 (S+2)
  L: number; // ローカルのセル数 (S+1)
  den: Float32Array;
  mat: Uint8Array;
  grad: Float32Array; // W^3 * 3
  gradDone: Uint8Array; // W^3
  cellVert: Int32Array; // L^3
  positions: Float32Array;
  normals: Float32Array;
  matWeights: Float32Array;
  indices: Uint32Array;
}

let scratch: Scratch | null = null;

function getScratch(S: number): Scratch {
  if (scratch && scratch.S === S) return scratch;
  const W = S + 2;
  const L = S + 1;
  const w3 = W * W * W;
  const l3 = L * L * L;
  scratch = {
    S,
    W,
    L,
    den: new Float32Array(w3),
    mat: new Uint8Array(w3),
    grad: new Float32Array(w3 * 3),
    gradDone: new Uint8Array(w3),
    cellVert: new Int32Array(l3),
    positions: new Float32Array(l3 * 3),
    normals: new Float32Array(l3 * 3),
    matWeights: new Float32Array(l3 * GEO_COUNT),
    // 四角形は最悪でもセル数程度なので、これで十分な余裕がある
    indices: new Uint32Array(l3 * 9),
  };
  return scratch;
}

/**
 * ノード勾配を必要になった時点で計算してメモする。
 * 活性セルは表面付近だけなので、全ノードを先に埋めるより大幅に速い。
 * field から直接読むので、どのチャンクから呼んでも同じ値になる (決定性)。
 */
function cornerGradient(
  s: Scratch,
  field: VoxelField,
  ox: number, oy: number, oz: number,
  li: number, lj: number, lk: number,
  out: Float32Array, outOff: number,
): void {
  const w = s.W;
  const wi = li + lj * w + lk * w * w;
  if (s.gradDone[wi] === 0) {
    const gi = ox + li;
    const gj = oy + lj;
    const gk = oz + lk;
    const inv = 1 / (2 * CELL);
    s.grad[wi * 3] = (field.densityAtNode(gi + 1, gj, gk) - field.densityAtNode(gi - 1, gj, gk)) * inv;
    s.grad[wi * 3 + 1] = (field.densityAtNode(gi, gj + 1, gk) - field.densityAtNode(gi, gj - 1, gk)) * inv;
    s.grad[wi * 3 + 2] = (field.densityAtNode(gi, gj, gk + 1) - field.densityAtNode(gi, gj, gk - 1)) * inv;
    s.gradDone[wi] = 1;
  }
  out[outOff] = s.grad[wi * 3];
  out[outOff + 1] = s.grad[wi * 3 + 1];
  out[outOff + 2] = s.grad[wi * 3 + 2];
}

const cornerD = new Float32Array(8);
const cornerM = new Uint8Array(8);
const cornerG = new Float32Array(24);
const wAccum = new Float32Array(GEO_COUNT);

/**
 * チャンク 1 個をメッシュ化する。表面が無ければ null。
 * @param ox,oy,oz チャンクの原点セル添字
 * @param S チャンクの一辺 [セル]
 */
export function surfaceNets(
  field: VoxelField,
  ox: number, oy: number, oz: number,
  S: number,
): ChunkMesh | null {
  const s = getScratch(S);
  const { W, L, den, mat } = s;

  // --- ノードウィンドウを読む ([o, o+S+1]) ---
  let anySolid = false;
  let anyAir = false;
  let wi = 0;
  for (let lk = 0; lk < W; lk++) {
    for (let lj = 0; lj < W; lj++) {
      for (let li = 0; li < W; li++, wi++) {
        const d = field.densityAtNode(ox + li, oy + lj, oz + lk);
        den[wi] = d;
        mat[wi] = field.materialAtNode(ox + li, oy + lj, oz + lk);
        if (d > 0) anySolid = true;
        else anyAir = true;
      }
    }
  }
  if (!anySolid || !anyAir) return null;

  s.gradDone.fill(0);
  s.cellVert.fill(-1);

  const { positions, normals, matWeights, indices, cellVert } = s;
  let vCount = 0;
  let iCount = 0;

  const wStrideY = W;
  const wStrideZ = W * W;
  const lStrideY = L;
  const lStrideZ = L * L;

  // --- パス 1: 活性セルごとに頂点を 1 個作る ---
  for (let ck = 0; ck < L; ck++) {
    for (let cj = 0; cj < L; cj++) {
      for (let ci = 0; ci < L; ci++) {
        const base = ci + cj * wStrideY + ck * wStrideZ;

        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const o = base + CORNER_DX[c] + CORNER_DY[c] * wStrideY + CORNER_DZ[c] * wStrideZ;
          const d = den[o];
          cornerD[c] = d;
          cornerM[c] = mat[o];
          if (d > 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;

        // エッジ交点の重心 (セルローカル [0,1]^3)
        let px = 0, py = 0, pz = 0, nCross = 0;
        for (let e = 0; e < 12; e++) {
          const a = EDGES[e][0];
          const b = EDGES[e][1];
          const da = cornerD[a];
          const db = cornerD[b];
          if ((da > 0) === (db > 0)) continue;
          const t = da / (da - db);
          px += CORNER_DX[a] + (CORNER_DX[b] - CORNER_DX[a]) * t;
          py += CORNER_DY[a] + (CORNER_DY[b] - CORNER_DY[a]) * t;
          pz += CORNER_DZ[a] + (CORNER_DZ[b] - CORNER_DZ[a]) * t;
          nCross++;
        }
        if (nCross === 0) continue;
        const fx = px / nCross;
        const fy = py / nCross;
        const fz = pz / nCross;

        // --- 法線: ノード勾配を三線形補間 ---
        for (let c = 0; c < 8; c++) {
          cornerGradient(
            s, field, ox, oy, oz,
            ci + CORNER_DX[c], cj + CORNER_DY[c], ck + CORNER_DZ[c],
            cornerG, c * 3,
          );
        }
        let gx = 0, gy = 0, gz = 0;
        for (let c = 0; c < 8; c++) {
          const wx = CORNER_DX[c] ? fx : 1 - fx;
          const wy = CORNER_DY[c] ? fy : 1 - fy;
          const wz = CORNER_DZ[c] ? fz : 1 - fz;
          const w = wx * wy * wz;
          gx += cornerG[c * 3] * w;
          gy += cornerG[c * 3 + 1] * w;
          gz += cornerG[c * 3 + 2] * w;
        }
        // 正 = 固体なので、勾配は固体の内側を向く。外向き法線はその逆。
        let len = Math.sqrt(gx * gx + gy * gy + gz * gz);
        if (len < 1e-9) {
          gx = 0; gy = 1; gz = 0; len = 1;
        }
        const invLen = -1 / len;

        // --- 地質重み: 三線形重み x 固体占有率 ---
        // 空気側の角の地質を数えると、地表の上にある層の色が混ざってしまうので
        // 占有率で重み付けして落とす。境界をまたぐ三角形が自然に混色になる。
        wAccum.fill(0);
        let wTotal = 0;
        for (let c = 0; c < 8; c++) {
          const wx = CORNER_DX[c] ? fx : 1 - fx;
          const wy = CORNER_DY[c] ? fy : 1 - fy;
          const wz = CORNER_DZ[c] ? fz : 1 - fz;
          const w = wx * wy * wz * occupancy(cornerD[c], CELL);
          wAccum[cornerM[c]] += w;
          wTotal += w;
        }
        if (wTotal < 1e-6) {
          // すべて空気寄りなら三線形重みだけで決める
          for (let c = 0; c < 8; c++) {
            const wx = CORNER_DX[c] ? fx : 1 - fx;
            const wy = CORNER_DY[c] ? fy : 1 - fy;
            const wz = CORNER_DZ[c] ? fz : 1 - fz;
            const w = wx * wy * wz;
            wAccum[cornerM[c]] += w;
            wTotal += w;
          }
        }

        const v3 = vCount * 3;
        positions[v3] = (ci + fx) * CELL;
        positions[v3 + 1] = (cj + fy) * CELL;
        positions[v3 + 2] = (ck + fz) * CELL;
        normals[v3] = gx * invLen;
        normals[v3 + 1] = gy * invLen;
        normals[v3 + 2] = gz * invLen;

        const vm = vCount * GEO_COUNT;
        const invW = 1 / wTotal;
        for (let g = 0; g < GEO_COUNT; g++) matWeights[vm + g] = wAccum[g] * invW;

        cellVert[ci + cj * lStrideY + ck * lStrideZ] = vCount;
        vCount++;
      }
    }
  }

  if (vCount === 0) return null;

  // --- パス 2: 符号が変わるノード辺ごとに四角形を張る ---
  // ノードの各成分が [1, S] のものだけを担当する (チャンク間で重複させない)
  const emitQuad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) {
      indices[iCount++] = a; indices[iCount++] = c; indices[iCount++] = b;
      indices[iCount++] = a; indices[iCount++] = d; indices[iCount++] = c;
    } else {
      indices[iCount++] = a; indices[iCount++] = b; indices[iCount++] = c;
      indices[iCount++] = a; indices[iCount++] = c; indices[iCount++] = d;
    }
  };

  // 担当範囲は辺の向きごとに違う。辺の向きの軸は [0, S-1]、他の 2 軸は [1, S]。
  //   X 辺 (li,lj,lk): 周囲セルは ci=li, cj∈{lj-1,lj}, ck∈{lk-1,lk}
  //     → li は 0 でよい (ci=0 は自分のセル)。lj,lk は 1 以上でないと cj=-1 になる。
  // 全チャンクの和をとると各ノード辺がちょうど 1 回ずつ現れる。
  // ここを 3 軸とも [1,S] にすると、ノード添字 0 の面がどのチャンクからも
  // 出力されず、ワールドの外周と底に穴があく。
  for (let lk = 0; lk <= S; lk++) {
    for (let lj = 0; lj <= S; lj++) {
      for (let li = 0; li <= S; li++) {
        const n0 = den[li + lj * wStrideY + lk * wStrideZ];
        const s0 = n0 > 0;

        // X 辺
        if (li <= S - 1 && lj >= 1 && lk >= 1) {
          const nx = den[li + 1 + lj * wStrideY + lk * wStrideZ];
          if (s0 !== nx > 0) {
            const c00 = cellVert[li + (lj - 1) * lStrideY + (lk - 1) * lStrideZ];
            const c10 = cellVert[li + lj * lStrideY + (lk - 1) * lStrideZ];
            const c11 = cellVert[li + lj * lStrideY + lk * lStrideZ];
            const c01 = cellVert[li + (lj - 1) * lStrideY + lk * lStrideZ];
            emitQuad(c00, c10, c11, c01, !s0);
          }
        }

        // Y 辺
        if (lj <= S - 1 && li >= 1 && lk >= 1) {
          const ny = den[li + (lj + 1) * wStrideY + lk * wStrideZ];
          if (s0 !== ny > 0) {
            const c00 = cellVert[li - 1 + lj * lStrideY + (lk - 1) * lStrideZ];
            const c01 = cellVert[li - 1 + lj * lStrideY + lk * lStrideZ];
            const c11 = cellVert[li + lj * lStrideY + lk * lStrideZ];
            const c10 = cellVert[li + lj * lStrideY + (lk - 1) * lStrideZ];
            emitQuad(c00, c01, c11, c10, !s0);
          }
        }

        // Z 辺
        if (lk <= S - 1 && li >= 1 && lj >= 1) {
          const nz = den[li + lj * wStrideY + (lk + 1) * wStrideZ];
          if (s0 !== nz > 0) {
            const c00 = cellVert[li - 1 + (lj - 1) * lStrideY + lk * lStrideZ];
            const c10 = cellVert[li + (lj - 1) * lStrideY + lk * lStrideZ];
            const c11 = cellVert[li + lj * lStrideY + lk * lStrideZ];
            const c01 = cellVert[li - 1 + lj * lStrideY + lk * lStrideZ];
            emitQuad(c00, c10, c11, c01, !s0);
          }
        }
      }
    }
  }

  if (iCount === 0) return null;

  return {
    positions: positions.slice(0, vCount * 3),
    normals: normals.slice(0, vCount * 3),
    matWeights: matWeights.slice(0, vCount * GEO_COUNT),
    indices: indices.slice(0, iCount),
    vertexCount: vCount,
    triangleCount: iCount / 3,
  };
}
