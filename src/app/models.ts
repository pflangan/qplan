export type Grade = 'G3' | 'G4' | 'G5' | 'G6';

export const GRADES: Record<Grade, { label: string; short: string; color: string }> = {
  G3: { label: 'Associate', short: 'G3', color: '#94a3b8' },
  G4: { label: 'Engineer', short: 'G4', color: '#3b82f6' },
  G5: { label: 'Senior', short: 'G5', color: '#8b5cf6' },
  G6: { label: 'Principal', short: 'G6', color: '#f59e0b' },
};

/** Seniority ordering for minimum-grade seat requirements. */
export const GRADE_RANK: Record<Grade, number> = { G3: 0, G4: 1, G5: 2, G6: 3 };

export type SizeId = 'XS' | 'S' | 'M' | 'L' | 'XL';

export interface SizeSpec {
  id: SizeId;
  engineers: number;
  sprints: number;
  color: string;
}

export const SIZE_IDS: SizeId[] = ['XS', 'S', 'M', 'L', 'XL'];

export const DEFAULT_SIZES: SizeSpec[] = [
  { id: 'XS', engineers: 1, sprints: 2, color: '#10b981' },
  { id: 'S', engineers: 2, sprints: 3, color: '#84cc16' },
  { id: 'M', engineers: 3, sprints: 4, color: '#eab308' },
  { id: 'L', engineers: 4, sprints: 4, color: '#f97316' },
  { id: 'XL', engineers: 5, sprints: 5, color: '#ef4444' },
];

export function sizeSpec(id: SizeId | null | undefined, sizes: SizeSpec[] = DEFAULT_SIZES): SizeSpec | undefined {
  return sizes.find((s) => s.id === id);
}

/** Total effort in person-sprints for a size, e.g. M (3×4) = 12. */
export function sizeTotal(id: SizeId, sizes: SizeSpec[] = DEFAULT_SIZES): number {
  const spec = sizeSpec(id, sizes);
  return spec ? spec.engineers * spec.sprints : 0;
}

/**
 * T-shirt size for an arbitrary person-sprint total: the largest size whose
 * total is <= the given one (e.g. 12 → M, 7–11 → S, 26+ → XL). Null when the
 * total is below XS.
 */
export function sizeForTotal(total: number, sizes: SizeSpec[] = DEFAULT_SIZES): SizeId | null {
  let best: SizeId | null = null;
  for (const s of sizes) {
    if (s.engineers * s.sprints <= total) best = s.id;
  }
  return best;
}

/** Shared 40-color picker palette (mid/dark shades only — tints stay readable). */
export const COLOR_PALETTE: string[] = [
  '#7f1d1d', '#991b1b', '#b91c1c', '#dc2626', '#ef4444',
  '#7c2d12', '#9a3412', '#c2410c', '#ea580c', '#f97316',
  '#78350f', '#92400e', '#b45309', '#d97706', '#f59e0b',
  '#14532d', '#166534', '#15803d', '#16a34a', '#22c55e',
  '#134e4a', '#115e59', '#0f766e', '#14b8a6', '#2dd4bf',
  '#1e3a8a', '#1d4ed8', '#2563eb', '#3b82f6', '#60a5fa',
  '#4c1d95', '#5b21b6', '#6d28d9', '#7c3aed', '#8b5cf6',
  '#831843', '#9d174d', '#be185d', '#db2777', '#ec4899',
];

export type QuarterId = 'Q1' | 'Q2' | 'Q3' | 'Q4';

export const QUARTER_IDS: QuarterId[] = ['Q1', 'Q2', 'Q3', 'Q4'];

export interface Settings {
  /** ISO date (yyyy-MM-dd) the first quarter starts on; null = no date labels. */
  quarterStart: string | null;
  /** Quarter planning starts from; the quarter list is ordered with it first. */
  startQuarter: QuarterId;
  /**
   * How a subsequent quarter's start chains from the previous quarter's end:
   * 'same' = same business day (shared boundary date), 'next' = next business day.
   */
  quarterChainMode: 'same' | 'next';
  sprintLengthWeeks: number;
  showDates: boolean;
  sizes: SizeSpec[];
  /** User-pickable background color per grade (drives grade tags app-wide). */
  gradeColors: Record<Grade, string>;
}

export const DEFAULT_SETTINGS: Settings = {
  quarterStart: null,
  startQuarter: 'Q1',
  quarterChainMode: 'same',
  sprintLengthWeeks: 2,
  showDates: true,
  sizes: DEFAULT_SIZES,
  gradeColors: {
    G3: GRADES.G3.color,
    G4: GRADES.G4.color,
    G5: GRADES.G5.color,
    G6: GRADES.G6.color,
  },
};

export interface Engineer {
  id: string;
  name: string;
  grade: Grade;
}

export interface Team {
  id: string;
  name: string;
  color: string;
  engineers: Engineer[];
}

/** An engineer's availability for the selected quarter. */
export interface CapacityMember {
  engineerId: string;
  /** Available from sprint 1 through this count (1..quarter sprints). */
  sprints: number;
}

/** One required engineer seat on a project, sourced from a team. */
export interface Slot {
  id: string;
  teamId: string | null;
  /** Minimum acceptable grade; null = any grade. */
  minGrade: Grade | null;
  /** Team-lead seat; at most one per project. */
  tl: boolean;
}

export interface Project {
  id: string;
  name: string;
  size: SizeId | null;
  /** Explicit sprint duration per engineer; null = use the size spec default. */
  sprints: number | null;
  accountableTeamId: string | null;
  slots: Slot[];
  onBoard: boolean;
  /** Display color, user-pickable; drives work-item and card accents. */
  color: string;
}

export type WorkRole = 'owned' | 'supporting';

export interface WorkItemSlot {
  slot: Slot;
  engineer: Engineer | null;
  /** 0-based sprint index the engineer starts on (only when filled). */
  start: number;
  /** Duration in sprints from the size spec (only when filled). */
  sprints: number;
}

/** A project as rendered under one team's lane. */
export interface WorkItem {
  project: Project;
  role: WorkRole;
  slots: WorkItemSlot[];
}

export interface Quarter {
  id: string;
  label: string;
  sprints: number; // 5–7
}

/** Horizontal scale: one sprint column on the timeline board (micro scale).
 *  Fixed — the canvas board is zoomed/panned instead of shrinking cells. */
export const PX_PER_SPRINT_X = 36;

/** Canvas board layout: free-form lane positions + saved viewport. */
export interface BoardLayout {
  /** teamId → top-left in layout px (pre-zoom space). */
  positions: Record<string, { x: number; y: number }>;
  /** Canvas zoom, clamped 0.25–2. */
  zoom: number;
  /** Pan translate on the pan layer, in viewport px. */
  panX: number;
  panY: number;
}

export const DEFAULT_BOARD_LAYOUT: BoardLayout = {
  positions: {},
  zoom: 1,
  panX: 0,
  panY: 0,
};
