import * as THREE from 'three';
import {
  RoadKind, ROAD_KIND_NAME, type Alignment, type Station,
} from './Alignment';
import { BridgeNetwork, type Bridge, type BridgePlan } from './Bridge';
import type { RoadPlan } from './Roadworks';

/**
 * 線形と道路・橋の可視化。
 *
 * ---- プレビューは「規格が地形と何を約束したか」を見せる ----
 * 制御点を置いた瞬間に見たいのは、線の形ではなく
 * **どこが切土で、どこが橋で、どこがトンネルになるか**。だから中心線の帯を
 * 区間の種別で塗り分ける。色を見れば工事の中身が分かる、という
 * このプロトタイプの規約 (地質・支保・保護工と同じ) をそのまま踏襲する。
 *
 *   平坦 灰 / 切土 橙 / 盛土 緑 / トンネル 紫 / 橋 水色
 *
 * 帯は**深度テストを切って**描く。切土やトンネルの区間は計画高が地山の中に
 * あるので、そのままだと山に隠れて「どこがトンネルになるのか」が
 * 決める前に見えない。決める前に見えないものは判断に使えない。
 *
 * ---- 架かった橋は形で読ませる ----
 * 支間表 (RC 桁 / PC 箱桁 / 鋼トラス) は桁高が違うので、桁の厚みがそのまま
 * どの橋かを表す。橋脚は深礎を下ろした深さだけ地中へ伸ばして描く
 * (深度テストを切ってあるので外から見える)。**払った金がどこに消えたのかが
 * 見えないと、支間表を選んだ意味が残らない。**
 * 支持力が足りない橋脚は赤く明滅する。トンネルの警告柱と同じ規約。
 */

const KIND_COLOR: Record<number, number> = {
  [RoadKind.Flat]: 0x9aa6b4,
  [RoadKind.Cut]: 0xe0913f,
  [RoadKind.Fill]: 0x5fae63,
  [RoadKind.Tunnel]: 0xa579d8,
  [RoadKind.Bridge]: 0x54b6d8,
};

export function roadKindCss(kind: RoadKind): string {
  return '#' + KIND_COLOR[kind].toString(16).padStart(6, '0');
}

export function roadKindName(kind: RoadKind): string {
  return ROAD_KIND_NAME[kind];
}

/** 帯を地表から浮かせる量 [m]。 */
const LIFT = 0.12;

const MAX_RIBBON_VERTS = 40000;

/** 制御点の杭の高さ [m]。 */
const MARK_HEIGHT = 9;

const _u = new THREE.Vector3();
const _c = new THREE.Color();

/** 中心線に直交する水平ベクトル。 */
function sideOf(st: Station, out: THREE.Vector3): THREE.Vector3 {
  return out.set(-st.dirZ, 0, st.dirX);
}

export class RoadView {
  readonly object = new THREE.Group();

  /** 検討中の線形の帯。 */
  private preview: THREE.Mesh;
  private previewPos: Float32Array;
  private previewCol: Float32Array;
  private previewGeo: THREE.BufferGeometry;

  /** 供用中の路面。 */
  private paved: THREE.Mesh;
  private pavedPos: Float32Array;
  private pavedCol: Float32Array;
  private pavedGeo: THREE.BufferGeometry;

  /** 制御点のマーカー。 */
  private marks: THREE.InstancedMesh;
  /** 橋脚 (深礎ぶん地中へ伸びる)。 */
  private piers: THREE.InstancedMesh;
  /** 桁。 */
  private decks: THREE.InstancedMesh;
  private pierBridges: Bridge[] = [];
  private t = 0;

  constructor() {
    this.previewPos = new Float32Array(MAX_RIBBON_VERTS * 3);
    this.previewCol = new Float32Array(MAX_RIBBON_VERTS * 3);
    this.previewGeo = new THREE.BufferGeometry();
    this.previewGeo.setAttribute('position', new THREE.BufferAttribute(this.previewPos, 3));
    this.previewGeo.setAttribute('color', new THREE.BufferAttribute(this.previewCol, 3));
    this.previewGeo.setDrawRange(0, 0);
    this.preview = new THREE.Mesh(
      this.previewGeo,
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.55,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.preview.renderOrder = 18;
    this.preview.frustumCulled = false;

    this.pavedPos = new Float32Array(MAX_RIBBON_VERTS * 3);
    this.pavedCol = new Float32Array(MAX_RIBBON_VERTS * 3);
    this.pavedGeo = new THREE.BufferGeometry();
    this.pavedGeo.setAttribute('position', new THREE.BufferAttribute(this.pavedPos, 3));
    this.pavedGeo.setAttribute('color', new THREE.BufferAttribute(this.pavedCol, 3));
    this.pavedGeo.setDrawRange(0, 0);
    this.paved = new THREE.Mesh(
      this.pavedGeo,
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.92,
        side: THREE.DoubleSide,
      }),
    );
    this.paved.renderOrder = 1;
    this.paved.frustumCulled = false;

