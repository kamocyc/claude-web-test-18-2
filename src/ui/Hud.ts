import type { ChunkStats } from '../terrain/ChunkManager';
import type { Time } from '../core/Time';

/** 画面左上の状態表示と、左下の性能表示。 */
export class Hud {
  private root: HTMLElement;
  private perf: HTMLElement;
  private fpsAvg = 60;

  constructor() {
    this.root = document.getElementById('hud')!;
    this.perf = document.getElementById('perf')!;
  }

  private static row(k: string, v: string): string {
    return `<div class="row"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  }

  update(time: Time, stats: ChunkStats, extra: string = ''): void {
    this.root.innerHTML =
      Hud.row('時刻', time.format()) +
      Hud.row('速度', `x${time.speed}`) +
      (extra ? '<hr>' + extra : '');

    const fps = time.realDelta > 0 ? 1 / time.realDelta : 0;
    this.fpsAvg += (fps - this.fpsAvg) * 0.08;

    this.perf.innerHTML =
      `${this.fpsAvg.toFixed(0)} fps · ` +
      `${stats.meshedChunks} chunks · ` +
      `${(stats.triangles / 1000).toFixed(0)}k tris` +
      (stats.dirtyRemaining > 0 ? ` · remesh ${stats.dirtyRemaining}` : '');
  }
}
