import { Directive, ElementRef, OnDestroy, effect, inject, input } from '@angular/core';
import { CapacityStore } from './capacity-store.service';

let activeRichTip: RichTip | null = null;

/**
 * Rich tooltip: replaces native `title` attributes with a styled dark panel.
 * Anchors above the host when there's room, otherwise below.
 *
 * Usage: `<button [appTip]="'Delete team'" [appTipDetail]="'Removes all engineers'">`
 */
@Directive({
  selector: '[appTip]',
  host: {
    '(mouseenter)': 'show($event)',
    '(mouseleave)': 'scheduleHide()',
    '(focusin)': 'show($event)',
    '(focusout)': 'scheduleHide()',
  },
})
export class RichTip implements OnDestroy {
  readonly label = input.required<string>({ alias: 'appTip' });
  readonly detail = input<string | null>(null, { alias: 'appTipDetail' });

  private readonly store = inject(CapacityStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private panel: HTMLElement | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  private pointerX: number | null = null;
  private pointerY: number | null = null;

  private readonly suppressOnDrag = effect(() => {
    if (this.store.drag()) {
      this.clearTimer();
      this.destroyPanel();
    }
  });

  private readonly labelWatcher = effect(() => {
    const label = this.label();
    if (!label && this.panel) {
      this.destroyPanel();
    }
  });

  constructor() {
    window.addEventListener('pointerdown', this.onPointerDown, true);
  }

  ngOnDestroy(): void {
    if (activeRichTip === this) {
      activeRichTip = null;
    }
    this.clearTimer();
    this.destroyPanel();
    window.removeEventListener('pointerdown', this.onPointerDown, true);
  }

  show(event?: MouseEvent | FocusEvent): void {
    if (this.store.drag()) return;
    if (event instanceof MouseEvent) {
      this.pointerX = event.clientX;
      this.pointerY = event.clientY;
    } else {
      this.pointerX = null;
      this.pointerY = null;
    }
    this.clearTimer();
    if (activeRichTip && activeRichTip !== this) {
      activeRichTip.destroyPanel();
      activeRichTip.clearTimer();
    }
    activeRichTip = this;
    this.timer = setTimeout(() => this.render(), 300);
  }

  private readonly onPointerDown = (): void => {
    this.clearTimer();
    this.destroyPanel();
    if (activeRichTip === this) {
      activeRichTip = null;
    }
  };

  scheduleHide(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.destroyPanel();
      if (activeRichTip === this) {
        activeRichTip = null;
      }
    }, 120);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private render(): void {
    this.destroyPanel();
    const label = this.label();
    if (!label) return;
    const rect = this.host.nativeElement.getBoundingClientRect();

    const panel = document.createElement('div');
    panel.className = 'rich-tip';

    const head = document.createElement('div');
    head.className = 'rt-label';
    head.textContent = label;
    panel.appendChild(head);

    const detail = this.detail();
    if (detail) {
      const body = document.createElement('div');
      body.className = 'rt-detail';
      body.textContent = detail;
      panel.appendChild(body);
    }

    document.body.appendChild(panel);
    const left = this.pointerX !== null
      ? Math.max(8, Math.min(this.pointerX + 8, window.innerWidth - panel.offsetWidth - 8))
      : Math.max(8, Math.min(rect.left, window.innerWidth - panel.offsetWidth - 8));
    panel.style.left = `${left}px`;
    const top = this.pointerY !== null ? this.pointerY : rect.top;
    if (this.pointerY === null && rect.top <= 140) {
      panel.style.top = `${rect.bottom + 8}px`;
      panel.style.transform = '';
    } else {
      panel.style.top = `${top}px`;
      panel.style.transform = 'translateY(calc(-100% - 8px))';
    }
    this.panel = panel;
  }

  private destroyPanel(): void {
    this.panel?.remove();
    this.panel = null;
  }
}
