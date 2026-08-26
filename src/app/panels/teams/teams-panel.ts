import { Component, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CapacityStore } from '../../capacity-store.service';
import { Grade, GRADES } from '../../models';
import { RichTip } from '../../rich-tip.directive';
import { TeamCard } from './team-card';

interface TeamImport {
  name: string;
  engineers: { name: string; grade?: Grade }[];
}

@Component({
  selector: 'app-teams-panel',
  imports: [FormsModule, TeamCard, RichTip],
  host: { '[class.collapsed]': 'collapsed()' },
  templateUrl: './teams-panel.html',
  styleUrl: './teams-panel.scss',
})
export class TeamsPanel {
  readonly store = inject(CapacityStore);
  /** Collapsed: full content hidden, a 44px sliver rail renders instead. */
  readonly collapsed = input(false);
  readonly newName = signal('');
  readonly showPaste = signal(false);
  readonly pasteText = signal('');

  add(): void {
    this.store.addTeam(this.newName());
    this.newName.set('');
  }

  togglePaste(): void {
    this.showPaste.update((v) => !v);
  }

  importPasted(): void {
    const text = this.pasteText().trim();
    if (!text) return;
    try {
      const teams = text.startsWith('{') || text.startsWith('[')
        ? this.parseJson(text)
        : this.parseCsv(text);
      const n = this.store.importTeams(teams);
      this.store.showToast(
        n > 0 ? `Imported ${n} team${n > 1 ? 's' : ''}` : 'Nothing to import',
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
        const teams = file.name.toLowerCase().endsWith('.json')
          ? this.parseJson(text)
          : this.parseCsv(text);
        const n = this.store.importTeams(teams);
        this.store.showToast(
          n > 0 ? `Imported ${n} team${n > 1 ? 's' : ''} from ${file.name}` : 'Nothing to import',
        );
      })
      .catch((err: Error) => this.store.showToast(`Import failed: ${err.message}`))
      .finally(() => (input.value = ''));
  }

  /** JSON: `[{"name":"Platform","engineers":[{"name":"Jane","grade":"G5"}]}]` or `{"teams":[...]}` */
  private parseJson(text: string): TeamImport[] {
    const data: unknown = JSON.parse(text);
    const list = Array.isArray(data)
      ? data
      : Array.isArray((data as { teams?: unknown[] })?.teams)
        ? (data as { teams: unknown[] }).teams
        : null;
    if (!list) {
      throw new Error('JSON must be an array of teams or { "teams": [...] }');
    }
    return list.map((raw) => {
      const t = raw as { name?: unknown; engineers?: unknown };
      return {
        name: String(t?.name ?? ''),
        engineers: Array.isArray(t?.engineers)
          ? t.engineers.map((e) => {
              if (typeof e === 'string') return { name: e };
              const eng = e as { name?: unknown; grade?: unknown };
              return {
                name: String(eng?.name ?? ''),
                grade: this.toGrade(eng?.grade),
              };
            })
          : [],
      };
    });
  }

  /** CSV: `Team,Engineer,Grade` rows (header optional). Engineers group by team name. */
  private parseCsv(text: string): TeamImport[] {
    const rows = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.split(',').map((c) => c.trim().replace(/^"|"$/g, '')));
    if (rows.length && rows[0][0].toLowerCase() === 'team') rows.shift();
    const byTeam = new Map<string, TeamImport>();
    for (const [team, name, grade] of rows) {
      if (!team || !name) continue;
      let entry = byTeam.get(team);
      if (!entry) {
        entry = { name: team, engineers: [] };
        byTeam.set(team, entry);
      }
      entry.engineers.push({ name, grade: this.toGrade(grade) });
    }
    return [...byTeam.values()];
  }

  /** Accepts "G5" codes or full labels like "Senior"; defaults to G4. */
  private toGrade(value: unknown): Grade {
    const v = String(value ?? '').trim().toUpperCase();
    if (v in GRADES) return v as Grade;
    const byLabel = (Object.keys(GRADES) as Grade[]).find(
      (g) => GRADES[g].label.toUpperCase() === v,
    );
    return byLabel ?? 'G4';
  }
}
