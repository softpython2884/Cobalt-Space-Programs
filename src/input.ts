// ============ COBALT SECTOR — entrées clavier/souris ============
// On utilise event.code (position physique) : ZQSD en AZERTY = WASD en QWERTY,
// donc le jeu marche nativement sur les deux dispositions.

export interface ClickEvent { button: number; x: number; y: number; ctrl: boolean; shift: boolean }

export class Input {
  keys = new Set<string>();
  justPressed = new Set<string>();
  mouseX = 0; mouseY = 0;
  leftDown = false; rightDown = false; middleDown = false;
  wheel = 0;
  clicks: ClickEvent[] = [];
  rightClicks: ClickEvent[] = [];
  middleClicks: ClickEvent[] = [];
  // glisser (sélection rectangle)
  dragStart: { x: number; y: number } | null = null;
  dragEnd: { x: number; y: number } | null = null;
  dragDone: { x0: number; y0: number; x1: number; y1: number; ctrl: boolean } | null = null;

  constructor(private el: HTMLElement) {
    window.addEventListener('keydown', e => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.justPressed.add(e.code);
      // empêche le défilement de la page
      if (['Space', 'Tab', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', e => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    // les événements souris démarrés sur l'interface ne doivent pas atteindre le jeu
    const onUI = (e: Event): boolean =>
      !!(e.target as Element | null)?.closest?.(
        '.side-panel, #tacticalbar, #ctxmenu, .overlay, #bottomcenter, #help-box');

    el.addEventListener('mousemove', e => {
      this.mouseX = e.clientX; this.mouseY = e.clientY;
      if (this.dragStart) this.dragEnd = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener('mousedown', e => {
      if (onUI(e)) return;
      if (e.button === 0) {
        this.leftDown = true;
        this.dragStart = { x: e.clientX, y: e.clientY };
        this.dragEnd = null;
      }
      if (e.button === 1) { this.middleDown = true; e.preventDefault(); }
      if (e.button === 2) this.rightDown = true;
    });
    // mouseup sur window : relâcher hors de la fenêtre ne doit pas bloquer leftDown/drag
    window.addEventListener('mouseup', e => {
      const ev: ClickEvent = { button: e.button, x: e.clientX, y: e.clientY, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };
      const ui = onUI(e);
      if (e.button === 0) {
        this.leftDown = false;
        if (this.dragStart) {
          const dx = Math.abs(e.clientX - this.dragStart.x), dy = Math.abs(e.clientY - this.dragStart.y);
          if (dx > 6 || dy > 6) {
            this.dragDone = {
              x0: Math.min(this.dragStart.x, e.clientX), y0: Math.min(this.dragStart.y, e.clientY),
              x1: Math.max(this.dragStart.x, e.clientX), y1: Math.max(this.dragStart.y, e.clientY),
              ctrl: ev.ctrl,
            };
          } else if (!ui) {
            this.clicks.push(ev);
          }
        }
        this.dragStart = null; this.dragEnd = null;
      }
      if (e.button === 1) { this.middleDown = false; if (!ui) this.middleClicks.push(ev); }
      if (e.button === 2) { this.rightDown = false; if (!ui) this.rightClicks.push(ev); }
    });
    el.addEventListener('contextmenu', e => e.preventDefault());
    el.addEventListener('wheel', e => {
      // la molette sur un panneau défilant garde son comportement natif
      if ((e.target as Element | null)?.closest?.('.side-panel, #help-box, #menu-box')) return;
      this.wheel += e.deltaY;
      e.preventDefault();
    }, { passive: false });
  }

  down(code: string): boolean { return this.keys.has(code); }
  pressed(code: string): boolean { return this.justPressed.has(code); }

  /** À appeler en fin de frame. */
  endFrame() {
    this.justPressed.clear();
    this.wheel = 0;
    this.clicks.length = 0;
    this.rightClicks.length = 0;
    this.middleClicks.length = 0;
    this.dragDone = null;
  }
}
