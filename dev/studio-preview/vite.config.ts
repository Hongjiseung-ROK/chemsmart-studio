import tailwind from '@tailwindcss/vite'
import react from '@vitejs/plugin-react-swc'
import { resolve } from 'path'
import { defineConfig } from 'vite'

const root = resolve(__dirname, '../..')

/**
 * Serves the ChemSmart Studio workspace in a plain browser with the real components, real design tokens
 * and real English copy, but with the IPC boundary replaced by an in-page mock. It exists so the Studio
 * surface can be driven and screenshotted deterministically without a molecule editor, an agent, or a
 * calculation. Every alias below mirrors the renderer target in `electron.vite.config.ts`; the four mock
 * aliases are the only difference.
 */
export default defineConfig({
  plugins: [tailwind(), react({ tsDecorators: true })],
  resolve: {
    alias: {
      '@renderer/ipc': resolve(__dirname, 'mocks/ipc.tsx'),
      '@renderer/data/hooks/useCache': resolve(__dirname, 'mocks/useCache.ts'),
      '@renderer/hooks/useModel': resolve(__dirname, 'mocks/useModel.ts'),
      '@logger': resolve(__dirname, 'mocks/logger.ts'),
      '@renderer': resolve(root, 'src/renderer'),
      '@data': resolve(root, 'src/renderer/data'),
      '@shared': resolve(root, 'src/shared'),
      '@chemsmart/molecular-engine': resolve(root, 'packages/chem-molecular-engine/src'),
      '@chemsmart/studio-protocol': resolve(root, 'packages/studio-protocol/src'),
      '@mcp-trace/trace-core': resolve(root, 'packages/mcp-trace/trace-core'),
      '@cherrystudio/ai-core/provider': resolve(root, 'packages/aiCore/src/core/providers'),
      '@cherrystudio/ai-core/built-in/plugins': resolve(root, 'packages/aiCore/src/core/plugins/built-in'),
      '@cherrystudio/ai-core': resolve(root, 'packages/aiCore/src'),
      '@cherrystudio/extension-table-plus': resolve(root, 'packages/extension-table-plus/src'),
      '@cherrystudio/ai-sdk-provider': resolve(root, 'packages/ai-sdk-provider/src'),
      '@cherrystudio/provider-registry/node': resolve(root, 'packages/provider-registry/src/registry-loader'),
      '@cherrystudio/provider-registry': resolve(root, 'packages/provider-registry/src'),
      '@cherrystudio/ui/icons': resolve(root, 'packages/ui/src/components/icons'),
      '@cherrystudio/ui': resolve(root, 'packages/ui/src')
    }
  },
  root: __dirname,
  server: { host: '127.0.0.1', port: 5199, strictPort: true }
})
