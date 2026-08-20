import * as THREE from 'three';
import { CELL, WORLD_X, WORLD_Y, WORLD_Z } from '../terrain/config';
import type { VoxelField } from '../terrain/VoxelField';
import { surfaceNormalAt } from '../terrain/raymarch';

/**
 * 一人称の身体。
 *
 * ---- なぜ高さ場ではなく密度場に当てるのか ----
 * このゲームの主役はトンネルなので、**自分で掘った坑道の中を歩けない**一人称は
 * 意味がない。高さ場 (HeightIndex) は列ごとの最上面しか持っていないから、
 * それに乗せると坑道の中に入った瞬間に山の上へ弾き出される。
 * 密度場を直接見れば、坑道の床も切羽も掘った瞬間の形のまま当たる。
 *
 * ---- 太さは円柱の縁を突いて見る ----
 * 密度は概ね符号付き距離なので「中心 1 点で d > -r なら太さぶん当たっている」と
 * したくなるが、これだと**地面の上に立っているだけで当たり判定に入る**
 * (足の 0.2 m 上は地表から 0.2 m しか離れていない)。距離は等方なので、
 * 横に当たっているのか下に乗っているのかを区別できない。
 *
 * そこで、高さ 3 段 x (中心 + 前後左右 4 点) の 15 点を突いて、
 * **その点が固体か (d > 0) だけ**を見る。円柱の内側の点しか見ないので、
 * 乗っている地面は当たりにならず、横の壁と頭上の天井だけが当たる。
 *
 * いちばん下の段を足元から 0.45 m にしてあるのは意味がある。半径 0.34 m の
 * 縁が斜面に埋まるのは tan(θ) > 0.45/0.34、つまり **53 度**から。
 * 歩ける斜面の上限 (`MAX_WALK_DEG` = 52 度) と勝手に一致するので、
 * 「登れる角度」と「体が当たる角度」が食い違わない。
 */

/** 目の高さ [m]。身長 1.78 m の人間の目の位置。 */
export const EYE_HEIGHT = 1.62;
/** 身体の半径 [m]。坑道 (掘削半径 2.6 m) にすれ違える太さ。 */
export const BODY_RADIUS = 0.34;
/** 身体の高さ [m]。天井の判定に使う。 */
export const BODY_HEIGHT = 1.78;
/** そのまま登れる段差 [m]。列の書き戻しが作る 0.5 m の段を跳ばずに越えられる。 */
export const STEP_UP = 0.62;

/**
 * 歩いて登れる斜面の限界 [度]。
 *
 * ここを段差 (STEP_UP) だけで決めるわけにいかない。1 フレームに進むのは
 * 歩速 4.6 m/s で 8 cm なので、80 度の壁でも 1 歩あたりの登りは 44 cm しかなく、
 * 段差の上限に引っかからずに垂直な切羽をよじ登れてしまう。
 * 段の**上の面が歩ける傾きか**で判定すれば、0.5 m の段 (上は平ら) は登れて、
 * 連続した急斜面は登れない。
 *
 * 52 度にしてあるのは工法の等級を足で分からせるため。
 * 安息角 34 度と種子吹付 45 度は登れ、法枠 65 度・擁壁 88 度・原地盤 85 度は登れない。
 */
export const MAX_WALK_DEG = 52;
const MIN_WALK_NY = Math.cos((MAX_WALK_DEG * Math.PI) / 180);

export const WALK_SPEED = 4.6;
export const RUN_SPEED = 8.4;
/** 重力 [m/s^2]。実測の 9.8 だと落下が間延びして「操作している感じ」が消える。 */
export const GRAVITY = 22;
/** ジャンプの初速 [m/s]。到達高さは v^2/2g = 1.0 m。段差 (0.62 m) より少し高い。 */
export const JUMP_SPEED = 6.6;
/** 落下速度の上限 [m/s]。谷底まで 50 m あるので、無いと 1 フレームで飛ぶ。 */
const MAX_FALL = 55;

/** 手の届く距離 [m]。一人称で扱えるのはここまで。 */
export const REACH = 4.5;

