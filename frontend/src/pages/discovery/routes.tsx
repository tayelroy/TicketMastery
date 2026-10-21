import type { FeatureRegistration } from '../../features';
import { ConcertDetailPage } from './ConcertDetailPage';
import { ConcertListPage } from './ConcertListPage';

export const discoveryFeature: FeatureRegistration = {
  routes: [
    { path: '/', element: <ConcertListPage /> },
    { path: '/concerts/:concertId', element: <ConcertDetailPage /> },
  ],
  nav: [{ label: 'Concerts', to: '/' }],
};
