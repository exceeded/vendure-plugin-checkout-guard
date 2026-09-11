import { NgModule } from '@angular/core';
import { SharedModule, addNavMenuItem } from '@vendure/admin-ui/core';

/**
 * Registers the "Checkout Guard" entry in the admin nav. It sits in the
 * built-in "Sales" section (next to Orders) because that section exists on
 * every Vendure install — `addNavMenuItem` silently drops an item whose
 * section id is unknown. Hosts that group HULO plugins into their own nav
 * section can add a second link there pointing at
 * `/extensions/checkout-guard`.
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
    ],
})
export class CheckoutGuardSharedModule {}
