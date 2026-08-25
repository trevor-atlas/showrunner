import { createAssetServer } from 'remix/assets'
import { uiHmr } from 'remix/ui-hmr/assets'
import { fileURLToPath } from 'node:url'

// Anchor the asset server at THIS module's tree (src/server), not process.cwd() —
// the daemon mounts this listener in-process from any cwd.
const rootDir = fileURLToPath(new URL('.', import.meta.url))
const nodeEnv = process.env.NODE_ENV ?? 'development'
const isDevelopment = nodeEnv === 'development'
const isHmr = Boolean(isDevelopment && process.env.REMIX_NODE_HMR)

export const assetServer = createAssetServer({
  basePath: '/assets',
  rootDir,
  fileMap: {
    '*path': '*path',
    'node_modules/*path': 'node_modules/*path',
  },
  allowFiles: ['routes.ts', '**/public/**'],
  allowPackages: ['remix'],
  denyFiles: ['**/*.test.*'],
  sourceMaps: isDevelopment ? 'external' : undefined,
  minify: !isDevelopment,
  watch: isDevelopment,
  hmr: isHmr
    ? async () => (await import('remix/node-hmr/runtime')).createBrowserHmrChannel()
    : undefined,
  scripts: { loaders: isHmr ? [uiHmr()] : undefined },
})

const entry = 'actions/public/entry.ts'

// Lazy accessors: resolve hrefs/preloads on first use (at render time, not
// module-eval). createAssetServer construction above is cheap and does not
// compile; the getHref/getPreloads calls do real asset work, so keep them out
// of module-eval so importing this module never blocks on the compiler.
let hrefPromise: Promise<string> | null = null
export function entryHref(): Promise<string> {
  return (hrefPromise ??= assetServer.getHref(entry))
}

let preloadsPromise: Promise<string[]> | null = null
export function entryPreloads(): Promise<string[]> {
  return (preloadsPromise ??= assetServer.getPreloads(entry))
}
