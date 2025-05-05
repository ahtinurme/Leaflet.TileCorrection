import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {defineConfig} from 'vite'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
    build: {
        rollupOptions: {
            input: resolve(__dirname, 'src/tileCorrection.js'),
            output: {
                dir: resolve(__dirname, 'dist'),
                format: 'es',
                entryFileNames: '[name].min.js',
                chunkFileNames: '[name].min.js',
                assetFileNames: '[name].[ext]',
            },
        },
    },
})