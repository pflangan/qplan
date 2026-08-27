import {
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  afterRenderEffect,
  computed,
  inject,
  input,
  signal,
  viewChild,
  viewChildren,
} from '@angular/core';
import { CapacityStore } from '../capacity-store.service';
import { TRACK_W } from '../models';
import { RichTip } from '../rich-tip.directive';
import { TeamLane } from './team-lane';

/** Lane snap grid, in layout px (pre-zoom space). */
const GRID = 20;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2;
/** Figma/Miro-style preset stops the −/+ buttons step through. */
const ZOOM_STOPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
/** Horizontal gap between auto-placed lanes. */
const LANE_GAP = 24;
/** Fallback lane width (layout px) when a lane hasn't been measured yet. */
const LANE_FALLBACK_W = 280;
/** Fallback lane height (layout px) when a lane hasn't been measured yet. */
const LANE_FALLBACK_H = 320;
/** Distance from a viewport edge (screen px) that triggers auto-pan while dragging. */
const EDGE_PAN_MARGIN = 64;
/** Screen px panned per animation frame while the pointer sits near an edge. */
const EDGE_PAN_SPEED = 16;

/** Live background-pan drag. */
interface PanDrag {
  pointerId: number;
  startX: number;
  startY: number;
  origPanX: number;
  origPanY: number;
}

/** Live lane header-drag; `last` is the latest collision-free snapped spot. */
interface LaneDrag {
  pointerId: number;
  startX: number;
  startY: number;
  orig: { x: number; y: number };
  last: { x: number; y: number };
}

@Component({
  selector: 'app-board',
  imports: [RichTip, TeamLane],
  templateUrl: './board.html',
  styleUrl: './board.scss',
})
export class Board {
  readonly store = inject(CapacityStore);
  readonly layoutMode = input.required<'canvas' | 'fixed'>();

  /** Sprint-cell width: fixed track width spread across the quarter's sprints. */
  readonly px = computed(() => TRACK_W / this.store.selectedQuarter().sprints);

  readonly viewportEl = viewChild<ElementRef<HTMLElement>>('viewportEl');
  readonly laneEls = viewChildren<ElementRef<HTMLElement>>('laneSlot');

  // ---- Viewport (zoom + pan) ----

  readonly zoom = computed(() => (this.layoutMode() === 'fixed' ? 1 : this.store.boardLayout().zoom));
  readonly panX = computed(() => (this.layoutMode() === 'fixed' ? 0 : this.store.boardLayout().panX));
  readonly panY = computed(() => (this.layoutMode() === 'fixed' ? 0 : this.store.boardLayout().panY));
  readonly zoomPct = computed(() => Math.round(this.zoom() * 100) + '%');

  readonly laneWidth = computed(() => {
    const viewport = this.viewportEl()?.nativeElement;
    const teams = this.store.teams();
    const count = Math.max(1, teams.length);
    const available = Math.max(
      0,
      (viewport?.clientWidth ?? 0) - 32 - (count - 1) * LANE_GAP,
    );
    return Math.max(300, Math.floor(available / count));
  });

  readonly fixedLanePositions = computed(() => {
    const laneW = this.laneWidth();
    return Object.fromEntries(
      this.store.teams().map((team, index) => [team.id, index * (laneW + LANE_GAP)]),
    );
  });

  readonly boardSize = computed(() => {
    const teams = this.store.teams();
    const sizes = this.laneSizes();
    if (this.layoutMode() === 'fixed') {
      const laneW = this.laneWidth();
      const totalWidth = teams.length ? teams.length * laneW + (teams.length - 1) * LANE_GAP : 0;
      const maxHeight = teams.reduce(
        (max, t) => Math.max(max, sizes[t.id]?.h ?? LANE_FALLBACK_H),
        0,
      );
      return { w: Math.max(totalWidth, laneW), h: Math.max(maxHeight, LANE_FALLBACK_H) };
    }

    const positions = this.store.boardLayout().positions;
    let maxX = 0;
    let maxY = 0;
    for (const t of teams) {
      const p = positions[t.id];
      const s = sizes[t.id] ?? { w: LANE_FALLBACK_W, h: LANE_FALLBACK_H };
      if (!p) continue;
      maxX = Math.max(maxX, p.x + s.w);
      maxY = Math.max(maxY, p.y + s.h);
    }
    return { w: Math.max(maxX, LANE_FALLBACK_W), h: Math.max(maxY, LANE_FALLBACK_H) };
  });

