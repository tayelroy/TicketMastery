import { RequireAuth } from '../../auth/RequireAuth';
import type { FeatureRegistration } from '../../features';
import { MyTicketsPage } from './MyTicketsPage';
import { TicketDetailPage } from './TicketDetailPage';

export const accountFeature: FeatureRegistration = {
  routes: [
    {
      path: '/myaccount',
      element: (
        <RequireAuth>
          <MyTicketsPage />
        </RequireAuth>
      ),
    },
    {
      path: '/myaccount/tickets/:ticketId',
      element: (
        <RequireAuth>
          <TicketDetailPage />
        </RequireAuth>
      ),
    },
  ],
  nav: [{ label: 'My Tickets', to: '/myaccount', requires: true }],
};
