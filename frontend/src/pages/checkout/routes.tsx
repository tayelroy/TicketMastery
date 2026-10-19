import { RequireAuth } from '../../auth/RequireAuth';
import type { FeatureRegistration } from '../../features';
import { CheckoutPage } from './CheckoutPage';

export const checkoutFeature: FeatureRegistration = {
  routes: [
    {
      path: '/concerts/:concertId/checkout',
      element: (
        <RequireAuth>
          <CheckoutPage />
        </RequireAuth>
      ),
    },
  ],
};
