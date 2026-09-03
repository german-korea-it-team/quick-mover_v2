/// <reference types="vite/client" />

import type { SdManagerApi } from '../../shared/types'

declare global {
  interface Window {
    sdManager: SdManagerApi
  }
}

export {}
