/**
 * ゲーム内時間。リアルタイム進行。
 * 支保の劣化タイマーや掘削の進捗はすべてここの経過時間で回る。
 */
export class Time {
  /** 実時間 1 秒あたりのゲーム内時間 [時]。 */
  static readonly HOURS_PER_SECOND = 0.5;

  private _speed = 1;
  private _gameHours = 0;
  private _last = performance.now();

  /** 前フレームからの実時間 [s]。速度倍率は掛かっていない。 */
  realDelta = 0;
  /** 前フレームからのゲーム内時間 [時]。速度倍率が掛かっている。 */
  gameDelta = 0;

  get speed(): number {
    return this._speed;
  }

  set speed(v: number) {
    this._speed = Math.max(0, v);
  }

  get gameHours(): number {
    return this._gameHours;
  }

  tick(): void {
    const now = performance.now();
    // タブ復帰などで巨大な dt が来ると劣化タイマーが一気に飛ぶので上限を掛ける
    this.realDelta = Math.min((now - this._last) / 1000, 0.1);
    this._last = now;
    this.gameDelta = this.realDelta * this._speed * Time.HOURS_PER_SECOND;
    this._gameHours += this.gameDelta;
  }

  /** "3日 14:30" のような表示用文字列。 */
  format(): string {
    const totalH = this._gameHours;
    const day = Math.floor(totalH / 24) + 1;
    const h = Math.floor(totalH % 24);
    const m = Math.floor((totalH * 60) % 60);
    return `${day}日 ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
}
