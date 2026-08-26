import { Component, computed, effect, input, output, signal } from '@angular/core';

const WINDOW = 5;

/**
 * Pill/button-group number stepper: `− 1 2 3 4 5 +`.
 * Shows a sliding window of 5 consecutive pills over [min, max]; −/+ step
 * the selection, extending the window at the start/end as needed.
 */
@Component({
  selector: 'app-number-pills',
  template: `
    <div class="pills">
      <button type="button" class="step" [disabled]="value() <= min()" (click)="step(-1)">−</button>
      @for (n of windowNums(); track n) {
        <button
          type="button"
          class="pill"
          [class.selected]="n === value()"
          (click)="pick(n)"
        >{{ n }}</button>
      }
      <button type="button" class="step" [disabled]="value() >= max()" (click)="step(1)">+</button>
    </div>
  `,
  styles: `
    .pills {
      display: inline-flex;
      align-items: center;
    }
    button {
      font: inherit;
      border: 1px solid #cbd5e1;
      background: #fff;
      color: #334155;
      border-radius: 0;
      height: 24px;
      min-width: 26px;
      padding: 0 5px;
      cursor: pointer;
      line-height: 1;
      margin-left: -1px;
    }
    button:first-child {
      margin-left: 0;
      border-radius: 999px 0 0 999px;
      padding-left: 8px;
    }
    button:last-child {
      border-radius: 0 999px 999px 0;
      padding-right: 8px;
    }
    button:hover:not(:disabled):not(.selected) {
      background: #f1f5f9;
    }
    button:disabled {
      opacity: 0.4;
      cursor: default;
    }
    .pill.selected {
      background: var(--size-color, #1e293b);
      border-color: var(--size-color, #1e293b);
      color: #fff;
      position: relative;
      z-index: 1;
    }
    .step {
      font-weight: 700;
    }
  `,
})
export class NumberPills {
  readonly value = input.required<number>();
  readonly min = input(1);
  readonly max = input.required<number>();
  readonly changed = output<number>();

  private readonly windowStart = signal(1);

  readonly windowNums = computed(() => {
    const start = this.clampedStart();
    const end = Math.min(this.max(), start + WINDOW - 1);
    const nums: number[] = [];
    for (let n = start; n <= end; n++) nums.push(n);
    return nums;
  });

  constructor() {
    // Keep the selected value inside the window with minimal shifting.
    effect(() => {
      const v = this.value();
      const start = this.clampedStart();
      if (v < start || v > start + WINDOW - 1) {
        this.windowStart.set(v < start ? v : v - WINDOW + 1);
      }
    });
  }

  pick(n: number): void {
    this.changed.emit(n);
  }

  step(delta: number): void {
    this.changed.emit(this.value() + delta);
  }

  private clampedStart(): number {
    const raw = this.windowStart();
    return Math.max(this.min(), Math.min(raw, this.max() - WINDOW + 1));
  }
}
