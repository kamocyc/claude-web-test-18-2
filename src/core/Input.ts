import * as THREE from 'three';

/**
 * ポインタの状態を NDC で保持し、カメラからのレイを作る。
 * ツール側は「今どこを指しているか」「押されているか」だけを見ればよい。
 */
export class Input {
  readonly ndc = new THREE.Vector2();
  /** 左ボタンが押されているか。 */
  primaryDown = false;
  /** 画面内にポインタがあるか。 */
  inside = false;
  /** このフレームで押し下げが始まったか。 */
  primaryPressed = false;
  /** このフレームで離されたか。 */
  primaryReleased = false;

  private raycaster = new THREE.Raycaster();

  constructor(private dom: HTMLElement) {
    dom.addEventListener('pointermove', (e) => {
      const r = dom.getBoundingClientRect();
      this.ndc.set(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1,
      );
      this.inside = true;
    });
    dom.addEventListener('pointerleave', () => {
      this.inside = false;
      this.primaryDown = false;
    });
    dom.addEventListener('pointerdown', (e) => {
      if (e.button === 0) {
        this.primaryDown = true;
        this.primaryPressed = true;
      }
    });
    window.addEventListener('pointerup', (e) => {
      if (e.button === 0 && this.primaryDown) {
        this.primaryDown = false;
        this.primaryReleased = true;
      }
    });
    // 右クリックメニューはカメラ操作の邪魔になるので殺す
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** カメラからポインタ方向への正規化レイ方向。 */
  rayDirection(camera: THREE.Camera, out: THREE.Vector3): THREE.Vector3 {
    this.raycaster.setFromCamera(this.ndc, camera);
    return out.copy(this.raycaster.ray.direction).normalize();
  }

  rayOrigin(camera: THREE.Camera, out: THREE.Vector3): THREE.Vector3 {
    this.raycaster.setFromCamera(this.ndc, camera);
    return out.copy(this.raycaster.ray.origin);
  }

  /** フレーム末に呼んでエッジフラグを落とす。 */
  endFrame(): void {
    this.primaryPressed = false;
    this.primaryReleased = false;
  }

  get element(): HTMLElement {
    return this.dom;
  }
}
