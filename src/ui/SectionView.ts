import * as THREE from 'three';
import { GEO_COLOR, GEO_NAME_JA, Geo, WATER_TABLE_Y, WORLD_Y } from '../terrain/config';
import type { VoxelField } from '../terrain/VoxelField';
import type { SurveySystem } from '../game/Survey';

/**
 * 地質断面ビュー。
 *
 * 企画の「調査に金をかけるか、勘で掘って事故るか」が実際の判断になるのは、
 * **裏付けの無い地質を見せない**からこそ。
 * ここでは各画素について
 *   - 露出面からの距離 (掘った坑道の壁も露出面なので、そこは分かる)
 *   - ボーリング孔からの水平距離 (到達していない深さは効かない)
 * の大きいほうを信頼度とし、信頼度が低い所は灰色のハッチに落とす。
 * 「掘ってみないと分からない」が画面上でそのまま見える。
 */

// 1 回の描画で W*H 回の場サンプルが走る。上げすぎると描き直しでフレームが飛ぶ。
const W = 380;
const H = 176;
/** 露出面から何 m まで地質が読めるか。 */
const EXPOSURE_RANGE = 2.5;

export class SectionView {
  private root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private img: ImageData;
  private a: THREE.Vector3 | null = null;
  private b: THREE.Vector3 | null = null;
  private needsRender = false;
  private lastRender = 0;

  constructor() {
    const style = document.createElement('style');
    style.textContent = `
      #section { bottom: 52px; left: 12px; padding: 8px 9px 6px; }
      #section canvas { display: block; border-radius: 4px; background: #0e1116; }
      #section .cap { color: #93a0b4; font-size: 11px; margin-top: 5px; display: flex; gap: 12px; }
      #section .cap b { color: #c8d0dc; font-weight: 600; }
    `;
    document.head.appendChild(style);

    this.root = document.createElement('div');
    this.root.className = 'panel';
    this.root.id = 'section';
    this.root.style.display = 'none';
    document.body.appendChild(this.root);

    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.root.appendChild(this.canvas);

    const cap = document.createElement('div');
    cap.className = 'cap';
    cap.innerHTML =
      ([Geo.Soil, Geo.Rock, Geo.Weak] as number[])
        .map((g) => {
          const c = GEO_COLOR[g];
          const hex =
            '#' + [c[0], c[1], c[2]]
              .map((v) => Math.round(Math.min(1, v * 1.5) * 255).toString(16).padStart(2, '0'))
              .join('');
          return `<span><span class="swatch" style="background:${hex}"></span>${GEO_NAME_JA[g]}</span>`;
        })
        .join('') +
      '<span><span class="swatch" style="background:#4b5058"></span>未調査</span>';
    this.root.appendChild(cap);

    this.ctx = this.canvas.getContext('2d')!;
    this.img = this.ctx.createImageData(W, H);
  }

  get hasLine(): boolean {
    return this.a !== null && this.b !== null;
  }

  setStart(p: THREE.Vector3): void {
    this.a = p.clone();
    this.b = null;
  }

  setEnd(p: THREE.Vector3): void {
    if (!this.a) return;
    this.b = p.clone();
    this.needsRender = true;
  }

  clear(): void {
    this.a = null;
    this.b = null;
    this.root.style.display = 'none';
  }

  /** ボーリングが進んだ / 地形が変わった等で描き直しが要るとき。 */
  invalidate(): void {
    this.needsRender = true;
  }

  update(field: VoxelField, survey: SurveySystem, nowMs: number): void {
    if (!this.hasLine) {
      this.root.style.display = 'none';
      return;
    }
    this.root.style.display = '';
    // 9 万画素ぶんの場サンプルを毎フレームやる必要はない
    if (!this.needsRender || nowMs - this.lastRender < 120) return;
    this.needsRender = false;
    this.lastRender = nowMs;
    this.render(field, survey);
  }

  private render(field: VoxelField, survey: SurveySystem): void {
    const a = this.a!;
    const b = this.b!;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 1) return;

    // --- 縦の描画範囲を決める ---
    let maxSurf = 0;
    for (let i = 0; i < W; i += 4) {
      const t = i / (W - 1);
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      for (let y = WORLD_Y; y > 0; y -= 1) {
        if (field.sample(x, y, z) > 0) {
          if (y > maxSurf) maxSurf = y;
          break;
        }
      }
    }
    const topY = Math.min(WORLD_Y, maxSurf + 4);
    const botY = Math.max(0, topY - 52);
    const span = topY - botY;