  /** Team being dragged by its header, if any. */
  readonly dragTeamId = signal<string | null>(null);
  /** Candidate position of the dragged lane (layout px). */
  readonly livePos = signal<{ x: number; y: number } | null>(null);
  /** Measured lane sizes in layout px, for collisions / stacking / fit. */
  readonly laneSizes = signal<Record<string, { w: number; h: number }>>({});

  private panDrag: PanDrag | null = null;
  private laneDrag: LaneDrag | null = null;
  private laneResizeObserver: ResizeObserver | null = null;

  // ---- Edge auto-pan during drags ----

  private edgePanRaf: number | null = null;
  private edgePanMode: 'lane' | 'cdk' | null = null;
  private edgePointer = { x: 0, y: 0 };

  constructor() {
    // ⌘/Ctrl+wheel = zoom at cursor; plain wheel = pan. Needs passive:false
    // so preventDefault can stop the browser's page zoom / scroll.
    afterRenderEffect((onCleanup) => {
      const el = this.viewportEl()?.nativeElement;
      if (!el) return;
      const onWheel = (e: WheelEvent): void => {
        if (this.layoutMode() === 'fixed') return;
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        if (e.ctrlKey || e.metaKey) {
          this.zoomAt(
            e.clientX - rect.left,
            e.clientY - rect.top,
            this.zoom() * (e.deltaY < 0 ? 1.1 : 1 / 1.1),
          );
        } else {
          const dx = e.shiftKey ? e.deltaY : e.deltaX;
          const dy = e.shiftKey ? 0 : e.deltaY;
          this.store.setViewport(this.zoom(), this.panX() - dx, this.panY() - dy);
        }
      };
      el.addEventListener('wheel', onWheel, { passive: false });
      onCleanup(() => el.removeEventListener('wheel', onWheel));
    });

    // While CDK drags an engineer chip, track the pointer for edge auto-pan
    // (the drag signal gates this listener).
    const onDragPointerMove = (e: PointerEvent): void => {
      if (!this.store.drag()) return;
      this.setEdgePointer(e.clientX, e.clientY);
      this.startEdgePan('cdk');
    };
    window.addEventListener('pointermove', onDragPointerMove);
    inject(DestroyRef).onDestroy(() =>
      window.removeEventListener('pointermove', onDragPointerMove),
    );

    // Measure rendered lanes (getBoundingClientRect / zoom = layout px) and
    // reset fixed-mode positions to side-by-side order when needed.
    afterRenderEffect((onCleanup) => {
      this.layoutMode();
      this.store.teams();
      this.store.projects();
      this.store.assignments();
      this.store.selectedQuarterId();
      this.laneEls();
      const teams = this.store.teams();
      const els = this.laneEls();
      const sizes: Record<string, { w: number; h: number }> = {};
      const z = this.zoom();
      teams.forEach((t, i) => {
        const el = els[i]?.nativeElement;
        if (!el) return;
        const r = el.getBoundingClientRect();
        sizes[t.id] = { w: r.width / z, h: r.height / z };
      });
      const prev = this.laneSizes();
      if (
        Object.keys(sizes).length !== Object.keys(prev).length ||
        teams.some((t) => {
          const a = sizes[t.id];
          const b = prev[t.id];
          return !a || !b || Math.abs(a.w - b.w) > 1 || Math.abs(a.h - b.h) > 1;
        })
      ) {
        this.laneSizes.set(sizes);
      }

      if (!this.laneResizeObserver) {
        this.laneResizeObserver = new ResizeObserver(() => this.measureLaneSizes());
      }
      this.laneResizeObserver.disconnect();
      els.forEach((el) => el?.nativeElement && this.laneResizeObserver?.observe(el.nativeElement));
      onCleanup(() => this.laneResizeObserver?.disconnect());

      // Auto-place unpositioned lanes in a horizontal row (top edges aligned):
      // each new lane goes to the right of everything already placed.
      const positions = { ...this.store.boardLayout().positions };
      let maxRight = teams.reduce(
        (m, t) =>
          t.id in positions
            ? Math.max(m, (positions[t.id]?.x ?? 0) + (sizes[t.id]?.w ?? LANE_FALLBACK_W))
            : m,
        0,
      );
      for (const t of teams) {
        if (t.id in positions) continue;
        const x = maxRight > 0 ? maxRight + LANE_GAP : 0;
        this.store.setLanePosition(t.id, { x, y: 0 });
        positions[t.id] = { x, y: 0 };
        maxRight = x + (sizes[t.id]?.w ?? LANE_FALLBACK_W);
      }
    });
  }

