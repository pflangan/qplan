import { Injectable, computed, effect, signal } from '@angular/core';
import {
  COLOR_PALETTE,
  CapacityMember,
  DEFAULT_BOARD_LAYOUT,
  DEFAULT_SETTINGS,
  BoardLayout,
  Engineer,
  Grade,
  GRADES,
  GRADE_RANK,
  Quarter,
  QUARTER_IDS,
  QuarterId,
  Settings,
  SizeId,
  Slot,
  Project,
  TagDef,
  TAG_COLOR_PAIRS,
  Team,
  WorkItem,
  sizeForTotal,
  sizeSpec,
} from './models';

/** One sprint window an engineer is booked for, with display info. */
export interface Allocation {
  slotId: string;
  projectId: string;
  projectName: string;
  start: number;
  sprints: number;
  color: string;
}

/** Parse an ISO 'YYYY-MM-DD' string as local midnight (NaN when malformed). */
function localMidnight(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return NaN;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getTime();
}

/** True Mon–Fri. */
function isBusinessDay(d: Date): boolean {
  const day = d.getDay();
  return day !== 0 && day !== 6;
}

/** First business day on or after the given date. */
function nextBusinessDay(d: Date): Date {
  const c = new Date(d);
  while (!isBusinessDay(c)) c.setDate(c.getDate() + 1);
  return c;
}

/** Pass through valid #rrggbb colors, else fall back. */
function hexColor(v: unknown, fb: string): string {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : fb;
}

/** Clamp/validate a raw tag list (missing ids assigned, dupes dropped). */
function sanitizeTags(raw: TagDef[] | undefined): TagDef[] {
  if (!Array.isArray(raw)) return [];
  const out: TagDef[] = [];
  for (const t of raw) {
    if (!t) continue;
    const short = String(t.short ?? '').trim().slice(0, 8);
    if (!short) continue;
    if (out.some((x) => x.short.toLowerCase() === short.toLowerCase())) continue;
    out.push({
      id: t.id || uid(),
      short,
      full: String(t.full ?? '').trim().slice(0, 80),
      bg: hexColor(t.bg, TAG_COLOR_PAIRS[0].bg),
      fg: hexColor(t.fg, TAG_COLOR_PAIRS[0].fg),
    });
  }
  return out;
}

const TEAM_PALETTE = [
  '#6366f1',
  '#06b6d4',
  '#ec4899',
  '#10b981',
  '#f59e0b',
  '#8b5cf6',
  '#ef4444',
  '#14b8a6',
];

const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

const STORAGE_KEY = 'capacity-planner-v1';

@Injectable({ providedIn: 'root' })
export class CapacityStore {
  /** Stashed plans for non-selected quarters (selected quarter lives in the signals). */
  private plans: Record<
    string,
    {
      projects: Project[];
      capacity: Record<string, CapacityMember[]>;
      assignments: Record<
        string,
        { engineerId: string; start: number; sprints?: number }
      >;
    }
  > = {};

  readonly teams = signal<Team[]>([]);
  readonly projects = signal<Project[]>([]);
  /** teamId -> members available this quarter */
  readonly capacity = signal<Record<string, CapacityMember[]>>({});
  /**
   * slotId -> { engineerId, start, sprints? } where start is a 0-based sprint
   * index and sprints is a custom duration (edge-resized); defaults to the
   * project's t-shirt size duration when absent.
   */
  readonly assignments = signal<
    Record<string, { engineerId: string; start: number; sprints?: number }>
  >({});

  readonly quarters = signal<Quarter[]>([
    { id: 'Q1', label: 'Q1', sprints: 6 },
    { id: 'Q2', label: 'Q2', sprints: 5 },
    { id: 'Q3', label: 'Q3', sprints: 5 },
    { id: 'Q4', label: 'Q4', sprints: 6 },
  ]);
  readonly selectedQuarterId = signal<string>('Q1');

  readonly settings = signal<Settings>(DEFAULT_SETTINGS);
  readonly sizes = computed(() => this.settings().sizes);

  /** Canvas board layout: lane positions + saved zoom/pan viewport. */
  readonly boardLayout = signal<BoardLayout>(
    structuredClone(DEFAULT_BOARD_LAYOUT),
  );

  /** Sidebar collapse flags (persisted in the snapshot's ui field). */
  readonly projectsExpanded = signal(true);
  readonly onCallExpanded = signal(true);

  setPanelsExpanded(projects: boolean, onCall: boolean): void {
    this.projectsExpanded.set(projects);
    this.onCallExpanded.set(onCall);
  }

  /** Global default for compact project cards (persisted in ui). */
  readonly projectsCompact = signal(false);
  /** Per-card deviations from the global default (ephemeral). */
  private readonly cardCompactOverrides = signal<Record<string, boolean>>({});

  isCardCompact(projectId: string): boolean {
    return this.cardCompactOverrides()[projectId] ?? this.projectsCompact();
  }

  /** Flip every card at once and forget individual deviations. */
  toggleCompactAll(): void {
    this.projectsCompact.update((v) => !v);
    this.cardCompactOverrides.set({});
  }

  toggleCardCompact(projectId: string): void {
    const next = !this.isCardCompact(projectId);
    this.cardCompactOverrides.update((o) => ({ ...o, [projectId]: next }));
  }

  readonly selectedQuarter = computed(
    () =>
      this.quarters().find((q) => q.id === this.selectedQuarterId()) ??
      this.quarters()[0],
  );

  readonly quarterWeeks = computed(
    () => this.selectedQuarter().sprints * this.settings().sprintLengthWeeks,
  );

  /** Start date of each quarter, cumulative from settings.quarterStart (nulls when unset). */
  readonly quarterStartDates = computed<(Date | null)[]>(() => {
    const s = this.settings();
    // Parse the ISO date as LOCAL midnight — Date.parse would give UTC
    // midnight, which renders as the previous day in behind-UTC timezones.
    const t = s.quarterStart ? localMidnight(s.quarterStart) : NaN;
    if (Number.isNaN(t)) return this.quarters().map(() => null);
    const dates: (Date | null)[] = [];
    // Advance by calendar days (not fixed ms) so DST transitions can't
    // drift a quarter boundary onto the wrong rendered day.
    const cursor = new Date(t);
    for (const q of this.quarters()) {
      dates.push(new Date(cursor));
      const rawNext = new Date(cursor);
      // Day after the quarter's last calendar day, before business-day snapping.
      rawNext.setDate(rawNext.getDate() + q.sprints * s.sprintLengthWeeks * 7);
      if (s.quarterChainMode === 'same') {
        // Same business day the quarter ends on: share the boundary date when
        // the last day is Mon–Fri, else start on the following Monday.
        const rawEnd = new Date(rawNext);
        rawEnd.setDate(rawEnd.getDate() - 1);
        cursor.setTime((isBusinessDay(rawEnd) ? rawEnd : nextBusinessDay(rawNext)).getTime());
      } else {
        cursor.setTime(nextBusinessDay(rawNext).getTime());
      }
    }
    return dates;
  });

  /** Date labels are rendered only when a start date exists and the user hasn't hidden them. */
  readonly datesEnabled = computed(
    () => this.settings().showDates && this.quarterStartDates()[0] !== null,
  );

  readonly loadedFromStorage: boolean;

