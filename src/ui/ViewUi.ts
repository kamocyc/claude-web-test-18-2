import type { ViewMode } from '../core/Engine';

/**
 * 視点モードまわりの表示。切替ボタン・十字・ロック案内の 3 つ。
 *
 * 十字は「今どこを狙っているか」だけでなく**手が届いているか**も出す。
 * 一人称で扱えるのは正面 4.5 m までなので、届いていないのに押しても何も
 * 起きない。届いた瞬間に十字が締まれば、それが唯一の合図になる。
 */
export class ViewUi {
  private button: HTMLButtonElement;
  private cross: HTMLElement;
  private hint: HTMLElement;
  private mode: ViewMode = 'orbit';
  onToggle: () => void = () => {};

  constructor() {
    const style = document.createElement('style');
    style.textContent = `
      /* 右上は警告 (#alerts) の場所。重ねると崩落の予告が読めなくなる。 */
      #viewmode { top: 12px; left: 50%; transform: translateX(-50%); padding: 5px; }
      #viewmode button {
        font: inherit; font-size: 12px; color: #c8d0dc;
        background: transparent; border: 1px solid transparent; border-radius: 5px;
        padding: 6px 13px; cursor: pointer; white-space: nowrap;
      }
      #viewmode button:hover { background: rgba(255,255,255,.06); }
      #viewmode button.on { background: #3d6ea8; border-color: #5b90d0; color: #fff; }
      #viewmode .k { opacity: .5; margin-left: 6px; font-size: 10px; }

      #cross {
        position: fixed; left: 50%; top: 50%; width: 22px; height: 22px;
        margin: -11px 0 0 -11px; pointer-events: none; display: none;
      }
      #cross::before, #cross::after {
        content: ''; position: absolute; background: #fff;
        box-shadow: 0 0 2px rgba(0,0,0,.9);
      }
      #cross::before { left: 50%; top: 0; width: 1px; height: 100%; margin-left: -0.5px; }
      #cross::after { top: 50%; left: 0; height: 1px; width: 100%; margin-top: -0.5px; }
      #cross.on { display: block; opacity: .35; }
      #cross.aim { opacity: 1; }

      #lockhint {
        position: fixed; left: 50%; top: 54%; transform: translateX(-50%);
        padding: 9px 16px; display: none; font-size: 13px;
      }
      #lockhint.on { display: block; }
    `;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.className = 'panel';
    root.id = 'viewmode';
    this.button = document.createElement('button');
    this.button.addEventListener('click', () => this.onToggle());
    root.appendChild(this.button);
    document.body.appendChild(root);

    this.cross = document.createElement('div');
    this.cross.id = 'cross';
    document.body.appendChild(this.cross);

    this.hint = document.createElement('div');
    this.hint.id = 'lockhint';
    this.hint.className = 'panel';
    this.hint.innerHTML = 'クリックで視点を掴む — <b>WASD</b> 移動 / <b>Space</b> 跳ぶ / <b>Shift</b> 走る / <b>Tab</b> 俯瞰へ';
    document.body.appendChild(this.hint);

    this.setMode('orbit');
  }

  setMode(mode: ViewMode): void {
    this.mode = mode;
    const fp = mode === 'fp';
    this.button.innerHTML = `${fp ? '一人称' : '俯瞰'}<span class="k">Tab</span>`;
    this.button.classList.toggle('on', fp);
    this.cross.classList.toggle('on', fp);
  }

  /** ポインタロックを掴んでいるか。掴めていない間は案内を出す。 */
  setLocked(locked: boolean): void {
    this.hint.classList.toggle('on', this.mode === 'fp' && !locked);
  }

  /** 狙いが手の届く所にあるか。 */
  setAim(inReach: boolean): void {
    this.cross.classList.toggle('aim', inReach);
  }
}
