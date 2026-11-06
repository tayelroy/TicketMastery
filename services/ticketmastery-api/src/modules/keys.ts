/**
 * Keys accepted by API_MODULES, one per feature module (modules/index.ts). Each ECS service sets API_MODULES to the
 * module(s) it serves. No imports, so config.ts can validate against it without loading the routers.
 */
export const moduleKeys = ['discovery', 'account', 'waiting-room', 'checkout', 'organiser'] as const;

export type ModuleKey = (typeof moduleKeys)[number];
