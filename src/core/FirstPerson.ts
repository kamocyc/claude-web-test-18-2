import * as THREE from 'three';
import { EYE_HEIGHT, Player, type MoveInput } from '../game/Player';
import type { VoxelField } from '../terrain/VoxelField';

/**
 * 一人称の操作。ポインタロック + WASD + マウス視点。
 *
 * カメラは `Engine` が 1 台しか持っていないので、ここは**俯瞰の
 * OrbitControls と排他で**同じカメラを動かす。有効な間だけ位置と姿勢を
 * 毎フレーム上書きし、抜けるときは何も後始末しない (俯瞰側が自分で
 * `lookAt` し直す)。二重に持つと、切り替えた瞬間にカメラが飛ぶ。
 *
 * 視点を掴む (ポインタロック) のはブラウザの都合でクリックが要る。
 * ロックが外れている間は歩けもしないので、道具の操作もそこで止める
 * (でないと「視点を掴むためのクリック」でいきなり地面を掘ることになる)。
 */
export class FirstPerson {
  readonly player = new Player();
  /** 一人称モードか。 */
  active = false;
  /** ポインタロックを掴んでいるか。 */
  locked = false;
  /** マウス感度 [rad/px]。 */
  sensitivity = 0.0022;
  /** ホイールで道具を送る。一人称では WASD が塞がるのでこれが持ち替え口になる。 */
  onWheel: (dir: number) => void = () => {};
  /** ロックが外れた (Esc・タブ切替)。押しっぱなしの後始末を外へ知らせる。 */
  onUnlock: () => void = () => {};

  private keys = new Set<string>();
  private input: MoveInput = { forward: 0, strafe: 0, jump: false, run: false };

  constructor(
    private camera: THREE.PerspectiveCamera,
    private dom: HTMLElement,
  ) {
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.dom;
      if (!this.locked) {
        this.keys.clear();
        this.onUnlock();
      }
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.active || !this.locked) return;
      const p = this.player;
      p.yaw -= e.movementX * this.sensitivity;
      p.pitch -= e.movementY * this.sensitivity;
      // 真上・真下で頭がひっくり返らないように少し手前で止める
      const lim = Math.PI * 0.5 - 0.01;
      p.pitch = Math.max(-lim, Math.min(lim, p.pitch));
    });

    window.addEventListener('keydown', (e) => {
      if (!this.active) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      this.keys.add(e.code);
      // Space はページを送ってしまう
      if (e.code === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    // タブを離れている間に離されたキーは拾えない。押しっぱなしで走り続けるのを防ぐ。
    window.addEventListener('blur', () => this.keys.clear());

    this.dom.addEventListener(
      'wheel',
      (e) => {
        if (!this.active || !this.locked) return;
        e.preventDefault();
        this.onWheel(e.deltaY > 0 ? 1 : -1);
      },
      { passive: false },
    );
  }

  /** 一人称に入る。(x, z) の地表に立たせ、今のカメラの向きをそのまま引き継ぐ。 */
  enter(field: VoxelField, x: number, z: number): void {
    this.active = true;
    this.player.placeAt(field, x, z);
    // 向きは俯瞰のカメラの視線から取る。入った瞬間に別の方角を向いていると、
    // 自分がどこに立ったのか分からなくなる。
    const dir = this.camera.getWorldDirection(new THREE.Vector3());
    this.player.yaw = Math.atan2(-dir.x, -dir.z);
    this.player.pitch = 0;
    this.requestLock();
  }

  exit(): void {
    this.active = false;
    this.keys.clear();
    if (document.pointerLockElement === this.dom) document.exitPointerLock();
  }

  /** クリックで視点を掴み直す。 */
  requestLock(): void {
    if (!this.active || this.locked) return;
    // 直前に外したばかりだとブラウザに断られる。断られても実害は無い
    // (案内が出たままになるだけ) ので、拒否は握りつぶす。
    const r = this.dom.requestPointerLock() as unknown as Promise<void> | undefined;
    if (r && typeof r.catch === 'function') r.catch(() => {});
  }

  /** 1 フレーム進める。dt は実時間 [s]。 */
  update(field: VoxelField, dt: number): void {
    if (!this.active) return;
    const k = this.keys;
    const on = this.locked;
    this.input.forward = on ? num(k.has('KeyW')) - num(k.has('KeyS')) : 0;
    this.input.strafe = on ? num(k.has('KeyD')) - num(k.has('KeyA')) : 0;
    this.input.jump = on && k.has('Space');
    this.input.run = on && (k.has('ShiftLeft') || k.has('ShiftRight'));

    this.player.update(field, dt, this.input);

    const p = this.player;
    this.camera.position.set(p.pos.x, p.pos.y + EYE_HEIGHT, p.pos.z);
    // yaw → pitch の順 (YXZ)。逆にすると水平線が傾く。
    this.camera.rotation.set(p.pitch, p.yaw, 0, 'YXZ');
  }
}

function num(b: boolean): number {
  return b ? 1 : 0;
}
