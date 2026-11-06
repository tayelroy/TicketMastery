import { RequireAuth } from '../../auth/RequireAuth';
import { ORGANISERS_GROUP } from '../../auth/session';
import type { FeatureRegistration } from '../../features';
import { OrganiserConcertPage } from './OrganiserConcertPage';
import { OrganiserHomePage } from './OrganiserHomePage';
import { OrganiserReportsPage } from './OrganiserReportsPage';

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
    {
      path: '/organiser/reports',
      element: (
        <RequireAuth group={ORGANISERS_GROUP}>
          <OrganiserReportsPage />
        </RequireAuth>
      ),
    },
  ],
  nav: [{ label: 'Organiser', to: '/organiser', requires: ORGANISERS_GROUP }],
};
