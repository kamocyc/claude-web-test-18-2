import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { TunnelNetwork, SEGMENT_LENGTH, type TunnelSegment } from './Tunnel';
import { VoxelField } from '../terrain/VoxelField';
import { CELL, NX, NY, NZ, Geo, WATER_TABLE_Y } from '../terrain/config';

/**
 * 必要支保レベルの判定。企画の表をそのまま数値で固定しておく。
 *   岩 0 / 土 1 / 軟弱 2、水位より下なら +1、土被りが薄ければ +1、
 *   土被りが掘削半径の 1.2 倍未満ならそもそもトンネル扱いしない。
 * ここが崩れるとゲームの判断がまるごと変わるので、目視ではなく数値で押さえる。
 */

const SURFACE_Y = 55;
const R = 2.6;

/** 地表 y=55 の一様な地盤。地質は (x,z) の区画ごとに塗り分ける。 */
function buildField(): VoxelField {
  const f = new VoxelField();
  for (let k = 0; k < NZ; k++) {
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) {
        const idx = f.idx(i, j, k);
        f.density[idx] = SURFACE_Y - j * CELL;
        // x で 3 つの区画に分ける: 土 / 岩 / 軟弱
        const x = i * CELL;
        f.material[idx] = x < 40 ? Geo.Soil : x < 80 ? Geo.Rock : Geo.Weak;
      }
    }
  }
  return f;
}

function segAt(x: number, y: number, z: number): TunnelSegment {
  return {
    id: 1,
    pos: new THREE.Vector3(x, y, z),
    dir: new THREE.Vector3(0, 0, 1),
    radius: R,
    worstGeo: Geo.Soil,
    required: 0,
    installed: 0,
    integrity: 1,
    cover: 0,
    belowWater: false,
    isTunnel: true,
    collapsed: false,
    installRemaining: 0,
    installTarget: 0,
    warned: false,
  };
}

