import { NgModule } from '@angular/core';
import { SharedModule, addNavMenuItem, registerDashboardWidget } from '@vendure/admin-ui/core';

/**
 * Registers the "Checkout Guard" entry in the admin nav and the dashboard
 * widget. The nav item sits in the built-in "Sales" section (next to
 * Orders) because that section exists on every Vendure install —
 * `addNavMenuItem` silently drops an item whose section id is unknown.
 * Hosts that group HULO plugins into their own nav section can add a
 * second link there pointing at `/extensions/checkout-guard`.
 *
 * The widget appears under Dashboard → Add widget → Checkout Guard.
 */
@NgModule({
    imports: [SharedModule],
    providers: [
        addNavMenuItem(
            {
                id: 'hulo-checkout-guard',
                label: 'Checkout Guard',
                routerLink: ['/extensions/checkout-guard'],
                icon: 'shield-check',
                requiresPermission: 'ReadOrder',
            },
            'sales',
        ),
        registerDashboardWidget('hulo-vendure-plugin-checkout-guard', {
            title: 'Checkout Guard',
            supportedWidths: [4, 6, 8],
            requiresPermissions: ['ReadOrder'],
            loadComponent: () => import('./components/checkout-guard-widget.component').then(m => m.CheckoutGuardWidgetComponent),
        }),
    ],
})
export class CheckoutGuardSharedModule {}
