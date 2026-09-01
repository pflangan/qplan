import {
  Component,
  HostListener,
  computed,
  ElementRef,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { CdkDrag, CdkDragDrop, CdkDropList } from '@angular/cdk/drag-drop';
import { CapacityStore } from '../capacity-store.service';
import { RichTip } from '../rich-tip.directive';
import { TagRow } from '../tags/tag-row';
import {
  Grade,
  Slot,
  WorkItem as WorkItemModel,
  WorkItemSlot,
  sizeSpec,
} from '../models';

/** State for a pointer-drag: move whole bar to a new start sprint. */
interface DragShift {
  slotId: string;
  origStart: number;
  origSprints: number;
  deltaStart: number;
  pointerId: number;
  startX: number;
}

/** Anchor for the rich hover panel on a filled bar. */
interface BarTip {
  engineerId: string;
  slotId: string;
  x: number;
  y: number;
}

/** Right-click context menu state for a slot row. */
interface CtxMenu {
  mode: 'assign' | 'switch';
  slotId: string;
  currentName: string | null;
  x: number;
  y: number;
  candidates: {
    engineerId: string;
    name: string;
    grade: Grade;
    teamName: string;
    freeSprints: number;
  }[];
}

@Component({
  selector: 'app-work-item',
  imports: [CdkDropList, RichTip, TagRow],
  templateUrl: './work-item.html',
  styleUrl: './work-item.scss',
})
export class WorkItem {
  readonly store = inject(CapacityStore);
  private readonly hostEl = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly item = input.required<WorkItemModel>();
  readonly connectedTo = input.required<string[]>();
  readonly dropped = output<CdkDragDrop<unknown>>();

  readonly grades = this.store.gradeMeta;
  /** Sprint-cell width — TRACK_W / quarter sprints, so the track stays fixed-width. */
  readonly px = input.required<number>();
  /** Canvas zoom — divides into pointer deltas and counter-zooms fixed overlays. */
  readonly zoom = input.required<number>();

  readonly quarterSprints = computed(() => this.store.selectedQuarter().sprints);
  readonly trackWidth = computed(() => this.quarterSprints() * this.px());

  /** Project display color — colors all 4 card borders. */
  readonly projectColor = computed(() => this.item().project.color || '#e2e8f0');

  /** T-shirt size color from settings — drives the size badge. */
  readonly sizeColor = computed(
    () => sizeSpec(this.item().project.size, this.store.sizes())?.color ?? '#94a3b8',
  );

  /** Tooltip explaining the t-shirt size badge, e.g. "L · 4 eng × 4 sprints". */
  readonly sizeTip = computed(() => {
    const spec = sizeSpec(this.item().project.size, this.store.sizes());
    return spec
      ? { title: `${spec.id} · ${spec.engineers} eng × ${spec.sprints} sprints`, detail: `${spec.engineers * spec.sprints} person-sprints` }
      : { title: 'No size set', detail: '' };
  });

  readonly meta = computed(() => {
    const project = this.item().project;
    const filled = this.item().slots.filter((s) => !!s.engineer).length;
      // const role = this.item().role === 'supporting' ? 'Supporting · ' : 'Accountable · ';
    return `${filled}/${project.slots.length} eng · ${this.store.slotSprints(project)} sprints`;
  });

  readonly dragging = signal<DragShift | null>(null);

  /** Rich hover panel anchor for a filled bar; null when hidden. */
  readonly barTip = signal<BarTip | null>(null);

  private readonly hideBarTipOnDrag = effect(() => {
    if (this.store.drag()) {
      this.hideBarTip();
    }
  });

  /** Right-click context menu state; null when closed. */
  readonly ctxMenu = signal<CtxMenu | null>(null);
  /** Rich confirm popover state for the ✕ remove-from-board; null when closed. */
  readonly offBoardConfirm = signal<{ x: number; y: number } | null>(null);
  private tipTimer: ReturnType<typeof setTimeout> | null = null;

  /** Filled seats on this card. */
  readonly filled = computed(
    () => this.item().slots.filter((s) => !!s.engineer).length,
  );

  /** Per-team engineer counts shown in the remove-from-board confirm popover. */
  readonly boardTeams = computed(() => {
    const counts = new Map<string, number>();
    for (const slot of this.item().project.slots) {
      if (slot.teamId) counts.set(slot.teamId, (counts.get(slot.teamId) ?? 0) + 1);
    }
    return [...counts.entries()].map(([teamId, count]) => ({
      name: this.store.team(teamId)?.name ?? '—',
      color: this.store.team(teamId)?.color ?? '#e2e8f0',
      count,
    }));
  });

  readonly tip = computed(() => {
    const t = this.barTip();
    if (!t) return null;
    const engineer = this.store.engineerById(t.engineerId);
    if (!engineer) return null;
    const team = this.store.homeTeamOfEngineer(t.engineerId);
    const allocations = this.store.allocationsOf(t.engineerId);
    const avail = team ? this.store.availSprintsOf(team.id, t.engineerId) : 0;
    const used = allocations.reduce((sum, a) => sum + a.sprints, 0);
    const tl = !!this.store
      .projects()
      .find((s) => s.id === this.item().project.id)
      ?.slots.find((sl) => sl.id === t.slotId)?.tl;
    // Off sprints inside this bar's own window — mirrors barConflict().
    let conflicts: number[] = [];
    const current = allocations.find((a) => a.slotId === t.slotId);
    if (team && current) {
      const off = new Set(this.store.unavailableOf(team.id, t.engineerId));
      conflicts = Array.from({ length: current.sprints }, (_, k) => current.start + k).filter((i) => off.has(i));
    }
    return {
      engineer,
      team,
      avail,
      used,
      pct: avail ? Math.round((used / avail) * 100) : 0,
      allocations,
      currentSlotId: t.slotId,
      conflicts,
      tl,
      x: t.x,
      y: t.y,
    };
  });

  /**
   * Full crew of this project across all teams — but only shown when
   * engineers from other teams are present (this lane's seats are already
   * visible as slot rows above).
   */
  readonly crew = computed(() => {
    const project = this.store.projects().find((s) => s.id === this.item().project.id);
    if (!project) return [];
    const laneTeam = this.item().slots[0]?.slot.teamId;
    if (!project.slots.some((slot) => slot.teamId && slot.teamId !== laneTeam)) {
      return [];
    }
    const assignments = this.store.assignments();
    const sprints = this.store.slotSprints(project);
    // On a supporting card, highlight the accountable team's crew row.
    const accountableId =
      this.item().role === 'supporting'
        ? this.store.effectiveAccountableTeamId(project)
        : null;
    // On an accountable card, this lane's engineers are already visible as
    // slot rows above — list only the supporting engineers from other teams.
    const rows =
      this.item().role === 'owned'
        ? project.slots
            .map((slot, i) => ({ slot, i }))
            .filter(({ slot }) => slot.teamId !== laneTeam)
        : project.slots.map((slot, i) => ({ slot, i }));
    return rows.map(({ slot, i }) => {
      const alloc = assignments[slot.id];
      return {
        index: i + 1,
        teamName: this.store.team(slot.teamId)?.name ?? '—',
        engineer: alloc ? (this.store.engineerById(alloc.engineerId) ?? null) : null,
        start: alloc?.start ?? 0,
        sprints: alloc?.sprints ?? sprints,
        tl: slot.tl,
        accountable: !!accountableId && slot.teamId === accountableId,
      };
    });
  });

  slotListId(slotId: string): string {
    return `slot-${slotId}`;
  }

  /** Card-level drop list id — whole card is a drop target. */
  readonly listId = computed(() => `wi-${this.item().project.id}`);

  /** Min-grade label for an empty seat, e.g. "G4+" or "Any". */
  minLabel(slot: Slot): string {
    return slot.minGrade ? `${slot.minGrade}+` : 'Any';
  }

  /** True while the project's TL seat is unfilled (warn only). */
  readonly noTL = computed(() => !this.store.hasTL(this.item().project.id));

  /** 'ok' | 'no' | null — live feedback while an engineer is dragged. */
  dropState(slotId: string): 'ok' | 'no' | null {
    const drag = this.store.drag();
    if (!drag) return null;
    return this.store.canAssign(slotId, drag.engineerId) ? 'ok' : 'no';
  }

  /** Tooltip for an empty seat: the reject reason while dragging. */
  dropTitle(slotId: string): string {
    const drag = this.store.drag();
    if (!drag) return 'Click to select, or drag/drop an engineer here';
    return this.store.assignRejectReason(slotId, drag.engineerId) ?? 'Drop to assign';
  }

  /** Only let a dragged engineer enter seats they actually qualify for. */
  slotPredicate(slotId: string) {
    return (item: CdkDrag<unknown>): boolean => {
      const data = item.data as { engineerId?: string } | undefined;
      return !!data?.engineerId && this.store.canAssign(slotId, data.engineerId);
    };
  }

  /** First open seat the engineer qualifies for, or null. */
  firstOpenSlotFor(engineerId: string): string | null {
    for (const s of this.item().slots) {
      if (!s.engineer && this.store.canAssign(s.slot.id, engineerId)) {
        return s.slot.id;
      }
    }
    return null;
  }

  /** Card-level live feedback while an engineer is dragged over the card. */
  readonly cardDropState = computed<'ok' | 'no' | null>(() => {
    const drag = this.store.drag();
    if (!drag) return null;
    return this.firstOpenSlotFor(drag.engineerId) ? 'ok' : 'no';
  });

  /** The card accepts a drag when any open seat qualifies. */
  readonly cardPredicate = (item: CdkDrag<unknown>): boolean => {
    const data = item.data as { engineerId?: string } | undefined;
    return !!data?.engineerId && this.firstOpenSlotFor(data.engineerId) !== null;
  };

  /** Assign and toast with the allocated sprint window. */
  private assignTo(slotId: string, engineerId: string): void {
    if (this.store.assignToSlot(slotId, engineerId)) {
      const alloc = this.store.assignments()[slotId];
      const engineer = this.store.engineerById(engineerId);
      const start = alloc?.start ?? 0;
      const end = start + (alloc?.sprints ?? this.store.slotSprints(this.item().project));
      this.store.showToast(`${engineer?.name} assigned: S${start + 1}–S${end}`);
    }
  }

  /** Left offset of a filled bar, applying any live drag deltas. */
  offsetOf(s: WorkItemSlot): number {
    const d = this.dragging();
    if (d && d.slotId === s.slot.id) return (s.start + d.deltaStart) * this.px();
    return s.start * this.px();
  }

  /** Live start sprint index of a filled bar (0-based). */
  startOf(s: WorkItemSlot): number {
    const d = this.dragging();
    if (d && d.slotId === s.slot.id) return s.start + d.deltaStart;
    return s.start;
  }

  /** Sprint count of a filled bar (fixed to the size estimate). */
  sprintsOf(s: WorkItemSlot): number {
    return s.sprints;
  }

  /** "S3, S5" — 0-based sprint indices to compact labels. */
  sprintLabels(indices: number[]): string {
    return indices.map((i) => `S${i + 1}`).join(', ');
  }

  /** True when the bar's window (live during a drag) hits an off sprint. */
  barConflict(s: WorkItemSlot): boolean {
    if (!s.engineer) return false;
    const team = this.store.homeTeamOfEngineer(s.engineer.id);
    if (!team) return false;
    const off = new Set(this.store.unavailableOf(team.id, s.engineer.id));
    const start = this.startOf(s);
    for (let i = start; i < start + s.sprints; i++) {
      if (off.has(i)) return true;
    }
    return false;
  }

  /**
   * Screen point → overlay coords. Overlays counter-zoom themselves (CSS
   * `zoom: 1/zoom`) to stay 1:1 in screen px, so this only has to subtract
   * the pan layer's own screen origin — no zoom division needed here too.
   */
  private toOverlayPoint(x: number, y: number): { x: number; y: number } {
    const panLayer = this.hostEl.nativeElement.closest('.pan-layer');
    const r = panLayer?.getBoundingClientRect();
    return { x: x - (r?.left ?? 0), y: y - (r?.top ?? 0) };
  }

  /** Show the rich hover panel anchored above a filled bar. */
  showTip(event: MouseEvent, s: WorkItemSlot): void {
    if (this.dragging() || this.store.drag() || !s.engineer) return;
    this.cancelHide();
    const bar = event.currentTarget as HTMLElement;
    const rect = bar.getBoundingClientRect();
    const p = this.toOverlayPoint(rect.left - 16, rect.top);
    this.barTip.set({
      engineerId: s.engineer.id,
      slotId: s.slot.id,
      x: p.x,
      y: p.y,
    });
  }

  scheduleHide(): void {
    this.cancelHide();
    this.tipTimer = setTimeout(() => this.barTip.set(null), 120);
  }

  cancelHide(): void {
    if (this.tipTimer) {
      clearTimeout(this.tipTimer);
      this.tipTimer = null;
    }
  }

  onPointerDown(event: PointerEvent, s: WorkItemSlot): void {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest('.unassign')) return;
    event.preventDefault();
    this.cancelHide();
    this.barTip.set(null);
    this.dragging.set({
      slotId: s.slot.id,
      origStart: s.start,
      origSprints: s.sprints,
      deltaStart: 0,
      pointerId: event.pointerId,
      startX: event.clientX,
    });
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
  }

  private readonly onMove = (e: PointerEvent): void => {
    const d = this.dragging();
    if (!d || e.pointerId !== d.pointerId) return;
    const q = this.quarterSprints();
    const dx = Math.round((e.clientX - d.startX) / (this.px() * this.zoom()));
    const min = -d.origStart;
    const max = q - d.origSprints - d.origStart;
    d.deltaStart = Math.min(max, Math.max(min, dx));
    this.dragging.set({ ...d });
  };

  private readonly onUp = (e: PointerEvent): void => {
    const d = this.dragging();
    if (!d || e.pointerId !== d.pointerId) return;
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    this.dragging.set(null);
    if (d.deltaStart !== 0) {
      this.store.setAllocationWindow(
        d.slotId,
        d.origStart + d.deltaStart,
        d.origSprints,
      );
    }
  };

  /** Right-click on an empty slot track: list matching engineers to add. */
  onTrackCtxMenu(event: MouseEvent, s: WorkItemSlot): void {
    event.preventDefault();
    event.stopPropagation();
    this.hideBarTip();
    this.openMenu('assign', s.slot.id, null, event.clientX, event.clientY);
  }

  /** Right-click on a filled bar: list engineers to switch the assignee for. */
  onBarCtxMenu(event: MouseEvent, s: WorkItemSlot): void {
    event.preventDefault();
    event.stopPropagation();
    this.hideBarTip();
    this.openMenu(
      'switch',
      s.slot.id,
      s.engineer?.id ?? null,
      event.clientX,
      event.clientY,
    );
  }

  private openMenu(
    mode: 'assign' | 'switch',
    slotId: string,
    excludeEngineerId: string | null,
    x: number,
    y: number,
  ): void {
    const candidates = this.store.candidateEngineersFor(
      slotId,
      excludeEngineerId ?? undefined,
    );
    if (!candidates.length) {
      this.store.showToast(
        mode === 'switch'
          ? 'No other available engineers match this seat'
          : 'No available engineers match this seat',
      );
      return;
    }
    const p = this.toOverlayPoint(x, y);
    this.ctxMenu.set({
      mode,
      slotId,
      currentName:
        mode === 'switch'
          ? (this.store.engineerById(excludeEngineerId!)?.name ?? null)
          : null,
      x: p.x,
      y: p.y,
      candidates,
    });
  }

  assignFromMenu(engineerId: string): void {
    const menu = this.ctxMenu();
    if (!menu) return;
    this.assignTo(menu.slotId, engineerId);
    this.ctxMenu.set(null);
  }

  @HostListener('document:click')
  @HostListener('document:contextmenu')
  closeMenu(): void {
    this.ctxMenu.set(null);
    this.offBoardConfirm.set(null);
  }

  /** Enter confirms, Escape cancels the remove-from-board confirm. */
  @HostListener('document:keydown', ['$event'])
  onDialogKey(event: KeyboardEvent): void {
    if (!this.offBoardConfirm()) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      this.removeFromBoard();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.offBoardConfirm.set(null);
    }
  }

  private hideBarTip(): void {
    this.cancelHide();
    this.barTip.set(null);
  }

  /** Open the rich confirm dialog, centered on the viewport. */
  askRemoveFromBoard(event: MouseEvent): void {
    event.stopPropagation();
    const p = this.toOverlayPoint(window.innerWidth / 2, window.innerHeight / 2);
    this.ctxMenu.set(null);
    this.offBoardConfirm.set(p);
  }

  unassign(slotId: string): void {
    this.hideBarTip();
    this.store.unassignSlot(slotId);
  }

  /** Mark this seat as the project's team lead. */
  toggleTL(slotId: string): void {
    this.store.toggleSlotTL(slotId);
  }

  removeFromBoard(): void {
    this.offBoardConfirm.set(null);
    this.store.removeFromBoard(this.item().project.id);
  }

  onDrop(event: CdkDragDrop<unknown>): void {
    const data = event.item.data as { engineerId?: string } | undefined;
    if (event.container.id === this.listId() && data?.engineerId) {
      const slotId = this.firstOpenSlotFor(data.engineerId);
      if (slotId) this.assignTo(slotId, data.engineerId);
      return;
    }
    this.dropped.emit(event);
  }
}
