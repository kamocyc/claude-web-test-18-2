import * as THREE from 'three';
import { GEO_COLOR, Geo } from '../terrain/config';
import type { RayHit } from '../terrain/raymarch';

/**
 * ブラシの位置と大きさを示すカーソル。
 * 地表に貼りつく輪と、影響範囲を示す薄い球。
 * 輪の色を「今そこにある地質」にしておくと、掘る前に地質が読める。
 */
export class BrushCursor {
  readonly object = new THREE.Group();
  private ring: THREE.Mesh;
  private ball: THREE.Mesh;
  private ringMat: THREE.MeshBasicMaterial;
  private ballMat: THREE.MeshBasicMaterial;
  private _radius = 1;

  constructor() {
    this.ringMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      side: THREE.DoubleSide,
    });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 64), this.ringMat);
    this.ring.renderOrder = 10;

    this.ballMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
    });
    this.ball = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), this.ballMat);
    this.ball.renderOrder = 9;

    this.object.add(this.ring, this.ball);
    this.object.visible = false;
  }

  setRadius(r: number): void {
    this._radius = r;
    this.ring.scale.setScalar(r);
    this.ball.scale.setScalar(r);
  }

  hide(): void {
    this.object.visible = false;
  }

  show(hit: RayHit, geo: Geo, mode: 'dig' | 'fill'): void {
    this.object.visible = true;
    this.object.position.copy(hit.point);
    // 輪を法線に合わせて寝かせる
    this.ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), hit.normal);
    this.ring.position.copy(hit.normal).multiplyScalar(0.06);
    this.ball.position.set(0, 0, 0);

    const c = GEO_COLOR[geo];
    this.ringMat.color.setRGB(c[0], c[1], c[2]).multiplyScalar(1.8).addScalar(0.25);
    this.ballMat.color.set(mode === 'dig' ? 0xff9a5c : 0x66d0ff);
    void this._radius;
  }
}
