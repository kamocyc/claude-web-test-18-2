import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  sampleBearing, capacityOf, planPier, planBridge, BRIDGE_TYPES,
  BridgeNetwork, FOOTING_RADIUS, MAX_FOUNDATION_DEPTH,
  type GeoSampler, type PierSite,
} from './Bridge';
import { Crew } from './Crew';
import { Geo, GEO_BEARING } from '../terrain/config';

/**
 * 橋。押さえたいのは 4 つ。
 *   1. 支持力は**弱い所が決める**。基礎の一部が軟弱層に掛かっただけで急落すること
 *      (算術平均にすると、この判断がまるごと消える)
 *   2. 直接基礎で足りなければ深礎で支持層まで下ろし、届かなければ立たないこと
 *   3. 支間表が意思決定になること — 短支間で立たない谷が、長支間なら渡れること
 *   4. あとから足元を掘れば支持力が落ちて落橋に向かうこと (トンネルと同じ因果)
 */

const rock: GeoSampler = () => Geo.Rock;
const weak: GeoSampler = () => Geo.Weak;

/** y > -8 は軟弱層、それより下は岩。深礎を下ろせば届く谷底。 */
const softOverRock = (boundary: number): GeoSampler =>
  (_x, y) => (y > boundary ? Geo.Weak : Geo.Rock);

describe('支持力のサンプル', () => {
  it('一様なら地質の値そのもの', () => {
    for (const g of [Geo.Soil, Geo.Rock, Geo.Weak]) {
      const s = sampleBearing(() => g, 30, 10, 30);
      expect(s.bearing).toBeCloseTo(GEO_BEARING[g], 6);
      expect(s.worstGeo).toBe(g);
    }
  });

  it('基礎の一部が軟弱層に掛かると急落する — 算術平均では起きない', () => {
    // x < 30 が岩、x >= 30 が軟弱層。中心 30 なので円盤のほぼ半分が軟弱層。
    const half: GeoSampler = (x) => (x < 30 ? Geo.Rock : Geo.Weak);
    const s = sampleBearing(half, 30, 10, 30);

    const arithmetic = (GEO_BEARING[Geo.Rock] + GEO_BEARING[Geo.Weak]) / 2;
    expect(s.bearing).toBeLessThan(arithmetic / 10);
    // 岩そのものの 1/20 以下まで落ちる
    expect(s.bearing).toBeLessThan(GEO_BEARING[Geo.Rock] / 20);
    expect(s.worstGeo).toBe(Geo.Weak);
  });

  it('円盤の外は見ない', () => {
    const far: GeoSampler = (x) => (x > 30 + FOOTING_RADIUS + 1 ? Geo.Weak : Geo.Rock);
    expect(sampleBearing(far, 30, 10, 30).bearing).toBeCloseTo(GEO_BEARING[Geo.Rock], 6);
  });
});

describe('橋脚', () => {
  const site = (groundY = 10): PierSite => ({
    s: 40, x: 60, z: 60, deckY: 34, groundY,
  });

  it('岩なら直接基礎で立つ', () => {
    const p = planPier(rock, site(), 20, 9, BRIDGE_TYPES[0]);
    expect(p.ok).toBe(true);
    expect(p.foundDepth).toBe(0);
    expect(p.capacity).toBeGreaterThan(p.load);
  });

  it('軟弱層だけなら深礎の限界まで下ろしても立たない', () => {
    const p = planPier(weak, site(), 20, 9, BRIDGE_TYPES[0]);
    expect(p.ok).toBe(false);
    expect(p.foundDepth).toBe(0); // どこまで下ろしても改善しないので直接基礎のまま
    expect(capacityOf(p.bearing)).toBeLessThan(p.load);
  });

  it('軟弱層の下に岩があれば深礎で届き、その分だけ高くなる', () => {
    const shallow = planPier(softOverRock(3), site(), 20, 9, BRIDGE_TYPES[0]);
    const deep = planPier(softOverRock(-6), site(), 20, 9, BRIDGE_TYPES[0]);
    expect(shallow.ok).toBe(true);
    expect(deep.ok).toBe(true);
    expect(deep.foundDepth).toBeGreaterThan(shallow.foundDepth);
    expect(deep.cost).toBeGreaterThan(shallow.cost);
    expect(deep.hours).toBeGreaterThan(shallow.hours);
  });

  it('支持層が深礎の限界より深ければ立たない', () => {
    const p = planPier(softOverRock(10 - MAX_FOUNDATION_DEPTH - 5), site(), 20, 9, BRIDGE_TYPES[0]);
    expect(p.ok).toBe(false);
  });

  it('橋脚が高いほど足元の荷重が増える', () => {
    const low = planPier(rock, site(28), 20, 9, BRIDGE_TYPES[0]);
    const high = planPier(rock, site(2), 20, 9, BRIDGE_TYPES[0]);
    expect(high.load).toBeGreaterThan(low.load);
    expect(high.cost).toBeGreaterThan(low.cost);
  });
});

