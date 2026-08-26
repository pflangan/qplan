import { Component, HostListener, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CapacityStore } from '../../capacity-store.service';
import { COLOR_PALETTE, GRADE_RANK, Grade, sizeForTotal, sizeSpec } from '../../models';
import { RichTip } from '../../rich-tip.directive';

@Component({
  selector: 'app-project-card',
  imports: [FormsModule, RichTip],
  templateUrl: './project-card.html',
  styleUrl: './project-card.scss',
})
export class ProjectCard {
  readonly store = inject(CapacityStore);
  readonly projectId = input.required<string>();

  readonly palette = COLOR_PALETTE;
  readonly sizes = computed(() => this.store.sizes());
  readonly grades = this.store.gradeMeta;
  /** Grade options with settings-overridden colors for the min-grade chips. */
  readonly gradeList = computed(() =>
    Object.entries(this.grades()).map(([id, g]) => ({
      id: id as Grade,
      ...g,
    })),
  );
  readonly editingName = signal(false);
  readonly draftName = signal('');
  readonly paletteOpen = signal(false);
  /** Rich confirm open — removing a boarded project from the Planning Board. */
  readonly confirmingOffBoard = signal(false);
  /** Rich confirm open — removing an engineer seat that holds data. */
  readonly confirmingRemoveEng = signal(false);
  /** Rich confirm open — deleting the project entirely. */
  readonly confirmingDelete = signal(false);

  readonly project = computed(() =>
    this.store.projects().find((s) => s.id === this.projectId()),
  );

  readonly spec = computed(() => sizeSpec(this.project()?.size, this.sizes()));


  /** Effective sprint duration per engineer (explicit or size default). */
  readonly sprintsVal = computed(() => {
    const project = this.project();
    return project?.sprints ?? sizeSpec(project?.size, this.sizes())?.sprints ?? 1;
  });

  readonly engineers = computed(() => this.project()?.slots.length ?? 0);

  /** Total effort in person-sprints, e.g. M = 3 × 4 = 12. */
  readonly total = computed(() => this.engineers() * this.sprintsVal());

  /** T-shirt size derived from the current total. */
  readonly derivedSpec = computed(() => sizeSpec(sizeForTotal(this.total(), this.sizes()), this.sizes()));

  readonly quarterSprints = computed(() => this.store.selectedQuarter().sprints);

  readonly largestTeamId = computed(() => {
    const project = this.project();
    return project ? this.store.effectiveAccountableTeamId(project) : null;
  });

  /** The seat that disappears when the engineer count is decremented. */
  readonly lastSlot = computed(() => {
    const slots = this.project()?.slots ?? [];
    return slots.length ? slots[slots.length - 1] : null;
  });

  /** Per-team engineer counts shown in the remove-from-board confirm dialog. */
  readonly slotTeams = computed(() => {
    const counts = new Map<string, number>();
    for (const slot of this.project()?.slots ?? []) {
      if (slot.teamId) counts.set(slot.teamId, (counts.get(slot.teamId) ?? 0) + 1);
    }
    return [...counts.entries()].map(([teamId, count]) => ({
      name: this.store.team(teamId)?.name ?? '—',
      color: this.store.team(teamId)?.color ?? '#e2e8f0',
      count,
    }));
  });

  readonly canAdd = computed(() => {
    const project = this.project();
    return !!project && this.store.canAddToBoard(project);
  });

  startRename(): void {
    this.draftName.set(this.project()?.name ?? '');
    this.editingName.set(true);
  }

  commitRename(): void {
    if (this.project()) this.store.renameProject(this.projectId(), this.draftName());
    this.editingName.set(false);
  }

  setSize(size: string | null): void {
    this.store.setSize(this.projectId(), size as never);
  }

  setEngineers(count: number): void {
    this.store.setProjectEngineers(this.projectId(), count);
  }

  /** Decrement: always confirm — the dropped seat may hold a team/grade/board allocation. */
  askRemoveEngineer(): void {
    this.confirmingRemoveEng.set(true);
  }

  removeEngineer(): void {
    this.confirmingRemoveEng.set(false);
    this.setEngineers(this.engineers() - 1);
  }

  askRemove(): void {
    this.confirmingDelete.set(true);
  }

  deleteProject(): void {
    this.confirmingDelete.set(false);
    this.remove();
  }

  stepSprints(delta: number): void {
    this.store.setProjectSprints(this.projectId(), this.sprintsVal() + delta);
  }

  setSlotTeam(index: number, teamId: string | null): void {
    this.store.setSlotTeam(this.projectId(), index, teamId ? teamId : null);
  }

  /** A pill is highlighted when the engineer's grade meets the seat minimum. */
  isGradeSelected(slot: { minGrade: Grade | null }, grade: Grade): boolean {
    return !!slot.minGrade && GRADE_RANK[grade] >= GRADE_RANK[slot.minGrade];
  }

  /** Clicking a pill sets the minimum; clicking the current minimum clears it. */
  setMinGrade(index: number, grade: Grade): void {
    const slot = this.project()?.slots[index];
    this.store.setSlotMinGrade(this.projectId(), index, slot?.minGrade === grade ? null : grade);
  }

  /** Open the rich confirm before clearing a boarded project's allocations. */
  askTakeOffBoard(event: Event): void {
    event.stopPropagation();
    this.confirmingOffBoard.set(true);
  }

  takeOffBoard(): void {
    this.confirmingOffBoard.set(false);
    this.store.removeFromBoard(this.projectId());
  }

  setAccountable(teamId: string | null): void {
    this.store.setAccountableTeam(this.projectId(), teamId ? teamId : null);
  }

  addToBoard(event: Event): void {
    event.stopPropagation();
    this.store.addToBoard(this.projectId());
  }

  remove(): void {
    this.store.removeProject(this.projectId());
  }

  teamName(teamId: string | null): string {
    return this.store.team(teamId)?.name ?? '—';
  }

  gradeLabel(grade: string | null): string {
    if (!grade) return '';
    return this.gradeList().find((g) => g.id === grade)?.label ?? grade;
  }

  sizeTip(s: { id: string; engineers: number; sprints: number }): string {
    return `${s.id} · ${s.engineers} eng × ${s.sprints} sprints`;
  }

  sizeTipDetail(s: { engineers: number; sprints: number }): string {
    return `${s.engineers * s.sprints} person-sprints`;
  }

  togglePalette(): void {
    this.paletteOpen.update((v) => !v);
  }

  pickColor(color: string): void {
    this.store.setProjectColor(this.projectId(), color);
    this.paletteOpen.set(false);
  }

  @HostListener('document:click')
  closePalette(): void {
    this.paletteOpen.set(false);
  }

  /** Enter confirms, Escape cancels — whichever rich confirm is open. */
  @HostListener('document:keydown', ['$event'])
  onDialogKey(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      if (this.confirmingOffBoard()) {
        event.preventDefault();
        this.takeOffBoard();
      } else if (this.confirmingRemoveEng()) {
        event.preventDefault();
        this.removeEngineer();
      } else if (this.confirmingDelete()) {
        event.preventDefault();
        this.deleteProject();
      }
    } else if (event.key === 'Escape') {
      if (
        this.confirmingOffBoard() ||
        this.confirmingRemoveEng() ||
        this.confirmingDelete()
      ) {
        event.preventDefault();
        this.confirmingOffBoard.set(false);
        this.confirmingRemoveEng.set(false);
        this.confirmingDelete.set(false);
      }
    }
  }
}
