import { Component, HostListener, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CapacityStore } from '../capacity-store.service';
import { RichTip } from '../rich-tip.directive';
import {
  COLOR_PALETTE,
  DEFAULT_SETTINGS,
  GRADES,
  Grade,
  QuarterId,
  Settings,
  SizeId,
  TAG_COLOR_PAIRS,
} from '../models';
import { NumberPills } from './number-pills';

interface SizeDraft {
  id: SizeId;
  engineers: number;
  sprints: number;
  color: string;
}

interface TagDraft {
  id: string | null;
  short: string;
  full: string;
  bg: string;
  fg: string;
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
  readonly draftTags = signal<TagDraft[]>(
    this.store.tagDefs().map((t) => ({
      id: t.id,
      short: t.short,
      full: t.full,
      bg: t.bg,
      fg: t.fg,
    })),
  );

  readonly quarters: QuarterId[] = ['Q1', 'Q2', 'Q3', 'Q4'];
  readonly sprintLengths = [1, 2, 3, 4];
  readonly gradeIds: Grade[] = ['G3', 'G4', 'G5', 'G6'];
  readonly grades = GRADES;
  readonly palette = COLOR_PALETTE;
  readonly tagPairs = TAG_COLOR_PAIRS;
  /** Which row's color popover is open ('size-M' / 'grade-G5'), null = none. */
  readonly paletteOpen = signal<string | null>(null);
  /** Which tag draft row's pair popover is open (row index), null = none. */
  readonly pairOpen = signal<number | null>(null);
  /** Tag draft row awaiting inline delete confirmation (row index). */
  readonly confirmDeleteTagRow = signal<number | null>(null);

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

  setDraftShort(i: number, value: string): void {
    this.draftTags.update((rows) => {
      rows[i].short = value;
      return [...rows];
    });
  }

  setDraftFull(i: number, value: string): void {
    this.draftTags.update((rows) => {
      rows[i].full = value;
      return [...rows];
    });
  }

  addTagRow(): void {
    this.draftTags.update((rows) => [
      ...rows,
      {
        id: null,
        short: '',
        full: '',
        bg: TAG_COLOR_PAIRS[0].bg,
        fg: TAG_COLOR_PAIRS[0].fg,
      },
    ]);
  }

  togglePair(i: number): void {
    this.pairOpen.update((k) => (k === i ? null : i));
  }

  pickPair(i: number, pair: { bg: string; fg: string }): void {
    this.draftTags.update((rows) => {
      rows[i].bg = pair.bg;
      rows[i].fg = pair.fg;
      return [...rows];
    });
    this.pairOpen.set(null);
  }

  /**
   * Delete a draft row immediately (not deferred to Save): an existing def
   * must also be stripped from every project right away via the store.
   */
  confirmDeleteTag(i: number): void {
    const row = this.draftTags()[i];
    if (row?.id) this.store.deleteTag(row.id);
    this.draftTags.update((rows) => rows.filter((_, j) => j !== i));
    this.confirmDeleteTagRow.set(null);
    this.pairOpen.set(null);
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
    this.pairOpen.set(null);
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
    // draftTags is deliberately left alone: deleting a tag definition strips
    // it from every project in every quarter — far too destructive to hide
    // behind a generic "reset defaults".
    this.paletteOpen.set(null);
  }

  save(): void {
    // Tag defs removed from the drafts (deleted rows go through
    // confirmDeleteTag immediately; this covers any other path).
    const keptIds = new Set(this.draftTags().map((t) => t.id).filter(Boolean));
    for (const def of this.store.tagDefs()) {
      if (!keptIds.has(def.id)) this.store.deleteTag(def.id);
    }
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
      tags: this.draftTags().map((t) => ({
        id: t.id ?? '',
        short: t.short,
        full: t.full,
        bg: t.bg,
        fg: t.fg,
      })),
    };
    this.store.saveSettings(settings);
    this.closed.emit();
  }
}
