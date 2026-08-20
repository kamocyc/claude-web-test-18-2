import { describe, it, expect } from 'vitest';
import {
  buildAlignment, ROAD_STANDARDS, RoadKind, lengthByKind,
  type Vec2, type Station,
} from './Alignment';
import { planRoad, RoadNetwork, groundHeightAt, tunnelRadius, terrainProbe } from './Roadworks';
import { BridgeNetwork } from './Bridge';
import { Crew } from './Crew';
import { Economy } from './Economy';
import { TunnelNetwork, SEGMENT_LENGTH } from './Tunnel';
import { VoxelField } from '../terrain/VoxelField';
import { HeightIndex, colIdx } from '../terrain/HeightIndex';
import { ReposeSystem } from '../terrain/Repose';
import { CELL, NX, NY, NZ, Geo, REPOSE_DEG } from '../terrain/config';
import type { ChunkManager } from '../terrain/ChunkManager';

/**
 * 道路の施工。押さえたいのは 4 つ。
 *   1. 路面が計画高で**平ら**になること (刻み幅ぶん波打たない)
 *   2. 法面を安息角で切ってあるので、**整定が何もしない**こと。
 *      ここが崩れると土砂が路面へ流れ込んで道が埋まる
 *   3. 掘った土が残土になって盛土に回ること (既存の Economy を通っていること)
 *   4. トンネル区間が既存の TunnelNetwork に登録され、支保の対象になること
 */

const chunks = { markDirtyByAABB(): void {} } as unknown as ChunkManager;
const STD = ROAD_STANDARDS[0]; // 山岳道路

/** 高さ場から密度場を作る。Generator と同じ正規化ハイトフィールド。 */
function buildField(h: (x: number, z: number) => number, geo: Geo = Geo.Soil): VoxelField {
  const f = new VoxelField();
  for (let k = 0; k < NZ; k++) {
    for (let i = 0; i < NX; i++) {
      const x = i * CELL;
      const z = k * CELL;
      const hh = h(x, z);
      // 勾配で正規化する。Edit.applyColumnHeights と同じ式でないと段が出る。
      const gx = (h(x + CELL, z) - h(x - CELL, z)) / (2 * CELL);
      const gz = (h(x, z + CELL) - h(x, z - CELL)) / (2 * CELL);
      const inv = 1 / Math.sqrt(1 + gx * gx + gz * gz);
      const onEdge = i === 0 || i === NX - 1 || k === 0 || k === NZ - 1;
      let idx = i + k * f.strideZ;
      for (let j = 0; j < NY; j++, idx += f.strideY) {
        let d = (hh - j * CELL) * inv;
        if (d > 8) d = 8;
        else if (d < -8) d = -8;
        if (onEdge || j === 0) d = -1;
        f.density[idx] = d;
        f.material[idx] = geo;
      }
    }
  }
  return f;
}

interface World {
  field: VoxelField;
  index: HeightIndex;
  repose: ReposeSystem;
  economy: Economy;
  crew: Crew;
  tunnels: TunnelNetwork;
  bridges: BridgeNetwork;
  roads: RoadNetwork;
}

function mkWorld(h: (x: number, z: number) => number, geo: Geo = Geo.Soil): World {
  const field = buildField(h, geo);
  const index = new HeightIndex();
  index.measureAll(field);
  const repose = new ReposeSystem(index);
  const crew = new Crew();
  const tunnels = new TunnelNetwork();
  tunnels.useCrew(crew);
  const bridges = new BridgeNetwork();
  bridges.useCrew(crew);
  const economy = new Economy();
  economy.money = 100_000_000; // 資金は別のテストの関心事
  return { field, index, repose, economy, crew, tunnels, bridges, roads: new RoadNetwork(crew) };
}

const trueGeo = (w: World) => (x: number, y: number, z: number): Geo =>
  w.field.materialAt(x, y, z);

/**
 * 実物の地形を使いつつ、計画高だけを地盤より `drop` m 下へ引き込むプローブ。
 * 「深さ一定の切土」を作るのに使う。トンネルの判定は実物のまま。
 */
function lowerBy(w: World, drop: number) {
  const real = terrainProbe(w.field, w.index);
  return { ...real, groundAt: (x: number, z: number) => real.groundAt(x, z) - drop };
}

function makeRoad(w: World, control: Vec2[], std = STD) {
  const al = buildAlignment(control, terrainProbe(w.field, w.index), std);
  const plan = planRoad(w.field, w.index, al, w.economy, trueGeo(w));
  const road = w.roads.build(
    w.field, chunks, w.index, w.repose, w.tunnels, w.bridges, w.economy, plan,
  );
  return { al, plan, road };
}

