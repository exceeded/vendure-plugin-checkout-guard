import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { SharedModule } from '@vendure/admin-ui/core';

/** REST prefix shared with the plugin controllers (same auth as the main page). */
const API = '/checkout-guard';

interface WidgetData {
    tier: 'paid' | 'trial' | 'free';
    notice: { kind: string; message: string; daysLeft: number } | null;
    stats: Array<{ label: string; value: string }>;
    route: string;
}

/**
 * Dashboard widget: three headline figures from the last 7 days, the
 * licence notice when one applies, and a link to the plugin page.
 * Registered by `CheckoutGuardSharedModule` (Dashboard → Add widget →
 * Checkout Guard).
 */
@Component({
    selector: 'hulo-checkout-guard-widget',
    standalone: true,
    imports: [SharedModule],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <div class="cgw" *ngIf="data; else loading">
            <div class="cgw-stats">
                <div class="cgw-stat" *ngFor="let s of data.stats">
                    <div class="cgw-num">{{ s.value }}</div>
                    <div class="cgw-label">{{ s.label }}</div>
                </div>
                <p class="cgw-empty" *ngIf="!data.stats.length">Nothing recorded in the last 7 days.</p>
            </div>
            <p class="cgw-notice" *ngIf="data.notice?.message">{{ data.notice?.message }}</p>
            <a class="cgw-link" [routerLink]="data.route">Open Checkout Guard →</a>
        </div>
        <ng-template #loading><p class="cgw-empty">{{ error || 'Loading…' }}</p></ng-template>
    `,
    styles: [`
        .cgw { display: flex; flex-direction: column; gap: 10px; padding: 4px 2px; }
        .cgw-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 10px; }
        .cgw-stat { padding: 10px 12px; border-radius: 10px; border: 1px solid var(--color-component-border-200, #d5d8de); min-width: 0; }
        .cgw-num { font-size: 24px; font-weight: 700; line-height: 1.1; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; overflow-wrap: anywhere; }
        .cgw-label { margin-top: 4px; font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--color-weight-500, #5d6470); }
        .cgw-notice { margin: 0; padding: 8px 12px; border-radius: 8px; font-size: 12.5px; line-height: 1.45; background: #fffbeb; border: 1px solid #fcd34d; color: #92400e; }
        .cgw-link { font-size: 13px; font-weight: 600; text-decoration: none; }
        .cgw-link:hover { text-decoration: underline; }
        .cgw-empty { margin: 0; font-size: 12.5px; color: var(--color-weight-500, #5d6470); }
    `],
})
export class CheckoutGuardWidgetComponent implements OnInit, OnDestroy {
    data: WidgetData | null = null;
    error = '';
    private sub: Subscription | null = null;

    constructor(private http: HttpClient, private cdr: ChangeDetectorRef) {}

    ngOnInit() {
        this.sub = this.http.get<WidgetData>(`${API}/widget`).subscribe({
            next: d => { this.data = d; this.cdr.markForCheck(); },
            error: e => { this.error = e?.error?.message || 'Checkout Guard is not reachable'; this.cdr.markForCheck(); },
        });
    }

    ngOnDestroy() { this.sub?.unsubscribe(); }
}