    const markMat = new THREE.MeshBasicMaterial({
      color: 0xffd066, depthTest: false, transparent: true, opacity: 0.9,
    });
    this.marks = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.5, 0.5, 1, 8).translate(0, 0.5, 0),
      markMat, 64,
    );
    this.marks.count = 0;
    this.marks.frustumCulled = false;
    this.marks.renderOrder = 21;

    this.piers = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(1.5, 1.9, 1, 10).translate(0, 0.5, 0),
      new THREE.MeshStandardMaterial({ roughness: 0.8, emissive: new THREE.Color(0x1a1a1e) }),
      256,
    );
    this.piers.count = 0;
    this.piers.frustumCulled = false;
    this.piers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    this.decks = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ roughness: 0.75, emissive: new THREE.Color(0x1a1a1e) }),
      1024,
    );
    this.decks.count = 0;
    this.decks.frustumCulled = false;
    this.decks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    this.object.add(this.paved, this.preview, this.marks, this.piers, this.decks);
  }

  /** 検討中の線形。制御点が変わるたびに呼ぶ。 */
  showPreview(al: Alignment | null, plan: RoadPlan | null, control: { x: number; z: number }[]): void {
    let v = 0;
    if (al && al.stations.length >= 2) {
      const halfW = al.std.width / 2;
      const side = new THREE.Vector3();
      const put = (st: Station, next: Station): void => {
        if (v + 6 > MAX_RIBBON_VERTS) return;
        // 立たない橋は赤く出す。着工できない理由が線の上で分かるようにする。
        const bad = plan?.bridges.some(
          (b) => !b.ok && st.s >= al.stations[b.from].s && st.s <= al.stations[b.to - 1].s,
        );
        _c.setHex(bad ? 0xe8504a : KIND_COLOR[st.kind]);

        sideOf(st, side).multiplyScalar(halfW);
        sideOf(next, _u).multiplyScalar(halfW);
        const quad: [number, number, number][] = [
          [st.x - side.x, st.y + LIFT, st.z - side.z],
          [st.x + side.x, st.y + LIFT, st.z + side.z],
          [next.x + _u.x, next.y + LIFT, next.z + _u.z],
          [st.x - side.x, st.y + LIFT, st.z - side.z],
          [next.x + _u.x, next.y + LIFT, next.z + _u.z],
          [next.x - _u.x, next.y + LIFT, next.z - _u.z],
        ];
        for (const p of quad) {
          this.previewPos[v * 3] = p[0];
          this.previewPos[v * 3 + 1] = p[1];
          this.previewPos[v * 3 + 2] = p[2];
          this.previewCol[v * 3] = _c.r;
          this.previewCol[v * 3 + 1] = _c.g;
          this.previewCol[v * 3 + 2] = _c.b;
          v++;
        }
      };
      for (let i = 0; i + 1 < al.stations.length; i++) put(al.stations[i], al.stations[i + 1]);
    }
    this.previewGeo.setDrawRange(0, v);
    this.previewGeo.attributes.position.needsUpdate = true;
    this.previewGeo.attributes.color.needsUpdate = true;
    this.previewGeo.computeBoundingSphere();

    // 制御点。中心線の高さに合わせて短い杭で立てる。
    // 世界を貫く長い柱にすると、肝心の帯より目立って線形が読めなくなる。
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    let n = 0;
    for (const c of control) {
      if (n >= 64) break;
      // その制御点にいちばん近い測点の計画高。線形がまだ無ければ地表を知らないので 0。
      let y = 0;
      if (al && al.stations.length > 0) {
        let best = Infinity;
        for (const st of al.stations) {
          const d = (st.x - c.x) ** 2 + (st.z - c.z) ** 2;
          if (d < best) { best = d; y = st.y; }
        }
      }
      m.compose(
        new THREE.Vector3(c.x, y - MARK_HEIGHT * 0.25, c.z),
        q,
        new THREE.Vector3(0.7, MARK_HEIGHT, 0.7),
      );
      this.marks.setMatrixAt(n++, m);
    }
    this.marks.count = n;
    this.marks.instanceMatrix.needsUpdate = true;
  }

  /**
   * 供用中の路面。橋とトンネルの区間は路面を敷かない (桁と坑道が持つ)。
   *
   * 舗装が済むまでは路盤の色 (明るい灰褐色) で出す。着工した瞬間に
   * 黒い舗装が出てしまうと、施工班の順番待ちが見えなくなる
   * (支保のリングの中間色・保護工の暗い板と同じ規約)。
   */
  rebuildPaved(roads: readonly { al: Alignment; paved: boolean }[]): void {
    let v = 0;
    const side = new THREE.Vector3();
    for (const road of roads) {
      const al = road.al;
      const halfW = al.std.width / 2;
      _c.setHex(road.paved ? 0x3a3d42 : 0x7d7364);
      for (let i = 0; i + 1 < al.stations.length; i++) {
        const st = al.stations[i];
        const next = al.stations[i + 1];
        if (st.kind === RoadKind.Tunnel || next.kind === RoadKind.Tunnel) continue;
        if (v + 6 > MAX_RIBBON_VERTS) break;
        sideOf(st, side).multiplyScalar(halfW);
        sideOf(next, _u).multiplyScalar(halfW);
        const quad: [number, number, number][] = [
          [st.x - side.x, st.y + LIFT, st.z - side.z],
          [st.x + side.x, st.y + LIFT, st.z + side.z],
          [next.x + _u.x, next.y + LIFT, next.z + _u.z],
          [st.x - side.x, st.y + LIFT, st.z - side.z],
          [next.x + _u.x, next.y + LIFT, next.z + _u.z],
          [next.x - _u.x, next.y + LIFT, next.z - _u.z],
        ];
        for (const p of quad) {
          this.pavedPos[v * 3] = p[0];
          this.pavedPos[v * 3 + 1] = p[1];
          this.pavedPos[v * 3 + 2] = p[2];
          this.pavedCol[v * 3] = _c.r;
          this.pavedCol[v * 3 + 1] = _c.g;
          this.pavedCol[v * 3 + 2] = _c.b;
          v++;
        }
      }
    }
    this.pavedGeo.setDrawRange(0, v);
    this.pavedGeo.attributes.position.needsUpdate = true;
    this.pavedGeo.attributes.color.needsUpdate = true;
    this.pavedGeo.computeVertexNormals();
    this.pavedGeo.computeBoundingSphere();
  }

  /** 架かっている橋。桁の厚みが支間表、橋脚の長さが深礎の深さ。 */
  syncBridges(net: BridgeNetwork): void {
    if (!net.dirtyVisuals) return;
    net.dirtyVisuals = false;

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const pos = new THREE.Vector3();
    let nPier = 0;
    let nDeck = 0;
    this.pierBridges.length = 0;

    for (const b of net.bridges) {
      if (b.collapsed) continue;
      const type = b.plan.type;
      _c.setHex(type.color);
      if (!b.built) _c.multiplyScalar(0.45); // 施工待ちは暗く (支保のリングと同じ規約)

      // --- 桁 ---
      for (let i = 0; i + 1 < b.path.length; i++) {
        if (nDeck >= 1024) break;
        const a = b.path[i];
        const c = b.path[i + 1];
        pos.copy(a).add(c).multiplyScalar(0.5);
        // 路面の下に桁がぶら下がる
        pos.y -= type.deckDepth * 0.5;
        _u.copy(c).sub(a);
        const len = _u.length() || 1;
        q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), _u.divideScalar(len));
        scale.set(b.width, type.deckDepth, len * 1.02);
        m.compose(pos, q, scale);
        this.decks.setMatrixAt(nDeck, m);
        this.decks.setColorAt(nDeck, _c);
        nDeck++;
      }

      // --- 橋脚 ---
      for (const p of b.plan.piers) {
        if (nPier >= 256) break;
        const top = p.deckY - type.deckDepth;
        const bottom = p.groundY - p.foundDepth;
        const h = Math.max(0.5, top - bottom);
        pos.set(p.x, bottom, p.z);
        q.identity();
        scale.set(1, h, 1);
        m.compose(pos, q, scale);
        this.piers.setMatrixAt(nPier, m);
        this.piers.setColorAt(nPier, p.ok ? _c : _c.clone().setHex(0xe8504a));
        this.pierBridges[nPier] = b;
        nPier++;
      }
    }

    this.piers.count = nPier;
    this.decks.count = nDeck;
    for (const im of [this.piers, this.decks]) {
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
  }

  /**
   * 支持力が足りない橋脚を明滅させる。トンネルの警告柱と同じで、
   * 落橋が近いほど速い = 点滅の速さがそのまま余命になる。
   */
  update(dt: number): void {
    this.t += dt;
    let any = false;
    for (let i = 0; i < this.piers.count; i++) {
      const b = this.pierBridges[i];
      if (!b || BridgeNetwork.worstRatio(b) <= 1) continue;
      any = true;
      const speed = 2 + (1 - Math.max(0, b.integrity)) * 10;
      const k = 0.5 + 0.5 * Math.sin(this.t * speed);
      _c.setRGB(1, 0.05 + 0.3 * b.integrity, 0.05 + 0.1 * b.integrity).multiplyScalar(0.55 + 0.45 * k);
      this.piers.setColorAt(i, _c);
    }
    if (any && this.piers.instanceColor) this.piers.instanceColor.needsUpdate = true;
  }
}

/** HUD 用。橋の中身を 1 行で。 */
export function describeBridge(p: BridgePlan): string {
  return `${p.type.name} ${p.spans} 径間 @ ${p.spanLength.toFixed(0)} m / 橋脚 ${p.piers.length} 基`;
}
