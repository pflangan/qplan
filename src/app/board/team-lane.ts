import {
  Component,
  HostListener,
  afterRenderEffect,
  computed,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { CdkDrag, CdkDragDrop, CdkDragPreview, CdkDropList } from '@angular/cdk/drag-drop';
import { CapacityStore } from '../capacity-store.service';
import { Grade } from '../models';
import { RichTip } from '../rich-tip.directive';
import { WorkItem } from './work-item';

/** One open seat offered by the right-click context menu. */
interface SeatOption {
  slotId: string;
  projectName: string;
  size: string;
  grades: string;
  sprints: number;
}

@Component({
  selector: 'app-team-lane',
  imports: [CdkDrag, CdkDragPreview, CdkDropList, RichTip, WorkItem],
  templateUrl: './team-lane.html',
  styleUrl: './team-lane.scss',
})
export class TeamLane {
  readonly store = inject(CapacityStore);
  private readonly hostEl = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly teamId = input.required<string>();
  /** Sprint-cell width — TRACK_W / quarter sprints, so the track stays fixed-width. */
  readonly px = input.required<number>();
  /** Canvas zoom — keeps fixed-position overlays 1:1 and cursor math honest. */
  readonly zoom = input.required<number>();
  readonly layoutMode = input.required<'canvas' | 'fixed'>();
  /** Header grabbed with the left button — the board handles the lane drag. */
  readonly headerDragStart = output<PointerEvent>();
  readonly grades = this.store.gradeMeta;

  readonly team = computed(() =>
    this.store.teams().find((t) => t.id === this.teamId()),
  );

  readonly workItems = computed(() => this.store.workItemsFor(this.teamId()));

  readonly owned = computed(() => this.workItems().filter((w) => w.role === 'owned'));
  readonly supporting = computed(() => this.workItems().filter((w) => w.role === 'supporting'));

  readonly quarterSprints = computed(() => this.store.selectedQuarter().sprints);

  readonly sprintNos = computed(() =>
    Array.from({ length: this.quarterSprints() }, (_, i) => i + 1),
  );

  /** Sprint start-date labels ("5 Jan") when date labels are enabled. */
  readonly sprintDates = computed(() => {
    if (!this.store.datesEnabled()) return [];
    const qIdx = this.store.quarters().findIndex((q) => q.id === this.store.selectedQuarterId());
    if (qIdx < 0) return [];
    return this.sprintNos().map((s) => this.store.sprintDate(qIdx, s - 1));
  });

  /** Members available this quarter: member joined with engineer + availability. */
  readonly members = computed(() => {
    const team = this.team();
    if (!team) return [];
    const quarter = this.quarterSprints();
    return this.store
      .membersOf(team.id)
      .map((m) => ({
        unavailable: m.unavailable,
        avail: quarter - m.unavailable.length,
        engineer: team.engineers.find((e) => e.id === m.engineerId),
      }))
      .filter((m): m is { unavailable: number[]; avail: number; engineer: NonNullable<typeof m.engineer> } =>
        !!m.engineer,
      );
  });

  /** Total available sprints across the team this quarter. */
  readonly totalSprints = computed(() =>
    this.members().reduce((sum, m) => sum + m.avail, 0),
  );

  /** Sprints already committed to filled slots in this lane. */
  readonly assignedSprints = computed(() =>
    this.workItems().reduce(
      (sum, w) =>
        sum +
        w.slots.filter((s) => !!s.engineer).length * this.store.slotSprints(w.project),
      0,
    ),
  );

  /** Capacity still available = total minus what filled slots consume. */
  readonly availableSprints = computed(() =>
    Math.max(0, this.totalSprints() - this.assignedSprints()),
  );

  /** Sprints committed to this lane across ALL seats (filled + open). */
  readonly committedSprints = computed(() =>
    this.workItems().reduce(
      (sum, w) => sum + w.slots.length * this.store.slotSprints(w.project),
      0,
    ),
  );

  /** Committed sprints beyond the team's total capacity. */
  readonly overSprints = computed(() =>
    Math.max(0, this.committedSprints() - this.totalSprints()),
  );

  /**
   * Squares for the capacity panel: one per sprint of committed work, then
   * free squares padding out to the team's total capacity. Committed-but-
   * unallocated squares get a border in the min-grade color (light orange
   * when any grade qualifies); allocated squares are filled with the
   * assigned engineer's grade color. Committed squares beyond the team's
   * total stay red-bordered as a persistent over-capacity risk marker.
   */
  readonly capacityCells = computed(() => {
    const cells: {
      state: 'free' | 'open' | 'filled';
      color?: string;
      title: string;
      over?: boolean;
    }[] = [];
    for (const w of this.workItems()) {
      const sprints = this.store.slotSprints(w.project);
      for (const s of w.slots) {
        for (let i = 0; i < sprints; i++) {
          if (s.engineer) {
            cells.push({
              state: 'filled',
              color: this.store.gradeColor(s.engineer.grade),
              title: `${s.engineer.name} (${s.engineer.grade}) · ${w.project.name} · S${s.start + 1 + i}`,
            });
          } else {
            const min = s.slot.minGrade;
            cells.push({
              state: 'open',
              color: min ? this.store.gradeColor(min) : '#fdba74',
              title: `${w.project.name} · needs ${min ? `${min}+` : 'any grade'} · unallocated`,
            });
          }
        }
      }
    }
    const total = this.totalSprints();
    // Committed beyond capacity: persistent over-capacity risk
    for (let i = total; i < cells.length; i++) {
      cells[i] = { ...cells[i], over: true };
    }
    const free = Math.max(0, total - cells.length);
    for (let i = 0; i < free; i++) {
      cells.push({ state: 'free', title: 'Uncommitted capacity' });
    }
    return cells;
  });

  /**
   * Every drop list in this lane: exact slot tracks first (innermost targets
   * win when both the slot and the whole-card list qualify), then the
   * card-level list per work item.
   */
  readonly connectedTo = computed(() =>
    this.workItems().flatMap((w) => [
      ...w.slots.map((s) => `slot-${s.slot.id}`),
      `wi-${w.project.id}`,
    ]),
  );

  readonly availListId = computed(() => `avail-${this.teamId()}`);

  /** Collapsed avail section = fixed 150px; expanded = as tall as needed. */
  readonly availExpanded = signal(false);

  readonly barsEl = viewChild<ElementRef<HTMLElement>>('barsEl');

  /** True when the engineer list is taller than the collapsed 110px window. */
  readonly availOverflows = signal(false);

  readonly availTip = signal<{
    engineerId: string;
    x: number;
    y: number;
    below: boolean;
  } | null>(null);
  private availTipTimer: ReturnType<typeof setTimeout> | null = null;

  readonly availTipData = computed(() => {
    const tip = this.availTip();
    if (!tip) return null;
    const engineer = this.store.engineerById(tip.engineerId);
    if (!engineer) return null;
    const team = this.team();
    const inCapacity = team ? this.store.isInCapacity(tip.engineerId) : false;
    const avail = team ? this.store.availSprintsOf(team.id, tip.engineerId) : 0;
    const allocations = this.store.allocationsOf(tip.engineerId);
    const used = allocations.reduce((sum, a) => sum + a.sprints, 0);
    const pct = avail ? Math.round((used / avail) * 100) : 0;
    const unavailable = team ? this.store.unavailableOf(team.id, tip.engineerId) : [];
    const off = new Set(unavailable);
    const conflicts = [
      ...new Set(
        allocations.flatMap((a) =>
          Array.from({ length: a.sprints }, (_, k) => a.start + k).filter((i) => off.has(i)),
        ),
      ),
    ].sort((a, b) => a - b);
    return { engineer, team, inCapacity, avail, allocations, used, pct, conflicts, ...tip };
  });

  constructor() {
    // Measure after DOM updates; scrollHeight is the full content height even
    // while clipped by the collapsed max-height, so it works in both states.
    afterRenderEffect(() => {
      this.members(); // re-measure when the roster changes
      const el = this.barsEl()?.nativeElement;
      this.availOverflows.set(!!el && el.scrollHeight > 110);
    });
  }

  readonly ctxMenu = signal<{
    engineerId: string;
    engineerName: string;
    x: number;
    y: number;
    seats: SeatOption[];
  } | null>(null);

  /** Rich confirm for removing an engineer from the quarter; null when closed. */
  readonly removeConfirm = signal<{ x: number; y: number; engineerId: string } | null>(null);

  /** Engineer pending removal from the quarter; null when closed. */
  readonly pendingMember = computed(() => {
    const c = this.removeConfirm();
    return c ? (this.store.engineerById(c.engineerId) ?? null) : null;
  });

  /** Board allocations that would be cleared by the removal. */
  readonly pendingMemberAllocs = computed(() => {
    const c = this.removeConfirm();
    return c ? this.store.allocationsOf(c.engineerId) : [];
  });

  @HostListener('document:click')
  @HostListener('document:contextmenu')
  closeMenu(): void {
    this.ctxMenu.set(null);
    this.removeConfirm.set(null);
  }

  /** Enter confirms, Escape cancels the remove-from-quarter confirm. */
  @HostListener('document:keydown', ['$event'])
  onDialogKey(event: KeyboardEvent): void {
    if (!this.removeConfirm()) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      this.removeMember();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.removeConfirm.set(null);
    }
  }

  /** The Available strip only accepts engineers dragged back (to cancel a drop). */
  readonly availPredicate = (item: CdkDrag<unknown>): boolean => {
    const data = item.data as { kind?: string } | undefined;
    return data?.kind === 'available';
  };

  /** % of the engineer's available sprints already allocated (0 when fully off). */
  pctOf(sprints: number, engineerId: string): number {
    const used = this.store
      .allocationsOf(engineerId)
      .reduce((sum, a) => sum + a.sprints, 0);
    return sprints > 0 ? Math.round((used / sprints) * 100) : 0;
  }

  /** Click a sprint cell on the capacity track → toggle that sprint's availability. */
  onCapCellClick(event: MouseEvent, engineerId: string): void {
    event.stopPropagation();
    if (this.store.drag()) return;
    const track = event.currentTarget as HTMLElement;
    const r = track.getBoundingClientRect();
    if (!r.width) return;
    const q = this.quarterSprints();
    const idx = Math.min(
      q - 1,
      Math.max(0, Math.floor(((event.clientX - r.left) / r.width) * q)),
    );
    this.store.toggleSprint(this.teamId(), engineerId, idx);
  }

  /** Contiguous runs where an allocation window overlaps unavailable sprints. */
  conflictRuns(
    start: number,
    sprints: number,
    unavailable: number[],
  ): { start: number; len: number }[] {
    const off = new Set(unavailable);
    const runs: { start: number; len: number }[] = [];
    for (let i = start; i < start + sprints; i++) {
      if (!off.has(i)) continue;
      const last = runs[runs.length - 1];
      if (last && last.start + last.len === i) last.len++;
      else runs.push({ start: i, len: 1 });
    }
    return runs;
  }

  /** "S3, S5" — 0-based sprint indices to compact labels. */
  sprintLabels(indices: number[]): string {
    return indices.map((i) => `S${i + 1}`).join(', ');
  }

  /** Grade color for the drag-preview chip (data comes back untyped). */
  gradeColor(grade: string): string {
    return this.store.gradeColor(grade as Grade) ?? '#94a3b8';
  }

  /** Header grabbed: hand the pointer to the board's lane drag. */
  onHeadPointerDown(event: PointerEvent): void {
    if (this.layoutMode() === 'fixed' || event.button !== 0) return;
    event.preventDefault();
    this.headerDragStart.emit(event);
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

  showAvailTip(event: MouseEvent, engineerId: string): void {
    if (this.store.drag()) return;
    this.clearAvailTipTimer();
    const icon = event.currentTarget as HTMLElement;
    const rect = icon.getBoundingClientRect();
    this.availTipTimer = setTimeout(() => {
      const point = this.toOverlayPoint(rect.right - 38, rect.top);
      this.availTip.set({
        engineerId,
        x: point.x,
        y: point.y,
        below: false,
      });
    }, 250);
  }

  scheduleHideAvailTip(): void {
    this.clearAvailTipTimer();
    this.availTipTimer = setTimeout(() => this.availTip.set(null), 120);
  }

  clearAvailTipTimer(): void {
    if (this.availTipTimer) {
      clearTimeout(this.availTipTimer);
      this.availTipTimer = null;
    }
  }

  /** Right-click an available engineer → menu of open seats they qualify for. */
  onCtxMenu(event: MouseEvent, engineerId: string, name: string): void {
    event.preventDefault();
    event.stopPropagation();
    const seats = this.store.candidateSeatsFor(engineerId);
    if (!seats.length) {
      this.store.showToast(`No open seats match ${name} (team, grade, or capacity)`);
      return;
    }
    // Screen px minus viewport origin + pan, like the work-item menus.
    const p = this.toOverlayPoint(event.clientX, event.clientY);
    this.ctxMenu.set({
      engineerId,
      engineerName: name,
      x: p.x,
      y: p.y,
      seats,
    });
  }

  assignFromMenu(seat: SeatOption): void {
    const menu = this.ctxMenu();
    if (!menu) return;
    this.ctxMenu.set(null);
    if (this.store.assignToSlot(seat.slotId, menu.engineerId)) {
      const alloc = this.store.assignments()[seat.slotId];
      const end = alloc ? alloc.start + (alloc.sprints ?? seat.sprints) : 0;
      this.store.showToast(
        `${menu.engineerName} → ${seat.projectName}: ${seat.sprints} sprints at S${(alloc?.start ?? 0) + 1}–S${end}`,
      );
    }
  }

  /** Open the rich confirm before removing an engineer from the quarter. */
  askRemoveMember(event: MouseEvent, engineerId: string): void {
    event.stopPropagation();
    this.ctxMenu.set(null);
    const p = this.toOverlayPoint(window.innerWidth / 2, window.innerHeight / 2);
    this.removeConfirm.set({ ...p, engineerId });
  }

  removeMember(): void {
    const c = this.removeConfirm();
    this.removeConfirm.set(null);
    if (c) this.store.toggleCapacity(this.teamId(), c.engineerId);
  }

  onDrop(event: CdkDragDrop<unknown>): void {
    const data = event.item.data as
      | { kind: 'available'; engineerId: string }
      | undefined;
    if (!data || data.kind !== 'available') return;

    const target = event.container.id;
    if (target.startsWith('slot-')) {
      this.store.assignToSlot(target.slice('slot-'.length), data.engineerId);
    }
  }
}
