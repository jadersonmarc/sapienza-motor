import React from "react"
import { useCurrentFrame, interpolate } from "remotion"
import { fieldStyle, fonts, minType, type Field } from "../../../lib/brand/tokens"
import type { QuoteProps, MotionAspect, MotionImage } from "../../../lib/content/motion-types"
import { type CaptionStyle, motionFallbacks, resolveCaption } from "../../../lib/content/caption-style"
import { Scene, easeOut } from "../brand"
import { ASPECTS } from "../aspects"

// Citação com destaque: a citação sobe e aparece (~15 frames). Uma tarja varre
// atrás da frase-chave (scaleX 0→1 da esquerda, ~18 frames) começando ~frame 20.
// Autoria surge por último (~frame 45). `QuoteBody` é o conteúdo sem <Scene>.
export function QuoteBody({
  aspect,
  field = "ink",
  caption,
  quote,
  keyphrase,
  author,
}: QuoteProps & { aspect: MotionAspect; field?: Field; caption?: CaptionStyle }) {
  const frame = useCurrentFrame()
  const { w } = ASPECTS[aspect]
  const fs = fieldStyle[field]
  const cap = resolveCaption(caption, motionFallbacks(field))
  const size = Math.max(minType.title - 8, Math.round(w * 0.072))

  const qOpacity = interpolate(frame, [0, 15], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const qY = interpolate(frame, [0, 15], [24, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: easeOut,
  })
  const bar = interpolate(frame, [20, 38], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: easeOut,
  })
  const authorOpacity = interpolate(frame, [45, 60], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const authorY = interpolate(frame, [45, 60], [12, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: easeOut,
  })

  // Divide a citação ao redor da frase-chave (substring; se não achar, sem tarja).
  const idx = quote.toLowerCase().indexOf(keyphrase.toLowerCase())
  const has = idx >= 0 && keyphrase.length > 0
  const before = has ? quote.slice(0, idx) : quote
  const key = has ? quote.slice(idx, idx + keyphrase.length) : ""
  const after = has ? quote.slice(idx + keyphrase.length) : ""

  return (
    <div style={{ opacity: qOpacity, transform: `translateY(${qY}px)` }}>
      <div
        style={{
          fontFamily: cap.fontFamily,
          fontWeight: 600,
          fontSize: size,
          lineHeight: 1.18,
          color: cap.color,
        }}
      >
        <span style={{ color: cap.highlight }}>“</span>
        {before}
        {has && (
          <span style={{ position: "relative", display: "inline-block", padding: "0 0.08em" }}>
            <span
              style={{
                position: "absolute",
                left: 0,
                top: "0.08em",
                bottom: "0.08em",
                width: "100%",
                backgroundColor: cap.highlight,
                transform: `scaleX(${bar})`,
                transformOrigin: "left",
              }}
            />
            <span style={{ position: "relative", color: bar > 0.5 ? fs.bg : cap.color }}>{key}</span>
          </span>
        )}
        {after}
        <span style={{ color: cap.highlight }}>”</span>
      </div>
      <div
        style={{
          marginTop: Math.round(size * 0.6),
          opacity: authorOpacity,
          transform: `translateY(${authorY}px)`,
          fontFamily: fonts.mono,
          fontWeight: 500,
          fontSize: Math.max(minType.mono, Math.round(w * 0.028)),
          color: cap.highlight,
          letterSpacing: 1,
        }}
      >
        — {author}
      </div>
    </div>
  )
}

export function Quote(
  props: QuoteProps & {
    aspect: MotionAspect
    brandHandle?: string
    brandLogo?: string
    image?: MotionImage | null
    caption?: CaptionStyle
  },
) {
  return (
    <Scene aspect={props.aspect} field="ink" brandHandle={props.brandHandle} brandLogo={props.brandLogo} image={props.image}>
      <QuoteBody aspect={props.aspect} field="ink" caption={props.caption} kind="quote" quote={props.quote} keyphrase={props.keyphrase} author={props.author} />
    </Scene>
  )
}
