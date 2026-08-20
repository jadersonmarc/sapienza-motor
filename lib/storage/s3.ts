import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  CopyObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3"

// Storage multi-tenant: UMA conta S3/R2 (credenciais globais), UM bucket por
// tenant (`motor-<tenantId>`). Isolamento é o bucket, não prefixo de chave. As
// imagens são servidas por um proxy público do motor (rota /api/media), então a
// URL pública deriva de MOTOR_PUBLIC_URL — o bucket em si fica privado.

const { S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, MOTOR_PUBLIC_URL } =
  process.env

export function isStorageConfigured(): boolean {
  return Boolean(S3_ENDPOINT && S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY && MOTOR_PUBLIC_URL)
}

/** Nome do bucket do tenant. UUID → `motor-<uuid>` (lowercase; válido em R2/S3). */
export function bucketFor(tenantId: string): string {
  return `motor-${tenantId.toLowerCase()}`
}

/** Base pública (via proxy do motor) das imagens de um tenant. */
function publicBaseFor(tenantId: string): string {
  return `${MOTOR_PUBLIC_URL!.replace(/\/$/, "")}/api/media/${tenantId}`
}

/** URL pública de uma key do tenant — aponta para o proxy do motor. */
export function publicUrlForKey(tenantId: string, key: string): string {
  return `${publicBaseFor(tenantId)}/${key}`
}

let client: S3Client | null = null
function getClient(): S3Client {
  if (!isStorageConfigured()) {
    throw new Error("Storage S3/R2 não configurado (ver envs S3_* e MOTOR_PUBLIC_URL).")
  }
  client ??= new S3Client({
    endpoint: S3_ENDPOINT,
    region: S3_REGION || "us-east-1",
    credentials: {
      accessKeyId: S3_ACCESS_KEY_ID!,
      secretAccessKey: S3_SECRET_ACCESS_KEY!,
    },
    forcePathStyle: true, // necessário para MinIO
  })
  return client
}

/** Cria o bucket do tenant se ainda não existir (idempotente). Chamado no
 *  provisionamento (SubscriptionActivated{motor}). Requer credencial com permissão. */
export async function createBucketIfMissing(tenantId: string): Promise<void> {
  const Bucket = bucketFor(tenantId)
  const s3 = getClient()
  try {
    await s3.send(new HeadBucketCommand({ Bucket }))
    return // já existe e é acessível
  } catch {
    /* não existe (ou 403) — tenta criar */
  }
  try {
    await s3.send(new CreateBucketCommand({ Bucket }))
  } catch (e) {
    const name = (e as { name?: string })?.name ?? ""
    if (name === "BucketAlreadyOwnedByYou" || name === "BucketAlreadyExists") return
    throw e
  }
}

/**
 * A URL aponta para o proxy público de mídia do motor?
 *
 * Allowlist para o que o servidor vai BUSCAR a partir de entrada do usuário (o
 * `?image=` do /api/og, resolvido server-side pelo Satori). Sem isto a rota é um
 * SSRF. Compara origin + prefixo de path `/api/media/`.
 */
export function isPublicAssetUrl(candidate: string): boolean {
  const base = process.env.MOTOR_PUBLIC_URL
  if (!base) return false
  try {
    const url = new URL(candidate)
    const allowed = new URL(base.replace(/\/$/, "") + "/api/media/")
    if (url.protocol !== allowed.protocol || url.host !== allowed.host) return false
    return url.pathname.startsWith(allowed.pathname)
  } catch {
    return false // relativa ou malformada
  }
}

// Sobe um objeto no bucket do tenant e devolve a URL pública (proxy).
export async function uploadObject(
  tenantId: string,
  key: string,
  body: Buffer,
  contentType: string,
): Promise<string> {
  await getClient().send(
    new PutObjectCommand({ Bucket: bucketFor(tenantId), Key: key, Body: body, ContentType: contentType }),
  )
  return publicUrlForKey(tenantId, key)
}

/** Bytes de uma imagem por URL. Se for a NOSSA URL de proxy
 *  (`MOTOR_PUBLIC_URL/api/media/<tenant>/<key>`), lê direto do storage — evita o
 *  hairpin de o container buscar o próprio domínio público (causa comum de a
 *  imagem "não ir"). URLs externas caem no fetch HTTP. null se falhar. */
export async function readImageBytes(url: string): Promise<Uint8Array | null> {
  const base = process.env.MOTOR_PUBLIC_URL
  if (base) {
    const prefix = `${base.replace(/\/$/, "")}/api/media/`
    if (url.startsWith(prefix)) {
      const rest = url.slice(prefix.length)
      const slash = rest.indexOf("/")
      if (slash > 0) {
        const obj = await getObject(rest.slice(0, slash), rest.slice(slash + 1))
        return obj?.body ?? null
      }
    }
  }
  const res = await fetch(url).catch(() => null)
  if (!res || !res.ok) return null
  return new Uint8Array(await res.arrayBuffer())
}

