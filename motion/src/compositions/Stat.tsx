import React from "react"
import { useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion"
import { fieldStyle, fonts, minType, type Field } from "../../../lib/brand/tokens"
import type { StatProps, MotionAspect } from "../../../lib/content/motion-types"
import { Scene, easeOut } from "../brand"
import { ASPECTS } from "../aspects"

// Card de dado + contador: número sobe de 0 ao valor em ~45 frames com spring
// (damping 200, sem overshoot), Math.round a cada frame; barra de progresso em
// paralelo; rótulo/subtítulo fade-in. (`source` é proveniência, não é exibido.)
// `StatBody` é o conteúdo sem <Scene>.
export function StatBody({
  aspect,
  field = "ink",
  label,
  value,
  suffix,
  subtitle,
}: StatProps & { aspect: MotionAspect; field?: Field }) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const { w } = ASPECTS[aspect]
  const fs = fieldStyle[field]

  const prog = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 45 })
  const shown = Math.round(value * prog)
  const labelOpacity = interpolate(frame, [0, 12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const subOpacity = interpolate(frame, [10, 26], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const subY = interpolate(frame, [10, 26], [10, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: easeOut,
  })
  const numSize = Math.round(w * 0.22)

  return (
    <div>
      <div
        style={{
          fontFamily: fonts.mono,
          fontWeight: 500,
          fontSize: Math.max(minType.support, Math.round(w * 0.032)),
          color: fs.accent,
          letterSpacing: 2,
          textTransform: "uppercase",
          opacity: labelOpacity,
        }}
      >
        {label}
      </div>

      <div style={{ display: "flex", alignItems: "baseline", gap: Math.round(w * 0.01), marginTop: Math.round(w * 0.02) }}>
        <span
          style={{
            fontFamily: fonts.display,
            fontWeight: 700,
            fontSize: numSize,
            lineHeight: 1,
            color: fs.fg,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {shown.toLocaleString("pt-BR")}
        </span>
        {suffix ? (
          <span style={{ fontFamily: fonts.display, fontWeight: 700, fontSize: Math.round(numSize * 0.5), color: fs.accent }}>
            {suffix}
          </span>
        ) : null}
      </div>

      <div
        style={{
          marginTop: Math.round(w * 0.04),
          height: 12,
          borderRadius: 6,
          backgroundColor: fs.line,
          overflow: "hidden",
        }}
      >
        <div
          style={{ height: "100%", width: "100%", backgroundColor: fs.accent, transform: `scaleX(${prog})`, transformOrigin: "left" }}
        />
      </div>

      <div
        style={{
          marginTop: Math.round(w * 0.03),
          fontFamily: fonts.sans,
          fontWeight: 400,
          fontSize: Math.max(minType.support, Math.round(w * 0.03)),
          color: fs.fg,
          opacity: subOpacity,
          transform: `translateY(${subY}px)`,
        }}
      >
        {subtitle}
      </div>
    </div>
  )
}

export function Stat(props: StatProps & { aspect: MotionAspect; brandHandle?: string; brandLogo?: string }) {
  return (
    <Scene aspect={props.aspect} field="ink" brandHandle={props.brandHandle} brandLogo={props.brandLogo}>
      <StatBody
        aspect={props.aspect}
        field="ink"
        kind="stat"
        label={props.label}
        value={props.value}
        suffix={props.suffix}
        subtitle={props.subtitle}
        source={props.source}
      />
    </Scene>
  )
}
