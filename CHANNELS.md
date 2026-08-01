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

## Falha de publicação (visível e reprocessável)

- Estado **por canal** em `social_drafts` (`status='sent'|'failed'`, `last_error`) — sucesso apaga a
  falha anterior.
- Ao publicar com falha, o motor emite **`ContentPublishFailed`** no `event_outbox`; o core consome e
  notifica o cliente (seam de e-mail).
- Reprocesso: `POST /api/v1/content/:id/republish` tenta só os canais que falharam (não re-fatura nem
  republica onde já saiu). No console: botão "Tentar novamente nos canais que falharam".
