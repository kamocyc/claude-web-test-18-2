import * as THREE from 'three';
import { CELL, NX, NZ, Geo } from '../terrain/config';
import { colIdx, NO_SURFACE, type HeightIndex } from '../terrain/HeightIndex';
import {
  columnSlopeDeg, TREE_MAX_DEG, VEG_TILE, VEG_TILES_X, VEG_TILES_Z, type Vegetation,
} from '../terrain/Vegetation';
import { groundHeightAt } from './Roadworks';

/**
 * 木と草の描画。
 *
 * 位置は `Vegetation` の被覆率から**毎回引き直す**。自前で「どこに木を植えたか」を
 * 覚えないので、掘っても崩しても道路を通しても、被覆率が落ちた瞬間に消える。
 * 覚えていると、消し忘れた木が宙に浮く。
 *
 * ---- 木は全域・草は足元だけ ----
 * 木は遠景の輪郭とスケール感を作るので世界中に置く (1024 本上限)。
 * 草の房は 1 m に 2-3 個ないと草地に見えないが、128 x 128 m 全部に置くと
 * 40 万個になって話にならない。**注視点のまわり 12 タイル (約 60 x 45 m) だけ**
 * 実体を持ち、その外は地形シェーダの色 (被覆率マップ) が受け持つ。
 * 遠くの草が消える境目は、下地が緑のままなので目立たない。
 *
 * ---- タイル単位で作り直す ----
 * 列 (0.5 m) 単位で差分を取ると、掘るたびに何百回も行列を書き換えることになる。
 * 16 m 角のタイルごと作り直せば 1 タイル 0.3 ms 程度で済み、フレーム予算で
 * 何タイルまで直すかを決められる。
 */

/** 木を置く格子 [列]。8 列 = 4 m 間隔。 */
const TREE_STEP = 8;
/** 1 タイルあたりの木の上限。 */
const TREE_PER_TILE = (VEG_TILE / TREE_STEP) * (VEG_TILE / TREE_STEP);
const TREE_TILES = VEG_TILES_X * VEG_TILES_Z;
const TREE_MAX = TREE_TILES * TREE_PER_TILE;

/** 木が立つ被覆率のしきい値。裸地とまばらな草地には木は生えない。 */
const TREE_COVER_MIN = 0.4;

/** 草の房を置く格子 [列]。1 列 = 0.5 m 間隔。 */
const GRASS_STEP = 1;
const GRASS_PER_TILE = (VEG_TILE / GRASS_STEP) * (VEG_TILE / GRASS_STEP);
/** 実体を持つタイルの数。3 x 3 タイル = 48 x 48 m。 */
const GRASS_BLOCKS = 9;
const GRASS_MAX = GRASS_BLOCKS * GRASS_PER_TILE;

/**
 * 1 フレームに作り直すタイル数の上限。
 * 木は 1 タイル 16 候補しか見ないので安い (81 タイル全部でも 1 ms 掛からない)。
 * 3 枚に絞っていたら、起動から林が出揃うまでに 5 秒以上かかっていた。
 * 草は 1 タイル 1024 候補なので、こちらは絞ったままにする。
 */
const TREE_BUDGET = 12;
const GRASS_BUDGET = 3;

