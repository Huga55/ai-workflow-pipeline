/// <reference types="vite/client" />
import type { PipelineApi } from '@core/api'

declare global {
  interface Window {
    pipeline: PipelineApi
  }
}

export {}