export interface MoveInput {
  /** 前 +1 / 後ろ -1 */
  forward: number;
  /** 右 +1 / 左 -1 */
  strafe: number;
  jump: boolean;
  run: boolean;
}

/**
 * 突く高さ [m]。脛・胴の中心・胸・目。
 *
 * 4 段なのは間隔を 0.45 m 以下に保つため。3 段 (0.6 m 間隔) だと、
 * 掘り跡に残った厚さ 0.5 m の板が段と段の隙間をすり抜けて、
 * 板の中を歩けてしまう (実測: 実地形の走り回りで体の中心が 5 cm 埋まった)。
 * **目の高さ (1.62 m) をそのまま 1 段に採ってある**ので、
 * 「カメラが地面の中に入る」は当たり判定の側で塞がっている。
 */
const PROBE_H = [0.45, 0.89, 1.3, EYE_HEIGHT];
/** 円柱の縁を突く向き。斜め 45 度は取らない (角ですり抜けても実害が無い)。 */
const PROBE_RING = [
  [BODY_RADIUS, 0], [-BODY_RADIUS, 0], [0, BODY_RADIUS], [0, -BODY_RADIUS],
];

/** 身体 (半径 BODY_RADIUS の円柱) がその足元位置に入れないか。 */
export function bodyBlocked(field: VoxelField, x: number, footY: number, z: number): boolean {
  for (const h of PROBE_H) {
    const y = footY + h;
    if (field.sample(x, y, z) > 0) return true;
    for (const d of PROBE_RING) {
      if (field.sample(x + d[0], y, z + d[1]) > 0) return true;
    }
  }
  return false;
}

/**
 * (x, z) で y0 から下へ、最初に地面 (空気 → 固体) が現れる高さ [m]。
 * 見つからなければ null。刻みと二分の作りは `raycastTerrain` と同じ規約。
 *
 * y0 自身が固体なら null を返す (= 埋まっている)。持ち上げるのは `unstuck` の仕事で、
 * ここで面倒を見ると「天井に頭を突っ込んだら天井の上に立つ」になる。
 */
export function groundBelow(
  field: VoxelField,
  x: number, y0: number, z: number,
  maxDrop: number,
): number | null {
  if (maxDrop <= 0 || field.sample(x, y0, z) > 0) return null;
  const step = CELL * 0.5;
  let prev = y0;
  // 刻みは半セル。ただし**最後は必ず maxDrop ちょうどを見る**。
  // 刻みで割り切れない窓 (1 フレームの落下量は数 cm) を素通りすると、
  // 地面が見つからないまま通り抜けて沈み続ける。
  for (let t = Math.min(step, maxDrop); ; t = Math.min(t + step, maxDrop)) {
    const y = y0 - t;
    if (y < 0) break;
    if (field.sample(x, y, z) > 0) {
      let lo = y;
      let hi = prev;
      for (let it = 0; it < 12; it++) {
        const mid = (lo + hi) * 0.5;
        if (field.sample(x, mid, z) > 0) lo = mid;
        else hi = mid;
      }
      return hi;
    }
    prev = y;
    if (t >= maxDrop) break;
  }
  return null;
}

/** 段差の上の面の向きを見るための作業用。毎フレーム確保しない。 */
const _n = new THREE.Vector3();

export class Player {
  /** 足元のワールド座標。 */
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  /** 水平の向き [rad]。0 で -Z を向く (three のカメラの既定と同じ)。 */
  yaw = 0;
  /** 上下の向き [rad]。真上 +pi/2。 */
  pitch = 0;
  onGround = false;