/** 中心線に沿った路面の凹凸 [m]。整定の前後で比べる。 */
function surfaceError(w: World, al: ReturnType<typeof buildAlignment>): number {
  let worst = 0;
  for (const st of al.stations) {
    if (st.kind === RoadKind.Bridge || st.kind === RoadKind.Tunnel) continue;
    worst = Math.max(worst, Math.abs(groundHeightAt(w.index, st.x, st.z) - st.y));
  }
  return worst;
}

describe('回廊の切盛', () => {
  const slope = (x: number): number => 34 - x * 0.16;

  it('路面が計画高で平らになる', () => {
    const w = mkWorld((x) => slope(x));
    const { al } = makeRoad(w, [{ x: 20, z: 64 }, { x: 100, z: 64 }]);
    // 書き戻しの分解能 (1 mm) と補間の丸めぶん。刻み幅の波打ちが出れば 10 cm 級になる。
    expect(surfaceError(w, al)).toBeLessThan(0.06);
  });

  it('整定が何もしない — 法面を最初から安息角で切ってあるので崩れない', () => {
    const w = mkWorld((x) => slope(x));
    const { al } = makeRoad(w, [{ x: 20, z: 64 }, { x: 100, z: 64 }]);
    const before = surfaceError(w, al);

    const res = w.repose.settleNow(w.field, chunks);
    const moved = w.repose.movedThisSlide;

    // 完全なゼロは求めない (書き戻しの丸めが 1 mm ある)。
    // 崩れれば土量は必ず 3 桁 m^3 になるので、そこと桁で切り分ける。
    expect(moved).toBeLessThan(3);
    expect(surfaceError(w, al)).toBeLessThan(before + 0.02);
    void res;
  });

  it('切土の法面は安息角で寝ている — 垂直な壁が残らない', () => {
    // 標高 30 の平らな台地を、計画高 22 で掘り下げる (深さ 8 m の切土)
    const w = mkWorld(() => 30);
    const al = buildAlignment(
      [{ x: 20, z: 64 }, { x: 100, z: 64 }],
      lowerBy(w, 8),
      ROAD_STANDARDS[1],
    );
    const plan = planRoad(w.field, w.index, al, w.economy, trueGeo(w));
    expect(plan.cutVolume).toBeGreaterThan(100);
    w.roads.build(w.field, chunks, w.index, w.repose, w.tunnels, w.bridges, w.economy, plan);

    // 中心線に**直交する**断面 (z 方向) でいちばん急な所を測る。
    // 道路に沿って測ると平らなのは当たり前で、何も確かめたことにならない。
    const i = Math.round(60 / CELL);
    const k0 = Math.round(64 / CELL);
    let steepest = 0;
    for (let k = k0 - 50; k < k0 + 50; k++) {
      const a = w.index.heights[colIdx(i, k)];
      const b = w.index.heights[colIdx(i, k + 1)];
      steepest = Math.max(steepest, Math.abs(a - b) / CELL);
    }
    const deg = (Math.atan(steepest) * 180) / Math.PI;
    expect(deg).toBeLessThanOrEqual(REPOSE_DEG[Geo.Soil] + 0.5);
    expect(deg).toBeGreaterThan(REPOSE_DEG[Geo.Soil] - 4);
  });

  it('掘り下げれば残土が出る — 既存の Economy をそのまま通っている', () => {
    const w = mkWorld(() => 30);
    const al = buildAlignment([{ x: 20, z: 64 }, { x: 100, z: 64 }], lowerBy(w, 8), STD);
    const plan = planRoad(w.field, w.index, al, w.economy, trueGeo(w));
    expect(plan.cutVolume).toBeGreaterThan(0);
    expect(plan.fillVolume).toBeLessThan(plan.cutVolume * 0.05);

    const before = w.economy.money;
    w.roads.build(w.field, chunks, w.index, w.repose, w.tunnels, w.bridges, w.economy, plan);
    expect(w.economy.spoil).toBeGreaterThan(plan.cutVolume * 0.8);
    expect(w.economy.money).toBeLessThan(before);
  });

  it('斜面では切土も盛土も出て、見積りが実費と桁違いにならない', () => {
    // 勾配 16 % の斜面。山岳規格 (10 %) でも登れないので、高いほうを切って
    // 低いほうへ盛ることになる。
    const w = mkWorld((x) => 34 - x * 0.16);
    const before = w.economy.money;
    const { plan } = makeRoad(w, [{ x: 20, z: 64 }, { x: 100, z: 64 }]);
    expect(plan.cutVolume).toBeGreaterThan(0);
    expect(plan.fillVolume).toBeGreaterThan(0);
    expect(w.economy.money).toBeLessThan(before);
    // 見積りが当てにならないと、着工するかどうかを選べない
    const spent = before - w.economy.money;
    expect(spent).toBeGreaterThan(plan.totalCost * 0.5);
    expect(spent).toBeLessThan(plan.totalCost * 1.6);
  });

  it('橋区間の下は土工しない — 谷は埋めない', () => {
    const w = mkWorld((x) => 40 - 30 * Math.exp(-((x - 64) ** 2) / (2 * 10 * 10)));
    const { al } = makeRoad(w, [{ x: 10, z: 64 }, { x: 118, z: 64 }], ROAD_STANDARDS[1]);
    expect(lengthByKind(al)[RoadKind.Bridge]).toBeGreaterThan(20);

    // 谷底の地盤高がほとんど変わっていないこと
    const bottom = groundHeightAt(w.index, 64, 64);
    expect(bottom).toBeLessThan(12);
  });

  it('橋台の面は整定でも崩れない — 取付部の路面が落ちない', () => {
    const w = mkWorld((x) => 40 - 30 * Math.exp(-((x - 64) ** 2) / (2 * 10 * 10)));
    const { al } = makeRoad(w, [{ x: 10, z: 64 }, { x: 118, z: 64 }], ROAD_STANDARDS[1]);

    // 橋に接する最後の土工の測点 = 橋台が立つ所
    const ends: Station[] = [];
    for (let i = 0; i + 1 < al.stations.length; i++) {
      const a = al.stations[i];
      const b = al.stations[i + 1];
      if (a.kind !== RoadKind.Bridge && b.kind === RoadKind.Bridge) ends.push(a);
      if (a.kind === RoadKind.Bridge && b.kind !== RoadKind.Bridge) ends.push(b);
    }
    expect(ends.length).toBeGreaterThan(0);

    w.repose.settleNow(w.field, chunks);

    // 垂直に切った面が崩れれば、まずそこの路面が谷へ落ちる。
    // 擁壁と同じ保護を入れてあるので立ったままのはず。
    // (谷の斜面そのものが安息角より急なら、回廊の近くはゆるんで動く。
    //  それは既存の規則どおりの挙動なので、ここでは路面だけを見る)
    for (const st of ends) {
      expect(groundHeightAt(w.index, st.x, st.z)).toBeGreaterThan(st.y - 0.3);
    }
  });
});

