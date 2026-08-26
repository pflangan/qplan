import { Component, HostListener, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CapacityStore } from '../capacity-store.service';
import { RichTip } from '../rich-tip.directive';
import { COLOR_PALETTE, DEFAULT_SETTINGS, GRADES, Grade, QuarterId, Settings, SizeId } from '../models';
import { NumberPills } from './number-pills';

interface SizeDraft {
  id: SizeId;
  engineers: number;
  sprints: number;
  color: string;
}

@Component({
  selector: 'app-settings-dialog',
  imports: [FormsModule, NumberPills, RichTip],
  templateUrl: './settings-dialog.html',
  styleUrl: './settings-dialog.scss',
})
export class SettingsDialog {
  readonly store = inject(CapacityStore);
  /** First-run mode: single confirm button, no cancel. */
  readonly firstRun = input(false);
  readonly closed = output<void>();

  readonly maxSprints = computed(() =>
    Math.max(...this.store.quarters().map((q) => q.sprints)),
  );

  readonly draftSizes = signal<SizeDraft[]>(
    this.store.settings().sizes.map((s) => ({
      id: s.id,
      engineers: s.engineers,
      sprints: s.sprints,
      color: s.color,
    })),
  );
  readonly draftGradeColors = signal<Record<Grade, string>>({
    ...this.store.settings().gradeColors,
  });
  readonly draftStartQuarter = signal<QuarterId>(this.store.settings().startQuarter);
  readonly draftChain = signal<'same' | 'next'>(this.store.settings().quarterChainMode);
  readonly draftStart = signal<string>(this.store.settings().quarterStart ?? '');
  readonly draftLength = signal<number>(this.store.settings().sprintLengthWeeks);
  readonly draftShowDates = signal<boolean>(this.store.settings().showDates);

  readonly quarters: QuarterId[] = ['Q1', 'Q2', 'Q3', 'Q4'];
  readonly sprintLengths = [1, 2, 3, 4];
  readonly gradeIds: Grade[] = ['G3', 'G4', 'G5', 'G6'];
  readonly grades = GRADES;
  readonly palette = COLOR_PALETTE;
  /** Which row's color popover is open ('size-M' / 'grade-G5'), null = none. */
  readonly paletteOpen = signal<string | null>(null);

  setDraftEngineers(i: number, value: number): void {
    this.draftSizes.update((rows) => {
      rows[i].engineers = value;
      return [...rows];
    });
  }

  setDraftSprints(i: number, value: number): void {
    this.draftSizes.update((rows) => {
      rows[i].sprints = value;
      return [...rows];
    });
  }

  clearStart(): void {
    this.draftStart.set('');
  }

  togglePalette(key: string): void {
    this.paletteOpen.update((k) => (k === key ? null : key));
  }

  pickColor(key: string, color: string): void {
    if (key.startsWith('size-')) {
      const id = key.slice(5) as SizeId;
      this.draftSizes.update((rows) => {
        const row = rows.find((r) => r.id === id);
        if (row) row.color = color;
        return [...rows];
      });
    } else {
      const grade = key.slice(6) as Grade;
      this.draftGradeColors.update((c) => ({ ...c, [grade]: color }));
    }
    this.paletteOpen.set(null);
  }

  @HostListener('document:click')
  closePalette(): void {
    this.paletteOpen.set(null);
  }

  /** Restore every draft field to DEFAULT_SETTINGS (user still reviews + saves). */
  resetDefaults(): void {
    const d = DEFAULT_SETTINGS;
    this.draftSizes.set(
      d.sizes.map((s) => ({
        id: s.id,
        engineers: s.engineers,
        sprints: s.sprints,
        color: s.color,
      })),
    );
    this.draftGradeColors.set({ ...d.gradeColors });
    this.draftStartQuarter.set(d.startQuarter);
    this.draftChain.set(d.quarterChainMode);
    this.draftStart.set(d.quarterStart ?? '');
    this.draftLength.set(d.sprintLengthWeeks);
    this.draftShowDates.set(d.showDates);
    this.paletteOpen.set(null);
  }

  save(): void {
    const settings: Partial<Settings> = {
      sizes: this.draftSizes().map((d) => ({
        id: d.id,
        engineers: d.engineers,
        sprints: d.sprints,
        color: d.color,
      })),
      startQuarter: this.draftStartQuarter(),
      quarterChainMode: this.draftChain(),
      quarterStart: this.draftStart().trim() || null,
      sprintLengthWeeks: this.draftLength(),
      showDates: this.draftShowDates(),
      gradeColors: { ...this.draftGradeColors() },
    };
    this.store.saveSettings(settings);
    this.closed.emit();
  }
}