  /** 目の高さのワールド座標。カメラはここに置く。 */
  eyePosition(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.pos.x, this.pos.y + EYE_HEIGHT, this.pos.z);
  }

  /** 視線の向き。 */
  lookDirection(out: THREE.Vector3): THREE.Vector3 {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  /** (x, z) の地表に立たせる。空から降ろすので、庇の下ではなく最上面に乗る。 */
  placeAt(field: VoxelField, x: number, z: number): void {
    this.pos.set(clampWorld(x, WORLD_X), WORLD_Y - 0.5, clampWorld(z, WORLD_Z));
    const g = groundBelow(field, this.pos.x, WORLD_Y - 0.5, this.pos.z, WORLD_Y);
    this.pos.y = g ?? 1;
    this.vel.set(0, 0, 0);
    this.onGround = g !== null;
  }

  /**
   * 1 フレーム進める。dt は実時間 [s]。
   *
   * 時間倍率 (0-3 キー) は掛けない。止めた時間の中でも歩き回れないと、
   * 崩落の様子を見に行くこともできない。
   */
  update(field: VoxelField, dt: number, input: MoveInput): void {
    if (dt <= 0) return;
    this.resolve(field, dt);

    // --- 水平の速度。空中では効きを落とす (空中で急旋回できると軽く見える) ---
    const speed = input.run ? RUN_SPEED : WALK_SPEED;
    const sy = Math.sin(this.yaw);
    const cy = Math.cos(this.yaw);
    let tx = -sy * input.forward + cy * input.strafe;
    let tz = -cy * input.forward - sy * input.strafe;
    const len = Math.hypot(tx, tz);
    if (len > 1e-6) {
      const s = (Math.min(1, len) * speed) / len;
      tx *= s;
      tz *= s;
    }
    const k = 1 - Math.exp(-(this.onGround ? 18 : 3.5) * dt);
    this.vel.x += (tx - this.vel.x) * k;
    this.vel.z += (tz - this.vel.z) * k;

    // --- ジャンプ ---
    if (input.jump && this.onGround) {
      this.vel.y = JUMP_SPEED;
      this.onGround = false;
    }

    // 1 歩が半セルを超えないように割る。割らないと、走りながら
    // 厚さ 0.5 m の壁を跨いで通り抜ける (行き先だけを見ているため)。
    // タブ復帰の dt (Time が 0.1 s で頭打ち) でも 8 分割で足りる。
    const reachStep = this.vel.length() * dt;
    const n = Math.max(1, Math.min(8, Math.ceil(reachStep / (CELL * 0.5))));
    const h = dt / n;
    for (let step = 0; step < n; step++) this.integrate(field, h);

    // 動いた先でもう一度解く。落ちながら急な法面を擦るときは、
    // 鉛直の移動が縁の当たりを見ていない (地面は中心の真下だけを見る) ので、
    // ここで押し戻さないと体が壁を 5-6 cm 削りながら落ちる。
    this.resolve(field, dt);
  }

  /** 1 刻みぶんの積分。速度は呼ぶ側が決めてある。 */
  private integrate(field: VoxelField, dt: number): void {
    this.vel.y = Math.max(-MAX_FALL, this.vel.y - GRAVITY * dt);

    // --- 水平移動。軸ごとに試すと、壁に斜めに当たったとき壁沿いに滑る ---
    this.moveAxis(field, this.vel.x * dt, true);
    this.moveAxis(field, this.vel.z * dt, false);

    // --- 垂直移動と接地 ---
    const dy = this.vel.y * dt;
    let y = this.pos.y + dy;
    if (dy > 0 && bodyBlocked(field, this.pos.x, y, this.pos.z)) {
      // 天井に頭をぶつけた
      y = this.pos.y;
      this.vel.y = 0;
    }
    // 接地中は下り坂に貼りつく。貼りつかないと、坂を下るたびに
    // 数 cm ずつ落下しては着地するので、視点が細かく上下して酔う。
    const snap = this.onGround && this.vel.y <= 0 ? STEP_UP : 0;
    // 測り始めは**動く前の足元の少し上**から。動いた先から測ると、
    // 速く落ちて地面を通り越したフレームで起点が地中に入り、
    // 地面が見つからないまま沈み続ける (実測で 0.44 m 埋まった)。
    const probeTop = Math.max(this.pos.y, y) + 0.1;
    const g = groundBelow(field, this.pos.x, probeTop, this.pos.z, probeTop - y + snap);
    if (g !== null && y <= g + 1e-4) {
      y = g;
      this.vel.y = 0;
      this.onGround = true;
    } else {
      this.onGround = false;
    }
    this.pos.y = Math.max(0, Math.min(WORLD_Y - BODY_HEIGHT, y));
  }

  /** 1 軸ぶんの水平移動。壁なら止まり、段差なら登る。 */
  private moveAxis(field: VoxelField, d: number, isX: boolean): void {
    if (d === 0) return;
    const x = clampWorld(isX ? this.pos.x + d : this.pos.x, WORLD_X);
    const z = clampWorld(isX ? this.pos.z : this.pos.z + d, WORLD_Z);
    if (!bodyBlocked(field, x, this.pos.y, z)) {
      this.pos.x = x;
      this.pos.z = z;
      return;
    }
    // 段差を登る。接地しているときだけ (空中で壁を登れるとよじ登りになる)
    if (this.onGround) {
      const up = this.pos.y + STEP_UP;
      const g = groundBelow(field, x, up + 0.05, z, STEP_UP + 0.05);
      if (
        g !== null && g > this.pos.y && g - this.pos.y <= STEP_UP &&
        !bodyBlocked(field, x, g, z) &&
        surfaceNormalAt(field, x, g, z, _n).y >= MIN_WALK_NY
      ) {
        this.pos.set(x, g, z);
        return;
      }
    }
    if (isX) this.vel.x = 0;
    else this.vel.z = 0;
  }

  /**
   * 地形と重なっているのを解く。地形が動いたフレームでは外からも呼ぶ。
   *
   * 起きかたが 2 通りあり、直しかたも別になる。
   *
   * 1. **中心まで埋まった** — 足元を掘り抜いた、崩落に埋められた。
   *    真上へ逃がす。列の最上面より上は定義上ぜんぶ空気なので、
   *    十分に上げれば必ず抜けられる (終わることが保証されている)。
   * 2. **縁だけ刺さった** — 急な法面へ落ちて張りついた。
   *    こちらを真上へ逃がしてはいけない。一様な 60 度の斜面では
   *    どの高さでも山側の縁が刺さったままなので、天井まで昇ってしまう。
   *    刺さった向きの逆、つまり**斜面の下側へ押し出す**。
   *    結果として、立てない崖に落ちるとそのまま滑り落ちる。
   */
  resolve(field: VoxelField, dt = 1 / 60): void {
    const { x, z } = this.pos;
    if (field.sample(x, this.pos.y + BODY_HEIGHT * 0.5, z) > 0) {
      for (let y = this.pos.y; y <= WORLD_Y - BODY_HEIGHT; y += CELL * 0.5) {
        if (!bodyBlocked(field, x, y, z)) {
          this.pos.y = y;
          this.vel.set(0, 0, 0);
          return;
        }
      }
      return;
    }

    // --- 縁の押し出し ---
    let px = 0;
    let pz = 0;
    let n = 0;
    let depth = 0;
    for (const h of PROBE_H) {
      const y = this.pos.y + h;
      for (const d of PROBE_RING) {
        const s = field.sample(x + d[0], y, z + d[1]);
        if (s > 0) {
          px -= d[0];
          pz -= d[1];
          if (s > depth) depth = s;
          n++;
        }
      }
    }
    if (n === 0) return;
    const len = Math.hypot(px, pz);
    if (len < 1e-9) {
      // 左右から等しく挟まれていて、押し出す向きが決まらない。上へ逃がす。
      for (let y = this.pos.y; y <= WORLD_Y - BODY_HEIGHT; y += CELL * 0.5) {
        if (!bodyBlocked(field, x, y, z)) {
          this.pos.y = y;
          this.vel.set(0, 0, 0);
          return;
        }
      }
      return;
    }
    // めり込んだ深さぶんを 1 回で戻す (密度はおおむね距離なのでそのまま使える)。
    // 一定速度で押すと、落下 (9 m/s) のほうが速い法面で追いつかない。
    // 下限の 4 m/s は、立てない斜面に張りついたまま止まらないようにするため。
    const k = Math.min(0.5, Math.max(depth + 0.02, 4 * dt)) / len;
    this.pos.x = clampWorld(this.pos.x + px * k, WORLD_X);
    this.pos.z = clampWorld(this.pos.z + pz * k, WORLD_Z);
  }
}

/** ワールドの外周は密度が -1 に固定された壁なので、距離では止まれない。座標で塞ぐ。 */
function clampWorld(v: number, size: number): number {
  return v < 1.2 ? 1.2 : v > size - 1.2 ? size - 1.2 : v;
}
