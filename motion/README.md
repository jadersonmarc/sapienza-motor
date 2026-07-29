# sapienza-motion — peças em movimento da Margot Editora

Vídeo animado on-brand (4 presets fixos), render **local** com Remotion. Vive dentro
do repo do motor para **reusar a mesma fonte** de design tokens (`../lib/brand/tokens.ts`)
e fontes (`../assets/fonts`) — sem redefinir cor/tipografia. Deploy no Coolify como um
**app separado** do web app (render de vídeo não pode bloquear a Editora).

## Presets

| id | preset | recebe (vindo da geração a partir do brief) |
|----|--------|---------------------------------------------|
| `headline` | Manchete que monta | `words[]`, `highlightIndex` |
| `quote` | Citação com destaque | `quote`, `keyphrase`, `author` |
| `slides` | Carrossel em loop | `slides[]` (2–4, `index`+`title`) |
| `stat` | Card de dado + contador | `label`, `value`, `suffix`, `subtitle`, `source` |

Formatos: **1:1** e **4:5** (feed) e **9:16** (story). O conteúdo NUNCA é hardcoded —
vem da geração (`../lib/ai/motion.ts`) a partir do brief do tenant. O `stat` só é usado
quando há um número verificável no brief (validação de `source`).

## Rodar

```bash
pnpm install
pnpm studio     # copia as fontes e abre o Remotion Studio (previewa os 4 × 3)
pnpm sample     # renderiza um MP4 de cada preset × formato em motion/out/
```

`pnpm studio` / `pnpm sample` rodam `copy-assets` antes (copia `../assets/fonts` →
`public/fonts`, de onde o `staticFile` serve). `public/fonts` e `out/` não são versionados.

## Envs

| env | uso | default |
|-----|-----|---------|
| `REMOTION_LICENSE_KEY` | licença Remotion nos renders | `free-license` |
| `DATABASE_URL` | mesmo Postgres do motor (serviço de render) | — |
| `S3_ENDPOINT`/`S3_REGION`/`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`/`MOTOR_PUBLIC_URL` | R2 (upload do MP4) | — |
| `WEBHOOK_SECRET` | protege o trigger do worker | — |
| `MOTION_RENDER_CONCURRENCY` | jobs simultâneos | `1` |
| `MOTION_RENDER_TIMEOUT_MS` | timeout por render | `120000` |

## Requisito de memória (deploy Coolify)

O render usa **Chromium headless + ffmpeg**. Dimensione o container com **≥ 2 GB de RAM**
(recomendado 4 GB para os aspectos maiores/9:16). Base do Dockerfile precisa das libs do
Chromium (o `@remotion/renderer` baixa um Chromium compatível no primeiro uso).

## Como adicionar um preset

1. Tipo dos campos em `../lib/content/motion-types.ts` (novo membro da união `MotionProps`).
2. Schema + regras no gerador `../lib/ai/motion.ts` (o modelo passa a poder escolhê-lo).
3. Composition em `src/compositions/<Nome>.tsx` (lê tokens/fontes; sem cor/texto hardcoded).
4. Despacho em `src/MotionPiece.tsx` e amostra em `src/samples.ts`.
   O `Root.tsx` registra automaticamente os 3 formatos do novo preset.