  // ---- Lane positions ----

  laneLeft(teamId: string): number {
    if (this.dragTeamId() === teamId && this.livePos()) return this.livePos()!.x;
    if (this.layoutMode() === 'fixed') {
      return this.fixedLanePositions()[teamId] ?? 0;
    }
    return this.store.lanePos(teamId)?.x ?? 0;
  }

  laneTop(teamId: string): number {
    if (this.dragTeamId() === teamId && this.livePos()) return this.livePos()!.y;
    if (this.layoutMode() === 'fixed') return 0;
    return this.store.lanePos(teamId)?.y ?? 0;
  }

  /** AABB overlap of the candidate spot against every other placed lane. */
  private collides(teamId: string, pos: { x: number; y: number }): boolean {
    const sizes = this.laneSizes();
    const positions = this.store.boardLayout().positions;
    const mine = sizes[teamId];
    if (!mine) return false;
    for (const [id, p] of Object.entries(positions)) {
      if (id === teamId) continue;
      const s = sizes[id];
      if (!s) continue;
      if (
        pos.x < p.x + s.w &&
        pos.x + mine.w > p.x &&
        pos.y < p.y + s.h &&
        pos.y + mine.h > p.y
      ) {
        return true;
      }
    }
    return false;
  }

  /** Lane header grabbed: drag freely in layout px, snap to grid, never overlap. */
  onHeaderDragStart(event: PointerEvent, teamId: string): void {
    if (this.layoutMode() === 'fixed') return;
    if (event.button !== 0 || this.laneDrag || this.panDrag) return;
    const orig = this.store.lanePos(teamId);
    if (!orig) return;
    event.preventDefault();
    this.dragTeamId.set(teamId);
    this.livePos.set(orig);
    this.laneDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      orig,
      last: orig,
    };
    window.addEventListener('pointermove', this.onLaneMove);
    window.addEventListener('pointerup', this.onLaneUp);
    // OS gesture recognition (macOS trackpad double-tap, palm rejection, Esc)
    // cancels the pointer stream with pointercancel instead of pointerup.
    // Treat it as a release or laneDrag sticks and the edge pan runs forever.
    window.addEventListener('pointercancel', this.onLaneUp);
    this.setEdgePointer(event.clientX, event.clientY);
    this.startEdgePan('lane');
  }

  private readonly onLaneMove = (e: PointerEvent): void => {
    const d = this.laneDrag;
    if (!d || e.pointerId !== d.pointerId) return;
    this.setEdgePointer(e.clientX, e.clientY);
    const z = this.zoom();
    const snapped = {
      x: Math.round((d.orig.x + (e.clientX - d.startX) / z) / GRID) * GRID,
      y: Math.round((d.orig.y + (e.clientY - d.startY) / z) / GRID) * GRID,
    };
    const teamId = this.dragTeamId();
    if (teamId && !this.collides(teamId, snapped)) d.last = snapped;
    this.livePos.set(d.last);
  };

  private readonly onLaneUp = (e: PointerEvent): void => {
    const d = this.laneDrag;
    if (!d || e.pointerId !== d.pointerId) return;
    window.removeEventListener('pointermove', this.onLaneMove);
    window.removeEventListener('pointerup', this.onLaneUp);
    window.removeEventListener('pointercancel', this.onLaneUp);
    this.laneDrag = null;
    this.stopEdgePan();
    const teamId = this.dragTeamId();
    this.dragTeamId.set(null);
    this.livePos.set(null);
    if (teamId) this.store.setLanePosition(teamId, d.last);
  };

  // ---- Edge auto-pan ----

  private setEdgePointer(x: number, y: number): void {
    this.edgePointer.x = x;
    this.edgePointer.y = y;
  }

  private startEdgePan(mode: 'lane' | 'cdk'): void {
    this.edgePanMode = mode;
    if (this.edgePanRaf === null) this.edgePanRaf = requestAnimationFrame(this.stepEdgePan);
  }

  private readonly stepEdgePan = (): void => {
    this.edgePanRaf = null;
    const mode = this.edgePanMode;
    if (!mode) return;
    // CDK clears its drag signals on pointerup — that's our stop signal.
    if (mode === 'cdk' && !this.store.drag()) {
      this.edgePanMode = null;
      return;
    }
    // Lane drags have no such signal — belt-and-braces self-stop if the drag
    // state was somehow cleared without stopEdgePan().
    if (mode === 'lane' && !this.laneDrag) {
      this.edgePanMode = null;
      return;
    }
    // Re-schedule before any pan work: the synthetic pointermove below can
    // re-enter startEdgePan synchronously and must not stack a second loop.
    this.edgePanRaf = requestAnimationFrame(this.stepEdgePan);
    const el = this.viewportEl()?.nativeElement;
    if (el) {
      const r = el.getBoundingClientRect();
      const p = this.edgePointer;
      // Pan only on axes where the pointer is inside the viewport, so holding
      // the drag over the side panels never pans the canvas.
      let vx = 0;
      let vy = 0;
      if (p.y >= r.top && p.y <= r.bottom) {
        if (p.x < r.left + EDGE_PAN_MARGIN) vx = -EDGE_PAN_SPEED;
        else if (p.x > r.right - EDGE_PAN_MARGIN) vx = EDGE_PAN_SPEED;
      }
      if (p.x >= r.left && p.x <= r.right) {
        if (p.y < r.top + EDGE_PAN_MARGIN) vy = -EDGE_PAN_SPEED;
        else if (p.y > r.bottom - EDGE_PAN_MARGIN) vy = EDGE_PAN_SPEED;
      }
      if (vx || vy) {
        // Pointer near the right edge → content pans left, revealing what's
        // beyond that edge (and mirrored for the other three).
        this.store.setViewport(this.zoom(), this.panX() - vx, this.panY() - vy);
        if (mode === 'cdk') {
          // CDK re-runs drop hit-testing only on pointermove: replay the last
          // pointer position so targets under the (stationary) pointer update.
          document.dispatchEvent(
            new PointerEvent('pointermove', { clientX: p.x, clientY: p.y }),
          );
        }
      }
    }
  };

  private stopEdgePan(): void {
    this.edgePanMode = null;
    if (this.edgePanRaf !== null) {
      cancelAnimationFrame(this.edgePanRaf);
      this.edgePanRaf = null;
    }
  }

  private measureLaneSizes(): void {
    const z = this.zoom();
    const teams = this.store.teams();
    const els = this.laneEls();
    const sizes: Record<string, { w: number; h: number }> = {};
    teams.forEach((t, i) => {
      const el = els[i]?.nativeElement;
      if (!el) return;
      const r = el.getBoundingClientRect();
      sizes[t.id] = { w: r.width / z, h: r.height / z };
    });
    const prev = this.laneSizes();
    if (
      Object.keys(sizes).length !== Object.keys(prev).length ||
      teams.some((t) => {
        const a = sizes[t.id];
        const b = prev[t.id];
        return !a || !b || Math.abs(a.w - b.w) > 1 || Math.abs(a.h - b.h) > 1;
      })
    ) {
      this.laneSizes.set(sizes);
    }
  }

  // ---- Background pan ----

  /** Pan when the press lands on the canvas itself (not a lane or control). */
  onCanvasPointerDown(event: PointerEvent): void {
    if (this.layoutMode() === 'fixed') return;
    if (event.button !== 0 || this.panDrag || this.laneDrag) return;
    const t = event.target as HTMLElement;
    if (!t.classList.contains('canvas-viewport') && !t.classList.contains('pan-layer') && !t.classList.contains('zoom-layer')) {
      return;
    }
    event.preventDefault();
    this.panDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origPanX: this.panX(),
      origPanY: this.panY(),
    };
    window.addEventListener('pointermove', this.onPanMove);
    window.addEventListener('pointerup', this.onPanUp);
    window.addEventListener('pointercancel', this.onPanUp);
  }

  private readonly onPanMove = (e: PointerEvent): void => {
    const d = this.panDrag;
    if (!d || e.pointerId !== d.pointerId) return;
    this.store.setViewport(
      this.zoom(),
      d.origPanX + (e.clientX - d.startX),
      d.origPanY + (e.clientY - d.startY),
    );
  };

  private readonly onPanUp = (e: PointerEvent): void => {
    const d = this.panDrag;
    if (!d || e.pointerId !== d.pointerId) return;
    window.removeEventListener('pointermove', this.onPanMove);
    window.removeEventListener('pointerup', this.onPanUp);
    window.removeEventListener('pointercancel', this.onPanUp);
    this.panDrag = null;
  };

  // ---- Zoom toolbar ----

  /** Zoom about a viewport-space point so the point under the cursor stays put. */
  private zoomAt(vx: number, vy: number, next: number): void {
    if (this.layoutMode() === 'fixed') return;
    const z1 = this.zoom();
    const z2 = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, next));
    const px = (vx - this.panX()) / z1;
    const py = (vy - this.panY()) / z1;
    this.store.setViewport(z2, vx - px * z2, vy - py * z2);
  }

  /** Step to the next preset stop above/below the current zoom. */
  zoomStep(dir: number): void {
    const z = this.zoom();
    const eps = 0.001; // current zoom may be a continuous wheel value
    const next =
      dir > 0
        ? ZOOM_STOPS.find((s) => s > z + eps)
        : [...ZOOM_STOPS].reverse().find((s) => s < z - eps);
    if (next === undefined) return;
    this.zoomAboutCenter(next);
  }

  /** Click on the % label: back to 100%. */
  resetZoom(): void {
    this.zoomAboutCenter(1);
  }

  private zoomAboutCenter(next: number): void {
    const el = this.viewportEl()?.nativeElement;
    const r = el?.getBoundingClientRect();
    const cx = r ? r.width / 2 : 0;
    const cy = r ? r.height / 2 : 0;
    this.zoomAt(cx, cy, next);
  }

  /** ⌘/Ctrl + / − / 0 keyboard zoom, matching the toolbar buttons. */
  @HostListener('window:keydown', ['$event'])
  onKeydown(e: KeyboardEvent): void {
    if (this.layoutMode() === 'fixed') return;
    if (!e.metaKey && !e.ctrlKey) return;
    if (e.key === '+' || e.key === '=') this.zoomStep(1);
    else if (e.key === '-' || e.key === '_') this.zoomStep(-1);
    else if (e.key === '0') this.resetZoom();
    else return;
    e.preventDefault();
  }

  /** Frame every placed lane: fit the union bbox horizontally and align to the top. */
  fit(): void {
    if (this.layoutMode() === 'fixed') return;
    const teams = this.store.teams();
    if (!teams.length) return;
    const positions = this.store.boardLayout().positions;
    const sizes = this.laneSizes();
    let minX = Infinity;
    let maxX = -Infinity;
    for (const t of teams) {
      const p = positions[t.id];
      if (!p) continue;
      const s = sizes[t.id];
      if (!s) continue;
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x + s.w);
      if (p.y !== 0) {
        this.store.setLanePosition(t.id, { x: p.x, y: 0 });
      }
    }
    if (minX === Infinity) return;
    const el = this.viewportEl()?.nativeElement;
    const vw = el?.clientWidth ?? 0;
    const vh = el?.clientHeight ?? 0;
    if (!vw || !vh) return;
    const pad = 32;
    const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, (vw - pad) / (maxX - minX)));
    this.store.setViewport(
      z,
      (vw - (maxX - minX) * z) / 2 - minX * z,
      16,
    );
  }

  /** Line up all lanes left-to-right with a small gap, tops aligned, then fit. */
  tidy(): void {
    if (this.layoutMode() === 'fixed') return;
    const sizes = this.laneSizes();
    // Step on the same 20px grid that setLanePosition snaps to — accumulating
    // raw x against snapped positions makes rounding errors stack up and the
    // gaps come out uneven (e.g. 20/20/40).
    let x = 0;
    for (const t of this.store.teams()) {
      this.store.setLanePosition(t.id, { x, y: 0 });
      const w = sizes[t.id]?.w ?? LANE_FALLBACK_W;
      x = Math.round((x + w + LANE_GAP) / GRID) * GRID;
    }
    this.fit();
  }

  // ---- Group ribbon (unchanged stats) ----

  /** Selected quarter's date range, e.g. "5 Jan – 27 Mar"; '' when disabled. */
  readonly dateRange = computed(() => {
    if (!this.store.datesEnabled()) return '';
    const idx = this.store.quarters().findIndex((q) => q.id === this.store.selectedQuarterId());
    return idx >= 0 ? this.store.quarterDateRange(idx) : '';
  });

  /** Total available sprints across every team this quarter. */
  readonly groupTotal = computed(() =>
    this.store.teams().reduce(
      (sum, t) =>
        sum +
        this.store
          .membersOf(t.id)
          .reduce((s, m) => s + this.store.availSprintsOf(t.id, m.engineerId), 0),
      0,
    ),
  );

  /** Sprints committed to on-board slots across all teams. */
  readonly groupCommitted = computed(() =>
    this.store
      .projects()
      .filter((s) => s.onBoard)
      .reduce((sum, s) => sum + s.slots.length * this.store.slotSprints(s), 0),
  );

  readonly groupFree = computed(() =>
    Math.max(0, this.groupTotal() - this.groupCommitted()),
  );

  readonly groupOver = computed(() =>
    Math.max(0, this.groupCommitted() - this.groupTotal()),
  );

  /**
   * Squares for the group ribbon: one per committed person-sprint across all
   * teams, then free squares padding out to the group total. Cells are
   * emitted per team (all its committed sprints together) so each team forms
   * a contiguous run of its color. Filled = an engineer is allocated to the
   * seat (their home team's color); border-only = committed but unallocated.
   * Committed squares beyond the group total carry a red over-capacity style.
   */
  readonly groupCells = computed(() => {
    const cells: {
      state: 'free' | 'open' | 'filled';
      color?: string;
      title: string;
      over?: boolean;
    }[] = [];
    for (const team of this.store.teams()) {
      for (const project of this.store.projects().filter((s) => s.onBoard)) {
        const sprints = this.store.slotSprints(project);
        for (const slot of project.slots.filter((sl) => sl.teamId === team.id)) {
          const alloc = this.store.assignments()[slot.id];
          const eng = alloc ? this.store.engineerById(alloc.engineerId) : undefined;
          for (let i = 0; i < sprints; i++) {
            cells.push(
              eng
                ? {
                    state: 'filled',
                    color: team.color,
                    title: `${eng.name} (${eng.grade}) · ${project.name} · ${team.name} · S${(alloc?.start ?? 0) + 1 + i}`,
                  }
                : {
                    state: 'open',
                    color: team.color,
                    title: `${project.name} · needs ${team.name} · unallocated`,
                  },
            );
          }
        }
      }
    }
    // Orphan seats (no team) shouldn't vanish from the ribbon: gray markers.
    for (const project of this.store.projects().filter((s) => s.onBoard)) {
      const sprints = this.store.slotSprints(project);
      const orphanSeats = project.slots.filter((sl) => !sl.teamId).length;
      for (let s = 0; s < orphanSeats; s++) {
        for (let i = 0; i < sprints; i++) {
          cells.push({
            state: 'open',
            color: '#94a3b8',
            title: `${project.name} · unassigned team`,
          });
        }
      }
    }
    const total = this.groupTotal();
    for (let i = total; i < cells.length; i++) {
      cells[i] = { ...cells[i], over: true };
    }
    for (let i = cells.length; i < total; i++) {
      cells.push({ state: 'free', title: 'Uncommitted capacity' });
    }
    return cells;
  });
}
