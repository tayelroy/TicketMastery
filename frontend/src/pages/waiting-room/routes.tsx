import type { FeatureRegistration } from '../../features';
import { WaitingRoomPage } from './WaitingRoomPage';

export const waitingRoomFeature: FeatureRegistration = {
  routes: [{ path: '/concerts/:concertId/waiting-room', element: <WaitingRoomPage /> }],
};
