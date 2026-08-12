/**
 * 支保。企画どおり 3 種類だけ。コストと施工速度がトレードオフになっている。
 * 木枠は安くて速いがレベル 1 までしか持たない。鋼製支保は高くて遅いが軟弱層 + 水位下でも持つ。
 */

export interface SupportDef {
  level: number;
  name: string;
  /** セグメント 1 本 (2 m) あたりの費用。 */
  cost: number;
  /** セグメント 1 本あたりの施工時間 [ゲーム内時間]。 */
  hours: number;
  color: number;
}

export const SUPPORT_NONE = 0;

/**
 * 施工時間は Tunnel.ts の HOURS_TO_FAIL_BASE より十分短く保つこと。
 * 施工班は 1 班しかいない (順番に処理する) ので、
 * 長いトンネルを一気に掘ると末端の施工が間に合わずに落ちる。それが狙いの緊張。
 * ただし「掘った直後の 1 本目すら間に合わない」ようだと軟弱層が理不尽になる。
 */
export const SUPPORTS: SupportDef[] = [
  { level: 1, name: '木枠', cost: 900, hours: 0.4, color: 0xb07a3c },
  { level: 2, name: 'コンクリート覆工', cost: 4200, hours: 1.2, color: 0xb9bcc0 },
  { level: 3, name: '鋼製支保+排水', cost: 11000, hours: 2.2, color: 0x6f8fb5 },
];

export function supportDef(level: number): SupportDef | null {
  return SUPPORTS.find((s) => s.level === level) ?? null;
}

export function supportName(level: number): string {
  if (level <= 0) return '無支保';
  return supportDef(level)?.name ?? `L${level}`;
}
