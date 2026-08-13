export type ToolId =
  | 'look' | 'dig' | 'fill'
  | 'sup1' | 'sup2' | 'sup3'
  | 'slope1' | 'slope2' | 'slope3'
  | 'boring' | 'section';

interface ToolDef {
  id: ToolId;
  label: string;
  key: string;
  hint: string;
  /** 支保ツールなら設置するレベル。 */
  support?: number;
  /** 法面保護工ツールなら施工するレベル。 */
  slope?: number;
}

const TOOLS: ToolDef[] = [
  { id: 'look', label: '見る', key: 'Q', hint: '左ドラッグで回転' },
  { id: 'dig', label: '掘る', key: 'W', hint: '左ドラッグで掘削 / 右ドラッグで回転' },
  { id: 'fill', label: '盛る', key: 'E', hint: '左ドラッグで盛土 / 右ドラッグで回転' },
  { id: 'sup1', label: '木枠', key: 'A', hint: '坑道か警告柱を狙ってドラッグ → 木枠 (L1)。狙った区間の前後 6 m に入る', support: 1 },
  { id: 'sup2', label: '覆工', key: 'S', hint: '坑道か警告柱を狙ってドラッグ → コンクリート覆工 (L2)。狙った区間の前後 6 m に入る', support: 2 },
  { id: 'sup3', label: '鋼製', key: 'D', hint: '坑道か警告柱を狙ってドラッグ → 鋼製支保+排水 (L3)。狙った区間の前後 6 m に入る', support: 3 },
  { id: 'slope1', label: '吹付', key: 'F', hint: '地表をドラッグして種子吹付 (45°)。塗った所は安息角ではなくこの角度で立つ', slope: 1 },
  { id: 'slope2', label: '法枠', key: 'G', hint: '地表をドラッグして法枠 (65°)。用地を節約できるが高い', slope: 2 },
  { id: 'slope3', label: '擁壁', key: 'H', hint: '地表をドラッグして擁壁 (88°)。ほぼ垂直に切れる。いちばん高い', slope: 3 },
  { id: 'boring', label: '調査', key: 'Z', hint: 'クリックでボーリング調査。周囲 9 m の地質が分かる' },
  { id: 'section', label: '断面', key: 'X', hint: '地表をドラッグして断面線を引く。裏付けの無い地質は伏せられる' },
];

/** そのツールが設置する支保レベル。支保ツールでなければ 0。 */
export function toolSupportLevel(id: ToolId): number {
  return TOOLS.find((t) => t.id === id)?.support ?? 0;
}

/** そのツールが施工する法面保護工のレベル。保護工ツールでなければ 0。 */
export function toolSlopeLevel(id: ToolId): number {
  return TOOLS.find((t) => t.id === id)?.slope ?? 0;
}

/** 画面下中央のツール選択。キーボードでも切り替えられる。 */
export class Toolbar {
  private root: HTMLElement;
  private buttons = new Map<ToolId, HTMLElement>();
  private _current: ToolId = 'look';
  onChange: (t: ToolId) => void = () => {};

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'panel';
    this.root.id = 'toolbar';
    document.body.appendChild(this.root);

    const style = document.createElement('style');
    style.textContent = `
      #toolbar {
        bottom: 12px; left: 50%; transform: translateX(-50%);
        display: flex; gap: 4px; padding: 5px;
      }
      #toolbar button {
        font: inherit; font-size: 12px; color: #c8d0dc;
        background: transparent; border: 1px solid transparent; border-radius: 5px;
        padding: 6px 13px; cursor: pointer; white-space: nowrap;
      }
      #toolbar button:hover { background: rgba(255,255,255,.06); }
      #toolbar button.on {
        background: #3d6ea8; border-color: #5b90d0; color: #fff;
      }
      #toolbar button .k { opacity: .5; margin-left: 6px; font-size: 10px; }
    `;
    document.head.appendChild(style);

    for (const t of TOOLS) {
      const b = document.createElement('button');
      b.innerHTML = `${t.label}<span class="k">${t.key}</span>`;
      b.title = t.hint;
      b.addEventListener('click', () => this.select(t.id));
      this.root.appendChild(b);
      this.buttons.set(t.id, b);
    }

    window.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = TOOLS.find((x) => x.key.toLowerCase() === e.key.toLowerCase());
      if (t) this.select(t.id);
    });

    this.refresh();
  }

  get current(): ToolId {
    return this._current;
  }

  select(id: ToolId): void {
    if (this._current === id) return;
    this._current = id;
    this.refresh();
    this.onChange(id);
  }

  private refresh(): void {
    for (const [id, el] of this.buttons) el.classList.toggle('on', id === this._current);
    const t = TOOLS.find((x) => x.id === this._current)!;
    const help = document.getElementById('help');
    if (help) {
      help.innerHTML = `<b>${t.label}</b> — ${t.hint}<br><b>ホイール</b> ズーム / <b>[ ]</b> ブラシ半径 / <b>0-3</b> 時間速度`;
    }
  }
}
