import type { Router } from 'express';
import { accountRouter } from './account/router';
import { checkoutRouter } from './checkout/router';
import { discoveryRouter } from './discovery/router';
import type { ModuleKey } from './keys';
import { organiserRouter } from './organiser/router';
import { waitingRoomRouter } from './waiting-room/router';

export interface ModuleRegistration {
  /** Name in API_MODULES (see keys.ts). */
  key: ModuleKey;
  /** Path under /api, e.g. '/organiser' -> /api/organiser/... */
  basePath: string;
  router: Router;
  useCase: string;
  owner: string;
}

/**
 * Central list of feature modules; app.ts mounts the ones selected by API_MODULES (all by default) at
 * `/api${basePath}`. Add new modules here and their key in keys.ts.
 */
export const modules: ModuleRegistration[] = [
  { key: 'discovery', basePath: '/concerts', router: discoveryRouter, useCase: 'UC1', owner: 'Cody & Nai Xin' },
  { key: 'account', basePath: '/me', router: accountRouter, useCase: 'UC2', owner: 'Andrew' },
  { key: 'waiting-room', basePath: '/waiting-room', router: waitingRoomRouter, useCase: 'UC3', owner: 'Yan Ting' },
  { key: 'checkout', basePath: '/checkout', router: checkoutRouter, useCase: 'UC4', owner: 'Shi Hui' },
  { key: 'organiser', basePath: '/organiser', router: organiserRouter, useCase: 'UC5', owner: 'Elroy' },
];
