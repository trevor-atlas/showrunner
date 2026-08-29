import { createAssetServer } from 'remix/assets'
import { uiHmr } from 'remix/ui-hmr/assets'
import { fileURLToPath } from 'node:url'

// Anchor the asset server at the REPO ROOT (not process.cwd()), computed from
// this module's URL so it is cwd-independent. rootDir must contain everything
// served — including node_modules (repo root), which the client module graph
// (remix + its @remix-run deps) imports; the asset server refuses to serve any
// file outside rootDir, so anchoring at src/server left node_modules
// unreachable and hydration silently dead. Source patterns below are re-scoped
// to src/server/ so the served surface (the security boundary) is unchanged.
const rootDir = fileURLToPath(new URL('../../', import.meta.url))
const nodeEnv = process.env.NODE_ENV ?? 'development'
const isDevelopment = nodeEnv === 'development'
const isHmr = Boolean(isDevelopment && process.env.REMIX_NODE_HMR)

export const assetServer = createAssetServer({
  basePath: '/assets',
  rootDir,
  fileMap: {
    'node_modules/*path': 'node_modules/*path',
    '*path': 'src/server/*path',
  },
  allowFiles: ['src/server/routes.ts', 'src/server/**/public/**'],
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

const entry = 'src/server/actions/public/entry.ts'

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
