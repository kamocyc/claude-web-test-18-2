import { describe, it, expect } from 'vitest';
import {
  buildAlignment, solveProfile, measureMinRadius, resampleUniform, circumRadius,
  ROAD_STANDARDS, RoadKind, STATION_STEP, lengthByKind, runsOf,
  boreCenterY, tunnelRadius,
  type Vec2, type RoadStandard, type TerrainProbe,
} from './Alignment';
import { isTunnelCover } from './Tunnel';

/**
 * 線形。押さえたいのは 4 つ。
 *   1. 規格 (最小曲線半径 / 最大勾配 / 縦断曲線) を**必ず**満たすこと。
 *      満たせないなら、黙って規格外を返さずに ok = false で言うこと。
 *   2. 制御点が急でも壊れないこと (発散も振動もしない)。
 *   3. 区間の種別が地形との差だけで決まり、短すぎる橋・トンネルが出ないこと。
 *   4. トンネルの判定が**掘る側と同じ述語**であること。ここがずれると
 *      「掘ったのに登録されない大穴」ができる。
 */

const MOUNTAIN = ROAD_STANDARDS[0];
const STANDARD = ROAD_STANDARDS[1];

/**
 * 高さ場からプローブを組む。
 *
 * 土被りの判定は**本物の述語 (`Tunnel.isTunnelCover`) をそのまま呼ぶ**。
 * ここで閾値を書き写すと、まさに今回消した重複がテストの中に復活する。
 * 高さ場にはオーバーハングが無いので、天端から上の土被りは
 * `地盤 - 天端` で厳密に一致する。
 */
function probeOf(ground: (x: number, z: number) => number): TerrainProbe {
  return {
    groundAt: ground,
    tunnelAt: (x, y, z, r) => isTunnelCover(Math.max(0, ground(x, z) - (y + r)), r),
  };
}

const flat = probeOf(() => 20);

describe('曲率の制約', () => {
  it('直角に折れた制御点でも最小曲線半径を下回らない', () => {
    const control: Vec2[] = [
      { x: 20, z: 60 }, { x: 60, z: 60 }, { x: 60, z: 100 },
    ];
    for (const std of ROAD_STANDARDS) {
      const al = buildAlignment(control, flat, std);
      expect(al.stations.length).toBeGreaterThan(5);
      expect(al.minRadius).toBeGreaterThanOrEqual(std.minRadius * 0.99);
      expect(al.ok).toBe(true);
    }
  });

  it('つづら折り (ヘアピン) でも発散しない', () => {
    const control: Vec2[] = [
      { x: 20, z: 20 }, { x: 90, z: 24 }, { x: 22, z: 30 },
      { x: 92, z: 36 }, { x: 24, z: 42 },
    ];
    const al = buildAlignment(control, flat, STANDARD);
    expect(al.minRadius).toBeGreaterThanOrEqual(STANDARD.minRadius * 0.99);
    // 曲がれないぶん制御点から離れる。それが「規格が押し返した量」。
    expect(al.maxOffset).toBeGreaterThan(3);
    for (const st of al.stations) {
      expect(Number.isFinite(st.x)).toBe(true);
      expect(Number.isFinite(st.z)).toBe(true);
    }
  });

  it('曲げる必要が無ければ制御点をほぼ通る', () => {
    const control: Vec2[] = [{ x: 10, z: 64 }, { x: 60, z: 64 }, { x: 110, z: 64 }];
    const al = buildAlignment(control, flat, STANDARD);
    expect(al.maxOffset).toBeLessThan(0.2);
    expect(al.length).toBeCloseTo(100, 0);
  });

  it('山岳規格のほうが制御点に近い線を引ける', () => {
    const control: Vec2[] = [
      { x: 20, z: 40 }, { x: 60, z: 40 }, { x: 60, z: 90 },
    ];
    const m = buildAlignment(control, flat, MOUNTAIN);
    const s = buildAlignment(control, flat, STANDARD);
    expect(m.maxOffset).toBeLessThan(s.maxOffset);
  });
});

describe('外接円半径', () => {
  it('半径 R の円上の 3 点で R を返す', () => {
    const R = 37;
    const p = (a: number): Vec2 => ({ x: R * Math.cos(a), z: R * Math.sin(a) });
    expect(circumRadius(p(0), p(0.2), p(0.4))).toBeCloseTo(R, 6);
  });

  it('一直線なら無限大', () => {
    expect(circumRadius({ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 })).toBe(Infinity);
  });
});

describe('等間隔の打ち直し', () => {
  it('刻み幅どおりに並び、両端が保たれる', () => {
    const poly: Vec2[] = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 7 }];
    const out = resampleUniform(poly, 2);
    expect(out[0]).toEqual({ x: 0, z: 0 });
    const last = out[out.length - 1];
    expect(Math.hypot(last.x - 10, last.z - 7)).toBeLessThan(1e-9);
    for (let i = 1; i < out.length - 1; i++) {
      const d = Math.hypot(out[i].x - out[i - 1].x, out[i].z - out[i - 1].z);
      expect(d).toBeCloseTo(2, 6);
    }
  });
});

