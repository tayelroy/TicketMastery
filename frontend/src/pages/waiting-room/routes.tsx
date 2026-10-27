import { RequireAuth } from '../../auth/RequireAuth';
import type { FeatureRegistration } from '../../features';
import { WaitingRoomPage } from './WaitingRoomPage';

export const waitingRoomFeature: FeatureRegistration = {
  routes: [
    {
      path: '/concerts/:concertId/waiting-room',
      element: (
        // A queue place belongs to a user, so fans must sign in first.
        <RequireAuth>
          <WaitingRoomPage />
        </RequireAuth>
      ),
    },
  ],
};
