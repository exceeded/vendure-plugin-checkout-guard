import { NgModule } from '@angular/core';
import { RouterModule } from '@angular/router';
import { SharedModule } from '@vendure/admin-ui/core';
import { FormsModule } from '@angular/forms';
import { HttpClientModule } from '@angular/common/http';
import { CheckoutGuardComponent } from './components/checkout-guard.component';

@NgModule({
    imports: [
        SharedModule, FormsModule, HttpClientModule,
        RouterModule.forChild([
            { path: '', pathMatch: 'full', component: CheckoutGuardComponent, data: { breadcrumb: 'Checkout Guard' } },
        ]),
    ],
    declarations: [CheckoutGuardComponent],
})
export class CheckoutGuardModule {}
