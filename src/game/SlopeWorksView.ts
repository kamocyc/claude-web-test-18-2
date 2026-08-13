import * as THREE from 'three';
import { CELL, NX } from '../terrain/config';
import { NO_SURFACE, type HeightIndex } from '../terrain/HeightIndex';
import { SLOPE_WORKS, slopeWorkDef, type SlopeWorks } from './SlopeWorks';

/**
 * 法面保護工の可視化。
 *
 * 塗った所が見えないと、何にいくら払ったのか分からないし、
 * 「ここは崩れない」という前提でその先の判断ができない。
 *
 * 支保のリングと同じ規約にしてある。
 *   色 … 工法 (吹付 緑 / 法枠 灰 / 擁壁 青灰)
 *   中間色 … 手配済みだが未着。まだ崩れうる事実を隠さないため、
 *            工法の色を暗く落として出す
 *
 * 列ごとに小さな板を地表のすぐ上へ置く。地形メッシュそのものを染めるには
 * 頂点属性を増やす必要があり、チャンクの再メッシュに手が入ってしまう。
 * 板を重ねるだけなら地形側に一切触らない。
 */

/** 地表からわずかに浮かせる [m]。埋まると z-fighting でちらつく。 */
const LIFT = 0.08;

const MAX_COLUMNS = 40000;

export class SlopeWorksView {
  readonly object = new THREE.Group();
  private mesh: THREE.Mesh;
  private positions: Float32Array;
  private colors: Float32Array;
  private geo: THREE.BufferGeometry;

  constructor() {
    this.positions = new Float32Array(MAX_COLUMNS * 6 * 3);
    this.colors = new Float32Array(MAX_COLUMNS * 6 * 3);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.geo.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(
      this.geo,
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.46,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.mesh.renderOrder = 1;
    this.object.add(this.mesh);
  }

  /**
   * 作り直す。列数ぶんの板を並べるだけなので、数千列でも 1 ms 程度。
   * 地形が整定で動くと板も追従させたいので、崩落があったフレームも呼ぶ。
   */
  rebuild(index: HeightIndex, works: SlopeWorks): void {
    const { heights, protect } = index;
    const pos = this.positions;
    const col = this.colors;
    const half = CELL * 0.5;
    let v = 0;

    /**
     * 板の隅の高さ。まわり 4 列の平均を採る。
     *
     * 列の高さで水平な板を置くと、法面では板が階段状に並んで
     * **格子がそのまま見えてしまう** (このプロトタイプの最優先要件に反する)。
     * 隅を共有させれば、隣の板と高さが一致して面が繋がる。
     */
    const corner = (i: number, k: number): number => {
      let sum = 0;
      let n = 0;
      for (let dk = -1; dk <= 0; dk++) {
        for (let di = -1; di <= 0; di++) {
          const ii = i + di;
          const kk = k + dk;
          if (ii < 0 || kk < 0 || ii >= NX) continue;
          const h = heights[ii + kk * NX];
          if (h === NO_SURFACE) continue;
          sum += h;
          n++;
        }
      }
      return n > 0 ? sum / n : NO_SURFACE;
    };

    const c = new THREE.Color();
    const put = (o: number, level: number, dim: boolean): void => {
      if (v + 6 > MAX_COLUMNS * 6) return;
      if (heights[o] === NO_SURFACE) return;
      const def = slopeWorkDef(level);
      if (!def) return;
      const i = o % NX;
      const k = (o / NX) | 0;
      const x = i * CELL;
      const z = k * CELL;

      c.set(def.color);
      // 手配済みだが未着は暗く落とす。入っているものと区別がつかないと、
      // 崩れないつもりで掘って事故る。
      if (dim) c.multiplyScalar(0.42);

      const y00 = corner(i, k);
      const y10 = corner(i + 1, k);
      const y01 = corner(i, k + 1);
      const y11 = corner(i + 1, k + 1);
      if (y00 === NO_SURFACE || y10 === NO_SURFACE || y01 === NO_SURFACE || y11 === NO_SURFACE) return;

      // 2 三角形で 1 枚の板。隅は隣と共有するので面が繋がる。
      const xs = [x - half, x + half, x + half, x - half, x + half, x - half];
      const zs = [z - half, z - half, z + half, z - half, z + half, z + half];
      const ys = [y00, y10, y11, y00, y11, y01];
      for (let n = 0; n < 6; n++, v++) {
        pos[v * 3] = xs[n];
        pos[v * 3 + 1] = ys[n] + LIFT;
        pos[v * 3 + 2] = zs[n];
        col[v * 3] = c.r;
        col[v * 3 + 1] = c.g;
        col[v * 3 + 2] = c.b;
      }
    };

    for (let o = 0; o < protect.length; o++) {
      if (protect[o] > 0) put(o, protect[o], false);
    }
    for (const [o, level] of works.pending) {
      if (protect[o] < level) put(o, level, true);
    }

    this.geo.setDrawRange(0, v);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
    this.geo.computeBoundingSphere();
  }
}

/** 凡例用。工法の色を CSS の色文字列で返す。 */
export function slopeWorkCss(level: number): string {
  const def = SLOPE_WORKS.find((s) => s.level === level);
  if (!def) return '#93a0b4';
  return '#' + def.color.toString(16).padStart(6, '0');
}
