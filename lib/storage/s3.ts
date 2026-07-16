import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  CopyObjectCommand,
} from "@aws-sdk/client-s3"

const {
  S3_ENDPOINT,
  S3_REGION,
  S3_BUCKET,
  S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY,
  S3_PUBLIC_URL,
} = process.env

export function isStorageConfigured(): boolean {
  return Boolean(
    S3_ENDPOINT &&
      S3_BUCKET &&
      S3_ACCESS_KEY_ID &&
      S3_SECRET_ACCESS_KEY &&
      S3_PUBLIC_URL,
  )
}

let client: S3Client | null = null
function getClient(): S3Client {
  if (!isStorageConfigured()) {
    throw new Error("Storage S3/MinIO não configurado (ver envs S3_*).")
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

// URL pública (CDN) de uma key. Requer storage configurado.
export function publicUrlForKey(key: string): string {
  return `${S3_PUBLIC_URL!.replace(/\/$/, "")}/${key}`
}

// Sobe um objeto e retorna a URL pública (S3_PUBLIC_URL/key).
export async function uploadObject(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<string> {
  await getClient().send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  )
  return `${S3_PUBLIC_URL!.replace(/\/$/, "")}/${key}`
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
export function mapListedObjects(
  contents: ListedItem[] | undefined,
  publicUrl: string,
): StoredObject[] {
  const base = publicUrl.replace(/\/$/, "")
  return (contents ?? [])
    .filter((o): o is ListedItem & { Key: string } =>
      typeof o.Key === "string" && o.Key.length > 0 && !o.Key.endsWith("/"),
    )
    .map((o) => {
      const obj: StoredObject = { key: o.Key, url: `${base}/${o.Key}` }
      if (typeof o.Size === "number") obj.size = o.Size
      if (o.LastModified) obj.lastModified = o.LastModified.toISOString()
      return obj
    })
}

// Lista objetos de uma pasta (prefixo), com paginação por continuation token.
export async function listObjects(
  prefix: string,
  opts: { token?: string; max?: number } = {},
): Promise<ListResult> {
  const res = await getClient().send(
    new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: prefix,
      MaxKeys: opts.max ?? 100,
      ContinuationToken: opts.token,
    }),
  )
  return {
    objects: mapListedObjects(res.Contents, S3_PUBLIC_URL!),
    nextToken: res.NextContinuationToken,
  }
}

// Versão simples (sem paginação) — alimenta o picker. Mantida por compat.
export async function listObjectsByPrefix(prefix: string, max = 100): Promise<StoredObject[]> {
  return (await listObjects(prefix, { max })).objects
}

// Remove um objeto do bucket.
export async function deleteObject(key: string): Promise<void> {
  await getClient().send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }))
}

// Copia um objeto para uma nova key e devolve a URL pública do destino.
export async function copyObject(srcKey: string, destKey: string): Promise<string> {
  await getClient().send(
    new CopyObjectCommand({
      Bucket: S3_BUCKET,
      CopySource: encodeURI(`${S3_BUCKET}/${srcKey}`),
      Key: destKey,
    }),
  )
  return `${S3_PUBLIC_URL!.replace(/\/$/, "")}/${destKey}`
}
