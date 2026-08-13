import * as THREE from 'three';
import {
  CELL, CHUNK, CHUNKS_X, CHUNKS_Y, CHUNKS_Z, CELLS_X, CELLS_Y, CELLS_Z,
} from './config';
import { surfaceNets } from './meshing/surfaceNets';
import type { VoxelField } from './VoxelField';

/**
 * チャンクの登録・メッシュ化・差し替え。
 *
 * 密度場は VoxelField が 1 本で持っているので、ここはその添字範囲を
 * メッシュ化して Three のシーンに載せるだけ。
 *
 * 編集時は「触れた AABB を 2 セル膨らませてチャンク範囲に変換」して dirty に積む。
 * 膨らませるのは、隣チャンクの境界頂点も自分の変更の影響を受けるため。
 * 再メッシュはフレーム予算制で、間に合わない分は次フレームに回す。
 * 古いメッシュは新しいものが出来るまで消さない (穴を見せない)。
 */

export interface ChunkStats {
  meshedChunks: number;
  vertices: number;
  triangles: number;
  lastRemeshMs: number;
  dirtyRemaining: number;
}

export class ChunkManager {
  readonly group = new THREE.Group();

  private meshes: (THREE.Mesh | null)[] = new Array(CHUNKS_X * CHUNKS_Y * CHUNKS_Z).fill(null);
  private dirty = new Set<number>();
  private dirtyOrder: number[] = [];

  readonly stats: ChunkStats = {
    meshedChunks: 0,
    vertices: 0,
    triangles: 0,
    lastRemeshMs: 0,
    dirtyRemaining: 0,
  };

  constructor(
    private field: VoxelField,
    private material: THREE.Material,
  ) {
    this.group.name = 'terrain';
  }

  private chunkIndex(cx: number, cy: number, cz: number): number {
    return cx + cy * CHUNKS_X + cz * CHUNKS_X * CHUNKS_Y;
  }

  /** 全チャンクを同期でメッシュ化する。起動時に 1 回だけ。 */
  buildAll(): void {
    const t0 = performance.now();
    for (let cz = 0; cz < CHUNKS_Z; cz++) {
      for (let cy = 0; cy < CHUNKS_Y; cy++) {
        for (let cx = 0; cx < CHUNKS_X; cx++) {
          this.remeshChunk(cx, cy, cz);
        }
      }
    }
    this.stats.lastRemeshMs = performance.now() - t0;
    this.recountStats();
  }

  /** ワールド AABB に触れたチャンクを dirty にする。 */
  markDirtyByAABB(
    minX: number, minY: number, minZ: number,
    maxX: number, maxY: number, maxZ: number,
  ): void {
    // 境界頂点は隣の値にも依存するので 2 セル分広げる
    const pad = 2 * CELL;
    const c0x = Math.max(0, Math.floor((minX - pad) / CELL / CHUNK));
    const c0y = Math.max(0, Math.floor((minY - pad) / CELL / CHUNK));
    const c0z = Math.max(0, Math.floor((minZ - pad) / CELL / CHUNK));
    const c1x = Math.min(CHUNKS_X - 1, Math.floor((maxX + pad) / CELL / CHUNK));
    const c1y = Math.min(CHUNKS_Y - 1, Math.floor((maxY + pad) / CELL / CHUNK));
    const c1z = Math.min(CHUNKS_Z - 1, Math.floor((maxZ + pad) / CELL / CHUNK));

    for (let cz = c0z; cz <= c1z; cz++) {
      for (let cy = c0y; cy <= c1y; cy++) {
        for (let cx = c0x; cx <= c1x; cx++) {
          const i = this.chunkIndex(cx, cy, cz);
          if (!this.dirty.has(i)) {
            this.dirty.add(i);
            this.dirtyOrder.push(i);
          }
        }
      }
    }
  }

  /** dirty なチャンクを予算内で再メッシュする。 */
  update(budgetMs = 6): void {
    if (this.dirtyOrder.length === 0) {
      this.stats.dirtyRemaining = 0;
      return;
    }
    const t0 = performance.now();
    let done = 0;
    while (this.dirtyOrder.length > 0) {
      const i = this.dirtyOrder.shift()!;
      this.dirty.delete(i);
      const cx = i % CHUNKS_X;
      const cy = Math.floor(i / CHUNKS_X) % CHUNKS_Y;
      const cz = Math.floor(i / (CHUNKS_X * CHUNKS_Y));
      this.remeshChunk(cx, cy, cz);
      done++;
      if (performance.now() - t0 > budgetMs) break;
    }
    this.stats.lastRemeshMs = performance.now() - t0;
    this.stats.dirtyRemaining = this.dirtyOrder.length;
    if (done > 0) this.recountStats();
  }

  private remeshChunk(cx: number, cy: number, cz: number): void {
    const i = this.chunkIndex(cx, cy, cz);
    const ox = cx * CHUNK;
    const oy = cy * CHUNK;
    const oz = cz * CHUNK;

    const result = surfaceNets(this.field, ox, oy, oz, CHUNK);
    const old = this.meshes[i];

    if (!result) {
      if (old) {
        this.group.remove(old);
        old.geometry.dispose();
        this.meshes[i] = null;
      }
      return;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(result.positions, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(result.normals, 3));
    geom.setAttribute('matWeight', new THREE.BufferAttribute(result.matWeights, 3));
    geom.setIndex(new THREE.BufferAttribute(result.indices, 1));
    geom.computeBoundingSphere();

    if (old) {
      // 差し替えは属性の入れ替えだけ。Mesh は使い回して余計な再登録を避ける。
      old.geometry.dispose();
      old.geometry = geom;
    } else {
      const mesh = new THREE.Mesh(geom, this.material);
      mesh.position.set(ox * CELL, oy * CELL, oz * CELL);
      mesh.castShadow = false; // 250 チャンクの影は割に合わない
      mesh.receiveShadow = true;
      mesh.frustumCulled = true;
      mesh.name = `chunk_${cx}_${cy}_${cz}`;
      this.group.add(mesh);
      this.meshes[i] = mesh;
    }
  }

  private recountStats(): void {
    let meshed = 0;
    let verts = 0;
    let tris = 0;
    for (const m of this.meshes) {
      if (!m) continue;
      meshed++;
      const pos = m.geometry.getAttribute('position');
      verts += pos.count;
      const idx = m.geometry.getIndex();
      tris += idx ? idx.count / 3 : 0;
    }
    this.stats.meshedChunks = meshed;
    this.stats.vertices = verts;
    this.stats.triangles = tris;
  }

  /** ワールドの寸法 (デバッグ表示・カメラ初期化用)。 */
  static worldSize(): THREE.Vector3 {
    return new THREE.Vector3(CELLS_X * CELL, CELLS_Y * CELL, CELLS_Z * CELL);
  }
}