describe('必要支保レベル', () => {
  let field: VoxelField;
  let net: TunnelNetwork;

  beforeAll(() => {
    field = buildField();
    net = new TunnelNetwork();
  });

  // 土被りは十分深く、水位より上になる高さ
  const DEEP_Y = 30;
  const X_SOIL = 20;
  const X_ROCK = 60;
  const X_WEAK = 100;

  it('岩は無支保で持つ', () => {
    const s = segAt(X_ROCK, DEEP_Y, 60);
    net.evaluate(field, s);
    expect(s.isTunnel).toBe(true);
    expect(s.worstGeo).toBe(Geo.Rock);
    expect(s.required).toBe(0);
  });

  it('土は 1 段階', () => {
    const s = segAt(X_SOIL, DEEP_Y, 60);
    net.evaluate(field, s);
    expect(s.required).toBe(1);
  });

  it('軟弱層は 2 段階', () => {
    const s = segAt(X_WEAK, DEEP_Y, 60);
    net.evaluate(field, s);
    expect(s.worstGeo).toBe(Geo.Weak);
    expect(s.required).toBe(2);
  });

  it('地下水位より下は +1', () => {
    const wet = segAt(X_WEAK, WATER_TABLE_Y - 4, 60);
    net.evaluate(field, wet);
    expect(wet.belowWater).toBe(true);
    expect(wet.required).toBe(3);

    const drySoil = segAt(X_SOIL, DEEP_Y, 60);
    const wetSoil = segAt(X_SOIL, WATER_TABLE_Y - 4, 60);
    net.evaluate(field, drySoil);
    net.evaluate(field, wetSoil);
    expect(wetSoil.required).toBe(drySoil.required + 1);
  });

  it('レベルは 3 で頭打ち', () => {
    // 軟弱層 2 + 水位下 1 + 浅い 1 = 4 だが 3 に収まる
    const y = SURFACE_Y - R * 1.05 - R * 2.0; // 土被り 2.0r → 「浅い」判定
    expect(y).toBeLessThan(WATER_TABLE_Y + 100);
    const s = segAt(X_WEAK, Math.min(y, WATER_TABLE_Y - 2), 60);
    net.evaluate(field, s);
    expect(s.required).toBeLessThanOrEqual(3);
  });

  it('土被りが浅いと +1', () => {
    // 掘削半径の 1.2 倍 < 土被り < 3 倍 に入る高さ
    const shallowY = SURFACE_Y - R * 1.05 - R * 2.0;
    const s = segAt(X_ROCK, shallowY, 60);
    net.evaluate(field, s);
    expect(s.isTunnel).toBe(true);
    expect(s.cover).toBeGreaterThan(R * 1.5);
    expect(s.cover).toBeLessThan(R * 3);
    // 岩 0 + 浅い 1
    expect(s.required).toBe(1);
  });

  it('土被りが掘削半径の 1.2 倍未満ならトンネル扱いしない (切土・坑口)', () => {
    const openY = SURFACE_Y - R * 1.05 - R * 0.8;
    const s = segAt(X_WEAK, openY, 60);
    net.evaluate(field, s);
    expect(s.isTunnel).toBe(false);
    // 溝を掘っただけの所に支保を要求してはいけない
    expect(s.required).toBe(0);
  });

  it('支保不足は時間が止まっていても即座に警告される', () => {
    // 健全度が目に見えて落ちてから知らせたのでは遅い。
    // 掘った瞬間に不足が確定するので、その時点で出す。
    const n = new TunnelNetwork();
    const weak = segAt(X_WEAK, DEEP_Y, 60);
    n.evaluate(field, weak);
    expect(weak.required).toBeGreaterThan(0);
    n.segments.push(weak);

    // gameDelta = 0 (一時停止中) でも警告が出ること
    n.update(field, null as never, 0);
    expect(n.newlyAtRisk).toHaveLength(1);
    expect(n.newlyAtRisk[0]).toBe(weak);

    // 二度は出さない
    n.update(field, null as never, 0);
    expect(n.newlyAtRisk).toHaveLength(0);

    // 支保が足りたら警告を降ろし、また足りなくなれば出し直す
    weak.installed = weak.required;
    n.update(field, null as never, 0);
    expect(n.newlyAtRisk).toHaveLength(0);
    weak.installed = 0;
    n.update(field, null as never, 0);
    expect(n.newlyAtRisk).toHaveLength(1);
  });

  it('崩落までの残り時間は不足段階の 2 乗で縮む', () => {
    const s = segAt(X_WEAK, DEEP_Y, 60);
    s.required = 3;
    s.installed = 2;
    s.integrity = 1;
    const d1 = TunnelNetwork.hoursToFailure(s);
    s.installed = 0;
    const d3 = TunnelNetwork.hoursToFailure(s);
    expect(d1).toBeCloseTo(80, 5);
    expect(d3).toBeCloseTo(80 / 9, 5);

    // 健全度が減れば残り時間も比例して減る
    s.integrity = 0.5;
    expect(TunnelNetwork.hoursToFailure(s)).toBeCloseTo(d3 / 2, 5);

    // 足りていれば崩落しない
    s.installed = 3;
    expect(TunnelNetwork.hoursToFailure(s)).toBe(Infinity);
  });

  it('崩落した区間は掘り返すと片付き、新しい区間に置き換わる', () => {
    // 崩落区間は再評価されないので、放っておくと再開通した坑道の中に
    // 崩落済みマーカーが残り続け、掘り直すたびに区間が増えていく。
    const n = new TunnelNetwork();
    const dir = new THREE.Vector3(1, 0, 0);
    const head = new THREE.Vector3(X_WEAK, DEEP_Y, 60);

    n.recordBore(field, head, dir, R);
    expect(n.segments).toHaveLength(1);

    // 崩落させる
    const s0 = n.segments[0];
    s0.collapsed = true;
    s0.integrity = 0;

    // 同じ所を掘り直す
    n.endBore();
    n.recordBore(field, head, dir, R);

    expect(n.segments).toHaveLength(1);
    expect(n.segments[0].collapsed).toBe(false);
    expect(n.segments[0].id).not.toBe(s0.id);

    // 離れた所の崩落マーカーは残る
    const far = new THREE.Vector3(X_WEAK, DEEP_Y, 60 + SEGMENT_LENGTH * 4);
    n.endBore();
    n.recordBore(field, far, dir, R);
    n.segments[n.segments.length - 1].collapsed = true;
    n.endBore();
    n.recordBore(field, head.clone().add(new THREE.Vector3(0, 0, 0.1)), dir, R);
    expect(n.segments.filter((s) => s.collapsed)).toHaveLength(1);
  });

  it('必要 0 の区間には支保を予約できない (金と施工班の無駄)', () => {
    const rock = segAt(X_ROCK, DEEP_Y, 60);
    net.evaluate(field, rock);
    const economy = { money: 999999, spend(n: number) { this.money -= n; } };
    const before = economy.money;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ok = net.queueInstall(rock, 3, economy as any);
    expect(ok).toBe(false);
    expect(economy.money).toBe(before);
  });
});
