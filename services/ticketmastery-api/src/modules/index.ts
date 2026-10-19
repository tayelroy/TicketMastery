import type { Router } from 'express';
import { accountRouter } from './account/router';
import { checkoutRouter } from './checkout/router';
import { discoveryRouter } from './discovery/router';
import { organiserRouter } from './organiser/router';
import { waitingRoomRouter } from './waiting-room/router';

export interface ModuleRegistration {
  /** Path under /api, e.g. '/organiser' -> /api/organiser/... */
  basePath: string;
  router: Router;
  useCase: string;
  owner: string;
}

/** Central list of feature modules; app.ts mounts each at `/api${basePath}`. Add new modules here. */
export const modules: ModuleRegistration[] = [
  { basePath: '/concerts', router: discoveryRouter, useCase: 'UC1', owner: 'Cody & Nai Xin' },
  { basePath: '/me', router: accountRouter, useCase: 'UC2', owner: 'Andrew' },
  { basePath: '/waiting-room', router: waitingRoomRouter, useCase: 'UC3', owner: 'Yan Ting' },
  { basePath: '/checkout', router: checkoutRouter, useCase: 'UC4', owner: 'Shi Hui' },
  { basePath: '/organiser', router: organiserRouter, useCase: 'UC5', owner: 'Elroy' },
];
