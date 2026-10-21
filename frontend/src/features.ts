import type { RouteObject } from 'react-router-dom';
import { accountFeature } from './pages/account/routes';
import { checkoutFeature } from './pages/checkout/routes';
import { discoveryFeature } from './pages/discovery/routes';
import { organiserFeature } from './pages/organiser/routes';
import { waitingRoomFeature } from './pages/waiting-room/routes';

export interface NavItem {
  label: string;
  to: string;
  /** Hide the link unless signed in (true) or in this group (string). */
  requires?: true | string;
}

/** One entry per page folder. Owners and API endpoints are listed in each folder's README.md. */
export interface FeatureRegistration {
  routes: RouteObject[];
  nav?: NavItem[];
}

/** Central list of feature page folders; router.tsx mounts every route. Add new features here. */
export const features: FeatureRegistration[] = [
  discoveryFeature,
  accountFeature,
  waitingRoomFeature,
  checkoutFeature,
  organiserFeature,
];
