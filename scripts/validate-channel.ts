import { InstagramChannel, LinkedinChannel, FacebookChannel } from "@/lib/channels/impls"
import type { Channel, Platform, PublishInput } from "@/lib/channels/types"

// Harness de validação de canal CONTRA CONTA REAL. Não toca no banco: instancia o
// adapter, monta as credenciais a partir de env e publica um post de teste,
// imprimindo o id/URL retornado (evidência) ou o erro real.
//
// Uso:
//   pnpm validate:channel -- --platform linkedin
//   pnpm validate:channel -- --platform instagram --image https://.../capa.png
//   pnpm validate:channel -- --platform facebook  --image https://.../capa.png
//
// Credenciais por env (só o canal que você vai testar precisa das suas):
//   linkedin : VALIDATE_LI_TOKEN            (token cru; autor resolvido pelo token)
//   instagram: VALIDATE_IG_TOKEN  VALIDATE_IG_ACCOUNT_ID
//   facebook : VALIDATE_FB_TOKEN  VALIDATE_FB_PAGE_ID
//
// Sem as credenciais do canal escolhido, sai como PENDENTE (exit 0) — separando com
// clareza "não pôde ser testado" de "falhou" (exit 1). IG/FB dependem de App Review
// da Meta, então PENDENTE é o estado esperado até a aprovação sair.

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

type Case = { channel: Channel; credentials: string | null }

// Monta adapter + credenciais do env; null => credencial ausente (PENDENTE).
function buildCase(platform: Platform): Case | null {
  const env = process.env
  switch (platform) {
    case "linkedin": {
      const token = env.VALIDATE_LI_TOKEN?.trim()
      if (!token) return { channel: new LinkedinChannel(), credentials: null }
      return { channel: new LinkedinChannel(), credentials: token }
    }
    case "instagram": {
      const access_token = env.VALIDATE_IG_TOKEN?.trim()
      const account_id = env.VALIDATE_IG_ACCOUNT_ID?.trim()
      if (!access_token || !account_id) return { channel: new InstagramChannel(), credentials: null }
      return { channel: new InstagramChannel(), credentials: JSON.stringify({ access_token, account_id }) }
    }
    case "facebook": {
      const access_token = env.VALIDATE_FB_TOKEN?.trim()
      const page_id = env.VALIDATE_FB_PAGE_ID?.trim()
      if (!access_token || !page_id) return { channel: new FacebookChannel(), credentials: null }
      return { channel: new FacebookChannel(), credentials: JSON.stringify({ access_token, page_id }) }
    }
    default:
      return null
  }
}

async function main() {
  const platform = arg("platform") as Platform | undefined
  if (!platform || !["instagram", "linkedin", "facebook"].includes(platform)) {
    console.error("uso: --platform <instagram|linkedin|facebook> [--image <url>] [--video <url>]")
    process.exit(2)
  }

  const built = buildCase(platform)
  if (!built) {
    console.error(`plataforma não suportada pelo harness: ${platform}`)
    process.exit(2)
  }
  if (built.credentials === null) {
    console.log(`PENDENTE (sem credencial): ${platform} — defina as envs VALIDATE_* do canal para testar.`)
    process.exit(0)
  }

  const input: PublishInput = {
    slug: `validacao-${Date.now()}`,
    title: arg("title") ?? "Validação de canal — Sapienza",
    body:
      arg("body") ??
      "Post de validação automatizada do canal (Sapienza Editora). Pode apagar depois de conferir.",
    imageUrl: arg("image"),
    videoUrl: arg("video"),
  }

  console.log(`[validate] publicando em ${platform} (conta real)…`)
  try {
    const { url } = await built.channel.publish(input, built.credentials)
    console.log(`OK ${platform}: ${url}`)
    process.exit(0)
  } catch (e) {
    console.error(`FALHOU ${platform}: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }
}

main()
