import { mulberry32 } from './rng';

/**
 * シード付き Perlin ノイズ (2D/3D) と fBm。
 * 地層生成にのみ使う (描画側のディテールは GLSL 内で別に持つ)。
 */
export class Noise {
  private perm = new Uint8Array(512);
  private grad3 = new Float32Array(16 * 3);

  constructor(seed = 1337) {
    const rand = mulberry32(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];

    // 12 方向 + 繰り返し 4 で 16 に切り上げ (& 15 でマスクできるように)
    const g = [
      1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
      1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
      0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
      1, 1, 0, -1, 1, 0, 0, -1, 1, 0, -1, -1,
    ];
    for (let i = 0; i < g.length; i++) this.grad3[i] = g[i];
  }

  private static fade(t: number): number {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  private gdot(hash: number, x: number, y: number, z: number): number {
    const i = (hash & 15) * 3;
    return this.grad3[i] * x + this.grad3[i + 1] * y + this.grad3[i + 2] * z;
  }

  perlin3(x: number, y: number, z: number): number {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const Z = Math.floor(z) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const zf = z - Math.floor(z);
    const u = Noise.fade(xf);
    const v = Noise.fade(yf);
    const w = Noise.fade(zf);

    const p = this.perm;
    const A = p[X] + Y;
    const AA = p[A] + Z;
    const AB = p[A + 1] + Z;
    const B = p[X + 1] + Y;
    const BA = p[B] + Z;
    const BB = p[B + 1] + Z;

    const lerp = (t: number, a: number, b: number) => a + t * (b - a);

    return lerp(
      w,
      lerp(
        v,
        lerp(u, this.gdot(p[AA], xf, yf, zf), this.gdot(p[BA], xf - 1, yf, zf)),
        lerp(u, this.gdot(p[AB], xf, yf - 1, zf), this.gdot(p[BB], xf - 1, yf - 1, zf)),
      ),
      lerp(
        v,
        lerp(u, this.gdot(p[AA + 1], xf, yf, zf - 1), this.gdot(p[BA + 1], xf - 1, yf, zf - 1)),
        lerp(
          u,
          this.gdot(p[AB + 1], xf, yf - 1, zf - 1),
          this.gdot(p[BB + 1], xf - 1, yf - 1, zf - 1),
        ),
      ),
    );
  }

  perlin2(x: number, z: number): number {
    return this.perlin3(x, 0.137, z);
  }

  /** 2D fBm。戻り値はおおむね [-1, 1]。 */
  fbm2(x: number, z: number, octaves: number, lacunarity = 2.03, gain = 0.5): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.perlin2(x * freq, z * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  /** 3D fBm。戻り値はおおむね [-1, 1]。 */
  fbm3(x: number, y: number, z: number, octaves: number, lacunarity = 2.03, gain = 0.5): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.perlin3(x * freq, y * freq, z * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }
}
