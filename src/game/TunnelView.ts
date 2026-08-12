import * as THREE from 'three';
import type { TunnelNetwork, TunnelSegment } from './Tunnel';
import { supportDef } from './Support';

/**
 * トンネルセグメントの可視化。
 *
 * 支保の状態が一目で分かることが最優先。
 *   灰・茶・青灰 = 支保が入っている (種類ごとの色)
 *   黄 → 赤      = 支保不足。健全度が下がるほど赤い
 *   暗い赤       = 崩落済み
 * リングは掘削半径に合わせて置くので、坑道の太さもそのまま読める。
 */

const UNIT_TORUS = new THREE.TorusGeometry(1, 0.075, 8, 28);
/** 警告柱。原点から +Y へ高さ 1 の細い柱 (スケールで伸ばす)。 */
const UNIT_BEAM = new THREE.CylinderGeometry(0.28, 0.28, 1, 6).translate(0, 0.5, 0);
const MAX_INSTANCES = 4000;
const MAX_BEAMS = 512;

const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const Z = new THREE.Vector3(0, 0, 1);

export class TunnelView {
  readonly object = new THREE.Group();
  private rings: THREE.InstancedMesh;
  /** 支保不足の区間から地表へ立てる警告柱。地形を透かして見える。 */
  private beams: THREE.InstancedMesh;
  private beamSegs: TunnelSegment[] = [];
  private riskRings: number[] = [];
  private ringSegs: TunnelSegment[] = [];
  private puffs: THREE.Mesh[] = [];
  private puffAge: number[] = [];
  private t = 0;

  constructor() {
    const mat = new THREE.MeshStandardMaterial({
      roughness: 0.6,
      metalness: 0.1,
      vertexColors: false,
    });
    this.rings = new THREE.InstancedMesh(UNIT_TORUS, mat, MAX_INSTANCES);
    this.rings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.rings.count = 0;
    this.rings.frustumCulled = false;
    this.object.add(this.rings);

    // 警告柱は地形の中に埋まっているので、深度テストを切って必ず手前に出す。
    // 「山の向こう側で崩れかけている」を外から気づけるようにするのが目的。
    const beamMat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.85,
      depthTest: false,
      depthWrite: false,
    });
    this.beams = new THREE.InstancedMesh(UNIT_BEAM, beamMat, MAX_BEAMS);
    this.beams.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.beams.count = 0;
    this.beams.frustumCulled = false;
    this.beams.renderOrder = 20;
    this.object.add(this.beams);
  }

  private static colorFor(seg: TunnelSegment, out: THREE.Color): THREE.Color {
    if (seg.collapsed) return out.setHex(0x4a2620);
    if (seg.installed >= seg.required && seg.required > 0) {
      return out.setHex(supportDef(seg.installed)?.color ?? 0xaaaaaa);
    }
    if (seg.installed > 0) return out.setHex(supportDef(seg.installed)?.color ?? 0xaaaaaa);
    if (seg.required === 0) return out.setHex(0x5c6b7a); // 岩・無支保で足りている
    // 支保不足: 健全度が落ちるほど赤へ
    return out.setRGB(1, 0.78 * seg.integrity, 0.12 * seg.integrity);
  }

  sync(net: TunnelNetwork): void {
    if (!net.dirtyVisuals) return;
    net.dirtyVisuals = false;

    let n = 0;
    let b = 0;
    this.riskRings.length = 0;
    this.ringSegs.length = 0;
    this.beamSegs.length = 0;

    for (const seg of net.segments) {
      if (n >= MAX_INSTANCES) break;
      if (!seg.isTunnel && !seg.collapsed) continue;

      _q.setFromUnitVectors(Z, seg.dir);
      _s.setScalar(seg.radius);
      _m.compose(seg.pos, _q, _s);
      this.rings.setMatrixAt(n, _m);
      this.rings.setColorAt(n, TunnelView.colorFor(seg, _c));

      const atRisk = !seg.collapsed && seg.isTunnel && seg.installed < seg.required;
      if (atRisk) this.riskRings.push(n);
      this.ringSegs[n] = seg;
      n++;

      // 支保不足の区間からは地表まで柱を立てる
      if (atRisk && b < MAX_BEAMS) {
        const h = seg.cover + seg.radius * 2 + 4;
        _q.identity();
        _s.set(1, h, 1);
        _m.compose(seg.pos, _q, _s);
        this.beams.setMatrixAt(b, _m);
        this.beamSegs[b] = seg;
        b++;
      }
    }
    this.rings.count = n;
    this.beams.count = b;
    this.rings.instanceMatrix.needsUpdate = true;
    this.beams.instanceMatrix.needsUpdate = true;
    if (this.rings.instanceColor) this.rings.instanceColor.needsUpdate = true;
  }

  /**
   * 支保不足の所だけ毎フレーム点滅させる。
   * 静止した色だと、地質による色分けに紛れて「まずい」ことが伝わらない。
   * 崩落が近いほど速く明滅させ、残り時間が見た目の周期に出るようにする。
   */
  private pulse(dt: number): void {
    if (this.riskRings.length === 0 && this.beams.count === 0) return;
    this.t += dt;

    for (const i of this.riskRings) {
      const seg = this.ringSegs[i];
      if (!seg) continue;
      const speed = 2 + (1 - Math.max(0, seg.integrity)) * 10;
      const k = 0.55 + 0.45 * Math.sin(this.t * speed);
      TunnelView.colorFor(seg, _c);
      this.rings.setColorAt(i, _c.multiplyScalar(k));
    }
    if (this.riskRings.length > 0 && this.rings.instanceColor) {
      this.rings.instanceColor.needsUpdate = true;
    }

    for (let i = 0; i < this.beams.count; i++) {
      const seg = this.beamSegs[i];
      if (!seg) continue;
      const speed = 2 + (1 - Math.max(0, seg.integrity)) * 10;
      const k = 0.5 + 0.5 * Math.sin(this.t * speed);
      _c.setRGB(1, 0.75 * seg.integrity, 0.1).multiplyScalar(0.55 + 0.45 * k);
      this.beams.setColorAt(i, _c);
    }
    if (this.beams.instanceColor) this.beams.instanceColor.needsUpdate = true;
  }

  /** 崩落した所に土煙を出す。 */
  burst(pos: THREE.Vector3, radius: number): void {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 14, 10),
      new THREE.MeshBasicMaterial({
        color: 0x8a7259,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      }),
    );
    m.position.copy(pos);
    this.object.add(m);
    this.puffs.push(m);
    this.puffAge.push(0);
  }

  update(dt: number): void {
    this.pulse(dt);
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      this.puffAge[i] += dt;
      const t = this.puffAge[i] / 1.6;
      const m = this.puffs[i];
      if (t >= 1) {
        this.object.remove(m);
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
        this.puffs.splice(i, 1);
        this.puffAge.splice(i, 1);
        continue;
      }
      m.scale.setScalar(1 + t * 1.8);
      (m.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - t);
    }
  }
}
