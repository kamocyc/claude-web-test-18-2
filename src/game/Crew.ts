/**
 * 施工班。**1 班しかいない。**
 *
 * 支保もこれを使い、法面保護工もこれを使う。橋も舗装もここへ積まれる。
 * キューを TunnelNetwork の中に置いたままにすると、支保専用の列と
 * 保護工専用の列ができて、班が 2 つあるのと変わらなくなる。
 *
 * ---- 今は工期 0 ----
 * `CREW_TIMED = false` にしてあるので、**積まれた仕事は押した瞬間に完成する**。
 * 工種で例外を作っていない。覆工も擁壁も、木枠も吹付も、橋も舗装も同じ。
 *
 * 待ち行列そのものは残してある。所要時間の表 (`SUPPORTS.hours`,
 * `SLOPE_WORKS.hours`, `PIER_HOURS`, `paveHours` …) も残っているので、
 * 工期を戻したくなったら `CREW_TIMED` を true にするだけでよい。
 * 表の値を 0 で潰すと「高い工法ほど手間がかかる」という設計意図まで
 * 消えてしまい、戻すときに数字を作り直す羽目になる。
 *
 * 消えるものははっきりさせておく: 1 班しかいないことによる
 * 「トンネルを急ぐか法面を押さえるか」の取り合いは無くなる。順番待ちが
 * 無いので、金さえあれば掘った端から支保が入る。
 */

/**
 * 施工に時間をかけるか。false なら計画から完成までが 0。
 * 個々の `Crew` はここを既定値として受け取る (試験は明示的に上書きする)。
 */
export const CREW_TIMED = false;

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

  /**
   * 工期を持つか。false なら `push` した瞬間に `finish` まで走る。
   * @param timed 既定は `CREW_TIMED`。待ち行列そのものを試すときだけ true を渡す。
   */
  constructor(readonly timed: boolean = CREW_TIMED) {}

  /** 施工待ちの件数。工期 0 のときは常に 0。 */
  get length(): number {
    return this.jobs.length;
  }

  /** 先頭のジョブ。HUD が「今なにを作っているか」を出すのに使う。 */
  get current(): CrewJob | null {
    return this.jobs[0] ?? null;
  }

  push(job: CrewJob): void {
    if (!this.timed) {
      // 工期 0。列に積まずにその場で終わらせる。
      // 積んでから update で流さないのは、時間を止めている (速度 0) と
      // gameDelta が 0 のままで永久に着工しないため。「押した瞬間に完成」を
      // 時間の進み方に依存させない。
      job.hours = 0;
      if (job.alive()) job.finish();
      return;
    }
    this.jobs.push(job);
  }

  /**
   * そのジョブが終わるまでの見込み時間 [ゲーム内時間]。列に無ければ null。
   * 工期 0 のときは何も列に無いので常に null になり、HUD の ETA 表示は消える。
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
