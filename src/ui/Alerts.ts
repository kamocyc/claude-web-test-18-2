import { GEO_NAME_JA } from '../terrain/config';
import { TunnelNetwork } from '../game/Tunnel';
import { supportName } from '../game/Support';

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
      #alerts { top: 12px; right: 12px; padding: 9px 12px; min-width: 210px; max-width: 280px; }
      #alerts .title { color: #93a0b4; margin-bottom: 5px; }
      #alerts .seg { display: flex; align-items: center; gap: 7px; margin: 3px 0; }
      #alerts .bar { flex: 1; height: 5px; background: rgba(255,255,255,.12); border-radius: 3px; overflow: hidden; }
      #alerts .bar i { display: block; height: 100%; }
      #alerts .n { font-variant-numeric: tabular-nums; color: #c8d0dc; font-size: 11px; }
      #alerts .ok { color: #7fc98a; }
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

    if (st.atRisk === 0) {
      parts.push('<div class="ok">支保は足りている</div>');
    } else {
      parts.push(`<div style="color:#e8b45c">支保不足 ${st.atRisk} 区間</div>`);
      const w = st.worst;
      if (w) {
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
      }
    }

    this.root.innerHTML = parts.join('');
  }
}