describe('トンネル区間', () => {
  it('尾根を抜く区間が掘られ、既存のトンネル台帳に載る', () => {
    // 中央に高い尾根。両側は低い。
    const w = mkWorld((x) => 16 + 34 * Math.exp(-((x - 64) ** 2) / (2 * 12 * 12)), Geo.Rock);
    const { al, plan } = makeRoad(w, [{ x: 8, z: 64 }, { x: 120, z: 64 }], ROAD_STANDARDS[1]);

    expect(lengthByKind(al)[RoadKind.Tunnel]).toBeGreaterThanOrEqual(12);
    expect(plan.tunnelLength).toBeGreaterThanOrEqual(12);

    const segs = w.tunnels.segments.filter((s) => s.isTunnel);
    expect(segs.length).toBeGreaterThan(2);
    // 掘った断面は路面幅より広い (建築限界ぶん)
    expect(segs[0].radius).toBeCloseTo(tunnelRadius(ROAD_STANDARDS[1]), 6);
    // 岩なので覆工は要らない。断面が路面幅ぶん大きいぶん土被りの基準も上がるので、
    // 尾根の高さでは全区間が「土被りが薄い」で +1 になる。木枠で足りる。
    for (const s of segs) {
      expect(s.worstGeo).toBe(Geo.Rock);
      expect(s.required).toBeLessThanOrEqual(1);
    }
  });

  it('トンネルと分類した区間は、坑口を除いてすべて台帳に載る', () => {
    // これがこのファイルでいちばん大事なテスト。
    //
    // 分類 (Alignment) と登録 (Tunnel.recordBore) が**別の量**を測っていた頃は、
    // 掘ったのに区間が 1 本も登録されないことがあった (実測: 22 m 掘って 0 本)。
    // そうなるとその帯は支保も崩落も掛からず、しかも回廊の切盛は
    // 「トンネル区間だから」と飛ばすので切土でもない大穴になる。
    // いまは両方が `Tunnel.isTunnelCover` という 1 つの述語を呼ぶので、
    // ずれるのは坑口だけのはず。
    for (const std of ROAD_STANDARDS) {
      const w = mkWorld((x) => 16 + 40 * Math.exp(-((x - 64) ** 2) / (2 * 12 * 12)), Geo.Rock);
      const { al, plan } = makeRoad(w, [{ x: 8, z: 64 }, { x: 120, z: 64 }], std);
      const classified = lengthByKind(al)[RoadKind.Tunnel];
      if (classified < 12) continue; // その規格ではトンネルにならない地形
      expect(plan.tunnelLength).toBeCloseTo(classified, 6);

      const registered = w.tunnels.segments.filter((s) => s.isTunnel).length * SEGMENT_LENGTH;
      // 坑口の土被りは、分類のあとに当てる取付部の切土で削られる。
      // 一巡で計画する以上ここは消せないので、両端 1 測点ぶんだけ許す。
      const portalSlack = 2 * SEGMENT_LENGTH * 2;
      expect(registered).toBeGreaterThanOrEqual(classified - portalSlack);
      expect(registered).toBeLessThanOrEqual(classified + portalSlack);
    }
  });

  it('軟弱層の尾根を抜くと支保が要る — 特別扱いは書いていない', () => {
    const w = mkWorld((x) => 16 + 34 * Math.exp(-((x - 64) ** 2) / (2 * 12 * 12)), Geo.Weak);
    makeRoad(w, [{ x: 8, z: 64 }, { x: 120, z: 64 }], ROAD_STANDARDS[1]);
    const segs = w.tunnels.segments.filter((s) => s.isTunnel);
    expect(segs.length).toBeGreaterThan(3);
    expect(segs.some((s) => s.required >= 2)).toBe(true);
  });
});