describe('支間表', () => {
  it('支間が長いほど床版が高く、桁も深い', () => {
    for (let i = 1; i < BRIDGE_TYPES.length; i++) {
      expect(BRIDGE_TYPES[i].maxSpan).toBeGreaterThan(BRIDGE_TYPES[i - 1].maxSpan);
      expect(BRIDGE_TYPES[i].deckCost).toBeGreaterThan(BRIDGE_TYPES[i - 1].deckCost);
      expect(BRIDGE_TYPES[i].deckDepth).toBeGreaterThan(BRIDGE_TYPES[i - 1].deckDepth);
    }
  });

  const siteAt = (groundAt: (x: number) => number) => (s: number): PierSite => ({
    s, x: s, z: 60, deckY: 34, groundY: groundAt(s),
  });

  it('岩の谷は一番安い支間で架かる', () => {
    const plan = planBridge(rock, 0, 30, 20, 80, siteAt(() => 8), 9);
    expect(plan.ok).toBe(true);
    expect(plan.type.id).toBe(BRIDGE_TYPES[0].id);
    expect(plan.spans).toBe(Math.ceil(60 / BRIDGE_TYPES[0].maxSpan));
    expect(plan.piers).toHaveLength(plan.spans - 1);
  });

  it('橋脚の落ちる所だけが軟弱層なら、支間を伸ばして跨げる', () => {
    // 60 m の谷。RC 桁 (最大 20 m) だと 3 径間 = 橋脚が s = 40, 60 に落ちる。
    // その 2 点だけ軟弱層にしておく。PC 箱桁 (最大 45 m) なら 2 径間 = s = 50 の 1 基。
    const badZones = [40, 60];
    const geo: GeoSampler = (x, y) => {
      void y;
      return badZones.some((b) => Math.abs(x - b) < FOOTING_RADIUS + 1) ? Geo.Weak : Geo.Rock;
    };
    const plan = planBridge(geo, 0, 30, 20, 80, siteAt(() => 8), 9);
    expect(plan.ok).toBe(true);
    expect(plan.type.id).toBe('pc');
    expect(plan.piers).toHaveLength(1);
  });

  it('軟弱層の谷が最大支間より長ければ、どの支間でも立たず理由が付く', () => {
    // 100 m は鋼トラス (90 m) でも 1 径間に収まらない = 橋脚が必ず 1 基要る
    const plan = planBridge(weak, 0, 50, 10, 110, siteAt(() => 8), 9);
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain('橋脚が立たない');
    expect(plan.reason).toContain('軟弱層');
  });

  it('橋脚が 1 基も要らない短い橋は地質を問わない (橋台は地山に乗る)', () => {
    const plan = planBridge(weak, 0, 8, 10, 25, siteAt(() => 8), 9);
    expect(plan.spans).toBe(1);
    expect(plan.piers).toHaveLength(0);
    expect(plan.ok).toBe(true);
  });

  it('長い橋ほど高い', () => {
    const short = planBridge(rock, 0, 10, 0, 20, siteAt(() => 8), 9);
    const long = planBridge(rock, 0, 40, 0, 80, siteAt(() => 8), 9);
    expect(long.cost).toBeGreaterThan(short.cost);
  });
});

describe('架かったあと', () => {
  const mkNet = (geo: GeoSampler, groundY: number): { net: BridgeNetwork; crew: Crew } => {
    const crew = new Crew();
    const net = new BridgeNetwork();
    net.useCrew(crew);
    const plan = planBridge(
      geo, 0, 30, 20, 80,
      (s) => ({ s, x: s, z: 60, deckY: 34, groundY }),
      9,
    );
    const path = [new THREE.Vector3(20, 34, 60), new THREE.Vector3(80, 34, 60)];
    net.add(plan, path, 9);
    return { net, crew };
  };

  it('工期 0 — 架けた瞬間に供用になる', () => {
    const { net, crew } = mkNet(rock, 8);
    // update を 1 回も回さずに供用済み。橋も工種で例外にしていない。
    expect(net.bridges[0].built).toBe(true);
    expect(crew.length).toBe(0);
    // 見積りの工期そのものは残してある (工期を戻すときに使う)
    expect(net.bridges[0].plan.hours).toBeGreaterThan(0);
  });

  it('足元の地質が軟弱層に変わると警告が出て、やがて落橋する', () => {
    const { net } = mkNet(rock, 8);
    const b = net.bridges[0];
    expect(b.plan.piers.length).toBeGreaterThan(0);

    // 掘って足元が軟弱層になった、という体で再評価させる
    net.markDirtyByAABB(0, -40, 0, 128, 64, 128);
    net.update(weak, () => 8, 0);
    expect(net.newlyAtRisk).toContain(b);
    expect(BridgeNetwork.worstRatio(b)).toBeGreaterThan(1);
    expect(BridgeNetwork.hoursToFailure(b)).toBeLessThan(Infinity);

    for (let i = 0; i < 400 && !b.collapsed; i++) net.update(weak, () => 8, 1);
    expect(b.collapsed).toBe(true);
    expect(net.status().collapsed).toBe(1);
  });

  it('足元を掘り下げて橋脚が伸びると荷重が増える', () => {
    const { net } = mkNet(rock, 20);
    const b = net.bridges[0];
    const before = b.plan.piers[0].load;
    net.markDirtyByAABB(0, -40, 0, 128, 64, 128);
    net.update(rock, () => 2, 0);
    expect(b.plan.piers[0].load).toBeGreaterThan(before);
    expect(b.plan.piers[0].height).toBeGreaterThan(0);
  });

  it('保っている橋は警告も劣化もしない', () => {
    const { net } = mkNet(rock, 8);
    const b = net.bridges[0];
    for (let i = 0; i < 100; i++) net.update(rock, () => 8, 1);
    expect(b.collapsed).toBe(false);
    expect(b.integrity).toBe(1);
    expect(net.newlyAtRisk).toHaveLength(0);
  });
});
