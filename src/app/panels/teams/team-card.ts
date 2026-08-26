import { Component, HostListener, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CapacityStore } from '../../capacity-store.service';
import { COLOR_PALETTE, Grade } from '../../models';
import { RichTip } from '../../rich-tip.directive';

@Component({
  selector: 'app-team-card',
  imports: [FormsModule, RichTip],
  templateUrl: './team-card.html',
  styleUrl: './team-card.scss',
})
export class TeamCard {
  readonly store = inject(CapacityStore);
  readonly teamId = input.required<string>();

  /** GRADES metadata with settings-overridden colors. */
  readonly grades = this.store.gradeMeta;
  readonly gradeList = computed(() =>
    Object.entries(this.grades()).map(([key, value]) => ({ key: key as Grade, value })),
  );
  readonly editingName = signal(false);
  readonly draftName = signal('');
  readonly addingEngineer = signal(false);
  readonly newEngineerName = signal('');
  readonly newEngineerGrade = signal<Grade>('G4');
  readonly importing = signal(false);
  readonly importText = signal('');
  readonly paletteOpen = signal(false);
  /** Rich confirm open — removing an engineer from the team. */
  readonly confirmingRemoveEng = signal(false);
  /** Rich confirm open — removing an engineer from the quarter capacity. */
  readonly confirmingOffQuarter = signal(false);
  readonly pendingEngineerId = signal<string | null>(null);

  readonly palette = COLOR_PALETTE;

  readonly team = computed(() =>
    this.store.teams().find((t) => t.id === this.teamId()),
  );

  /** Rich hover panel anchor (engineer row); null when hidden. */
  readonly engTip = signal<{ engineerId: string; x: number; y: number; below: boolean } | null>(
    null,
  );
  private tipTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly hideEngTipOnDrag = effect(() => {
    if (this.store.drag() || this.store.projectDrag()) {
      this.engTip.set(null);
    }
  });

  /** Live quarter-commitment summary for the hovered engineer. */
  readonly engTipData = computed(() => {
    const t = this.engTip();
    if (!t) return null;
    const engineer = this.store.engineerById(t.engineerId);
    if (!engineer) return null;
    const inCapacity = this.store.isInCapacity(t.engineerId);
    const avail = inCapacity ? this.store.availSprintsOf(this.teamId(), t.engineerId) : 0;
    const allocations = this.store.allocationsOf(t.engineerId);
    const used = allocations.reduce((sum, a) => sum + a.sprints, 0);
    const pct = avail ? Math.round((used / avail) * 100) : 0;
    const quarter = this.store.selectedQuarter();
    const state = pct > 100 ? 'over' : pct > 75 ? 'warn' : 'ok';
    return { engineer, inCapacity, avail, used, pct, state, quarter, allocations, ...t };
  });

  showEngTip(event: MouseEvent, engineerId: string): void {
    if (this.store.drag() || this.store.projectDrag()) return;
    this.clearTipTimer();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.tipTimer = setTimeout(() => {
      this.engTip.set({
        engineerId,
        x: Math.max(8, Math.min(rect.left, window.innerWidth - 288)),
        y: rect.top < 240 ? rect.bottom : rect.top,
        below: rect.top < 240,
      });
    }, 250);
  }

  scheduleHideTip(): void {
    this.clearTipTimer();
    this.tipTimer = setTimeout(() => this.engTip.set(null), 120);
  }

  clearTipTimer(): void {
    if (this.tipTimer) {
      clearTimeout(this.tipTimer);
      this.tipTimer = null;
    }
  }

  startRename(): void {
    this.draftName.set(this.team()?.name ?? '');
    this.editingName.set(true);
  }

  commitRename(): void {
    if (this.team()) this.store.renameTeam(this.teamId(), this.draftName());
    this.editingName.set(false);
  }

  toggleAddEngineer(): void {
    this.addingEngineer.update((v) => !v);
    this.newEngineerName.set('');
    this.newEngineerGrade.set('G4');
  }

  addEngineer(): void {
    if (!this.newEngineerName().trim()) return;
    this.store.addEngineer(this.teamId(), this.newEngineerName(), this.newEngineerGrade());
    this.newEngineerName.set('');
  }

  toggleImport(): void {
    this.importing.update((v) => !v);
    this.importText.set('');
  }

  doImport(): void {
    const count = this.store.importEngineers(this.teamId(), this.importText());
    this.store.showToast(`Imported ${count} engineer${count === 1 ? '' : 's'}`);
    this.importing.set(false);
  }

  setGrade(engineerId: string, grade: string): void {
    this.store.setEngineerGrade(this.teamId(), engineerId, grade as Grade);
  }

  /** Engineer pending removal in the confirm dialog; null when closed. */
  readonly pendingEngineer = computed(() => {
    const id = this.pendingEngineerId();
    return id ? (this.store.engineerById(id) ?? null) : null;
  });

  /** The quarter's board allocations that would be cleared by the removal. */
  readonly pendingAllocs = computed(() => {
    const id = this.pendingEngineerId();
    return id ? this.store.allocationsOf(id) : [];
  });

  /** Open the rich confirm before removing an engineer. */
  askRemoveEngineer(engineerId: string): void {
    this.pendingEngineerId.set(engineerId);
    this.confirmingRemoveEng.set(true);
  }

  removeEngineer(): void {
    const id = this.pendingEngineerId();
    this.confirmingRemoveEng.set(false);
    this.pendingEngineerId.set(null);
    if (id) this.store.removeEngineer(this.teamId(), id);
  }

  /** Adding to the quarter is free; removing clears board work — confirm it. */
  toggleCapacity(engineerId: string): void {
    if (this.store.isInCapacity(engineerId)) {
      this.pendingEngineerId.set(engineerId);
      this.confirmingOffQuarter.set(true);
    } else {
      this.store.toggleCapacity(this.teamId(), engineerId);
    }
  }

  removeFromQuarter(): void {
    const id = this.pendingEngineerId();
    this.confirmingOffQuarter.set(false);
    this.pendingEngineerId.set(null);
    if (id) this.store.toggleCapacity(this.teamId(), id);
  }

  removeTeam(): void {
    this.store.removeTeam(this.teamId());
  }

  togglePalette(): void {
    this.paletteOpen.update((v) => !v);
  }

  pickColor(color: string): void {
    this.store.setTeamColor(this.teamId(), color);
    this.paletteOpen.set(false);
  }

  /** Enter confirms, Escape cancels — whichever rich confirm is open. */
  @HostListener('document:keydown', ['$event'])
  onDialogKey(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      if (this.confirmingRemoveEng()) {
        event.preventDefault();
        this.removeEngineer();
      } else if (this.confirmingOffQuarter()) {
        event.preventDefault();
        this.removeFromQuarter();
      }
    } else if (event.key === 'Escape') {
      if (this.confirmingRemoveEng()) {
        event.preventDefault();
        this.confirmingRemoveEng.set(false);
        this.pendingEngineerId.set(null);
      } else if (this.confirmingOffQuarter()) {
        event.preventDefault();
        this.confirmingOffQuarter.set(false);
        this.pendingEngineerId.set(null);
      }
    }
  }

  @HostListener('document:click')
  closePalette(): void {
    this.paletteOpen.set(false);
  }
}