describe('見積り', () => {
  it('規格外の線形と資金不足は着工前に理由が出る', () => {
    const w = mkWorld(() => 30);
    const al = buildAlignment(
      [{ x: 20, z: 64 }, { x: 100, z: 64 }],
      terrainProbe(w.field, w.index),
      ROAD_STANDARDS[1],
    );
    w.economy.money = 10;
    const plan = planRoad(w.field, w.index, al, w.economy, trueGeo(w));
    expect(plan.ok).toBe(false);
    expect(plan.problems.join()).toContain('資金が足りない');
    expect(
      w.roads.build(w.field, chunks, w.index, w.repose, w.tunnels, w.bridges, w.economy, plan),
    ).toBeNull();
  });

  it('工期 0 — 舗装は着工した瞬間に供用になる', () => {
    const w = mkWorld(() => 30);
    const { road, plan } = makeRoad(w, [{ x: 20, z: 64 }, { x: 100, z: 64 }]);
    expect(road).not.toBeNull();
    // update を 1 回も回さずに供用済み
    expect(road!.paved).toBe(true);
    expect(w.crew.length).toBe(0);
    // 見積りの工期そのものは残してある (工期を戻すときに使う)
    expect(plan.hours).toBeGreaterThan(0);
  });

  it('規格が違えば土工量も変わる — 曲がれないほうが地形を切る', () => {
    const control: Vec2[] = [
      { x: 16, z: 30 }, { x: 60, z: 40 }, { x: 60, z: 96 }, { x: 112, z: 100 },
    ];
    const bend = (x: number, z: number): number => 20 + 0.2 * x + 0.12 * z;
    const a = mkWorld(bend);
    const b = mkWorld(bend);
    const pa = makeRoad(a, control, ROAD_STANDARDS[0]).plan;
    const pb = makeRoad(b, control, ROAD_STANDARDS[1]).plan;
    expect(pb.al.minRadius).toBeGreaterThan(pa.al.minRadius);
    expect(pb.al.maxOffset).toBeGreaterThan(pa.al.maxOffset);
  });
});

describe('地盤高の読み', () => {
  it('格子の間も双一次で滑らかに読める', () => {
    const w = mkWorld((x) => 20 + x * 0.25);
    // 格子点のちょうど中間でも段にならない
    const a = groundHeightAt(w.index, 40.0, 64);
    const m = groundHeightAt(w.index, 40.25, 64);
    const b = groundHeightAt(w.index, 40.5, 64);
    expect(m).toBeGreaterThan(a);
    expect(m).toBeLessThan(b);
    expect(m).toBeCloseTo((a + b) / 2, 6);
  });
});
