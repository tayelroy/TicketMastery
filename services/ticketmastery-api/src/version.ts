import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config } from './config';

const packageJson = z.object({ version: z.string() });

/** APP_VERSION (e.g. git SHA from the pipeline) wins; otherwise package.json (one level above src/ and dist/). */
export const appVersion: string =
  config.APP_VERSION ??
  packageJson.parse(JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'))).version;
