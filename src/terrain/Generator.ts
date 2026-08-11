import { Noise } from '../util/noise';
import { CELL, NX, NY, NZ, Geo } from './config';
import { clamp } from './FieldMath';
import type { VoxelField } from './VoxelField';

/**
 * 地層の生成。
 *
 * 方針:
 *  - 地表高さ h(x,z) と地層境界面は 2D グリッド (257x257) で先に作る。安い。
 *  - 密度は d = (h - y) / sqrt(1 + |grad h|^2) で近似的な符号付き距離にする。
 *    素の (h - y) だと急斜面で距離が伸びてしまい、ブラシのブレンド幅 k の効き方が
 *    場所によって変わってしまう。勾配で割ることで k の意味を揃える。
 *  - 3D ノイズは地表付近 (|d| < 6 m) にだけ足す。全ノードに掛けると生成が遅いうえ、
 *    深部では見えないので無駄。これでオーバーハングや自然な凹凸が出る。
 *
 * ゲーム的な狙い:
 *  - 掘り抜きたくなる尾根を 1 本、橋を架けたくなる谷を 1 本置く。
 *  - 軟弱層は「傾いた板状のレンズ」にする。断面で斜めの黄色い帯として現れるので、
 *    「避けて回るか、突っ切るか」の判断が地形を見た瞬間に立ち上がる。
 */

export interface StrataMaps {
  /** 地表高さ [m]。NX * NZ */
  height: Float32Array;
  /** sqrt(1 + |grad h|^2)。距離場の正規化係数。 */
  slope: Float32Array;
  /** この高さより下は岩。 */
  rockTop: Float32Array;
  /** 軟弱レンズの中心高さ。 */
  weakMid: Float32Array;
  /** 軟弱レンズの半厚。0 ならその地点にレンズは無い。 */
  weakHalf: Float32Array;
}

const SEED = 20260811;

function buildStrataMaps(): StrataMaps {
  const n = new Noise(SEED);
  const nWeak = new Noise(SEED + 991);

  const height = new Float32Array(NX * NZ);
  const slope = new Float32Array(NX * NZ);
  const rockTop = new Float32Array(NX * NZ);
  const weakMid = new Float32Array(NX * NZ);
  const weakHalf = new Float32Array(NX * NZ);

  for (let k = 0; k < NZ; k++) {
    const z = k * CELL;
    for (let i = 0; i < NX; i++) {
      const x = i * CELL;
      const o = i + k * NX;

      // --- 広域の起伏 ---
      let h =
        22 +
        14 * n.fbm2(x * 0.011, z * 0.011, 4) +
        6 * n.fbm2(x * 0.031, z * 0.031, 3) +
        2 * n.fbm2(x * 0.09, z * 0.09, 2);

      // --- 谷 (Z 方向に蛇行させる)。橋を架けたくなる場所。 ---
      const valleyX = 38 + 13 * Math.sin(z * 0.035) + 7 * n.fbm2(z * 0.02, 11.3, 2);
      const dv = (x - valleyX) / 15;
      h -= 17 * Math.exp(-dv * dv);

      // --- 尾根。トンネルで抜きたくなる場所。 ---
      const ridgeX = 93 + 9 * Math.sin(z * 0.021 + 1.1);
      const dr = (x - ridgeX) / 21;
      h += 17 * Math.exp(-dr * dr);

      height[o] = clamp(h, 3.5, 58);

      // --- 岩盤上面。ところどころ地表を突き抜けて露岩になる。 ---
      rockTop[o] =
        height[o] - 13 + 9 * n.fbm2(x * 0.017 + 40.7, z * 0.017 - 12.1, 3) - 2 * Math.sin(x * 0.05);

      // --- 軟弱レンズ: 緩く傾いた板 + マスクで存在範囲を切る ---
      const mask = nWeak.fbm2(x * 0.014 - 7.7, z * 0.014 + 3.3, 3);
      const mid = 30 - 0.115 * x + 5.5 * nWeak.fbm2(x * 0.02, z * 0.02, 2);
      weakMid[o] = mid;
      // mask がしきい値を超えた分だけレンズが厚くなる → 縁が自然に尖る
      weakHalf[o] = mask > 0.02 ? clamp((mask - 0.02) * 26, 0, 4.2) : 0;
    }
  }

  // --- 勾配から距離場の正規化係数を作る ---
  for (let k = 0; k < NZ; k++) {
    for (let i = 0; i < NX; i++) {
      const o = i + k * NX;
      const iL = i > 0 ? i - 1 : i;
      const iR = i < NX - 1 ? i + 1 : i;
      const kD = k > 0 ? k - 1 : k;
      const kU = k < NZ - 1 ? k + 1 : k;
      const dhdx = (height[iR + k * NX] - height[iL + k * NX]) / ((iR - iL) * CELL);
      const dhdz = (height[i + kU * NX] - height[i + kD * NX]) / ((kU - kD) * CELL);
      slope[o] = Math.sqrt(1 + dhdx * dhdx + dhdz * dhdz);
    }
  }

  return { height, slope, rockTop, weakMid, weakHalf };
}

/** 密度場・地質場を初期地形で埋める。 */
export function generate(field: VoxelField): StrataMaps {
  const maps = buildStrataMaps();
  const detail = new Noise(SEED + 4242);
  const { height, slope, rockTop, weakMid, weakHalf } = maps;
  const { density, material } = field;

  const DETAIL_AMP = 1.6;
  const DETAIL_BAND = 6.0;
  const CLAMP = 8.0;

  for (let k = 0; k < NZ; k++) {
    const z = k * CELL;
    for (let i = 0; i < NX; i++) {
      const x = i * CELL;
      const o2 = i + k * NX;
      const h = height[o2];
      const inv = 1 / slope[o2];
      const rt = rockTop[o2];
      const wm = weakMid[o2];
      const wh = weakHalf[o2];

      // ワールドの外周は閉じる。開いたままだと横から見たときに
      // 地面が薄い皮に見えてしまう。閉じると「地面の塊」になり、
      // 側壁に地層がそのまま出るので地質も読みやすくなる。
      const onEdge = i === 0 || i === NX - 1 || k === 0 || k === NZ - 1;

      let idx = i + k * field.strideZ;
      for (let j = 0; j < NY; j++, idx += field.strideY) {
        const y = j * CELL;

        let d = (h - y) * inv;

        // 地表付近だけ 3D ノイズを足す。深部は見えないので計算しない。
        if (d > -DETAIL_BAND && d < DETAIL_BAND) {
          d += DETAIL_AMP * detail.fbm3(x * 0.055, y * 0.055, z * 0.055, 2);
        }

        if (onEdge || j === 0) d = -1;

        density[idx] = clamp(d, -CLAMP, CLAMP);

        // 地質は空気ノードにも入れておく。後から掘ったときに正しい色が出る。
        let g: Geo;
        if (wh > 0 && Math.abs(y - wm) < wh) g = Geo.Weak;
        else if (y < rt) g = Geo.Rock;
        else g = Geo.Soil;
        material[idx] = g;
      }
    }
  }

  return maps;
}
