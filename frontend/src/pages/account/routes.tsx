import { Navigate } from 'react-router-dom';
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
    // The checkout confirmation links here; the list lives at /myaccount.
    { path: '/myaccount/tickets', element: <Navigate to="/myaccount" replace /> },
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