  constructor() {
    let loaded = false;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) loaded = this.applyData(JSON.parse(raw));
    } catch {
      loaded = false;
    }
    this.loadedFromStorage = loaded;
    // Persist state changes (debounced — canvas pan/zoom updates in bursts);
    // silently skip when storage is unavailable (e.g. Safari file://).
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    effect(() => {
      const snap = JSON.stringify(this.exportSnapshot());
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = null;
        try {
          localStorage.setItem(STORAGE_KEY, snap);
        } catch {
          /* storage unavailable */
        }
      }, 250);
    });
  }

  readonly toast = signal<string | null>(null);
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  // ---------- Settings ----------

  /** Merge a settings patch, clamping values into their legal ranges. */
  saveSettings(patch: Partial<Settings>): void {
    const current = this.settings();
    const maxSprints = Math.max(...this.quarters().map((q) => q.sprints));
    const fallbacks = DEFAULT_SETTINGS.sizes;
    const sizes = (patch.sizes ?? current.sizes).map((s, i) => {
      const fallback = fallbacks[i];
      return {
        id: fallback.id,
        engineers: Math.max(1, Math.min(12, Math.round(Number(s?.engineers) || fallback.engineers))),
        sprints: Math.max(1, Math.min(maxSprints, Math.round(Number(s?.sprints) || fallback.sprints))),
        color: hexColor(s?.color, fallback.color),
      };
    });
    const gradeSource = patch.gradeColors ?? current.gradeColors;
    const gradeColors = Object.fromEntries(
      (Object.keys(GRADES) as Grade[]).map((g) => [
        g,
        hexColor(gradeSource[g], DEFAULT_SETTINGS.gradeColors[g]),
      ]),
    ) as Record<Grade, string>;
    const quarterStart =
      patch.quarterStart !== undefined
        ? patch.quarterStart && !Number.isNaN(Date.parse(patch.quarterStart))
          ? patch.quarterStart
          : null
        : current.quarterStart;
    const startQuarter =
      patch.startQuarter !== undefined && QUARTER_IDS.includes(patch.startQuarter)
        ? patch.startQuarter
        : current.startQuarter;
    const quarterChainMode =
      patch.quarterChainMode !== undefined &&
      (patch.quarterChainMode === 'same' || patch.quarterChainMode === 'next')
        ? patch.quarterChainMode
        : current.quarterChainMode;
    this.settings.set({
      quarterStart,
      startQuarter,
      quarterChainMode,
      sprintLengthWeeks:
        patch.sprintLengthWeeks !== undefined
          ? Math.max(1, Math.min(4, Math.round(Number(patch.sprintLengthWeeks) || 2)))
          : current.sprintLengthWeeks,
      showDates: patch.showDates !== undefined ? !!patch.showDates : current.showDates,
      sizes,
      gradeColors,
      tags: sanitizeTags(patch.tags !== undefined ? patch.tags : current.tags),
    });
    this.rotateQuartersIfNeeded(startQuarter);
    this.clampToQuarter();
  }

  /** User-pickable color for a grade (settings override, GRADES as fallback). */
  gradeColor(grade: Grade): string {
    return this.settings().gradeColors[grade] ?? GRADES[grade].color;
  }

  /** GRADES metadata with colors overridden by settings (for templates). */
  readonly gradeMeta = computed(() => {
    const colors = this.settings().gradeColors;
    return Object.fromEntries(
      (Object.keys(GRADES) as Grade[]).map((g) => [
        g,
        { ...GRADES[g], color: colors[g] ?? GRADES[g].color },
      ]),
    ) as typeof GRADES;
  });

  // ---------- Project tags ----------

  /** App-wide tag definitions (settings-persisted). */
  readonly tagDefs = computed<TagDef[]>(() => this.settings().tags ?? []);

  tagDef(id: string): TagDef | undefined {
    return this.tagDefs().find((t) => t.id === id);
  }

  /** Create a tag definition; null (with toast) when the shorthand is taken. */
  createTag(short: string, full: string, pair: { bg: string; fg: string }): TagDef | null {
    const s = short.trim().slice(0, 8);
    if (!s) return null;
    if (this.tagDefs().some((t) => t.short.toLowerCase() === s.toLowerCase())) {
      this.showToast(`A tag "${s}" already exists`);
      return null;
    }
    const def: TagDef = { id: uid(), short: s, full: full.trim().slice(0, 80), bg: pair.bg, fg: pair.fg };
    this.settings.update((cur) => ({ ...cur, tags: [...(cur.tags ?? []), def] }));
    return def;
  }

  renameTag(id: string, short: string, full: string): void {
    this.settings.update((cur) => ({
      ...cur,
      tags: (cur.tags ?? []).map((t) =>
        t.id === id ? { ...t, short: short.trim().slice(0, 8) || t.short, full: full.trim().slice(0, 80) } : t,
      ),
    }));
  }

  setTagColor(id: string, bg: string, fg: string): void {
    this.settings.update((cur) => ({
      ...cur,
      tags: (cur.tags ?? []).map((t) => (t.id === id ? { ...t, bg, fg } : t)),
    }));
  }

  /** Toggle a tag on a project in the selected quarter (both hosts re-render). */
  toggleProjectTag(projectId: string, tagId: string): void {
    const toggle = (tags: string[] | undefined): string[] => {
      const cur = tags ?? [];
      return cur.includes(tagId) ? cur.filter((t) => t !== tagId) : [...cur, tagId];
    };
    this.projects.update((ps) =>
      ps.map((p) => (p.id === projectId ? { ...p, tags: toggle(p.tags) } : p)),
    );
    // Defensive: keep stashed quarters in sync too.
    for (const plan of Object.values(this.plans)) {
      plan.projects = plan.projects.map((p) =>
        p.id === projectId ? { ...p, tags: toggle(p.tags) } : p,
      );
    }
  }

  /** Delete a tag definition and strip it from every project in every quarter. */
  deleteTag(id: string): void {
    this.settings.update((cur) => ({
      ...cur,
      tags: (cur.tags ?? []).filter((t) => t.id !== id),
    }));
    const strip = (p: Project): Project =>
      p.tags?.includes(id) ? { ...p, tags: p.tags.filter((t) => t !== id) } : p;
    this.projects.update((ps) => ps.map(strip));
    for (const plan of Object.values(this.plans)) {
      plan.projects = plan.projects.map(strip);
    }
  }

  /** Reorder quarters so the chosen start quarter comes first (dates chain from it). */
  private rotateQuartersIfNeeded(startQuarter: QuarterId): void {
    const quarters = this.quarters();
    const idx = quarters.findIndex((q) => q.id === startQuarter);
    if (idx <= 0) return;
    const rotated = quarters.slice(idx).concat(quarters.slice(0, idx));
    this.quarters.set(rotated);
    this.selectQuarter(rotated[0].id);
  }

  /** Short "5 Jan" label for a sprint's start (empty when dates are off). */
  sprintDate(quarterIdx: number, sprintIdx: number): string {
    const start = this.quarterStartDates()[quarterIdx];
    if (!start) return '';
    const d = new Date(start);
    d.setDate(d.getDate() + sprintIdx * this.settings().sprintLengthWeeks * 7);
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  /** "5 Jan – 27 Mar" range for a quarter (empty when no start date). */
  quarterDateRange(quarterIdx: number): string {
    const starts = this.quarterStartDates();
    const start = starts[quarterIdx];
    const q = this.quarters()[quarterIdx];
    if (!start || !q) return '';
    // Derive the end from the NEXT quarter's start so the display matches the
    // chaining mode: 'same' shares the boundary date, 'next' ends the day before.
    const nextStart = starts[quarterIdx + 1];
    const end = new Date(nextStart ?? start);
    if (!nextStart) {
      // No following quarter: fall back to the raw calendar end.
      end.setDate(end.getDate() + q.sprints * this.settings().sprintLengthWeeks * 7 - 1);
    } else if (this.settings().quarterChainMode !== 'same') {
      end.setDate(end.getDate() - 1);
    }
    const fmt = (d: Date) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    return `${fmt(start)} – ${fmt(end)}`;
  }

  // ---------- Teams ----------

  addTeam(name: string): void {
    const team: Team = {
      id: uid(),
      name: name.trim() || `Team ${this.teams().length + 1}`,
      color: TEAM_PALETTE[this.teams().length % TEAM_PALETTE.length],
      engineers: [],
    };
    this.teams.update((teams) => [...teams, team]);
  }

  renameTeam(teamId: string, name: string): void {
    const n = name.trim();
    if (!n) return;
    this.teams.update((teams) =>
      teams.map((t) => (t.id === teamId ? { ...t, name: n } : t)),
    );
  }

  setTeamColor(teamId: string, color: string): void {
    this.teams.update((teams) =>
      teams.map((t) => (t.id === teamId ? { ...t, color } : t)),
    );
  }

  removeTeam(teamId: string): void {
    this.teams.update((teams) => teams.filter((t) => t.id !== teamId));
    this.capacity.update((c) => {
      const next = { ...c };
      delete next[teamId];
      return next;
    });
    this.boardLayout.update((l) => {
      const positions = { ...l.positions };
      delete positions[teamId];
      return { ...l, positions };
    });
    this.projects.update((projects) =>
      projects.map((s) => ({
        ...s,
        accountableTeamId:
          s.accountableTeamId === teamId ? null : s.accountableTeamId,
        slots: s.slots.map((slot) =>
          slot.teamId === teamId ? { ...slot, teamId: null } : slot,
        ),
      })),
    );
    this.showToast('Team removed');
  }

  team(teamId: string | null | undefined): Team | undefined {
    return this.teams().find((t) => t.id === teamId);
  }

  // ---------- Board layout ----------

  /** Stored top-left of a team's lane, or null when unplaced (auto-stacked). */
  lanePos(teamId: string): { x: number; y: number } | null {
    return this.boardLayout().positions[teamId] ?? null;
  }

  /** Snap a lane's top-left to the 20px grid and persist it. */
  setLanePosition(teamId: string, pos: { x: number; y: number }): void {
    const snapped = {
      x: Math.round(pos.x / 20) * 20,
      y: Math.round(pos.y / 20) * 20,
    };
    this.boardLayout.update((l) => ({
      ...l,
      positions: { ...l.positions, [teamId]: snapped },
    }));
  }

  /** Set the canvas viewport (zoom clamped 0.25–2, pan finite). */
  setViewport(zoom: number, panX: number, panY: number): void {
    this.boardLayout.update((l) => ({
      ...l,
      zoom: Math.max(0.25, Math.min(2, zoom)),
      panX: Number.isFinite(panX) ? panX : 0,
      panY: Number.isFinite(panY) ? panY : 0,
    }));
  }

  /** Reset lane positions and viewport to defaults. */
  resetLayout(): void {
    this.boardLayout.set(structuredClone(DEFAULT_BOARD_LAYOUT));
  }

  /** Bulk-import teams with their engineers (from JSON/CSV file). Returns teams added. */
  importTeams(
    teams: { name: string; engineers: { name: string; grade?: Grade }[] }[],
  ): number {
    let count = 0;
    for (const t of teams) {
      const name = t.name?.trim();
      if (!name) continue;
      const team: Team = {
        id: uid(),
        name,
        color: TEAM_PALETTE[this.teams().length % TEAM_PALETTE.length],
        engineers: (t.engineers ?? [])
          .filter((e) => e.name?.trim())
          .map((e) => ({
            id: uid(),
            name: e.name.trim(),
            grade: e.grade ?? 'G4',
          })),
      };
      this.teams.update((ts) => [...ts, team]);
      count++;
    }
    return count;
  }

  // ---------- Engineers ----------

  addEngineer(teamId: string, name: string, grade: Grade = 'G4'): void {
    const n = name.trim();
    if (!n) return;
    const engineer: Engineer = { id: uid(), name: n, grade };
    this.teams.update((teams) =>
      teams.map((t) =>
        t.id === teamId ? { ...t, engineers: [...t.engineers, engineer] } : t,
      ),
    );
  }

  importEngineers(teamId: string, text: string): number {
    let count = 0;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      // Supports "Name : G5", "Name, G5", "Name G5" or just "Name"
      const m = line.match(/^(.*?)[\s:,-]+(G[3-6])$/i);
      const name = (m ? m[1] : line).trim();
      const grade = m ? (m[2].toUpperCase() as Grade) : 'G4';
      if (name) {
        this.addEngineer(teamId, name, grade);
        count++;
      }
    }
    return count;
  }

  setEngineerGrade(teamId: string, engineerId: string, grade: Grade): void {
    this.teams.update((teams) =>
      teams.map((t) =>
        t.id === teamId
          ? {
              ...t,
              engineers: t.engineers.map((e) =>
                e.id === engineerId ? { ...e, grade } : e,
              ),
            }
          : t,
      ),
    );
    // Clear assignments on slots that no longer accept this engineer's grade
    for (const project of this.projects()) {
      for (const slot of project.slots) {
        if (this.assignments()[slot.id]?.engineerId !== engineerId) continue;
        if (slot.minGrade && GRADE_RANK[grade] < GRADE_RANK[slot.minGrade]) {
          this.unassignSlot(slot.id);
          this.showToast(`Grade change unassigned ${this.engineerById(engineerId)?.name} from "${project.name}"`);
        }
      }
    }
  }

  removeEngineer(teamId: string, engineerId: string): void {
    this.teams.update((teams) =>
      teams.map((t) =>
        t.id === teamId
          ? { ...t, engineers: t.engineers.filter((e) => e.id !== engineerId) }
          : t,
      ),
    );
    this.capacity.update((c) => {
      const members = c[teamId];
      if (!members) return c;
      return { ...c, [teamId]: members.filter((m) => m.engineerId !== engineerId) };
    });
    this.assignments.update((a) => {
      const next = { ...a };
      for (const [slotId, alloc] of Object.entries(next)) {
        if (alloc.engineerId === engineerId) delete next[slotId];
      }
      return next;
    });
  }

  engineerById(engineerId: string): Engineer | undefined {
    for (const t of this.teams()) {
      const e = t.engineers.find((eng) => eng.id === engineerId);
      if (e) return e;
    }
    return undefined;
  }

  homeTeamOfEngineer(engineerId: string): Team | undefined {
    return this.teams().find((t) => t.engineers.some((e) => e.id === engineerId));
  }

  // ---------- Quarter capacity ----------

  membersOf(teamId: string): CapacityMember[] {
    return this.capacity()[teamId] ?? [];
  }

  /** Sprints the engineer is available for this quarter (0 when not in capacity). */
  availSprintsOf(teamId: string, engineerId: string): number {
    const member = this.membersOf(teamId).find((m) => m.engineerId === engineerId);
    return member ? this.selectedQuarter().sprints - member.unavailable.length : 0;
  }

  /** 0-based indices of sprints the engineer is unavailable for (empty when not in capacity). */
  unavailableOf(teamId: string, engineerId: string): number[] {
    return (
      this.membersOf(teamId).find((m) => m.engineerId === engineerId)?.unavailable ??
      []
    );
  }

  /** True when the engineer is unavailable for the given 0-based sprint index. */
  isSprintOff(teamId: string, engineerId: string, index: number): boolean {
    return this.unavailableOf(teamId, engineerId).includes(index);
  }

  isInCapacity(engineerId: string): boolean {
    return Object.values(this.capacity()).some((members) =>
      members.some((m) => m.engineerId === engineerId),
    );
  }

  toggleCapacity(teamId: string, engineerId: string): void {
    const members = this.membersOf(teamId);
    if (members.some((m) => m.engineerId === engineerId)) {
      // Remove from capacity and clear their assignments
      this.capacity.update((c) => ({
        ...c,
        [teamId]: c[teamId].filter((m) => m.engineerId !== engineerId),
      }));
      this.assignments.update((a) => {
        const next = { ...a };
        for (const [slotId, alloc] of Object.entries(next)) {
          if (alloc.engineerId === engineerId) delete next[slotId];
        }
        return next;
      });
    } else {
      const member: CapacityMember = {
        engineerId,
        unavailable: [],
      };
      this.capacity.update((c) => ({
        ...c,
        [teamId]: [...(c[teamId] ?? []), member],
      }));
    }
  }

  /** Add every engineer of a team to the current quarter (skips those already in capacity). */
  addAllToQuarter(teamId: string): void {
    const team = this.team(teamId);
    if (!team) return;
    const existing = new Set(this.membersOf(teamId).map((m) => m.engineerId));
    const additions = team.engineers
      .filter((e) => !existing.has(e.id))
      .map<CapacityMember>((e) => ({
        engineerId: e.id,
        unavailable: [],
      }));
    if (!additions.length) {
      this.showToast('Whole team is already in this quarter');
      return;
    }
    this.capacity.update((c) => ({
      ...c,
      [teamId]: [...(c[teamId] ?? []), ...additions],
    }));
    this.showToast(
      `Added ${additions.length} engineer${additions.length === 1 ? '' : 's'} to ${team.name}`,
    );
  }

  /**
   * Toggle a single sprint's availability (0-based index). Allocations that
   * land on newly-off sprints are left in place — the lane flags them as
   * conflicts instead of silently moving them.
   */
  toggleSprint(teamId: string, engineerId: string, index: number): void {
    const quarter = this.selectedQuarter().sprints;
    if (index < 0 || index >= quarter) return;
    this.capacity.update((c) => ({
      ...c,
      [teamId]: (c[teamId] ?? []).map((m) => {
        if (m.engineerId !== engineerId) return m;
        const off = m.unavailable.includes(index);
        const unavailable = off
          ? m.unavailable.filter((i) => i !== index)
          : [...m.unavailable, index].sort((a, b) => a - b);
        return { ...m, unavailable };
      }),
    }));
  }

  /**
   * After availability shrinks (or the quarter shortens), keep each of the
   * engineer's allocations that still fits where it is; re-place the rest at
   * their first still-valid window; unassign + toast when nothing fits.
   */
  private replaceOrUnassign(engineerId: string): void {
    const engineer = this.engineerById(engineerId);
    const quarter = this.selectedQuarter().sprints;
    for (const alloc of this.allocationsOf(engineerId)) {
      const taken = this.allocationsOf(engineerId).filter(
        (a) => a.slotId !== alloc.slotId,
      );
      const fitsAt = (s: number) =>
        s >= 0 &&
        s + alloc.sprints <= quarter &&
        !taken.some((a) => s < a.start + a.sprints && a.start < s + alloc.sprints);
      if (fitsAt(alloc.start)) continue; // placement still valid — leave it be
      const start = this.firstFreeStart(engineerId, alloc.sprints, alloc.slotId);
      if (start !== null) {
        this.assignments.update((a) => ({
          ...a,
          [alloc.slotId]: { engineerId, start, sprints: alloc.sprints },
        }));
      } else {
        this.unassignSlot(alloc.slotId);
        this.showToast(
          `${engineer?.name ?? 'Engineer'} has no free window of ${alloc.sprints} consecutive sprints — unassigned`,
        );
      }
    }
  }

  // ---------- Projects ----------

  private colorCursor = 0;

  private nextColor(): string {
    return COLOR_PALETTE[this.colorCursor++ % COLOR_PALETTE.length];
  }

  addProject(name: string): void {
    const project: Project = {
      id: uid(),
      name: name.trim() || `Project ${this.projects().length + 1}`,
      size: null,
      sprints: null,
      accountableTeamId: null,
      onlyAccountableTeam: false,
      slots: [],
      onBoard: false,
      color: this.nextColor(),
    };
    this.projects.update((projects) => [...projects, project]);
  }

  /** Bulk-import projects with title + t-shirt size. Returns projects added. */
  importProjects(projects: { name: string; size: SizeId | null }[]): number {
    let count = 0;
    for (const s of projects) {
      const name = s.name?.trim();
      if (!name) continue;
      const id = uid();
      const spec = sizeSpec(s.size, this.sizes());
      const slots: Slot[] = spec
        ? Array.from({ length: spec.engineers }, (_, i) => ({
            id: `${id}:${i + 1}`,
            teamId: null,
            minGrade: null,
            tl: false,
          }))
        : [];
      this.projects.update((list) => [
        ...list,
        {
          id,
          name,
          size: s.size,
          sprints: spec?.sprints ?? null,
          accountableTeamId: null,
          onlyAccountableTeam: false,
          slots,
          onBoard: false,
          color: this.nextColor(),
        },
      ]);
      count++;
    }
    return count;
  }

  renameProject(projectId: string, name: string): void {
    const n = name.trim();
    if (!n) return;
    this.projects.update((projects) =>
      projects.map((s) => (s.id === projectId ? { ...s, name: n } : s)),
    );
  }

  setProjectColor(projectId: string, color: string): void {
    this.projects.update((projects) =>
      projects.map((s) => (s.id === projectId ? { ...s, color } : s)),
    );
  }

  removeProject(projectId: string): void {
    this.projects.update((projects) => projects.filter((s) => s.id !== projectId));
    this.assignments.update((a) => {
      const next = { ...a };
      for (const slotId of Object.keys(next)) {
        if (slotId.startsWith(projectId + ':')) delete next[slotId];
      }
      return next;
    });
  }

  /** Keep slot ids stable as "<projectId>:<n>" so assignments survive size changes. */
  setSize(projectId: string, size: SizeId | null): void {
    const spec = sizeSpec(size, this.sizes());
    const count = spec ? spec.engineers : 0;
    const current = this.projects().find((s) => s.id === projectId);
    if (current) {
      const removed = current.slots.slice(count);
      if (removed.length) {
        this.assignments.update((a) => {
          const next = { ...a };
          for (const slot of removed) delete next[slot.id];
          return next;
        });
      }
    }
    this.projects.update((projects) =>
      projects.map((s) => {
        if (s.id !== projectId) return s;
        const old = s.slots;
        const slots: Slot[] = Array.from({ length: count }, (_, i) =>
          old[i] ? old[i] : { id: `${projectId}:${i + 1}`, teamId: null, minGrade: null, tl: false },
        );
        return { ...s, size, sprints: spec?.sprints ?? null, slots };
      }),
    );
    // Reset any custom per-slot durations — the preset is authoritative again.
    if (spec) this.resetSlotDurations(projectId);
  }

  /** Change the engineer count (slots); the t-shirt size follows the new total. */
  setProjectEngineers(projectId: string, count: number): void {
    const project = this.projects().find((s) => s.id === projectId);
    if (!project) return;
    const n = Math.max(1, Math.min(12, Math.round(count)));
    if (n === project.slots.length) return;
    if (n < project.slots.length) {
      const removed = project.slots.slice(n);
      this.assignments.update((a) => {
        const next = { ...a };
        for (const slot of removed) delete next[slot.id];
        return next;
      });
    }
    this.projects.update((projects) =>
      projects.map((s) => {
        if (s.id !== projectId) return s;
        const slots: Slot[] = Array.from({ length: n }, (_, i) =>
          s.slots[i]
            ? s.slots[i]
            : {
                id: `${projectId}:${i + 1}`,
                // Only-mode: new seats default to the accountable team
                teamId: s.onlyAccountableTeam ? this.effectiveAccountableTeamId(s) : null,
                minGrade: null,
                tl: false,
              },
        );
        return { ...s, size: sizeForTotal(n * (s.sprints ?? sizeSpec(s.size, this.sizes())?.sprints ?? 0), this.sizes()), slots };
      }),
    );
  }

  /** Change the sprint duration per engineer; re-places filled slots at the new length. */
  setProjectSprints(projectId: string, sprints: number): void {
    const project = this.projects().find((s) => s.id === projectId);
    if (!project) return;
    const n = Math.max(1, Math.min(this.selectedQuarter().sprints, Math.round(sprints)));
    if (n === (project.sprints ?? sizeSpec(project.size, this.sizes())?.sprints)) return;
    this.projects.update((projects) =>
      projects.map((s) =>
        s.id === projectId
          ? { ...s, sprints: n, size: sizeForTotal(s.slots.length * n, this.sizes()) }
          : s,
      ),
    );
    // Durations changed: drop custom lengths and re-place each filled slot.
    this.resetSlotDurations(projectId);
    for (const slot of project.slots) {
      const alloc = this.assignments()[slot.id];
      if (!alloc) continue;
      const start = this.firstFreeStart(alloc.engineerId, n, slot.id);
      if (start === null) {
        this.unassignSlot(slot.id);
        this.showToast(
          `${this.engineerById(alloc.engineerId)?.name ?? 'Engineer'} has no free window of ${n} consecutive sprints — unassigned`,
        );
      } else if (start !== alloc.start) {
        this.assignments.update((a) => ({ ...a, [slot.id]: { engineerId: alloc.engineerId, start } }));
      }
    }
  }

  /** Drop custom per-slot durations so they follow the project's sprint count again. */
  private resetSlotDurations(projectId: string): void {
    this.assignments.update((a) => {
      const next = { ...a };
      let changed = false;
      for (const [slotId, alloc] of Object.entries(next)) {
        if (slotId.startsWith(projectId + ':') && alloc.sprints !== undefined) {
          const { sprints: _drop, ...rest } = alloc;
          next[slotId] = rest;
          changed = true;
        }
      }
      return changed ? next : a;
    });
  }

  setSlotTeam(projectId: string, slotIndex: number, teamId: string | null): void {
    this.projects.update((projects) =>
      projects.map((s) =>
        s.id === projectId
          ? {
              ...s,
              slots: s.slots.map((slot, i) =>
                i === slotIndex ? { ...slot, teamId } : slot,
              ),
            }
          : s,
      ),
    );
    // clear assignment if slot's team changed
    const project = this.projects().find((s) => s.id === projectId);
    const slot = project?.slots[slotIndex];
    if (slot) this.clearAssignmentForSlot(slot.id, teamId);
  }

  /** Set the minimum acceptable grade for a slot; null = any grade. */
  setSlotMinGrade(projectId: string, slotIndex: number, minGrade: Grade | null): void {
    this.projects.update((projects) =>
      projects.map((s) =>
        s.id !== projectId
          ? s
          : {
              ...s,
              slots: s.slots.map((slot, i) =>
                i !== slotIndex ? slot : { ...slot, minGrade },
              ),
            },
      ),
    );
    // Clear assignment if the assigned engineer no longer qualifies
    const slot = this.projects().find((s) => s.id === projectId)?.slots[slotIndex];
    const engId = slot ? this.assignments()[slot.id]?.engineerId : undefined;
    const eng = engId ? this.engineerById(engId) : undefined;
    if (slot && eng && slot.minGrade && GRADE_RANK[eng.grade] < GRADE_RANK[slot.minGrade]) {
      this.unassignSlot(slot.id);
      this.showToast(`${eng.name} (${eng.grade}) no longer fits this seat — unassigned`);
    }
  }

  /** Toggle the team-lead seat (by slot id); at most one slot per project. */
  toggleSlotTL(slotId: string): void {
    this.projects.update((projects) =>
      projects.map((s) => {
        const idx = s.slots.findIndex((sl) => sl.id === slotId);
        if (idx < 0) return s;
        const turningOn = !s.slots[idx]?.tl;
        return {
          ...s,
          slots: s.slots.map((slot, i) =>
            i === idx ? { ...slot, tl: turningOn } : turningOn ? { ...slot, tl: false } : slot,
          ),
        };
      }),
    );
  }

  private clearAssignmentForSlot(slotId: string, teamId: string | null): void {
    const engId = this.assignments()[slotId]?.engineerId;
    if (!engId) return;
    const home = this.homeTeamOfEngineer(engId);
    if (!teamId || home?.id !== teamId) {
      this.assignments.update((a) => {
        const next = { ...a };
        delete next[slotId];
        return next;
      });
      this.clearTLForSlot(slotId);
    }
  }

  setAccountableTeam(projectId: string, teamId: string | null): void {
    this.projects.update((projects) =>
      projects.map((s) => (s.id === projectId ? { ...s, accountableTeamId: teamId } : s)),
    );
  }

  /**
   * Point every slot at one team, dropping assignments held by engineers from
   * other teams (target-team engineers keep their seats).
   */
  retargetSlotsTo(projectId: string, teamId: string): void {
    const project = this.projects().find((s) => s.id === projectId);
    if (!project) return;
    this.projects.update((projects) =>
      projects.map((s) =>
        s.id === projectId
          ? { ...s, slots: s.slots.map((slot) => ({ ...slot, teamId })) }
          : s,
      ),
    );
    for (const slot of project.slots) this.clearAssignmentForSlot(slot.id, teamId);
  }

  /**
   * Toggle "Only" sourcing: on = every slot sources engineers from the
   * accountable team; off = slots keep their current teams.
   */
  setOnlyAccountableTeam(projectId: string, teamId: string | null): void {
    this.projects.update((projects) =>
      projects.map((s) =>
        s.id === projectId ? { ...s, onlyAccountableTeam: !!teamId } : s,
      ),
    );
    if (teamId) this.retargetSlotsTo(projectId, teamId);
  }

  /**
   * Accountable team actually in effect: the explicit choice, or by default
   * the team with the largest number of engineer slots on this project.
   */
  effectiveAccountableTeamId(project: Project): string | null {
    if (project.accountableTeamId) return project.accountableTeamId;
    let best: string | null = null;
    let bestCount = 0;
    const counts = new Map<string, number>();
    for (const slot of project.slots) {
      if (!slot.teamId) continue;
      const count = (counts.get(slot.teamId) ?? 0) + 1;
      counts.set(slot.teamId, count);
      if (count > bestCount) {
        best = slot.teamId;
        bestCount = count;
      }
    }
    return best;
  }

  /** Project is ready for the board when sized and every slot mapped to a team. */
  canAddToBoard(project: Project): boolean {
    return (
      !!project.size &&
      project.slots.length > 0 &&
      project.slots.every((slot) => !!slot.teamId)
    );
  }

  addToBoard(projectId: string): void {
    const project = this.projects().find((s) => s.id === projectId);
    if (!project || !this.canAddToBoard(project)) {
      this.showToast('Pick a size and a team for every engineer first');
      return;
    }
    if (project.onBoard) {
      this.showToast(`"${project.name}" is already on the board`);
      return;
    }
    this.projects.update((projects) =>
      projects.map((s) => (s.id === projectId ? { ...s, onBoard: true } : s)),
    );
    this.showToast(`"${project.name}" added to the board`);
  }

  removeFromBoard(projectId: string): void {
    const project = this.projects().find((s) => s.id === projectId);
    if (!project) return;
    this.projects.update((projects) =>
      projects.map((s) => (s.id === projectId ? { ...s, onBoard: false } : s)),
    );
    this.assignments.update((a) => {
      const next = { ...a };
      for (const slot of project.slots) delete next[slot.id];
      return next;
    });
  }

  /** Work items for a team lane: on-board projects that have at least one slot from that team. */
  workItemsFor(teamId: string): WorkItem[] {
    const assignments = this.assignments();
    return this.projects()
      .filter((s) => s.onBoard && s.slots.some((slot) => slot.teamId === teamId))
      .map((project) => ({
        project,
        role:
          this.effectiveAccountableTeamId(project) === teamId
            ? ('owned' as const)
            : ('supporting' as const),
        slots: project.slots
          .filter((slot) => slot.teamId === teamId)
          .map((slot) => {
            const alloc = assignments[slot.id];
            const engineer = alloc
              ? (this.engineerById(alloc.engineerId) ?? null)
              : null;
            return {
              slot,
              engineer,
              start: alloc?.start ?? 0,
              sprints: engineer ? (alloc?.sprints ?? this.slotSprints(project)) : 0,
            };
          }),
      }));
  }

  slotSprints(project: Project): number {
    return project.sprints ?? sizeSpec(project.size, this.sizes())?.sprints ?? 0;
  }

  // ---------- Drag & drop assignment ----------

  /** Engineer currently being dragged, for live drop-zone feedback. */
  readonly drag = signal<{ engineerId: string } | null>(null);

  dragStarted(engineerId: string): void {
    this.drag.set({ engineerId });
  }

  dragEnded(): void {
    this.drag.set(null);
  }

  /** All sprint windows an engineer is currently allocated to (colored by project color). */
  allocationsOf(engineerId: string): Allocation[] {
    const out: Allocation[] = [];
    for (const project of this.projects()) {
      for (const slot of project.slots) {
        const alloc = this.assignments()[slot.id];
        if (alloc?.engineerId !== engineerId) continue;
        out.push({
          slotId: slot.id,
          projectId: project.id,
          projectName: project.name,
          start: alloc.start,
          sprints: alloc.sprints ?? this.slotSprints(project),
          color: project.color || '#94a3b8',
        });
      }
    }
    return out;
  }

  /**
   * Earliest start where [start, start+duration) fits without overlapping the
   * engineer's other allocations, or null. Prefers windows that avoid their
   * off sprints entirely; falls back to any clear window (off sprints become
   * flagged conflicts) so a contiguous bar can still be placed.
   */
  firstFreeStart(
    engineerId: string,
    duration: number,
    ignoreSlotId?: string,
  ): number | null {
    const home = this.homeTeamOfEngineer(engineerId);
    if (!home) return null;
    const quarter = this.selectedQuarter().sprints;
    const off = new Set(this.unavailableOf(home.id, engineerId));
    const taken = this.allocationsOf(engineerId).filter((a) => a.slotId !== ignoreSlotId);
    const windowClear = (s: number): boolean =>
      !taken.some((a) => s < a.start + a.sprints && a.start < s + duration);
    const windowAvail = (s: number): boolean => {
      for (let i = s; i < s + duration; i++) if (off.has(i)) return false;
      return true;
    };
    for (let start = 0; start <= quarter - duration; start++) {
      if (windowClear(start) && windowAvail(start)) return start;
    }
    for (let start = 0; start <= quarter - duration; start++) {
      if (windowClear(start)) return start;
    }
    return null;
  }

  /** Why the engineer can't take this seat, or null when they can. */
  assignRejectReason(slotId: string, engineerId: string): string | null {
    for (const project of this.projects()) {
      const slot = project.slots.find((sl) => sl.id === slotId);
      if (!slot) continue;
      const home = this.homeTeamOfEngineer(engineerId);
      if (!home) return 'Engineer not found';
      const engineer = this.engineerById(engineerId);
      if (home.id !== slot.teamId) {
        return `${engineer?.name} belongs to ${home.name}, but this seat needs ${this.team(slot.teamId)?.name}`;
      }
      if (slot.minGrade && engineer && GRADE_RANK[engineer.grade] < GRADE_RANK[slot.minGrade]) {
        return `${engineer.name} is ${engineer.grade} — this seat needs ${slot.minGrade}+`;
      }
      const duration = this.slotSprints(project);
      if (this.firstFreeStart(engineerId, duration, slotId) === null) {
        return `${engineer?.name} has no free window of ${duration} consecutive sprints this quarter`;
      }
      return null;
    }
    return 'Seat not found';
  }

  canAssign(slotId: string, engineerId: string): boolean {
    return this.assignRejectReason(slotId, engineerId) === null;
  }

  /** True when a TL seat exists and is filled (used for the "no TL" warning). */
  hasTL(projectId: string): boolean {
    const project = this.projects().find((s) => s.id === projectId);
    if (!project) return false;
    return project.slots.some((slot) => slot.tl && this.assignments()[slot.id]);
  }

  /**
   * Unfilled seats on committed projects this engineer could take right
   * now (home team + grade + free-window rules all pass), for the right-click
   * context menu.
   */
  candidateSeatsFor(
    engineerId: string,
  ): { slotId: string; projectName: string; size: string; grades: string; sprints: number }[] {
    const out: { slotId: string; projectName: string; size: string; grades: string; sprints: number }[] = [];
    for (const project of this.projects()) {
      if (!project.onBoard) continue;
      for (const slot of project.slots) {
        if (this.assignments()[slot.id]) continue;
        if (!this.canAssign(slot.id, engineerId)) continue;
        out.push({
          slotId: slot.id,
          projectName: project.name,
          size: project.size ?? '—',
          grades: slot.minGrade ? `${slot.minGrade}+` : 'Any',
          sprints: this.slotSprints(project),
        });
      }
    }
    return out;
  }

  /**
   * Capacity engineers who could take this seat right now (home team + grade
   * + free-window rules all pass), for the right-click context menu. Excludes
   * the currently assigned engineer in "switch for" mode.
   */
  candidateEngineersFor(
    slotId: string,
    excludeEngineerId?: string,
  ): { engineerId: string; name: string; grade: Grade; teamName: string; freeSprints: number }[] {
    const out: {
      engineerId: string;
      name: string;
      grade: Grade;
      teamName: string;
      freeSprints: number;
    }[] = [];
    for (const team of this.teams()) {
      for (const member of this.membersOf(team.id)) {
        if (member.engineerId === excludeEngineerId) continue;
        if (!this.canAssign(slotId, member.engineerId)) continue;
        const engineer = this.engineerById(member.engineerId);
        if (!engineer) continue;
        const used = this.allocationsOf(member.engineerId).reduce(
          (sum, a) => sum + a.sprints,
          0,
        );
        out.push({
          engineerId: member.engineerId,
          name: engineer.name,
          grade: engineer.grade,
          teamName: team.name,
          freeSprints: Math.max(
            0,
            this.availSprintsOf(team.id, member.engineerId) - used,
          ),
        });
      }
    }
    return out;
  }

  assignToSlot(slotId: string, engineerId: string): boolean {
    const reason = this.assignRejectReason(slotId, engineerId);
    if (reason) {
      this.showToast(reason);
      return false;
    }
    for (const project of this.projects()) {
      const slot = project.slots.find((sl) => sl.id === slotId);
      if (!slot) continue;
      const start = this.firstFreeStart(engineerId, this.slotSprints(project), slotId);
      if (start === null) return false;
      this.assignments.update((a) => ({ ...a, [slotId]: { engineerId, start } }));
      return true;
    }
    return false;
  }

  /**
   * Move and/or resize an allocation (edge drag). Duration defaults to the
   * project's t-shirt size when sprints is omitted; explicit values become the
   * custom duration. No-ops with a toast when the window is invalid.
   */
  setAllocationWindow(slotId: string, newStart: number, newSprints?: number): void {
    const alloc = this.assignments()[slotId];
    if (!alloc) return;
    const project =this.projects().find((s) => s.slots.some((sl) => sl.id === slotId));
    if (!project) return;
    const duration = newSprints ?? alloc.sprints ?? this.slotSprints(project);
    const quarter = this.selectedQuarter().sprints;
    const outOfRange = duration < 1 || newStart < 0 || newStart + duration > quarter;
    if (!outOfRange) {
      const taken = this.allocationsOf(alloc.engineerId).filter((a) => a.slotId !== slotId);
      if (
        taken.some((a) => newStart < a.start + a.sprints && a.start < newStart + duration)
      ) {
        this.showToast('That window is already taken for this engineer');
        return;
      }
    } else {
      this.showToast('That window is outside the quarter');
      return;
    }
    this.assignments.update((a) => ({
      ...a,
      [slotId]: { engineerId: alloc.engineerId, start: newStart, sprints: duration },
    }));
  }

  unassignSlot(slotId: string): void {
    this.assignments.update((a) => {
      const next = { ...a };
      delete next[slotId];
      return next;
    });
    this.clearTLForSlot(slotId);
  }

  /** An emptied seat loses its tech-lead flag — the TL left with the engineer. */
  private clearTLForSlot(slotId: string): void {
    this.projects.update((projects) =>
      projects.map((s) =>
        s.slots.some((sl) => sl.id === slotId && sl.tl)
          ? { ...s, slots: s.slots.map((sl) => (sl.id === slotId ? { ...sl, tl: false } : sl)) }
          : s,
      ),
    );
  }

  // ---------- Quarter ----------

  selectQuarter(quarterId: string): void {
    if (quarterId === this.selectedQuarterId()) return;
    this.plans[this.selectedQuarterId()] = {
      projects: this.projects(),
      capacity: this.capacity(),
      assignments: this.assignments(),
    };
    const next = this.plans[quarterId] ?? {
      projects: [],
      capacity: {},
      assignments: {},
    };
    delete this.plans[quarterId];
    this.selectedQuarterId.set(quarterId);
    this.projects.set(next.projects);
    this.capacity.set(next.capacity);
    this.assignments.set(next.assignments);
    this.clampToQuarter();
  }

  setQuarterSprints(quarterId: string, sprints: number): void {
    this.quarters.update((qs) =>
      qs.map((q) => (q.id === quarterId ? { ...q, sprints } : q)),
    );
    if (quarterId === this.selectedQuarterId()) this.clampToQuarter();
  }

  /** After the quarter shrinks: clamp availability and re-place allocations. */
  private clampToQuarter(): void {
    const quarter = this.selectedQuarter().sprints;
    this.capacity.update((c) => {
      const next: Record<string, CapacityMember[]> = {};
      for (const [teamId, members] of Object.entries(c)) {
        next[teamId] = members.map((m) => ({
          ...m,
          unavailable: [
            ...new Set(m.unavailable.filter((i) => i >= 0 && i < quarter)),
          ].sort((a, b) => a - b),
        }));
      }
      return next;
    });
    const engineerIds = new Set(
      Object.values(this.assignments()).map((a) => a.engineerId),
    );
    for (const engineerId of engineerIds) this.replaceOrUnassign(engineerId);
  }

  // ---------- Import / Export ----------

  /** Plain-object snapshot of all state (export files + localStorage share this). */
  private exportSnapshot() {
    return {
      version: 6,
      exportedAt: new Date().toISOString(),
      selectedQuarterId: this.selectedQuarterId(),
      quarters: this.quarters(),
      teams: this.teams(),
      settings: this.settings(),
      boardLayout: this.boardLayout(),
      ui: {
        projectsExpanded: this.projectsExpanded(),
        onCallExpanded: this.onCallExpanded(),
        projectsCompact: this.projectsCompact(),
      },
      plans: {
        ...this.plans,
        [this.selectedQuarterId()]: {
          projects: this.projects(),
          capacity: this.capacity(),
          assignments: this.assignments(),
        },
      },
    };
  }

  /** Full snapshot of every quarter's plan for saving to disk. */
  exportData(): string {
    return JSON.stringify(this.exportSnapshot(), null, 2);
  }

  /** Wipe the plan and start a fresh board (settings are kept). */
  newBoard(): void {
    this.teams.set([]);
    this.projects.set([]);
    this.capacity.set({});
    this.assignments.set({});
    this.quarters.set([
      { id: 'Q1', label: 'Q1', sprints: 6 },
      { id: 'Q2', label: 'Q2', sprints: 5 },
      { id: 'Q3', label: 'Q3', sprints: 5 },
      { id: 'Q4', label: 'Q4', sprints: 6 },
    ]);
    this.selectedQuarterId.set('Q1');
    this.boardLayout.set(structuredClone(DEFAULT_BOARD_LAYOUT));
    this.showToast('New board started');
  }

  /** Replace all state from a previously exported JSON string. */
  importData(json: string): void {
    let data: unknown;
    try {
      data = JSON.parse(json);
    } catch {
      this.showToast('Import failed — not valid JSON');
      return;
    }
    if (!this.applyData(data)) {
      this.showToast('Import failed — unrecognized file format');
      return;
    }
    const d = data as {
      teams: Team[];
      plans?: Record<string, { projects?: Project[]; subInitiatives?: Project[] }>;
    };
    const totalProjects = Object.values(d.plans ?? {}).reduce(
      (sum, p) => sum + ((p.projects ?? p.subInitiatives)?.length ?? 0),
      0,
    );
    const quarterCount = Object.keys(d.plans ?? {}).length;
    this.showToast(
      `Imported ${d.teams.length} teams · ${totalProjects} projects across ${quarterCount} quarter${quarterCount === 1 ? '' : 's'}`,
    );
  }

  /**
   * Validate + install a snapshot (v1 flat, v2 per-quarter, v3 with settings,
   * v4 with board layout, v6 per-sprint availability). Returns false for
   * unrecognized shapes. Shared by file import and localStorage load.
   */
  private applyData(input: unknown): boolean {
    if (!input || typeof input !== 'object') return false;
    const data = input as {
      version?: number;
      selectedQuarterId?: string;
      quarters?: Quarter[];
      teams?: Team[];
      settings?: Partial<Settings>;
      boardLayout?: BoardLayout;
      ui?: { projectsExpanded?: boolean; onCallExpanded?: boolean; projectsCompact?: boolean };
      plans?: Record<
        string,
        {
          projects?: Project[];
          subInitiatives?: Project[];
          capacity?: Record<string, CapacityMember[]>;
          assignments?: Record<
            string,
            { engineerId: string; start: number; sprints?: number }
          >;
        }
      >;
      // v1 flat layout (single shared plan)
      subInitiatives?: Project[];
      capacity?: Record<string, CapacityMember[]>;
      assignments?: Record<
        string,
        { engineerId: string; start: number; sprints?: number }
      >;
    };
    if (
      (data.version !== 1 &&
        data.version !== 2 &&
        data.version !== 3 &&
        data.version !== 4 &&
        data.version !== 5 &&
        data.version !== 6) ||
      !Array.isArray(data.quarters) ||
      !data.quarters.length ||
      !Array.isArray(data.teams)
    ) {
      return false;
    }

    // Board layout: clamp zoom, keep finite pan, drop positions for unknown
    // teams. v1–3 snapshots have no layout — fall back to defaults (auto-place).
    const layoutIn = data.boardLayout ?? DEFAULT_BOARD_LAYOUT;
    const teamIds = new Set(data.teams.map((t: Team) => t.id));
    this.boardLayout.set({
      zoom: Math.max(
        0.25,
        Math.min(2, Number.isFinite(layoutIn.zoom) ? layoutIn.zoom : 1),
      ),
      panX: Number.isFinite(layoutIn.panX) ? layoutIn.panX : 0,
      panY: Number.isFinite(layoutIn.panY) ? layoutIn.panY : 0,
      positions: Object.fromEntries(
        Object.entries(layoutIn.positions ?? {}).filter(
          ([id, p]) =>
            teamIds.has(id) && !!p && Number.isFinite(p.x) && Number.isFinite(p.y),
        ),
      ),
    });

    const engineerIds = new Set(
      data.teams.flatMap((t) => t.engineers.map((e) => e.id)),
    );
    const sanitizeAssignments = (
      projects: Project[],
      assignments: Record<
        string,
        { engineerId: string; start: number; sprints?: number }
      >,
    ): Record<string, { engineerId: string; start: number; sprints?: number }> => {
      const slotIds = new Set(projects.flatMap((s) => s.slots.map((slot) => slot.id)));
      const clean: Record<
        string,
        { engineerId: string; start: number; sprints?: number }
      > = {};
      for (const [slotId, a] of Object.entries(assignments)) {
        if (slotIds.has(slotId) && a && engineerIds.has(a.engineerId)) {
          clean[slotId] = a;
        }
      }
      return clean;
    };

    // v1 files hold one flat plan — land it in the quarter it was saved on.
    const quarterPlans =
      data.version === 1
        ? {
            [data.selectedQuarterId ?? data.quarters[0].id]: {
              subInitiatives: data.subInitiatives ?? [],
              capacity: data.capacity ?? {},
              assignments: data.assignments ?? {},
            },
          }
        : data.plans ?? {};

    // v1/v2 files predate project colors — backfill from the shared palette.
    let colorCursor = 0;
    const withColor = (s: Project): Project => ({
      ...s,
      color: s.color || COLOR_PALETTE[colorCursor++ % COLOR_PALETTE.length],
    });

    // Tag ids known after sanitizeTags runs in saveSettings — strip orphans on
    // import so deleted defs can't linger on projects.
    const tagIds = new Set(
      sanitizeTags(
        (data.settings as Partial<Settings> | undefined)?.tags ?? DEFAULT_SETTINGS.tags,
      ).map((t) => t.id),
    );
    const withTags = (s: Project): Project => ({
      ...s,
      tags: [...new Set((s.tags ?? []).filter((t) => tagIds.has(t)))],
    });

    // v5 and earlier stored a prefix (`sprints: N` = available sprints 1..N);
    // v6 stores explicit 0-based off indices. Migrate per quarter — each has
    // its own sprint count.
    const quarterSprints = new Map(
      data.quarters.map((q: Quarter) => [q.id, q.sprints]),
    );
    const migrateCapacity = (
      quarterId: string,
      capacity: Record<string, { engineerId: string; unavailable?: number[]; sprints?: number }[]>,
    ): Record<string, CapacityMember[]> => {
      const quarter = quarterSprints.get(quarterId) ?? 0;
      const migrate = (m: {
        engineerId: string;
        unavailable?: number[];
        sprints?: number;
      }): CapacityMember => {
        if (Array.isArray(m.unavailable)) {
          return {
            engineerId: m.engineerId,
            unavailable: [
              ...new Set(
                m.unavailable.filter((i) => Number.isInteger(i) && i >= 0 && i < quarter),
              ),
            ].sort((a, b) => a - b),
          };
        }
        // Legacy prefix: available sprints 1..sprints → the tail is off.
        const avail = Math.max(0, Math.min(quarter, Math.round(m.sprints ?? quarter)));
        return {
          engineerId: m.engineerId,
          unavailable: Array.from(
            { length: quarter - avail },
            (_, i) => avail + i,
          ),
        };
      };
      return Object.fromEntries(
        Object.entries(capacity ?? {}).map(([teamId, members]) => [
          teamId,
          (members ?? []).map(migrate),
        ]),
      );
    };

    const plans: Record<
      string,
      {
        projects: Project[];
        capacity: Record<string, CapacityMember[]>;
        assignments: Record<
          string,
          { engineerId: string; start: number; sprints?: number }
        >;
      }
    > = {};
    for (const [quarterId, plan] of Object.entries(quarterPlans)) {
      // v5+ writes `projects`; v1–4 wrote `subInitiatives` — accept both so
      // old export files and localStorage migrate in place.
      const projects = (plan.projects ?? plan.subInitiatives ?? []).map(withColor).map(withTags);
      plans[quarterId] = {
        projects,
        capacity: migrateCapacity(quarterId, plan.capacity ?? {}),
        assignments: sanitizeAssignments(projects, plan.assignments ?? {}),
      };
    }

    const selectedId = data.quarters.some((q) => q.id === data.selectedQuarterId)
      ? data.selectedQuarterId!
      : data.quarters[0].id;
    const selected = plans[selectedId] ?? {
      projects: [],
      capacity: {},
      assignments: {},
    };

    this.teams.set(data.teams);
    this.quarters.set(data.quarters);
    this.plans = plans;
    this.selectedQuarterId.set(selectedId);
    this.projects.set(selected.projects);
    this.capacity.set(selected.capacity);
    this.assignments.set(selected.assignments);
    if (data.settings) this.saveSettings({ ...DEFAULT_SETTINGS, ...data.settings });
    if (data.ui) {
      this.projectsExpanded.set(data.ui.projectsExpanded !== false);
      this.onCallExpanded.set(data.ui.onCallExpanded !== false);
      this.projectsCompact.set(data.ui.projectsCompact === true);
    }
    return true;
  }

  // ---------- Toast ----------

  showToast(message: string): void {
    this.toast.set(message);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.set(null), 3200);
  }
}
