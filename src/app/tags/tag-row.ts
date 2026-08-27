import { Component, ElementRef, HostListener, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CapacityStore } from '../capacity-store.service';
import { TAG_COLOR_PAIRS, TagDef } from '../models';
import { RichTip } from '../rich-tip.directive';

/**
 * Shared tag footer row for project renderings (Projects panel card and
 * Planning Board work item). Chips + a "+" that opens a picker menu with a
 * new-tag mini-form; hovering a chip shows the full name in a tag-tinted
 * rich tooltip with an × to untag.
 */
@Component({
  selector: 'app-tag-row',
  imports: [FormsModule, RichTip],
  templateUrl: './tag-row.html',
  styleUrl: './tag-row.scss',
})
export class TagRow {
  readonly store = inject(CapacityStore);
  readonly projectId = input.required<string>();

  readonly pairs = TAG_COLOR_PAIRS;

  readonly menuOpen = signal(false);
  readonly newShort = signal('');
  readonly newFull = signal('');
  readonly newPair = signal(0);

  /** The popover, hoisted to <body> so it can overflow the panel's clipping scroll container. */
  readonly menu = viewChild<ElementRef<HTMLElement>>('menu');
  private anchor: HTMLElement | null = null;

  constructor() {
    effect(() => {
      const el = this.menu()?.nativeElement;
      if (!el) return;
      document.body.appendChild(el);
      this.place(el);
    });
  }

  readonly project = computed(() =>
    this.store.projects().find((p) => p.id === this.projectId()),
  );

  readonly tags = computed(() =>
    (this.project()?.tags ?? [])
      .map((id) => this.store.tagDef(id))
      .filter((t): t is TagDef => !!t),
  );

  has(tagId: string): boolean {
    return (this.project()?.tags ?? []).includes(tagId);
  }

  toggle(tagId: string): void {
    this.store.toggleProjectTag(this.projectId(), tagId);
  }

  removeTag(event: MouseEvent, tagId: string): void {
    event.stopPropagation();
    event.preventDefault();
    this.store.toggleProjectTag(this.projectId(), tagId);
  }

  toggleMenu(event: MouseEvent): void {
    event.stopPropagation();
    this.anchor = event.target as HTMLElement;
    this.menuOpen.update((v) => !v);
  }

  /**
   * Fixed-position placement above the + button (screen-space rect, so the
   * board canvas needs no zoom compensation). Clamped to the viewport; flips
   * below the anchor when there is no room above.
   */
  private place(menu: HTMLElement): void {
    if (!this.anchor) return;
    const r = this.anchor.getBoundingClientRect();
    const left = Math.min(Math.max(8, r.left), window.innerWidth - menu.offsetWidth - 8);
    const above = r.top - menu.offsetHeight - 4;
    menu.style.left = `${left}px`;
    menu.style.top = `${above < 8 ? r.bottom + 4 : above}px`;
  }

  create(): void {
    const def = this.store.createTag(this.newShort(), this.newFull(), this.pairs[this.newPair()]);
    if (!def) return;
    this.store.toggleProjectTag(this.projectId(), def.id);
    this.newShort.set('');
    this.newFull.set('');
    this.newPair.set(0);
    this.menuOpen.set(false);
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.menuOpen.set(false);
  }

  @HostListener('document:click', ['$event'])
  close(event: MouseEvent): void {
    // The menu lives on <body>, so its own clicks must not count as "outside".
    if (this.menu()?.nativeElement.contains(event.target as Node)) return;
    this.menuOpen.set(false);
  }
}
