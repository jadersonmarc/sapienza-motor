import React from "react"
import { useCurrentFrame, interpolate } from "remotion"
import { fieldStyle, fonts, minType, type Field } from "../../../lib/brand/tokens"
import type { StatementProps, MotionAspect } from "../../../lib/content/motion-types"
import { easeOut } from "../brand"
import { ASPECTS } from "../aspects"

// Afirmação com rótulo — primitiva dos arquétipos (Mito/Verdade, Antes/Depois, item
// de lista, resposta). Chip de rótulo (bloco de acento) entra primeiro; a frase sobe
// logo depois. Sem <Scene> — é bloco de cena. `field` vem do tema do story.
export function StatementBody({
  aspect,
  field = "ink",
  label,
  text,
}: StatementProps & { aspect: MotionAspect; field?: Field }) {
  const frame = useCurrentFrame()
  const { w } = ASPECTS[aspect]
  const fs = fieldStyle[field]
  const size = Math.max(minType.title - 6, Math.round(w * 0.084))

  const chipOpacity = interpolate(frame, [0, 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const chipX = interpolate(frame, [0, 10], [-14, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeOut })
  const textOpacity = interpolate(frame, [8, 22], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const textY = interpolate(frame, [8, 22], [18, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeOut })

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: Math.round(w * 0.035) }}>
      {label ? (
        <span
          style={{
            alignSelf: "flex-start",
            opacity: chipOpacity,
            transform: `translateX(${chipX}px)`,
            backgroundColor: fs.accent,
            color: fs.bg,
            fontFamily: fonts.mono,
            fontWeight: 600,
            fontSize: Math.max(minType.mono, Math.round(w * 0.03)),
            letterSpacing: 1.5,
            textTransform: "uppercase",
            padding: `${Math.round(w * 0.012)}px ${Math.round(w * 0.024)}px`,
            borderRadius: 8,
          }}
        >
          {label}
        </span>
      ) : null}
      <span
        style={{
          opacity: textOpacity,
          transform: `translateY(${textY}px)`,
          fontFamily: fonts.display,
          fontWeight: 700,
          fontSize: size,
          lineHeight: 1.08,
          color: fs.fg,
        }}
      >
        {text}
      </span>
    </div>
  )
}
