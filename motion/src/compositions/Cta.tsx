import React from "react"
import { useCurrentFrame, interpolate } from "remotion"
import { fieldStyle, fonts, minType, type Field } from "../../../lib/brand/tokens"
import type { CtaProps, MotionAspect } from "../../../lib/content/motion-types"
import { easeOut } from "../brand"
import { ASPECTS } from "../aspects"

// Cena de chamada à ação (fecho do roteiro): o convite entra (fade + subida), uma
// seta desliza e um traço de acento varre embaixo. Sem <Scene> — é bloco de cena.
export function CtaBody({
  aspect,
  field = "ink",
  text,
}: CtaProps & { aspect: MotionAspect; field?: Field }) {
  const frame = useCurrentFrame()
  const { w } = ASPECTS[aspect]
  const fs = fieldStyle[field]
  const size = Math.max(minType.title - 6, Math.round(w * 0.09))

  const opacity = interpolate(frame, [0, 14], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const y = interpolate(frame, [0, 14], [20, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeOut })
  const arrow = interpolate(frame, [10, 24], [-12, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeOut })
  const line = interpolate(frame, [16, 34], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeOut })

  return (
    <div style={{ opacity, transform: `translateY(${y}px)` }}>
      <div style={{ display: "flex", alignItems: "center", gap: Math.round(w * 0.02) }}>
        <span
          style={{
            fontFamily: fonts.display,
            fontWeight: 700,
            fontSize: size,
            lineHeight: 1.05,
            color: fs.fg,
          }}
        >
          {text}
        </span>
        <span style={{ fontSize: size, color: fs.accent, transform: `translateX(${arrow}px)` }}>→</span>
      </div>
      <div
        style={{
          marginTop: Math.round(size * 0.22),
          height: Math.max(6, Math.round(size * 0.06)),
          width: "60%",
          backgroundColor: fs.accent,
          transform: `scaleX(${line})`,
          transformOrigin: "left",
        }}
      />
    </div>
  )
}