describe('縦断の制約', () => {
  /** 距離 s [m] に対する地盤高。深さ 24 m の V 字谷。 */
  const valley = (n: number): number[] => {
    const g: number[] = [];
    for (let i = 0; i < n; i++) {
      const s = i * STATION_STEP;
      g.push(40 - 24 * Math.exp(-((s - 80) ** 2) / (2 * 14 * 14)));
    }
    return g;
  };

  /**
   * 超過は 1 mm も許さない。交互射影は規格面へ外側から漸近するので、
   * ソルバは詰めの段階で 0.1 % きつい面へ落としている。そこが効いているか
   * どうかは、ここを緩めた瞬間に見えなくなる。
   */
  const TOL = 0;
  const check = (y: number[], std: RoadStandard): void => {
    const gLim = std.maxGrade * STATION_STEP;
    const cLim = (STATION_STEP * STATION_STEP) / std.vertRadius;
    for (let i = 0; i + 1 < y.length; i++) {
      expect(Math.abs(y[i + 1] - y[i])).toBeLessThanOrEqual(gLim + TOL);
    }
    for (let i = 1; i + 1 < y.length; i++) {
      expect(Math.abs(y[i - 1] - 2 * y[i] + y[i + 1])).toBeLessThanOrEqual(cLim + TOL);
    }
  };

  it('急な谷でも勾配と縦断曲線を必ず満たす', () => {
    for (const std of ROAD_STANDARDS) {
      check(solveProfile(valley(80), STATION_STEP, std), std);
    }
  });

  it('崖 (段差) でも満たす', () => {
    const g: number[] = [];
    for (let i = 0; i < 60; i++) g.push(i < 30 ? 45 : 12);
    for (const std of ROAD_STANDARDS) check(solveProfile(g, STATION_STEP, std), std);
  });

  it('制約に掛からない地形なら地盤をほぼなぞる (土工量を増やさない)', () => {
    const g: number[] = [];
    for (let i = 0; i < 60; i++) g.push(20 + i * STATION_STEP * 0.02);
    const y = solveProfile(g, STATION_STEP, STANDARD);
    for (let i = 0; i < g.length; i++) expect(Math.abs(y[i] - g[i])).toBeLessThan(0.35);
  });

  it('谷は跨ぎ、尾根は削る — 縦断は地形の平均に寄る', () => {
    const g = valley(80);
    const y = solveProfile(g, STATION_STEP, STANDARD);
    // 谷底では計画高が地盤よりずっと高い = 橋になる高さ
    const bottom = 40;
    expect(y[bottom] - g[bottom]).toBeGreaterThan(9);
  });
});

