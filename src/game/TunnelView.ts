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
const MAX_INSTANCES = 4000;

const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const Z = new THREE.Vector3(0, 0, 1);

export class TunnelView {
  readonly object = new THREE.Group();
  private rings: THREE.InstancedMesh;
  private puffs: THREE.Mesh[] = [];
  private puffAge: number[] = [];

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
    for (const seg of net.segments) {
      if (n >= MAX_INSTANCES) break;
      if (!seg.isTunnel && !seg.collapsed) continue;

      _q.setFromUnitVectors(Z, seg.dir);
      _s.setScalar(seg.radius);
      _m.compose(seg.pos, _q, _s);
      this.rings.setMatrixAt(n, _m);
      this.rings.setColorAt(n, TunnelView.colorFor(seg, _c));
      n++;
    }
    this.rings.count = n;
    this.rings.instanceMatrix.needsUpdate = true;
    if (this.rings.instanceColor) this.rings.instanceColor.needsUpdate = true;
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
