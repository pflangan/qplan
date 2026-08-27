import { Component, HostListener, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CapacityStore } from '../../capacity-store.service';
import { COLOR_PALETTE, GRADE_RANK, Grade, sizeForTotal, sizeSpec } from '../../models';
import { RichTip } from '../../rich-tip.directive';
import { TagRow } from '../../tags/tag-row';

@Component({
  selector: 'app-project-card',
  imports: [FormsModule, RichTip, TagRow],
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
  /** Compact 2-line rendering (per-card override of the global default). */
  readonly compact = computed(() => this.store.isCardCompact(this.projectId()));
  /** Size quick-pick menu in compact mode: hover opens, click pins. */
  readonly sizeMenuOpen = signal(false);
  readonly sizeMenuPinned = signal(false);
  private sizeMenuCloseTimer: ReturnType<typeof setTimeout> | undefined;
  /** Rich confirm open — removing a boarded project from the Planning Board. */
  readonly confirmingOffBoard = signal(false);
  /** Rich confirm open — removing an engineer seat that holds data. */
  readonly confirmingRemoveEng = signal(false);
  /** Rich confirm open — deleting the project entirely. */
  readonly confirmingDelete = signal(false);
  /**
   * Rich confirm open — switching engineer sourcing to the accountable team
   * only. `prev` is the prior explicit accountable choice (reverted on cancel
   * when the switch was triggered by changing the accountable team).
   */
  readonly confirmingOnly = signal<{
    teamId: string;
    prev: string | null;
    turningOn: boolean;
  } | null>(null);

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

  /**
   * Team the Only toggle would source from: the explicit accountable choice,
   * or — when every seat already shares one team — that team. Null (toggle
   * disabled) for mixed or unassigned seats with no explicit choice.
   */
  readonly onlyTarget = computed(() => {
    const project = this.project();
    if (!project) return null;
    if (project.accountableTeamId) return project.accountableTeamId;
    const teams = new Set(
      project.slots.map((s) => s.teamId).filter((t): t is string => !!t),
    );
    return teams.size === 1 ? [...teams][0] : null;
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
    const project = this.project();
    // Manually picking a different team opts out of Only-mode (flag off; the
    // other slots keep their teams).
    if (project?.onlyAccountableTeam && teamId && teamId !== this.largestTeamId()) {
      this.store.setOnlyAccountableTeam(project.id, null);
    }
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

  /** Toggle "Only": on = all seats source from the accountable team. */
  toggleOnly(): void {
    const project = this.project();
    if (!project) return;
    if (project.onlyAccountableTeam) {
      this.store.setOnlyAccountableTeam(project.id, null);
      return;
    }
    const teamId = this.onlyTarget();
    if (!teamId) {
      this.store.showToast('No accountable team to source from yet');
      return;
    }
    if (this.displacedFor(teamId).length) {
      this.confirmingOnly.set({ teamId, prev: project.accountableTeamId, turningOn: true });
    } else {
      this.store.setOnlyAccountableTeam(project.id, teamId);
    }
  }

  /**
   * Changing the accountable team while Only is on: apply the team change
   * immediately (keeps the select's view in sync), then either confirm the
   * seat re-pointing or revert the team choice on cancel.
   */
  setAccountable(teamId: string | null): void {
    const project = this.project();
    const id = teamId ? teamId : null;
    if (!project || !project.onlyAccountableTeam || !id) {
      this.store.setAccountableTeam(this.projectId(), id);
      return;
    }
    const prev = project.accountableTeamId;
    this.store.setAccountableTeam(this.projectId(), id);
    if (this.displacedFor(id).length) {
      this.confirmingOnly.set({ teamId: id, prev, turningOn: false });
    } else {
      this.store.retargetSlotsTo(this.projectId(), id);
    }
  }

  applyOnly(): void {
    const c = this.confirmingOnly();
    this.confirmingOnly.set(null);
    if (!c) return;
    if (c.turningOn) this.store.setOnlyAccountableTeam(this.projectId(), c.teamId);
    else this.store.retargetSlotsTo(this.projectId(), c.teamId);
  }

  cancelOnly(): void {
    const c = this.confirmingOnly();
    this.confirmingOnly.set(null);
    // Accountable-team-change path: undo the team selection too.
    if (c && !c.turningOn) this.store.setAccountableTeam(this.projectId(), c.prev);
  }

  /** Assigned engineers whose home team is not the given team. */
  private displacedFor(teamId: string): {
    name: string;
    teamName: string;
    color: string;
  }[] {
    const project = this.project();
    if (!project) return [];
    const out: { name: string; teamName: string; color: string }[] = [];
    for (const slot of project.slots) {
      const engId = this.store.assignments()[slot.id]?.engineerId;
      if (!engId) continue;
      const home = this.store.homeTeamOfEngineer(engId);
      if (home?.id === teamId) continue;
      const eng = this.store.engineerById(engId);
      if (eng) {
        out.push({
          name: eng.name,
          teamName: home?.name ?? 'No team',
          color: home?.color ?? '#e2e8f0',
        });
      }
    }
    return out;
  }

  /** Displaced engineers listed in the Only confirm dialog. */
  readonly onlyDisplaced = computed(() => {
    const c = this.confirmingOnly();
    return c ? this.displacedFor(c.teamId) : [];
  });

  addToBoard(event: Event): void {
    event.stopPropagation();
    this.store.addToBoard(this.projectId());
  }

  remove(): void {
    this.store.removeProject(this.projectId());
  }

  onlyTip(): string {
    const project = this.project();
    if (project?.onlyAccountableTeam) {
      return 'Engineers sourced from the accountable team only — click to allow other teams';
    }
    return this.onlyTarget()
      ? 'Source all engineers from the accountable team'
      : 'Choose an accountable team — or give every seat the same team — first';
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

  toggleCompact(): void {
    this.store.toggleCardCompact(this.projectId());
  }

  openSizeMenu(): void {
    if (!this.compact()) return;
    clearTimeout(this.sizeMenuCloseTimer);
    this.sizeMenuOpen.set(true);
  }

  /**
   * Mouse leaving the chip/menu area closes the menu unless it was
   * click-pinned — after a short grace period so diagonal moves from the
   * chip onto the menu don't dismiss it.
   */
  closeSizeMenu(): void {
    if (this.sizeMenuPinned()) return;
    clearTimeout(this.sizeMenuCloseTimer);
    this.sizeMenuCloseTimer = setTimeout(() => this.sizeMenuOpen.set(false), 350);
  }

  toggleSizeMenu(): void {
    clearTimeout(this.sizeMenuCloseTimer);
    const open = !this.sizeMenuOpen();
    this.sizeMenuOpen.set(open);
    this.sizeMenuPinned.set(open);
  }

  pickSize(size: string): void {
    clearTimeout(this.sizeMenuCloseTimer);
    this.setSize(size);
    this.sizeMenuOpen.set(false);
    this.sizeMenuPinned.set(false);
  }

  @HostListener('document:click')
  closePalette(): void {
    clearTimeout(this.sizeMenuCloseTimer);
    this.paletteOpen.set(false);
    this.sizeMenuOpen.set(false);
    this.sizeMenuPinned.set(false);
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
      } else if (this.confirmingOnly()) {
        event.preventDefault();
        this.applyOnly();
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
      } else if (this.confirmingOnly()) {
        event.preventDefault();
        this.cancelOnly();
      }
    }
  }
}
