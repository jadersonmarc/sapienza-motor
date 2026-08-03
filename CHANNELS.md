# Canais de publicação — Editora

## Catálogo suportado

Ofertados ao cliente (aparecem em `/motor/canais` e podem ser conectados):

| Canal | Conta | Mídia | Entra na contagem do plano? |
|---|---|---|---|
| **Instagram** | conta profissional (Graph API) | imagem + vídeo (Reels) | **sim** |
| **LinkedIn** | pessoa (token OpenID) | texto + imagem + vídeo | **sim** |
| **Facebook** | Página (Graph API) | texto + imagem | **sim** |
| Blog | interno (slug) | — | não |
| WordPress | Application Password | HTML + capa | não |
| Webhook | HMAC compartilhado | JSON (texto/imagem/vídeo) | não |

**X (Twitter) e Threads** seguem no código (`lib/channels/impls.ts`, `PLATFORMS`) mas **fora do
catálogo**: `supportedPlatforms()` (`lib/channels/types.ts`) não os inclui, então não aparecem na UI
nem podem ser conectados (`POST /channels` → 400). Reabilitar sem redeploy: `CHANNELS_EXPERIMENTAL=1`.
Não implementar mídia para eles nem sugerir reativação.

## Gating por plano (Etapa 2)

Só **canais sociais** contam no limite do plano (`isCounted()` em `lib/channels/types.ts` = tudo
exceto blog/wordpress/webhook). Limite por tier vem de `plans.canais` (start 1 / pro 2 / **scale =
todos os disponíveis**; a cópia ao cliente no Premium **nunca cita o número**).

- **Conexão:** `connectChannel` barra um social além do limite (`ChannelLimitError` → 409, com dica de
  upgrade); blog/wp/webhook nunca são barrados. Troca de social é livre (desconectar libera o slot).
- **Contador:** `GET /channels` devolve `used` (sociais) + `tier`; o console mostra "2 de 3" (ou
  "todos os canais disponíveis" no Premium).
- **Downgrade** (via Sapienza/superadmin): o core (`assertChannelsAllowDowngrade`) **trava** a redução
  de tier do motor enquanto houver mais sociais conectados que o novo plano permite — o cliente
  escolhe qual desconectar; nunca desconectamos por heurística.
- **Tenant já acima do limite** (mudança de regra nossa): nada é desconectado; publicação segue; só
  **novas conexões** são barradas até voltar ao limite.

## Validação contra conta real

Harness que publica de verdade, sem tocar no banco:

```bash
pnpm validate:channel -- --platform linkedin
pnpm validate:channel -- --platform instagram --image https://.../capa.png
pnpm validate:channel -- --platform facebook  --image https://.../capa.png
# vídeo: --video https://.../peca.mp4  (Instagram Reels / LinkedIn vídeo)
```

Credenciais por env (só o canal testado precisa das suas):

| Canal | Envs |
|---|---|
| linkedin | `VALIDATE_LI_TOKEN` (token cru; autor resolvido pelo token) |
| instagram | `VALIDATE_IG_TOKEN`, `VALIDATE_IG_ACCOUNT_ID` |
| facebook | `VALIDATE_FB_TOKEN`, `VALIDATE_FB_PAGE_ID` |

Saída: `OK <canal>: <url>` (evidência), `FALHOU <canal>: <erro>` (exit 1) ou
`PENDENTE (sem credencial)` (exit 0 — não pôde ser testado, ≠ falhou).

## Estado da validação

| Canal | Estado | Evidência / motivo |
|---|---|---|
| LinkedIn | ⏳ a validar | requer token real (`VALIDATE_LI_TOKEN`); harness pronto |
| Instagram | ⏳ **pendente de credencial** | depende de App Review da Meta (Graph API) |
| Facebook | ⏳ **pendente de credencial** | depende de App Review da Meta (Graph API) |

> Anote aqui o id/URL retornado por cada validação conforme sair. Um canal que **falhar** (não
> "pendente") sai do catálogo removendo-o de `supportedPlatforms()`.

## Permissões do token (publicação + métricas)

O token de cada canal social é usado tanto para **publicar** quanto para **coletar métricas**. Faltando
o escopo de insights, o canal publica normalmente mas as **métricas ficam vazias sem erro** (Relatório e
Assistente sem dados). Tokens do Meta/LinkedIn **expiram (~60 dias)** — use sempre o de longa duração.

| Canal | Escopos p/ publicar | Escopos p/ métricas | Validade |
|---|---|---|---|
| Instagram | `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement` | `instagram_manage_insights` (insights de post + seguidores) | Page Token de longa duração (~60d) |
| Facebook | `pages_manage_posts`, `pages_read_engagement`, `pages_show_list` | `read_insights` (fan_count já vem em `pages_read_engagement`) | Page Token de longa duração (~60d) |
| LinkedIn | `w_member_social`, `openid`, `profile` | **sem métrica por post** (perfil pessoal — limitação da API) | access_token ~60d |

Hoje o token é colado manualmente (cifrado em `motor_channels`) e renovado à mão. O mecanismo
**OAuth + refresh automático** (o cliente conecta uma vez, a Sapienza renova sozinha) está desenhado
em `~/.claude/plans/ethereal-honking-balloon.md` (Fase 2 — depende de apps OAuth + App Review da Meta).

## Métricas (Bloco D)

Coleta diária (cron `collect-metrics`, dia São Paulo, idempotente) de dois fatos:

- **Por post** (`post_metrics`): impressões/alcance/curtidas/comentários/compart. Adapters reais:
  **Instagram** (Graph insights) e **Facebook** (page-post insights + summary). **LinkedIn não tem
  coleta por post** — post de perfil pessoal (`urn:li:person`) não expõe métrica por post via API;
  é limitação da plataforma, não falha (não fingimos dado).
- **De conta** (`channel_metrics`): seguidores/alcance de conta ao longo do tempo. `fetchAccount`
  em IG (`followers_count`) e FB (`fan_count`).

Sem credencial/adapter do canal, a coleta é no-op (seam). As stats alimentam o relatório
(desempenho + crescimento de seguidores) e o assistente de IA (`editora_stats`/`top_posts`/
`by_config`/`growth`).

## Trilha do motion (seam)

O vídeo de motion pode ter **trilha sonora** com pacing na batida (beat-sync). A música é asset do
operador (licenciada) — entra como seam:

1. Solte as faixas em `sapienza-motor/assets/audio/` com estes nomes/BPM (do catálogo
   `lib/content/motion-audio.ts`): `calm.mp3` (90 bpm), `upbeat.mp3` (120 bpm), `bold.mp3` (100 bpm).
2. Redeploy do **render-worker** do motion (o `copy-assets` do boot copia para `public/audio`).

Com os arquivos presentes, a IA escolhe o mood por peça e o worker liga a trilha (encode AAC) + fade;
as durações das cenas já vêm quantizadas à batida do BPM. **Sem os arquivos, o vídeo sai mudo** (o
worker rebaixa o mood para `none`) — exatamente como antes. Beat-sync aqui é quantização por BPM fixo
(sem análise de áudio em runtime).

## Falha de publicação (visível e reprocessável)

- Estado **por canal** em `social_drafts` (`status='sent'|'failed'`, `last_error`) — sucesso apaga a
  falha anterior.
- Ao publicar com falha, o motor emite **`ContentPublishFailed`** no `event_outbox`; o core consome e
  notifica o cliente (seam de e-mail).
- Reprocesso: `POST /api/v1/content/:id/republish` tenta só os canais que falharam (não re-fatura nem
  republica onde já saiu). No console: botão "Tentar novamente nos canais que falharam".
