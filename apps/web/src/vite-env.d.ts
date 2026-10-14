/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional base path for the API when it is not same-origin. */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
