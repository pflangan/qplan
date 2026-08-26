import { Component, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CapacityStore } from '../../capacity-store.service';
import { SIZE_IDS, SizeId } from '../../models';
import { RichTip } from '../../rich-tip.directive';
import { ProjectCard } from './project-card';

interface ProjectImport {
  name: string;
  size: SizeId | null;
}

@Component({
  selector: 'app-projects-panel',
  imports: [FormsModule, ProjectCard, RichTip],
  host: { '[class.collapsed]': 'collapsed()' },
  templateUrl: './projects-panel.html',
  styleUrl: './projects-panel.scss',
})
export class ProjectsPanel {
  readonly store = inject(CapacityStore);
  /** Collapsed: full content hidden, a 44px sliver rail renders instead. */
  readonly collapsed = input(false);
  readonly newName = signal('');
  readonly showPaste = signal(false);
  readonly pasteText = signal('');

  add(): void {
    this.store.addProject(this.newName());
    this.newName.set('');
  }

  togglePaste(): void {
    this.showPaste.update((v) => !v);
  }

  importPasted(): void {
    const text = this.pasteText().trim();
    if (!text) return;
    try {
      const projects = text.startsWith('{') || text.startsWith('[')
        ? this.parseJson(text)
        : this.parseText(text);
      const n = this.store.importProjects(projects);
      this.store.showToast(
        n > 0 ? `Imported ${n} project${n > 1 ? 's' : ''}` : 'Nothing to import',
      );
      if (n > 0) {
        this.pasteText.set('');
        this.showPaste.set(false);
      }
    } catch (err) {
      this.store.showToast(`Import failed: ${(err as Error).message}`);
    }
  }

  importFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    file
      .text()
      .then((text) => {
        const projects = file.name.toLowerCase().endsWith('.json')
          ? this.parseJson(text)
          : this.parseText(text);
        const n = this.store.importProjects(projects);
        this.store.showToast(
          n > 0 ? `Imported ${n} project${n > 1 ? 's' : ''} from ${file.name}` : 'Nothing to import',
        );
      })
      .catch((err: Error) => this.store.showToast(`Import failed: ${err.message}`))
      .finally(() => (input.value = ''));
  }

  /** JSON: `[{"name":"Payments","size":"M"}]` or `{"projects":[...]}` */
  private parseJson(text: string): ProjectImport[] {
    const data: unknown = JSON.parse(text);
    const obj = data as { projects?: unknown[]; subs?: unknown[] };
    const list = Array.isArray(data)
      ? data
      : Array.isArray(obj?.projects)
        ? obj.projects
        : Array.isArray(obj?.subs)
          ? obj.subs
          : null;
    if (!list) {
      throw new Error('JSON must be an array of projects or { "projects": [...] }');
    }
    return list.map((raw) => {
      const s = raw as { name?: unknown; title?: unknown; size?: unknown };
      return {
        name: String(s?.name ?? s?.title ?? ''),
        size: this.toSize(s?.size),
      };
    });
  }

  /** Plain text/CSV: `Title, Size` or `Title : M` per line (header optional). */
  private parseText(text: string): ProjectImport[] {
    const rows = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.split(',').map((c) => c.trim().replace(/^"|"$/g, '')));
    if (rows.length && /^title$/i.test(rows[0][0])) rows.shift();
    return rows.map(([title, size]) => ({
      name: title ?? '',
      size: this.toSize(size),
    }));
  }

  /** Accepts "M"/"m" size codes; anything else → null (unsized). */
  private toSize(value: unknown): SizeId | null {
    const v = String(value ?? '').trim().toUpperCase();
    return (SIZE_IDS as readonly string[]).includes(v) ? (v as SizeId) : null;
  }
}
