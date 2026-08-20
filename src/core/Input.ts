import * as THREE from 'three';

/** 一人称の狙いはいつでも画面の中心。 */
const CENTER = new THREE.Vector2(0, 0);

/**
 * ポインタの状態を NDC で保持し、カメラからのレイを作る。
 * ツール側は「今どこを指しているか」「押されているか」だけを見ればよい。
 */
export class Input {
  readonly ndc = new THREE.Vector2();
  /** 左ボタンが押されているか。 */
  primaryDown = false;
  /**
   * 狙いを画面中央に固定するか。一人称はポインタロックでカーソルが
   * 動かないので、十字の位置 = 画面の中心がそのまま狙いになる。
   */
  centered = false;
  private _inside = false;
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
      this._inside = true;
    });
    dom.addEventListener('pointerleave', () => {
      this._inside = false;
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

  /** 画面内を指しているか。中央固定のときは常に指している。 */
  get inside(): boolean {
    return this.centered || this._inside;
  }

  /** カメラからポインタ方向への正規化レイ方向。 */
  rayDirection(camera: THREE.Camera, out: THREE.Vector3): THREE.Vector3 {
    this.raycaster.setFromCamera(this.centered ? CENTER : this.ndc, camera);
    return out.copy(this.raycaster.ray.direction).normalize();
  }

  rayOrigin(camera: THREE.Camera, out: THREE.Vector3): THREE.Vector3 {
    this.raycaster.setFromCamera(this.centered ? CENTER : this.ndc, camera);
    return out.copy(this.raycaster.ray.origin);
  }

  /**
   * 押し下げの状態をまとめて落とす。
   * ポインタロックが外れる瞬間は mouseup を取りこぼすことがあり、
   * 押しっぱなしのまま残ると俯瞰へ戻った先で掘り続ける。
   */
  clear(): void {
    this.primaryDown = false;
    this.primaryPressed = false;
    this.primaryReleased = false;
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