describe('区間の分類', () => {
  /** x に沿って谷が 1 本走る地形。 */
  const ground = (x: number): number => 40 - 26 * Math.exp(-((x - 64) ** 2) / (2 * 11 * 11));

  it('谷は橋、尾根は切土 — 種別は地形との差だけで決まる', () => {
    const al = buildAlignment(
      [{ x: 10, z: 64 }, { x: 118, z: 64 }],
      probeOf((x) => ground(x)),
      STANDARD,
    );
    const kinds = new Set(al.stations.map((s) => s.kind));
    expect(kinds.has(RoadKind.Bridge)).toBe(true);
    const len = lengthByKind(al);
    expect(len[RoadKind.Bridge]).toBeGreaterThan(20);
  });

  it('短すぎる橋・トンネルは切盛に均される', () => {
    // 幅 4 m だけ深い溝。橋にするには短すぎる。
    const al = buildAlignment(
      [{ x: 10, z: 64 }, { x: 118, z: 64 }],
      probeOf((x) => (Math.abs(x - 64) < 2 ? 8 : 30)),
      MOUNTAIN,
    );
    for (const [from, to] of runsOf(al, RoadKind.Bridge)) {
      expect((to - from) * STATION_STEP).toBeGreaterThanOrEqual(12);
    }
    for (const [from, to] of runsOf(al, RoadKind.Tunnel)) {
      expect((to - from) * STATION_STEP).toBeGreaterThanOrEqual(12);
    }
  });

  it('尾根が高ければトンネルになる', () => {
    const al = buildAlignment(
      [{ x: 10, z: 64 }, { x: 118, z: 64 }],
      probeOf((x) => 18 + 54 * Math.exp(-((x - 64) ** 2) / (2 * 11 * 11))),
      STANDARD,
    );
    expect(lengthByKind(al)[RoadKind.Tunnel]).toBeGreaterThan(20);
  });

  it('土被りが無ければトンネルにしない — 高さの差が同じでも', () => {
    // 分類が「計画高と地盤高の差」で決めていた頃に出た不具合の再現。
    // 差は同じでも、天端の上に地山が残っていなければトンネルではない
    // (オーバーハングの下、既に掘った坑道の真上、盛土の下)。
    const ridge = (x: number): number => 18 + 54 * Math.exp(-((x - 64) ** 2) / (2 * 11 * 11));
    const control: Vec2[] = [{ x: 10, z: 64 }, { x: 118, z: 64 }];

    const solid = buildAlignment(control, probeOf(ridge), STANDARD);
    expect(lengthByKind(solid)[RoadKind.Tunnel]).toBeGreaterThan(20);

    // 同じ高さ場だが、天端の上に残る地山は 0.5 m しか無い
    const hollow: TerrainProbe = {
      groundAt: ridge,
      tunnelAt: (_x, _y, _z, r) => isTunnelCover(0.5, r),
    };
    const al = buildAlignment(control, hollow, STANDARD);
    expect(lengthByKind(al)[RoadKind.Tunnel]).toBe(0);
    // 高さの差は 20 m 以上ある = 差で分類していたらトンネルになっていた
    const maxCut = Math.max(...al.stations.map((s) => s.ground - s.y));
    expect(maxCut).toBeGreaterThan(20);
  });

  it('土被りを聞く位置が、掘る位置 (坑道の中心) と同じ', () => {
    // ここがずれると「トンネルと分類した所を掘っても土被りが付かない」が起きる。
    const ridge = (x: number): number => 18 + 54 * Math.exp(-((x - 64) ** 2) / (2 * 11 * 11));
    const r = tunnelRadius(STANDARD);
    const asked: { x: number; y: number; z: number; r: number }[] = [];
    const spy: TerrainProbe = {
      groundAt: ridge,
      tunnelAt: (x, y, z, rr) => {
        asked.push({ x, y, z, r: rr });
        return false;
      },
    };
    const al = buildAlignment([{ x: 10, z: 64 }, { x: 118, z: 64 }], spy, STANDARD);

    expect(asked.length).toBeGreaterThan(10);
    for (const a of asked) {
      expect(a.r).toBeCloseTo(r, 9);
      const st = al.stations.find((s) => s.x === a.x && s.z === a.z);
      expect(st).toBeDefined();
      expect(a.y).toBeCloseTo(boreCenterY(st!.y, r), 9);
    }
  });

  it('盛土や橋では土被りを聞かない (制御点を置くたびに走るので無駄撃ちしない)', () => {
    let calls = 0;
    const spy: TerrainProbe = {
      // 深い谷。計画高はずっと地盤より上になる。
      groundAt: (x) => 40 - 30 * Math.exp(-((x - 64) ** 2) / (2 * 10 * 10)),
      tunnelAt: () => { calls++; return false; },
    };
    const al = buildAlignment([{ x: 40, z: 64 }, { x: 88, z: 64 }], spy, STANDARD);
    const above = al.stations.filter((s) => s.y - s.ground > 0).length;
    expect(above).toBeGreaterThan(10);
    expect(calls).toBeLessThan(al.stations.length - above + 1);
  });

  it('トンネルにする深さは断面の大きさで決まる — 幅が広いほど深くないと潜れない', () => {
    // 同じ尾根でも、断面の大きい標準道路のほうがトンネルになる区間は短い。
    // 掘っても土被りが付かない深さでトンネルと言ってはいけない。
    const ridge = (x: number): number => 18 + 44 * Math.exp(-((x - 64) ** 2) / (2 * 13 * 13));
    const control: Vec2[] = [{ x: 10, z: 64 }, { x: 118, z: 64 }];
    const m = lengthByKind(buildAlignment(control, probeOf(ridge), MOUNTAIN))[RoadKind.Tunnel];
    const s = lengthByKind(buildAlignment(control, probeOf(ridge), STANDARD))[RoadKind.Tunnel];
    expect(m).toBeGreaterThan(s);
  });
});

describe('退化した入力', () => {
  it('制御点 1 点以下なら空の線形', () => {
    expect(buildAlignment([], flat, STANDARD).stations).toHaveLength(0);
    expect(buildAlignment([{ x: 5, z: 5 }], flat, STANDARD).stations).toHaveLength(0);
  });

  it('同じ点を重ねても壊れない', () => {
    const al = buildAlignment(
      [{ x: 30, z: 30 }, { x: 30, z: 30 }, { x: 70, z: 30 }],
      flat, STANDARD,
    );
    for (const st of al.stations) expect(Number.isFinite(st.y)).toBe(true);
  });
});

describe('折れ線の最小半径', () => {
  it('円弧を刻んだ折れ線ではその半径になる', () => {
    const R = 25;
    const pts: Vec2[] = [];
    for (let a = 0; a < 1.2; a += 0.05) pts.push({ x: R * Math.cos(a), z: R * Math.sin(a) });
    expect(measureMinRadius(pts)).toBeCloseTo(R, 3);
  });
});
