import { DIG_COST, GEO_COUNT, GEO_NAME_JA } from '../terrain/config';

/**
 * 資金と土量。
 * 掘った土は消えずに残土になり、盛土で使える。余れば搬出費、足りなければ購入費。
 * 「切土と盛土を釣り合わせる」という土木の基本がこれだけで意思決定になる。
 */
export class Economy {
  money = 250_000;
  /** 残土 [m^3]。 */
  spoil = 0;
  /** 地質別の累計掘削量 [m^3]。 */
  readonly digged = new Float64Array(GEO_COUNT);

  /** 搬出単価 / 購入単価 [金/m^3]。 */
  static readonly HAUL_COST = 3;
  static readonly IMPORT_COST = 12;

  spend(amount: number): void {
    this.money -= amount;
  }

  /** 掘削の記帳。戻り値は掛かった費用。 */
  chargeExcavation(volumeByGeo: Float64Array): number {
    let cost = 0;
    let net = 0;
    for (let g = 0; g < GEO_COUNT; g++) {
      const v = volumeByGeo[g];
      if (v === 0) continue;
      if (v > 0) {
        cost += v * DIG_COST[g];
        this.digged[g] += v;
      }
      net += v;
    }
    if (net > 0) {
      this.spoil += net;
    } else {
      // 盛土。残土から充当し、足りない分は購入。
      const need = -net;
      const fromSpoil = Math.min(this.spoil, need);
      this.spoil -= fromSpoil;
      cost += (need - fromSpoil) * Economy.IMPORT_COST;
    }
    this.money -= cost;
    return cost;
  }

  /** 表示用の内訳。 */
  breakdown(): string {
    const parts: string[] = [];
    for (let g = 0; g < GEO_COUNT; g++) {
      if (this.digged[g] > 0.5) parts.push(`${GEO_NAME_JA[g]} ${this.digged[g].toFixed(0)}`);
    }
    return parts.join(' / ') || '-';
  }
}
