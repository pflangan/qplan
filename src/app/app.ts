import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CapacityStore } from './capacity-store.service';
import { ProjectsPanel } from './panels/projects/projects-panel';
import { TeamsPanel } from './panels/teams/teams-panel';
import { Board } from './board/board';
import { RichTip } from './rich-tip.directive';
import { SettingsDialog } from './settings/settings-dialog';

@Component({
  selector: 'app-root',
  imports: [FormsModule, ProjectsPanel, TeamsPanel, Board, RichTip, SettingsDialog],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  readonly store = inject(CapacityStore);
  /** Selectable sprint counts per quarter. */
  readonly sprintOptions = [5, 6, 7];
  /** Auto-opens on first run (no persisted data). */
  readonly settingsOpen = signal(!this.store.loadedFromStorage);
  /** Selected board mode: canvas or fixed. */
  readonly layoutMode = signal<'canvas' | 'fixed'>('canvas');

  /** New-board confirmation dialog; open when a reset is pending. */
  readonly confirmNew = signal(false);

  startNewBoard(): void {
    this.store.newBoard();
    this.confirmNew.set(false);
  }

  exportPlan(): void {
    const quarter = this.store.selectedQuarter();
    const date = new Date().toISOString().slice(0, 10);
    const blob = new Blob([this.store.exportData()], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `capacity-plan-${quarter.label}-${date}.json`;
    link.click();
    URL.revokeObjectURL(url);
    this.store.showToast('Plan exported');
  }

  importPlan(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    file.text().then((text) => this.store.importData(text));
    input.value = '';
  }
}
