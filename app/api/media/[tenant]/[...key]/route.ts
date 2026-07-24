import { getObject, isStorageConfigured } from "@/lib/storage/s3"
import { R2_PURPOSES, prefixFor } from "@/lib/storage/keys"

export const runtime = "nodejs"

// Proxy PÚBLICO de mídia: serve a imagem do bucket privado do tenant. Público de
// propósito — IG/LinkedIn buscam a URL na publicação, sem credencial. Só serve
// chaves dentro das pastas conhecidas da biblioteca (evita ler chave arbitrária).

const ALLOWED_PREFIXES = R2_PURPOSES.map((p) => prefixFor(p) + "/")

function isMediaKey(key: string): boolean {
  return ALLOWED_PREFIXES.some((p) => key.startsWith(p))
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ tenant: string; key: string[] }> },
): Promise<Response> {
  if (!isStorageConfigured()) return new Response("storage indisponível", { status: 503 })
  const { tenant, key } = await ctx.params
  const objectKey = (key ?? []).join("/")
  if (!tenant || !objectKey || !isMediaKey(objectKey)) return new Response("não encontrado", { status: 404 })

  const obj = await getObject(tenant, objectKey)
  if (!obj) return new Response("não encontrado", { status: 404 })

  return new Response(obj.body, {
    status: 200,
    headers: {
      "content-type": obj.contentType ?? "application/octet-stream",
      // Imagens on-brand são imutáveis por chave (uuid/slug+format).
      "cache-control": "public, max-age=31536000, immutable",
    },
  })
}
