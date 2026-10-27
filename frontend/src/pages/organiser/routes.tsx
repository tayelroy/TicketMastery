import { RequireAuth } from '../../auth/RequireAuth';
import { ORGANISERS_GROUP } from '../../auth/session';
import type { FeatureRegistration } from '../../features';
import { OrganiserConcertPage } from './OrganiserConcertPage';
import { OrganiserHomePage } from './OrganiserHomePage';

export const organiserFeature: FeatureRegistration = {
  routes: [
    {
      path: '/organiser',
      element: (
        <RequireAuth group={ORGANISERS_GROUP}>
          <OrganiserHomePage />
        </RequireAuth>
      ),
    },
    {
      path: '/organiser/concerts/:concertId',
      element: (
        <RequireAuth group={ORGANISERS_GROUP}>
          <OrganiserConcertPage />
        </RequireAuth>
      ),
    },
  ],
  nav: [{ label: 'Organiser', to: '/organiser', requires: ORGANISERS_GROUP }],
};
