import * as THREE from 'three';
import { CELL, Geo, GEO_COLOR, WORLD_Y } from '../terrain/config';
import type { VoxelField } from '../terrain/VoxelField';
import type { Economy } from './Economy';

/**
 * ボーリング調査。
 *
 * 企画の「調査に金をかけるか、勘で掘って事故るか」を成立させる。
 *
 * 地質の「既知 / 未知」をセル単位で保存はしない。
 * 画面に描かれている地表は定義上すべて露出面なので、見えている所は常に真の色でよい
 * (企画の「色を見れば分かる」)。分からないのは「まだ掘っていない面の裏側」だけ。
 * だから保持するのはボーリングの柱状図だけで足り、断面ビューがそこから
 * 信頼度を逆距離加重で作って、裏付けの無い所を伏せる。
 */

/** 掘進速度 [m / ゲーム内時間]。 */
const DRILL_RATE = 3.5;
/** 単価 [金 / m]。 */
export const BORING_COST_PER_M = 380;
/** 既定の調査深度 [m]。 */
export const BORING_DEPTH = 26;

/** 1 本のボーリングが周囲何 m まで地質を裏付けるか。 */
export const BORING_INFLUENCE = 9;

export interface BoringLayer {
  /** 標高 [m]。top > bottom。 */
  top: number;
  bottom: number;
  geo: Geo;
}

export interface Boring {
  id: number;
  x: number;
  z: number;
  /** 孔口の標高。 */
  surfaceY: number;
  /** 目標深度 [m]。 */
  targetDepth: number;
  /** 現在の掘進深度 [m]。 */
  drilled: number;
  layers: BoringLayer[];
  done: boolean;
}

export class SurveySystem {
  readonly borings: Boring[] = [];
  private nextId = 1;
  /** 柱状図や断面を作り直す必要があるか。 */
  dirty = false;

  /** 孔口の標高を探す。地表が見つからなければ null。 */
  private surfaceAt(field: VoxelField, x: number, z: number): number | null {
    for (let y = WORLD_Y; y > 0; y -= CELL * 0.5) {
      if (field.sample(x, y, z) > 0) return y;
    }
    return null;
  }

  /** 調査を開始する。費用は前払い。 */
  start(field: VoxelField, x: number, z: number, economy: Economy, depth = BORING_DEPTH): Boring | null {
    const surfaceY = this.surfaceAt(field, x, z);
    if (surfaceY === null) return null;

    const cost = depth * BORING_COST_PER_M;
    if (economy.money < cost) return null;
    economy.spend(cost);

    const b: Boring = {
      id: this.nextId++,
      x, z,
      surfaceY,
      targetDepth: depth,
      drilled: 0,
      layers: [],
      done: false,
    };
    this.borings.push(b);
    this.dirty = true;
    return b;
  }

  /** 実時間で掘り進める。 */
  update(field: VoxelField, gameDelta: number): void {
    if (gameDelta <= 0) return;
    for (const b of this.borings) {
      if (b.done) continue;
      const next = Math.min(b.targetDepth, b.drilled + DRILL_RATE * gameDelta);
      if (next === b.drilled) continue;
      this.extend(field, b, next);
      if (b.drilled >= b.targetDepth) b.done = true;
      this.dirty = true;
    }
  }

  /** 掘進した区間の地質を読み、同じ地質が続く範囲を 1 層にまとめる。 */
  private extend(field: VoxelField, b: Boring, toDepth: number): void {
    const stepM = 0.25;
    for (let d = b.drilled + stepM; d <= toDepth + 1e-6; d += stepM) {
      const y = b.surfaceY - d;
      if (y < 0) break;
      const geo = field.materialAt(b.x, y, b.z);
      const last = b.layers[b.layers.length - 1];
      if (last && last.geo === geo) {
        last.bottom = y;
      } else {
        b.layers.push({ top: b.surfaceY - (d - stepM), bottom: y, geo });
      }
    }
    b.drilled = toDepth;
  }

  /**
   * ある地点の地質がどれだけ裏付けられているか [0,1]。
   * ボーリングの近くほど高い。到達していない深さは効かない。
   */
  confidenceAt(x: number, y: number, z: number): number {
    let best = 0;
    for (const b of this.borings) {
      // その深さまで掘れていなければ何も言えない
      if (y < b.surfaceY - b.drilled) continue;
      if (y > b.surfaceY) continue;
      const dx = x - b.x;
      const dz = z - b.z;
      const hd = Math.sqrt(dx * dx + dz * dz);
      const c = Math.exp(-0.5 * (hd / BORING_INFLUENCE) * (hd / BORING_INFLUENCE));
      if (c > best) best = c;
      if (best > 0.999) break;
    }
    return best;
  }

  totalSpent(): number {
    let m = 0;
    for (const b of this.borings) m += b.drilled;
    return m * BORING_COST_PER_M;
  }
}

/**
 * ボーリング孔をワールドに立てる。どこを調べたかが 3D で分かるようにする。
 * 層ごとに色分けした細い柱 (コア) として描く。
 */
export class SurveyView {
  readonly object = new THREE.Group();
  private built = new Map<number, THREE.Group>();
  /** 作り直した時点の掘進深度。掘進中だけ作り直せば足りる。 */
  private builtDepth = new Map<number, number>();

  sync(survey: SurveySystem): void {
    if (!survey.dirty) return;
    survey.dirty = false;

    for (const b of survey.borings) {
      // 掘り止まっている孔を毎フレーム作り直さない
      if (this.builtDepth.get(b.id) === b.drilled) continue;
      this.builtDepth.set(b.id, b.drilled);

      let g = this.built.get(b.id);
      if (g) {
        this.object.remove(g);
        g.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            o.geometry.dispose();
            (o.material as THREE.Material).dispose();
          }
        });
      }
      g = new THREE.Group();

      // 孔口のマーカー (地表から少し出す)
      const head = new THREE.Mesh(
        new THREE.CylinderGeometry(0.55, 0.55, 1.2, 10),
        new THREE.MeshStandardMaterial({ color: 0xe8e2d4, roughness: 0.6 }),
      );
      head.position.set(b.x, b.surfaceY + 0.6, b.z);
      g.add(head);

      // 層ごとのコア
      for (const l of b.layers) {
        const h = Math.max(0.05, l.top - l.bottom);
        const c = GEO_COLOR[l.geo];
        const m = new THREE.Mesh(
          new THREE.CylinderGeometry(0.4, 0.4, h, 8),
          new THREE.MeshStandardMaterial({
            color: new THREE.Color(c[0], c[1], c[2]).multiplyScalar(1.7),
            roughness: 0.8,
          }),
        );
        m.position.set(b.x, (l.top + l.bottom) / 2, b.z);
        g.add(m);
      }

      this.object.add(g);
      this.built.set(b.id, g);
    }
  }
}