/** Busca os bytes de um objeto (alimenta o proxy público). null se não existir. */
export async function getObject(
  tenantId: string,
  key: string,
): Promise<{ body: Uint8Array; contentType?: string } | null> {
  try {
    const res = await getClient().send(new GetObjectCommand({ Bucket: bucketFor(tenantId), Key: key }))
    if (!res.Body) return null
    const body = await res.Body.transformToByteArray()
    return { body, contentType: res.ContentType }
  } catch {
    return null
  }
}

export interface StoredObject {
  key: string
  url: string
  size?: number
  lastModified?: string // ISO-8601
}

export interface ListResult {
  objects: StoredObject[]
  nextToken?: string
}

type ListedItem = { Key?: string; Size?: number; LastModified?: Date }

// Mapeia o retorno do ListObjectsV2 para {key, url, size?, lastModified?}. Puro
// (testável): descarta chaves vazias e "pseudo-pastas" (terminadas em "/").
export function mapListedObjects(contents: ListedItem[] | undefined, publicBase: string): StoredObject[] {
  const base = publicBase.replace(/\/$/, "")
  return (contents ?? [])
    .filter(
      (o): o is ListedItem & { Key: string } =>
        typeof o.Key === "string" && o.Key.length > 0 && !o.Key.endsWith("/"),
    )
    .map((o) => {
      const obj: StoredObject = { key: o.Key, url: `${base}/${o.Key}` }
      if (typeof o.Size === "number") obj.size = o.Size
      if (o.LastModified) obj.lastModified = o.LastModified.toISOString()
      return obj
    })
}

// Lista objetos de uma pasta (prefixo) no bucket do tenant, paginado.
export async function listObjects(
  tenantId: string,
  prefix: string,
  opts: { token?: string; max?: number } = {},
): Promise<ListResult> {
  const res = await getClient().send(
    new ListObjectsV2Command({
      Bucket: bucketFor(tenantId),
      Prefix: prefix,
      MaxKeys: opts.max ?? 100,
      ContinuationToken: opts.token,
    }),
  )
  return {
    objects: mapListedObjects(res.Contents, publicBaseFor(tenantId)),
    nextToken: res.NextContinuationToken,
  }
}

// Versão simples (sem paginação) — alimenta o picker.
export async function listObjectsByPrefix(tenantId: string, prefix: string, max = 100): Promise<StoredObject[]> {
  return (await listObjects(tenantId, prefix, { max })).objects
}

// Soma os bytes usados no bucket do tenant (todas as pastas), paginando. Alimenta
// a cota da biblioteca. Sem storage configurado, 0.
export async function usedBytes(tenantId: string): Promise<number> {
  if (!isStorageConfigured()) return 0
  let total = 0
  let token: string | undefined
  do {
    const res = await listObjects(tenantId, "", { token, max: 1000 })
    for (const o of res.objects) total += o.size ?? 0
    token = res.nextToken
  } while (token)
  return total
}

// Remove um objeto do bucket do tenant.
export async function deleteObject(tenantId: string, key: string): Promise<void> {
  await getClient().send(new DeleteObjectCommand({ Bucket: bucketFor(tenantId), Key: key }))
}

/** Exclusão BEST-EFFORT que NÃO lança (não derruba a exclusão do registro) mas
 *  também NÃO some sem rastro: loga bucket/chave/tenant na falha — a única fonte
 *  real de órfão no R2. Devolve os bytes liberados (0 se o objeto não existia ou a
 *  remoção falhou), para somar o espaço recuperado numa limpeza em lote. */
export async function safeDeleteObject(tenantId: string, key: string, context?: string): Promise<number> {
  const bucket = bucketFor(tenantId)
  let size = 0
  try {
    const head = await getClient().send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    size = head.ContentLength ?? 0
  } catch {
    // Objeto pode não existir (já removido / nunca subiu) — segue para o delete idempotente.
  }
  try {
    await getClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
    return size
  } catch (e) {
    console.error(
      `[storage][delete-falhou] bucket=${bucket} key=${key} tenant=${tenantId}${context ? ` ctx=${context}` : ""}:`,
      e instanceof Error ? e.message : e,
    )
    return 0
  }
}

// Copia um objeto (dentro do bucket do tenant) e devolve a URL pública do destino.
export async function copyObject(tenantId: string, srcKey: string, destKey: string): Promise<string> {
  const Bucket = bucketFor(tenantId)
  await getClient().send(
    new CopyObjectCommand({ Bucket, CopySource: encodeURI(`${Bucket}/${srcKey}`), Key: destKey }),
  )
  return publicUrlForKey(tenantId, destKey)
}
