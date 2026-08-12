import React from "react"
import { AbsoluteFill, OffthreadVideo, Img, useCurrentFrame, useVideoConfig, interpolate } from "remotion"
import { fieldStyle, fonts, colors } from "../../../lib/brand/tokens"
import type { ClipAspect, ClipProps, TranscriptWord } from "../../../lib/content/clip-types"
import { HeadlineBody } from "./Headline"
import { easeOut } from "../brand"

// Composição do CLIPE: vídeo-fonte recortado + legenda karaokê + (opcional) card de
// abertura com o gancho + rodapé de marca do tenant. É composição NOVA: importa o
// HeadlineBody do motion como overlay, sem alterar nenhum preset existente.

// Canvas por aspecto (base 1080). O reframe inteligente é Onda 2; aqui a janela de
// corte (crop) é manual.
export const CLIP_ASPECTS: Record<ClipAspect, { w: number; h: number }> = {
  "9x16": { w: 1080, h: 1920 },
  "16x9": { w: 1920, h: 1080 },
}

export type ClipCompProps = {
  aspect: ClipAspect
  /** URL pública (proxy do motor) do vídeo-fonte — resolvida pelo worker. */
  sourceUrl: string
  brandHandle?: string
  brandLogo?: string
  clip: ClipProps
}

const FPS = 30

/** Frames de um instante em ms. */
function msToFrames(ms: number): number {
  return Math.round((ms / 1000) * FPS)
}

/** Índice da palavra ativa no tempo (ms): a última cujo início já passou. */
function activeWordIndex(words: TranscriptWord[], ms: number): number {
  let idx = -1
  for (let i = 0; i < words.length; i++) {
    if (words[i].startMs <= ms) idx = i
    else break
  }
  return idx
}

const Karaoke: React.FC<{ words: TranscriptWord[]; style: ClipProps["caption"]; aspect: ClipAspect }> = ({
  words,
  style,
  aspect,
}) => {
  const frame = useCurrentFrame()
  const { w, h } = CLIP_ASPECTS[aspect]
  const ms = (frame / FPS) * 1000
  const active = activeWordIndex(words, ms)
  if (active < 0 || words.length === 0) return null

  // Janela deslizante de ~6 palavras centrada na ativa (legenda legível, não o texto todo).
  const from = Math.max(0, active - 2)
  const line = words.slice(from, from + 6)
  const size = Math.round(h * ((style.fontSizePct ?? 5.2) / 100))
  const highlight = style.highlightColor ?? colors.signal.hex
  const color = style.color ?? "#ffffff"
  const pos = style.position ?? "bottom"
  const justify = pos === "top" ? "flex-start" : pos === "center" ? "center" : "flex-end"

  return (
    <AbsoluteFill style={{ justifyContent: justify, alignItems: "center", padding: Math.round(w * 0.06) }}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: `${Math.round(size * 0.12)}px ${Math.round(size * 0.32)}px`,
          fontFamily: fonts.display,
          fontWeight: 700,
          fontSize: size,
          lineHeight: 1.1,
          textAlign: "center",
          marginBottom: pos === "bottom" ? Math.round(h * 0.1) : 0,
          textShadow: style.outline === false ? undefined : "0 2px 12px rgba(0,0,0,0.85)",
        }}
      >
        {line.map((word, i) => {
          const wi = from + i
          const isActive = wi === active
          return (
            <span key={wi} style={{ color: isActive ? highlight : color, opacity: wi <= active ? 1 : 0.55 }}>
              {word.text}
            </span>
          )
        })}
      </div>
    </AbsoluteFill>
  )
}

/** Card de abertura com o gancho (reusa HeadlineBody), sobre um scrim, nos ~2s
 *  iniciais, com fade de saída — para não competir com o resto do clipe. */
const OpeningCard: React.FC<{ card: NonNullable<ClipProps["openingCard"]>; aspect: ClipAspect }> = ({ card, aspect }) => {
  const frame = useCurrentFrame()
  const { w } = CLIP_ASPECTS[aspect]
  const holdUntil = 55
  const opacity = interpolate(frame, [holdUntil, holdUntil + 15], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: easeOut,
  })
  if (frame > holdUntil + 15) return null
  return (
    <AbsoluteFill
      style={{
        opacity,
        backgroundColor: "rgba(0,0,0,0.55)",
        justifyContent: "center",
        alignItems: "center",
        padding: Math.round(w * 0.08),
      }}
    >
      <HeadlineBody aspect="9x16" field="ink" kind="headline" words={card.words} highlightIndex={card.highlightIndex ?? 0} />
    </AbsoluteFill>
  )
}

/** Rodapé de marca do tenant (logo + handle) — inline, sem tocar brand.tsx. */
const BrandBadge: React.FC<{ handle?: string; logo?: string; aspect: ClipAspect }> = ({ handle, logo, aspect }) => {
  const { w, h } = CLIP_ASPECTS[aspect]
  const fs = fieldStyle.ink
  return (
    <AbsoluteFill style={{ justifyContent: "flex-start", alignItems: "flex-start", padding: Math.round(w * 0.045) }}>
      <div style={{ display: "flex", alignItems: "center", gap: Math.round(w * 0.02) }}>
        {logo ? (
          <Img src={logo} style={{ height: Math.round(h * 0.035), maxWidth: Math.round(w * 0.25), objectFit: "contain" }} />
        ) : null}
        {handle ? (
          <span
            style={{
              fontFamily: fonts.sans,
              fontWeight: 600,
              fontSize: Math.round(h * 0.024),
              color: "#ffffff",
              textShadow: "0 2px 8px rgba(0,0,0,0.8)",
            }}
          >
            {handle}
          </span>
        ) : null}
      </div>
      <span style={{ display: "none" }}>{fs.bg}</span>
    </AbsoluteFill>
  )
}

export const ClipComposition: React.FC<ClipCompProps> = ({ aspect, sourceUrl, brandHandle, brandLogo, clip }) => {
  const { fps } = useVideoConfig()
  const trimBefore = msToFrames(clip.inMs) * (fps / FPS)
  const crop = clip.crop
  const scale = crop?.scale && crop.scale > 0 ? crop.scale : 1
  const tx = crop ? (0.5 - crop.x) * 100 : 0
  const ty = crop ? (0.5 - crop.y) * 100 : 0

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <AbsoluteFill style={{ overflow: "hidden" }}>
        {sourceUrl ? (
          <OffthreadVideo
            src={sourceUrl}
            trimBefore={Math.max(0, Math.round(trimBefore))}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              transform: `scale(${scale}) translate(${tx}%, ${ty}%)`,
            }}
          />
        ) : null}
      </AbsoluteFill>
      {clip.words.length > 0 && <Karaoke words={clip.words} style={clip.caption} aspect={aspect} />}
      {clip.brandOn && <BrandBadge handle={brandHandle} logo={brandLogo} aspect={aspect} />}
      {clip.openingCard && <OpeningCard card={clip.openingCard} aspect={aspect} />}
    </AbsoluteFill>
  )
}
