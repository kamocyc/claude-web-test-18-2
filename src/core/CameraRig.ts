import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/**
 * 軌道カメラ。
 *
 * 掘削モードでは左ドラッグをツールに明け渡し、回転を中ボタン / 右ドラッグへ移す。
 * M1 の時点では常に閲覧モード (左ドラッグ = 回転)。
 */
export class CameraRig {
  readonly controls: OrbitControls;
  private digMode = false;
  private enabled = true;

  constructor(camera: THREE.PerspectiveCamera, dom: HTMLElement) {
    this.controls = new OrbitControls(camera, dom);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = false;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 320;
    // 地下から見上げられるように上下の制限を外し気味にしておく
    this.controls.maxPolarAngle = Math.PI * 0.99;
    this.setDigMode(false);
  }

  setDigMode(on: boolean): void {
    this.digMode = on;
    this.controls.mouseButtons = {
      LEFT: on ? null : THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: on ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN,
    };
  }

  get isDigMode(): boolean {
    return this.digMode;
  }

  /**
   * 一人称に入っている間は止める。
   * 止めないと、同じカメラを毎フレーム両方が書きに来て、
   * 減衰の残りが一人称の視点をじわじわ引っぱる。
   */
  setEnabled(on: boolean): void {
    this.enabled = on;
    this.controls.enabled = on;
  }

  lookAt(target: THREE.Vector3, from: THREE.Vector3): void {
    this.controls.target.copy(target);
    this.controls.object.position.copy(from);
    this.controls.update();
  }

  update(): void {
    if (!this.enabled) return;
    this.controls.update();
  }
}