/** 位置から決まる乱数 [0,1)。同じ場所なら毎回同じ木が立つ。 */
function hash2(i: number, k: number, salt: number): number {
  let h = Math.imul(i + 0x9e37, 0x85ebca6b) ^ Math.imul(k + 0x1b87, 0xc2b2ae35) ^ Math.imul(salt + 1, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

export class VegetationView {
  readonly object = new THREE.Group();

  private trunks: THREE.InstancedMesh;
  private leaves: THREE.InstancedMesh;
  private needles: THREE.InstancedMesh;
  private grass: THREE.InstancedMesh;

  /** 草の実体を持っているタイル → ブロック番号。 */
  private grassBlock = new Map<number, number>();
  private freeBlocks: number[] = [];
  private treeDirty = new Set<number>();
  private grassDirty = new Set<number>();
  private lastFocusTile = -1;

  /** 風の位相。実時間で進める。 */
  private wind: THREE.IUniform = { value: 0 };
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);
  private spin = new THREE.Quaternion();
  private nrm = new THREE.Vector3();
  private col = new THREE.Color();

  constructor() {
    const trunkGeo = new THREE.CylinderGeometry(0.13, 0.22, 1, 6, 1, true);
    trunkGeo.translate(0, 0.5, 0);
    const leafGeo = new THREE.IcosahedronGeometry(1, 0);
    leafGeo.translate(0, 1, 0);
    const needleGeo = new THREE.ConeGeometry(1, 2.4, 7, 2);
    needleGeo.translate(0, 1.2, 0);

    const bark = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true });
    const foliage = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.9,
      flatShading: true,
      // 樹冠の裏 (太陽の当たらない下側) が真っ黒に落ちるのを止める。
      // 木の下に立つのは一人称では日常なので、そこが黒い穴だと画にならない。
      emissive: 0x0d1a0b,
    });

    this.trunks = new THREE.InstancedMesh(trunkGeo, bark, TREE_MAX);
    this.leaves = new THREE.InstancedMesh(leafGeo, foliage, TREE_MAX);
    this.needles = new THREE.InstancedMesh(needleGeo, foliage, TREE_MAX);
    this.grass = new THREE.InstancedMesh(tuftGeometry(), grassMaterial(this.wind), GRASS_MAX);

    for (const im of [this.trunks, this.leaves, this.needles, this.grass]) {
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.frustumCulled = false; // 全域に散っているので境界球は世界全体になる。判定するだけ無駄。
      for (let n = 0; n < im.count; n++) im.setMatrixAt(n, ZERO);
      this.object.add(im);
    }
    // 影を落とすのは木だけ。地形は 250 チャンクぶんの影を持たない方針なので、
    // 草まで落とすと「影の出どころが揃っていない」がかえって目立つ。
    for (const im of [this.trunks, this.leaves, this.needles]) {
      im.castShadow = true;
      im.receiveShadow = true;
    }
    this.grass.receiveShadow = true;

    for (let b = GRASS_BLOCKS - 1; b >= 0; b--) this.freeBlocks.push(b);
  }

  /** 風を進める。dt は実時間 [s]。 */
  update(dt: number): void {
    this.wind.value = (this.wind.value as number) + dt;
  }

  /**
   * 被覆率に追いつかせる。
   * @param focus 草の実体を持つ中心 (一人称なら目の位置、俯瞰なら注視点)
   */
  sync(veg: Vegetation, index: HeightIndex, focus: THREE.Vector3, grassOn = true): void {
    for (const t of veg.dirtyTiles) {
      this.treeDirty.add(t);
      if (this.grassBlock.has(t)) this.grassDirty.add(t);
    }
    veg.dirtyTiles.clear();

    this.updateGrassBlocks(grassOn ? focus : null);

    let n = 0;
    for (const t of this.treeDirty) {
      this.rebuildTrees(veg, index, t);
      this.treeDirty.delete(t);
      if (++n >= TREE_BUDGET) break;
    }
    if (n > 0) {
      this.trunks.instanceMatrix.needsUpdate = true;
      this.leaves.instanceMatrix.needsUpdate = true;
      this.needles.instanceMatrix.needsUpdate = true;
      if (this.leaves.instanceColor) this.leaves.instanceColor.needsUpdate = true;
      if (this.needles.instanceColor) this.needles.instanceColor.needsUpdate = true;
      if (this.trunks.instanceColor) this.trunks.instanceColor.needsUpdate = true;
    }

    let g = 0;
    for (const t of this.grassDirty) {
      const block = this.grassBlock.get(t);
      this.grassDirty.delete(t);
      if (block === undefined) continue;
      this.rebuildGrass(veg, index, t, block);
      if (++g >= GRASS_BUDGET) break;
    }
    if (g > 0) {
      this.grass.instanceMatrix.needsUpdate = true;
      if (this.grass.instanceColor) this.grass.instanceColor.needsUpdate = true;
    }
  }

  /**
   * 注視点が別のタイルへ移ったら、草を持つタイルの顔ぶれを入れ替える。
   * focus が null なら実体を全部返す (俯瞰で引いているとき)。
   * 遠景の緑は被覆率マップの色が受け持つので、房が消えても穴は開かない。
   */
  private updateGrassBlocks(focus: THREE.Vector3 | null): void {
    if (!focus) {
      if (this.grassBlock.size === 0) return;
      for (const [, block] of this.grassBlock) {
        this.clearGrassBlock(block);
        this.freeBlocks.push(block);
      }
      this.grassBlock.clear();
      this.lastFocusTile = -1;
      return;
    }
    const fi = Math.max(0, Math.min(VEG_TILES_X - 1, (focus.x / CELL / VEG_TILE) | 0));
    const fk = Math.max(0, Math.min(VEG_TILES_Z - 1, (focus.z / CELL / VEG_TILE) | 0));
    const ft = fi + fk * VEG_TILES_X;
    if (ft === this.lastFocusTile) return;
    this.lastFocusTile = ft;

    // 注視点に近い順に GRASS_BLOCKS 枚
    const want: number[] = [];
    for (let k = 0; k < VEG_TILES_Z; k++) {
      for (let i = 0; i < VEG_TILES_X; i++) {
        const d = (i - fi) * (i - fi) + (k - fk) * (k - fk);
        if (d <= 5) want.push(i + k * VEG_TILES_X);
      }
    }
    want.sort(
      (a, b) =>
        dist2(a, fi, fk) - dist2(b, fi, fk),
    );
    const keep = new Set(want.slice(0, GRASS_BLOCKS));

    for (const [tile, block] of this.grassBlock) {
      if (keep.has(tile)) continue;
      this.clearGrassBlock(block);
      this.grassBlock.delete(tile);
      this.freeBlocks.push(block);
    }
    for (const tile of keep) {
      if (this.grassBlock.has(tile)) continue;
      const block = this.freeBlocks.pop();
      if (block === undefined) break;
      this.grassBlock.set(tile, block);
      this.grassDirty.add(tile);
    }
  }

  private clearGrassBlock(block: number): void {
    const base = block * GRASS_PER_TILE;
    for (let n = 0; n < GRASS_PER_TILE; n++) this.grass.setMatrixAt(base + n, ZERO);
    this.grass.instanceMatrix.needsUpdate = true;
  }

  /** 1 タイルぶんの木を置き直す。 */
  private rebuildTrees(veg: Vegetation, index: HeightIndex, tile: number): void {
    const ti = tile % VEG_TILES_X;
    const tk = (tile / VEG_TILES_X) | 0;
    const base = tile * TREE_PER_TILE;
    let slot = 0;

    for (let gk = 0; gk < VEG_TILE / TREE_STEP; gk++) {
      for (let gi = 0; gi < VEG_TILE / TREE_STEP; gi++) {
        const ci = ti * VEG_TILE + gi * TREE_STEP;
        const ck = tk * VEG_TILE + gk * TREE_STEP;
        if (ci >= NX || ck >= NZ) continue;
        const r1 = hash2(ci, ck, 1);
        const r2 = hash2(ci, ck, 2);
        // 格子から散らす。揃っていると並木に見える。
        const i = ci + ((r1 * TREE_STEP) | 0);
        const k = ck + ((r2 * TREE_STEP) | 0);
        if (i <= 0 || k <= 0 || i >= NX - 1 || k >= NZ - 1) continue;
        const o = colIdx(i, k);
        if (index.heights[o] === NO_SURFACE) continue;
        const cover = veg.cover[o];
        if (cover < TREE_COVER_MIN) continue;
        // 木は草より条件が厳しい。急斜面と岩には立たない。
        if (columnSlopeDeg(index, i, k) > TREE_MAX_DEG) continue;
        if (index.surfaceMat(o) === Geo.Rock) continue;
        // 疎らな所ほど間引く。被覆率がそのまま林の密度になる。
        if (hash2(i, k, 3) > 0.35 + cover * 0.6) continue;

        const x = i * CELL;
        const z = k * CELL;
        const y = index.heights[o];
        const r3 = hash2(i, k, 4);
        const r4 = hash2(i, k, 5);
        const conifer = hash2(i, k, 6) < 0.38;

        const trunkH = 3.4 + r3 * 4.6;
        const crownR = conifer ? 1.1 + r4 * 0.7 : 1.7 + r4 * 1.4;
        this.q.setFromAxisAngle(this.up, r3 * Math.PI * 2);

        this.p.set(x, y - 0.2, z);
        this.s.set(1, trunkH, 1);
        this.trunks.setMatrixAt(base + slot, this.m.compose(this.p, this.q, this.s));
        this.col.setRGB(0.24 + r4 * 0.08, 0.17 + r4 * 0.05, 0.11);
        this.trunks.setColorAt(base + slot, this.col);

        this.p.set(x, y + trunkH * (conifer ? 0.28 : 0.72), z);
        // 針葉樹は縦に、広葉樹は横に広がる
        this.s.set(crownR, conifer ? trunkH * 0.42 : crownR * 0.82, crownR);
        const canopy = conifer ? this.needles : this.leaves;
        const other = conifer ? this.leaves : this.needles;
        canopy.setMatrixAt(base + slot, this.m.compose(this.p, this.q, this.s));
        other.setMatrixAt(base + slot, ZERO);
        // 常緑の濃い緑から、明るい緑まで振る。単色だと森が塗り絵に見える。
        this.col.setRGB(
          conifer ? 0.13 + r3 * 0.06 : 0.22 + r3 * 0.14,
          conifer ? 0.26 + r4 * 0.08 : 0.38 + r4 * 0.16,
          conifer ? 0.14 + r3 * 0.05 : 0.14 + r4 * 0.08,
        );
        canopy.setColorAt(base + slot, this.col);

        if (++slot >= TREE_PER_TILE) break;
      }
      if (slot >= TREE_PER_TILE) break;
    }

    for (let n = slot; n < TREE_PER_TILE; n++) {
      this.trunks.setMatrixAt(base + n, ZERO);
      this.leaves.setMatrixAt(base + n, ZERO);
      this.needles.setMatrixAt(base + n, ZERO);
    }
  }

  /** 1 タイルぶんの草を置き直す。 */
  private rebuildGrass(veg: Vegetation, index: HeightIndex, tile: number, block: number): void {
    const ti = tile % VEG_TILES_X;
    const tk = (tile / VEG_TILES_X) | 0;
    const base = block * GRASS_PER_TILE;
    const n = VEG_TILE / GRASS_STEP;
    let slot = 0;

    for (let gk = 0; gk < n; gk++) {
      for (let gi = 0; gi < n; gi++) {
        const i = ti * VEG_TILE + gi * GRASS_STEP;
        const k = tk * VEG_TILE + gk * GRASS_STEP;
        if (i <= 0 || k <= 0 || i >= NX - 1 || k >= NZ - 1) continue;
        const o = colIdx(i, k);
        const cover = veg.cover[o];
        // 被覆率をそのまま「その升目に房が立つ確率」として使う。
        // しきい値で切ると草地の縁が直線になる。
        if (cover < 0.08 || hash2(i, k, 11) > cover) continue;

        const jx = (hash2(i, k, 12) - 0.5) * GRASS_STEP * CELL;
        const jz = (hash2(i, k, 13) - 0.5) * GRASS_STEP * CELL;
        const x = i * CELL + jx;
        const z = k * CELL + jz;
        const y = groundHeightAt(index, x, z);

        // 斜面では少しだけ寝かせる。垂直に立てると法面が針山になる。
        surfaceNormal(index, i, k, this.nrm);
        this.nrm.lerp(this.up, 0.45).normalize();
        this.q.setFromUnitVectors(this.up, this.nrm);
        this.q.multiply(this.spin.setFromAxisAngle(this.up, hash2(i, k, 14) * Math.PI));

        // 足首から膝下まで。これ以上伸ばすと、一人称で足元が草しか見えなくなる。
        const h = 0.34 + hash2(i, k, 15) * 0.26;
        this.p.set(x, y - 0.05, z);
        this.s.set(0.8 + hash2(i, k, 16) * 0.5, h * (0.6 + cover * 0.5), 0.8);
        this.grass.setMatrixAt(base + slot, this.m.compose(this.p, this.q, this.s));
        // 乾いた黄緑から濃い緑まで。被覆率が高い所ほど濃くする。
        const v = hash2(i, k, 17);
        this.col.setRGB(0.72 + v * 0.5 - cover * 0.25, 0.86 + v * 0.3, 0.6 + v * 0.35 - cover * 0.2);
        this.grass.setColorAt(base + slot, this.col);

        if (++slot >= GRASS_PER_TILE) break;
      }
      if (slot >= GRASS_PER_TILE) break;
    }

    for (let s = slot; s < GRASS_PER_TILE; s++) this.grass.setMatrixAt(base + s, ZERO);
  }
}

