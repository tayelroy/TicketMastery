// Bundles src/index.ts into bundle/index.js, the file Terraform zips (infra/modules/messaging/ticket_fn.tf).
// The bundle is committed so `terraform plan` never runs npm. Run `npm run build` after changing src/ or the
// dependencies, and commit bundle/index.js with the change.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'bundle/index.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  // CommonJS so the external AWS SDK resolves from the runtime's own node_modules through require().
  format: 'cjs',
  // Prefer the dependencies' ES module builds: pdf-lib's CommonJS build can't be tree-shaken.
  mainFields: ['module', 'main'],
  // The nodejs22.x runtime ships AWS SDK v3; leaving it out keeps the committed bundle small.
  external: ['@aws-sdk/*'],
  minify: true,
  legalComments: 'eof',
  logLevel: 'info',
});
