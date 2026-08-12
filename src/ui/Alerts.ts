import { GEO_NAME_JA } from '../terrain/config';
import { TunnelNetwork } from '../game/Tunnel';
import { supportName, supportDef } from '../game/Support';

/**
 * 支保不足と崩落の警告。
 * 崩落は突然起きてはいけない。健全度のバーで「あと何割か」が常に見えているようにする。
 */
export class Alerts {
  private root: HTMLElement;
  private toast: HTMLElement;
  private toastTimer = 0;

  constructor() {
    const style = document.createElement('style');
    style.textContent = `
      #alerts { top: 12px; right: 12px; padding: 9px 12px; min-width: 232px; max-width: 300px; }
      #alerts.risk { border-color: #c8703a; background: rgba(48,28,16,.88); }
      #alerts.urgent { border-color: #e05a4a; background: rgba(58,20,16,.9); animation: pulse 1s infinite; }
      @keyframes pulse { 50% { border-color: #ff9a86; } }
      #alerts .big { font-size: 15px; font-weight: 600; color: #ffd0a8; margin: 2px 0 4px; }
      #alerts .big.urgent { color: #ffb3a6; }
      #alerts .title { color: #93a0b4; margin-bottom: 5px; }
      #alerts .seg { display: flex; align-items: center; gap: 7px; margin: 3px 0; }
      #alerts .bar { flex: 1; height: 5px; background: rgba(255,255,255,.12); border-radius: 3px; overflow: hidden; }
      #alerts .bar i { display: block; height: 100%; }
      #alerts .n { font-variant-numeric: tabular-nums; color: #c8d0dc; font-size: 11px; }
      #alerts .ok { color: #7fc98a; }
      #alerts .built { display: flex; flex-wrap: wrap; gap: 4px 10px; margin: 4px 0; font-size: 11px; color: #c8d0dc; }
      #toast {
        top: 50%; left: 50%; transform: translate(-50%,-50%);
        padding: 14px 22px; font-size: 15px; font-weight: 600;
        border-color: #b5493c; background: rgba(70,22,18,.9); color: #ffd9d2;
        pointer-events: none; opacity: 0; transition: opacity .25s;
      }
      #toast.on { opacity: 1; }
    `;
    document.head.appendChild(style);

    this.root = document.createElement('div');
    this.root.className = 'panel';
    this.root.id = 'alerts';
    document.body.appendChild(this.root);

    this.toast = document.createElement('div');
    this.toast.className = 'panel';
    this.toast.id = 'toast';
    document.body.appendChild(this.toast);
  }

  static fmtHours(h: number): string {
    if (!Number.isFinite(h)) return '—';
    if (h < 1) return `${Math.max(1, Math.round(h * 60))} 分`;
    if (h < 48) return `${h.toFixed(1)} 時間`;
    return `${(h / 24).toFixed(1)} 日`;
  }

  flash(message: string): void {
    this.toast.textContent = message;
    this.toast.classList.add('on');
    this.toastTimer = 2.6;
  }

  update(net: TunnelNetwork, dt: number): void {
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toast.classList.remove('on');
    }

    const st = net.status();
    if (st.tunnels === 0 && st.collapsed === 0) {
      this.root.style.display = 'none';
      return;
    }
    this.root.style.display = '';

    const parts: string[] = [
      `<div class="title">トンネル ${st.tunnels} 区間` +
      (st.collapsed > 0 ? ` / <span style="color:#e08878">崩落 ${st.collapsed}</span>` : '') +
      (net.queueLength > 0 ? ` / 施工待ち ${net.queueLength}` : '') +
      '</div>',
    ];

    this.root.classList.remove('risk', 'urgent');

    // 設置済み支保の内訳。坑内に入らなくても「どれだけ巻いたか」が分かるように。
    const inst = [0, 0, 0, 0];
    for (const s of net.segments) {
      if (s.collapsed || !s.isTunnel) continue;
      inst[Math.min(3, Math.max(0, s.installed))]++;
    }
    const built = [1, 2, 3]
      .filter((l) => inst[l] > 0)
      .map((l) => {
        const d = supportDef(l)!;
        const hex = '#' + d.color.toString(16).padStart(6, '0');
        return `<span><span class="swatch" style="background:${hex}"></span>${d.name} ${inst[l]}</span>`;
      });
    if (built.length > 0) {
      parts.push(`<div class="built">${built.join('')}</div>`);
    }

    if (st.atRisk === 0) {
      parts.push('<div class="ok">支保は足りている</div>');
    } else {
      const w = st.worst;
      const hours = w ? TunnelNetwork.hoursToFailure(w) : Infinity;
      // 残り 12 時間を切ったら「今すぐ手を打つ」段階として扱う
      const urgent = hours < 12;
      this.root.classList.add(urgent ? 'urgent' : 'risk');

      parts.push(
        `<div class="big${urgent ? ' urgent' : ''}">⚠ 支保不足 ${st.atRisk} 区間</div>`,
      );
      if (w) {
        // 割合ではなく残り時間を主役にする。
        // 「あと何時間で落ちるか」のほうが、支保を入れるか掘り進むかの判断に直結する。
        parts.push(
          `<div class="big${urgent ? ' urgent' : ''}">あと ${Alerts.fmtHours(hours)} で崩落</div>`,
        );
        const pct = Math.max(0, w.integrity) * 100;
        const col = pct > 50 ? '#e8c05c' : pct > 20 ? '#e08b4a' : '#e05a4a';
        parts.push(
          `<div class="seg">` +
          `<span class="bar"><i style="width:${pct.toFixed(0)}%;background:${col}"></i></span>` +
          `<span class="n">${pct.toFixed(0)}%</span></div>`,
        );
        parts.push(
          `<div class="n">最悪区間: ${GEO_NAME_JA[w.worstGeo]}` +
          `${w.belowWater ? '・水位下' : ''} → 必要 ${supportName(w.required)}` +
          ` / 現状 ${supportName(w.installed)}</div>`,
        );
        parts.push('<div class="n">画面の光る柱が危険な区間。A / S / D でなぞって支保を入れる</div>');
      }
    }

    this.root.innerHTML = parts.join('');
  }
}