function dist2(tile: number, fi: number, fk: number): number {
  const i = tile % VEG_TILES_X;
  const k = (tile / VEG_TILES_X) | 0;
  return (i - fi) * (i - fi) + (k - fk) * (k - fk);
}

/**
 * 草のマテリアル。先だけを風で揺らす。
 *
 * インスタンスごとの位相はインスタンス行列の平行移動から作るので、
 * 属性を 1 本も増やさずに済む。根元 (ローカル y = 0) は動かさない。
 * 全部が同じ位相で揺れると、草地が 1 枚の布に見える。
 */
function grassMaterial(wind: THREE.IUniform): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
  });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uWind = wind;
    // 裏面を向いた葉の法線が反転して真っ黒になるのを止める。
    // 葉の法線はもともと真上に倒してあるので、裏返すと下向き = 影になる。
    // 両面とも地面と同じ向きで受けさせる。
    sh.fragmentShader = sh.fragmentShader.replace(
      '#include <normal_fragment_begin>',
      '#include <normal_fragment_begin>\nnormal = normalize( vNormal );',
    );
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uWind;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          vec2 ip = instanceMatrix[3].xz;
          float phase = ip.x * 0.7 + ip.y * 1.3;
          float sway = sin( uWind * 1.7 + phase ) * 0.09 + sin( uWind * 3.3 + phase * 1.7 ) * 0.035;
          transformed.x += sway * position.y;
          transformed.z += sway * 0.55 * position.y;
        }`,
      );
  };
  mat.customProgramCacheKey = () => 'grass-wind-v1';
  return mat;
}

/** 列の地表法線。高さ場の中央差分から作る。 */
function surfaceNormal(index: HeightIndex, i: number, k: number, out: THREE.Vector3): THREE.Vector3 {
  const h = index.heights;
  const o = colIdx(i, k);
  const at = (ii: number, kk: number): number => {
    const v = h[ii + kk * NX];
    return v === NO_SURFACE ? h[o] : v;
  };
  const gx = (at(i + 1, k) - at(i - 1, k)) / (2 * CELL);
  const gz = (at(i, k + 1) - at(i, k - 1)) / (2 * CELL);
  return out.set(-gx, 1, -gz).normalize();
}

/**
 * 草の房。3 枚の葉を放射状に、先を細めた四角形で作る。
 * テクスチャを使わないので抜き色の並べ替えが要らず、深度書き込みのまま出せる。
 */
function tuftGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const blades = 3;
  const baseC = [0.16, 0.24, 0.09];
  const tipC = [0.44, 0.62, 0.22];

  for (let b = 0; b < blades; b++) {
    const a = (b / blades) * Math.PI;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    const w = 0.055;
    // 先を風下へ倒す。まっすぐだと草というより棘に見える。
    const lean = 0.22;
    const o = pos.length / 3;
    pos.push(-dx * w, 0, -dz * w);
    pos.push(dx * w, 0, dz * w);
    pos.push(dx * w * 0.25 + dz * lean, 1, dz * w * 0.25 - dx * lean);
    pos.push(-dx * w * 0.25 + dz * lean, 1, -dz * w * 0.25 - dx * lean);
    col.push(...baseC, ...baseC, ...tipC, ...tipC);
    idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  }

  // 法線は葉の面ではなく**真上**にする。面の向きどおりにすると、
  // 横を向いた葉だけが黒く落ちて草地が斑になる。地面と同じ向きで
  // 受ければ、草は地面の明るさにそのまま馴染む。
  const nrm: number[] = [];
  for (let n = 0; n < pos.length / 3; n++) nrm.push(0, 1, 0);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  return g;
}
