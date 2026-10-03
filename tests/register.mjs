import { register } from 'node:module'

register(new URL('./alias-loader.mjs', import.meta.url).href, import.meta.url)
