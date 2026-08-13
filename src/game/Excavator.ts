import * as THREE from 'three';
import { CELL, DIG_RATE, Geo, WORLD_X, WORLD_Y, WORLD_Z } from '../terrain/config';
import { applyCapsule, type EditResult } from '../terrain/Edit';
import type { VoxelField } from '../terrain/VoxelField';
import type { ChunkManager } from '../terrain/ChunkManager';
import type { RayHit } from '../terrain/raymarch';

/**
 * リアルタイムの掘削。
 *
 * ---- 速度のモデル ----
 * 「掘削ヘッド」がカーソルの少し先を追いかける。ヘッドの進める速さは
 *     v = 掘削速度 [m^3/s] / 断面積 (pi * r^2)
 * なので、岩ではヘッドが目に見えて鈍る。掘れる量ではなく**進み方**が
 * 遅くなるので、地質の差が数字ではなく手応えとして伝わる。
 *
 * カーソルを止めるとヘッドが追いつくが、掘れた分だけ地表が後退するので
 * 狙点も奥へ進み、そのまま素直に「掘り進む」動きになる。
 * ヘッドが追いつけない間は地表が後退しないので、勝手に暴走もしない。
 */
export class Excavator {
  radius = 2.6;
  /** スムーズ演算のブレンド幅 [m]。斜めのトンネルが自然に開口する肝。 */
  blend = 0.5;
  mode: 'dig' | 'fill' = 'dig';

  /** 盛土の速度 [m^3/s]。地質によらず一定。 */
  static readonly FILL_RATE = 12.0;

  private head = new THREE.Vector3();
  private active = false;
  private _lastGeo: Geo = Geo.Soil;
  private _headSpeed = 0;

  /** 直前フレームにヘッドが居た地質。HUD の表示に使う。 */
  get headGeology(): Geo {
    return this._lastGeo;
  }

  /** 直前フレームのヘッド速度 [m/s]。 */
  get headSpeed(): number {
    return this._headSpeed;
  }

  get isActive(): boolean {
    return this.active;
  }

  /** 掘削ヘッドの現在位置。トンネル中心線の記録に使う。 */
  get headPosition(): THREE.Vector3 {
    return this.head;
  }

  /**
   * ヘッドは地表の「手前」、ブラシ球が地表に接する位置から始める。
   * 地表の上に中心を置くと初手でいきなり球ぶんの大穴 (半径 2.6 m なら 70 m^3) が
   * 開いてしまい、地質による速度差が体積に出てこない。
   * 接する位置から始めれば、削れる量は概ね「断面積 x 進んだ距離」になり、
   * 単位時間あたりの掘削量が DIG_RATE そのものになる。
   */
  begin(hit: RayHit, rayDir: THREE.Vector3): void {
    this.active = true;
    this.head.copy(hit.point).addScaledVector(rayDir, -this.radius);
  }

  end(): void {
    this.active = false;
    this._headSpeed = 0;
  }

  /**
   * 1 フレーム分進める。実際に場が変わったら EditResult を返す。
   * @param dt 実時間 [s] に速度倍率を掛けたもの
   */
  update(
    field: VoxelField,
    chunks: ChunkManager,
    dt: number,
    hit: RayHit | null,
    rayDir: THREE.Vector3,
  ): EditResult | null {
    if (!this.active || !hit || dt <= 0) return null;

    const r = this.radius;
    const area = Math.PI * r * r;

    // 狙点はカーソルの少し奥 (掘る) / 少し手前 (盛る)
    const target = new THREE.Vector3();
    if (this.mode === 'dig') {
      target.copy(rayDir).multiplyScalar(r * 0.9).add(hit.point);
    } else {
      target.copy(hit.normal).multiplyScalar(r * 0.6).add(hit.point);
    }

    // ワールドの外へは出さない
    target.set(
      THREE.MathUtils.clamp(target.x, 0, WORLD_X),
      THREE.MathUtils.clamp(target.y, 0, WORLD_Y),
      THREE.MathUtils.clamp(target.z, 0, WORLD_Z),
    );

    const geo = field.materialAt(this.head.x, this.head.y, this.head.z);
    this._lastGeo = geo;

    // ヘッドが進める速さ。断面積で割るので、
    // 完全に地中に潜った状態での掘削量が DIG_RATE そのものになる。
    //   体積 = 断面積 x 進んだ距離 = area * (rate/area) * dt = rate * dt
    const rate = this.mode === 'dig' ? DIG_RATE[geo] : Excavator.FILL_RATE;
    const speed = rate / area;
    this._headSpeed = speed;

    const dir = target.clone().sub(this.head);
    let dist = dir.length();
    if (dist < 1e-4) return null;
    dir.multiplyScalar(1 / dist);

    // --- 後退しながら掘らない ---
    // 狙点は「今カーソルのレイが当たっている地表の 2.34 m 奥」なので、
    // 崩落で坑口が埋まると狙点が手前へ戻り、ヘッドが山から後退する。
    // その後退掃引をそのまま掘ると、法尻に溜まったばかりの崩積土を削り返し、
    // それがまた崩落を呼ぶ。掘るほど掘れなくなるループになる。
    // 位置だけ戻して場は触らない。狙点を振り直して掘る操作は今までどおりできる。
    if (this.mode === 'dig' && dir.dot(rayDir) < 0) {
      this.head.addScaledVector(dir, Math.min(dist, speed * dt));
      return null;
    }

    // --- 何も削れない区間は無料で飛ばす ---
    // ブラシ球が完全に空中にある間は、カプセルを掃引しても削れる物が無い。
    // つまりそこを「編集せずに一気に進む」のは結果として等価。
    // ここまで速度制限をかけると、カーソルを離れた場所へ動かしたときに
    // ヘッドが空中を延々と這うだけになり、ただ待たされる。
    //
    // 逆に、ヘッド中心の密度を見て「空中だから速度制限を外す」とやってはいけない。
    // 掘った空洞の真ん中にヘッドが居るときに一気に進んでしまい、
    // その長い掃引が空洞の向こう側の壁を丸ごと削ってしまう。
    if (this.mode === 'dig') {
      const skipStep = r * 0.5;
      let skipped = 0;
      while (skipped + skipStep < dist) {
        const s = field.sample(
          this.head.x + dir.x * skipStep,
          this.head.y + dir.y * skipStep,
          this.head.z + dir.z * skipStep,
        );
        // 場は近似的な符号付き距離。1 セル余裕を見て、確実に空の所だけ飛ばす。
        if (s >= -(r + CELL)) break;
        this.head.addScaledVector(dir, skipStep);
        skipped += skipStep;
      }
      dist -= skipped;
      if (dist < 1e-4) return null;
    }

    const step = Math.min(dist, speed * dt);
    if (step < 1e-6) return null;

    const from = this.head.clone();
    this.head.addScaledVector(dir, step);

    const res = applyCapsule(
      field, chunks,
      from.x, from.y, from.z,
      this.head.x, this.head.y, this.head.z,
      r,
      this.mode,
      this.blend,
      Geo.Soil,
    );
    return res.changed ? res : null;
  }
}
