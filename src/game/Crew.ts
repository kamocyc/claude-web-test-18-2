/**
 * 施工班。**1 班しかいない。**
 *
 * 支保もこれを使い、法面保護工もこれを使う。押した順に 1 本ずつしか
 * 進まないので、両者は同じ班を奪い合う。「トンネルを急ぐか、法面を
 * 押さえるか」という選択がここで初めて意味を持つ。
 *
 * キューを TunnelNetwork の中に置いたままにすると、支保専用の列と
 * 保護工専用の列ができて、班が 2 つあるのと変わらなくなる。
 */

export interface CrewJob {
  /** 残り施工時間 [ゲーム内時間]。 */
  hours: number;
  /** HUD 表示用の名前。 */
  label: string;
  /**
   * まだ意味のあるジョブか。崩落した区間の支保などは捨てる。
   * 捨てられたジョブの費用は戻らない (前払いなので)。
   */
  alive(): boolean;
  /** 順番が来て時間を使い切ったときに呼ばれる。ここで効果を適用する。 */
  finish(): void;
}

export class Crew {
  private jobs: CrewJob[] = [];

  /** 施工待ちの件数。 */
  get length(): number {
    return this.jobs.length;
  }

  /** 先頭のジョブ。HUD が「今なにを作っているか」を出すのに使う。 */
  get current(): CrewJob | null {
    return this.jobs[0] ?? null;
  }

  push(job: CrewJob): void {
    this.jobs.push(job);
  }

  /**
   * そのジョブが終わるまでの見込み時間 [ゲーム内時間]。列に無ければ null。
   *
   * 1 班しかいないので、列の前に積まれたジョブの残り時間を全部足す。
   * これを出さないと、押した瞬間に金だけ減って見た目が変わらないので
   * 「効いていないのでは」と思われる。
   */
  eta(job: CrewJob): number | null {
    const idx = this.jobs.indexOf(job);
    if (idx < 0) return null;
    let h = 0;
    for (let i = 0; i <= idx; i++) h += Math.max(0, this.jobs[i].hours);
    return h;
  }

  /** 列全部を捌き終わるまでの見込み時間 [ゲーム内時間]。 */
  get totalHours(): number {
    let h = 0;
    for (const j of this.jobs) h += Math.max(0, j.hours);
    return h;
  }

  /**
   * 先頭から順に進める。余った時間は次のジョブへ繰り越す
   * (繰り越さないと、短いジョブが並んだときに 1 フレーム 1 本しか進まない)。
   * @returns 何か完了したか
   */
  update(gameDelta: number): boolean {
    let left = gameDelta;
    let finished = false;
    while (left > 0 && this.jobs.length > 0) {
      const job = this.jobs[0];
      if (!job.alive()) {
        this.jobs.shift();
        continue;
      }
      if (job.hours > left) {
        job.hours -= left;
        left = 0;
        break;
      }
      left -= job.hours;
      job.hours = 0;
      this.jobs.shift();
      job.finish();
      finished = true;
    }
    return finished;
  }
}
