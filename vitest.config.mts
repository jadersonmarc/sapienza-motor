import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"

// Resolve o alias @/* (igual ao tsconfig). Testes de integração compartilham um
// único Postgres e recriam schemas no setup; rodar arquivos em série evita corrida.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    fileParallelism: false,
  },
})
