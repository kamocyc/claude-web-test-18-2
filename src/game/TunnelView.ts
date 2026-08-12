import * as THREE from 'three';
import { SEGMENT_LENGTH, type TunnelNetwork, type TunnelSegment } from './Tunnel';
import { supportDef } from './Support';

/**
 * トンネルセグメントの可視化。
 *
 * 支保の種類と状態が一目で分かることが最優先。
 * 色だけで区別させると、暗い坑内では読めないし、地質の色分けとも紛れる。
 * そこで **形を変える**。実際の構造物がそうなっている、というのがそのまま根拠になる。
 *
 *   木枠 (L1)   … 細いリングが飛び飛び。あいだから地山がそのまま見える
 *   覆工 (L2)   … 連続した滑らかな覆工チューブ。地山が完全に隠れる
 *   鋼製 (L3)   … 覆工チューブ + 太いリブ。いちばん重装備に見える
 *   支保不足    … 黄→赤に明滅するリング。崩落が近いほど速い
 *   崩落済み    … 暗い赤
 *
 * さらに支保不足の区間からは地表へ警告柱を立てる (深度テストを切ってあるので
 * 山の向こう側でも外から気づける)。
 */

const UNIT_TORUS = new THREE.TorusGeometry(1, 0.075, 8, 28);
/** 太いリブ (鋼製支保用)。 */
const UNIT_RIB = new THREE.TorusGeometry(1, 0.16, 8, 28);
/** 覆工チューブ。Y 軸方向の開いた円筒。内側から見るので BackSide で描く。 */
const UNIT_TUBE = new THREE.CylinderGeometry(1, 1, 1, 24, 1, true);
/** 警告柱。原点から +Y へ高さ 1 の細い柱 (スケールで伸ばす)。 */
const UNIT_BEAM = new THREE.CylinderGeometry(0.28, 0.28, 1, 6).translate(0, 0.5, 0);

const MAX_INSTANCES = 4000;
const MAX_BEAMS = 512;

const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const Z = new THREE.Vector3(0, 0, 1);
const Y = new THREE.Vector3(0, 1, 0);

export class TunnelView {
  readonly object = new THREE.Group();
  private rings: THREE.InstancedMesh;
  private ribs: THREE.InstancedMesh;
  private tubes: THREE.InstancedMesh;
  private beams: THREE.InstancedMesh;

  private beamSegs: TunnelSegment[] = [];
  private riskRings: number[] = [];
  private ringSegs: TunnelSegment[] = [];
  private puffs: THREE.Mesh[] = [];
  private puffAge: number[] = [];
  private t = 0;

  constructor() {
    // 坑内は暗いので、わずかに自発光させないと支保の色が読めない
    const structMat = () => new THREE.MeshStandardMaterial({
      roughness: 0.65,
      metalness: 0.15,
      emissive: new THREE.Color(0x2a2a2e),
    });

    this.rings = TunnelView.mkInstanced(UNIT_TORUS, structMat(), MAX_INSTANCES);
    this.ribs = TunnelView.mkInstanced(UNIT_RIB, structMat(), MAX_INSTANCES);

    const tubeMat = structMat();
    tubeMat.side = THREE.BackSide;
    this.tubes = TunnelView.mkInstanced(UNIT_TUBE, tubeMat, MAX_INSTANCES);

    // 警告柱は地形の中に埋まっているので、深度テストを切って必ず手前に出す。
    // 「山の向こう側で崩れかけている」を外から気づけるようにするのが目的。
    const beamMat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.85,
      depthTest: false,
      depthWrite: false,
    });
    this.beams = TunnelView.mkInstanced(UNIT_BEAM, beamMat, MAX_BEAMS);
    this.beams.renderOrder = 20;

    this.object.add(this.tubes, this.rings, this.ribs, this.beams);
  }

  private static mkInstanced(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    max: number,
  ): THREE.InstancedMesh {
    const m = new THREE.InstancedMesh(geo, mat, max);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.count = 0;
    m.frustumCulled = false;
    return m;
  }

  private static colorFor(seg: TunnelSegment, out: THREE.Color): THREE.Color {
    if (seg.collapsed) return out.setHex(0x4a2620);
    if (seg.installed > 0) {
      return out.setHex(supportDef(seg.installed)?.color ?? 0xaaaaaa);
    }
    if (seg.installed >= seg.required) return out.setHex(0x5c6b7a); // 岩・無支保で足りている
    // 支保不足: 健全度が落ちるほど赤へ
    return out.setRGB(1, 0.78 * seg.integrity, 0.12 * seg.integrity);
  }

  sync(net: TunnelNetwork): void {
    if (!net.dirtyVisuals) return;
    net.dirtyVisuals = false;

    let nRing = 0;
    let nRib = 0;
    let nTube = 0;
    let nBeam = 0;
    this.riskRings.length = 0;
    this.ringSegs.length = 0;
    this.beamSegs.length = 0;

    for (const seg of net.segments) {
      if (nRing >= MAX_INSTANCES) break;
      if (!seg.isTunnel && !seg.collapsed) continue;

      const atRisk = !seg.collapsed && seg.isTunnel && seg.installed < seg.required;
      TunnelView.colorFor(seg, _c);

      // --- 覆工チューブ (L2 以上)。地山を覆うので「巻いた」ことが一目で分かる ---
      if (seg.installed >= 2 && !seg.collapsed) {
        _q.setFromUnitVectors(Y, seg.dir);
        _s.set(seg.radius * 0.96, SEGMENT_LENGTH * 1.06, seg.radius * 0.96);
        _m.compose(seg.pos, _q, _s);
        this.tubes.setMatrixAt(nTube, _m);
        this.tubes.setColorAt(nTube, _c);
        nTube++;
      }

      // --- リング / リブ ---
      _q.setFromUnitVectors(Z, seg.dir);
      _s.setScalar(seg.radius);
      _m.compose(seg.pos, _q, _s);

      if (seg.installed >= 3 && !seg.collapsed) {
        // 鋼製支保は太いリブ。いちばん重装備に見せる。
        this.ribs.setMatrixAt(nRib, _m);
        this.ribs.setColorAt(nRib, _c);
        nRib++;
      } else {
        this.rings.setMatrixAt(nRing, _m);
        this.rings.setColorAt(nRing, _c);
        if (atRisk) this.riskRings.push(nRing);
        this.ringSegs[nRing] = seg;
        nRing++;
      }

      // --- 支保不足の区間からは地表まで警告柱を立てる ---
      if (atRisk && nBeam < MAX_BEAMS) {
        const h = seg.cover + seg.radius * 2 + 4;
        _q.identity();
        _s.set(1, h, 1);
        _m.compose(seg.pos, _q, _s);
        this.beams.setMatrixAt(nBeam, _m);
        this.beamSegs[nBeam] = seg;
        nBeam++;
      }
    }

    this.rings.count = nRing;
    this.ribs.count = nRib;
    this.tubes.count = nTube;
    this.beams.count = nBeam;
    for (const m of [this.rings, this.ribs, this.tubes, this.beams]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  /**
   * 支保不足の所だけ毎フレーム明滅させる。
   * 静止した色だと、地質による色分けに紛れて「まずい」ことが伝わらない。
   * 崩落が近いほど速く明滅させ、残り時間が見た目の周期にも出るようにする。
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