    const data = this.img.data;
    for (let i = 0; i < W; i++) {
      const t = i / (W - 1);
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;

      // 上から下へ走らせて、最初に固体に当たった所を地表とみなす。
      // 別途 地表を探す走査を回すと場のサンプル数が倍になり、
      // 描き直しのたびにフレームが飛ぶ。
      let seenSolid = false;

      for (let j = 0; j < H; j++) {
        const y = topY - (j / (H - 1)) * span;
        const o = (j * W + i) * 4;
        const d = field.sample(x, y, z);

        let r: number, g: number, bl: number;

        if (d <= 0) {
          if (!seenSolid) {
            // 地表より上 = 空
            r = 26; g = 33; bl = 44;
          } else {
            // 地中の空洞 = 掘った坑道
            r = 12; g = 14; bl = 18;
          }
        } else {
          seenSolid = true;
          // 露出面からの距離とボーリングからの距離、良いほうを信頼度にする。
          // 密度場の値がほぼ「固体内部での表面までの距離」なのでそのまま使える。
          const exposure = Math.exp(-0.5 * (d / EXPOSURE_RANGE) * (d / EXPOSURE_RANGE));
          const conf = Math.max(exposure, survey.confidenceAt(x, y, z));

          const geo = field.materialAt(x, y, z);
          const c = GEO_COLOR[geo];
          let cr = c[0] * 255 * 1.45;
          let cg = c[1] * 255 * 1.45;
          let cb = c[2] * 255 * 1.45;

          // 水位より下は湿らせる (3D の見た目と揃える)
          if (y < WATER_TABLE_Y) {
            cr *= 0.62; cg *= 0.72; cb *= 0.85;
          }

          // 未調査は灰色へ。さらに斜めハッチをかけて「これはデータではない」と示す。
          const k = conf * conf;
          const hatch = (i + j) % 9 < 2 ? 1 : 0;
          const ur = 62 + hatch * 14;
          const ug = 66 + hatch * 14;
          const ub = 74 + hatch * 14;
          r = ur + (cr - ur) * k;
          g = ug + (cg - ug) * k;
          bl = ub + (cb - ub) * k;
        }

        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = bl;
        data[o + 3] = 255;
      }
    }
    this.ctx.putImageData(this.img, 0, 0);

    // --- 地下水位線 ---
    const wy = ((topY - WATER_TABLE_Y) / span) * (H - 1);
    if (wy >= 0 && wy < H) {
      this.ctx.strokeStyle = 'rgba(110,200,235,.85)';
      this.ctx.lineWidth = 1;
      this.ctx.setLineDash([5, 4]);
      this.ctx.beginPath();
      this.ctx.moveTo(0, wy);
      this.ctx.lineTo(W, wy);
      this.ctx.stroke();
      this.ctx.setLineDash([]);
      this.ctx.fillStyle = 'rgba(150,215,240,.95)';
      this.ctx.font = '10px sans-serif';
      this.ctx.fillText('地下水位', 4, Math.max(10, wy - 3));
    }

    // --- ボーリング孔の投影 ---
    const dx = (b.x - a.x) / len;
    const dz = (b.z - a.z) / len;
    for (const bo of survey.borings) {
      // 断面線への射影位置と、線からの離れ
      const px = bo.x - a.x;
      const pz = bo.z - a.z;
      const s = px * dx + pz * dz;
      const off = Math.abs(px * dz - pz * dx);
      if (s < 0 || s > len || off > 6) continue;
      const cx = (s / len) * (W - 1);
      const y0 = ((topY - bo.surfaceY) / span) * (H - 1);
      const y1 = ((topY - (bo.surfaceY - bo.drilled)) / span) * (H - 1);
      this.ctx.strokeStyle = off < 2 ? '#ffffff' : 'rgba(255,255,255,.5)';
      this.ctx.lineWidth = 2;
      this.ctx.beginPath();
      this.ctx.moveTo(cx, y0);
      this.ctx.lineTo(cx, y1);
      this.ctx.stroke();
    }

    // --- 標高の目盛り ---
    this.ctx.fillStyle = 'rgba(200,210,225,.75)';
    this.ctx.font = '10px sans-serif';
    this.ctx.fillText(`${topY.toFixed(0)}m`, W - 34, 11);
    this.ctx.fillText(`${botY.toFixed(0)}m`, W - 34, H - 4);
    this.ctx.fillText(`${len.toFixed(0)}m`, 4, H - 4);
  }
}
