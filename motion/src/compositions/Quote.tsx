import React from "react"
import { useCurrentFrame, interpolate } from "remotion"
import { fieldStyle, fonts, minType } from "../../../lib/brand/tokens"
import type { QuoteProps, MotionAspect } from "../../../lib/content/motion-types"
import { Scene, easeOut } from "../brand"
import { ASPECTS } from "../aspects"

// Citação com destaque: a citação sobe e aparece (~15 frames). Uma tarja varre
// atrás da frase-chave (scaleX 0→1 da esquerda, ~18 frames) começando ~frame 20.
// Autoria surge por último (~frame 45).
export function Quote({
  aspect,
  brandHandle,
  quote,
  keyphrase,
  author,
}: QuoteProps & { aspect: MotionAspect; brandHandle?: string }) {
  const frame = useCurrentFrame()
  const { w } = ASPECTS[aspect]
  const fs = fieldStyle.ink
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
    <Scene aspect={aspect} field="ink" brandHandle={brandHandle}>
      <div style={{ opacity: qOpacity, transform: `translateY(${qY}px)` }}>
        <div
          style={{
            fontFamily: fonts.display,
            fontWeight: 600,
            fontSize: size,
            lineHeight: 1.18,
            color: fs.fg,
          }}
        >
          <span style={{ color: fs.accent }}>“</span>
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
                  backgroundColor: fs.accent,
                  transform: `scaleX(${bar})`,
                  transformOrigin: "left",
                }}
              />
              <span style={{ position: "relative", color: bar > 0.5 ? fs.bg : fs.fg }}>{key}</span>
            </span>
          )}
          {after}
          <span style={{ color: fs.accent }}>”</span>
        </div>
        <div
          style={{
            marginTop: Math.round(size * 0.6),
            opacity: authorOpacity,
            transform: `translateY(${authorY}px)`,
            fontFamily: fonts.mono,
            fontWeight: 500,
            fontSize: Math.max(minType.mono, Math.round(w * 0.028)),
            color: fs.accent,
            letterSpacing: 1,
          }}
        >
          — {author}
        </div>
      </div>
    </Scene>
  )
}
