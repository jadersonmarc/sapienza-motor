import React from "react"
import { useCurrentFrame, interpolate } from "remotion"
import { fieldStyle, minType, type Field } from "../../../lib/brand/tokens"
import type { HeadlineProps, MotionAspect, MotionImage } from "../../../lib/content/motion-types"
import { type CaptionStyle, motionFallbacks, resolveCaption } from "../../../lib/content/caption-style"
import { Scene, easeOut } from "../brand"
import { ASPECTS } from "../aspects"

// Manchete que monta: cada palavra entra (translateY 14→0 + opacity) em ~10 frames,
// stagger ~7. Após a última, o sublinhado da destacada desenha (scaleX 0→1 da esquerda).
// `HeadlineBody` é o conteúdo sem o <Scene> — reusado como bloco de cena no `story`.
export function HeadlineBody({
  aspect,
  field = "ink",
  caption,
  words,
  highlightIndex,
}: HeadlineProps & { aspect: MotionAspect; field?: Field; caption?: CaptionStyle }) {
  const frame = useCurrentFrame()
  const { w } = ASPECTS[aspect]
  const fs = fieldStyle[field]
  // Estilo de legenda (8a): fonte + cor + realce dos tokens da marca. Sem estilo →
  // display/fg/accent = idêntico ao render anterior.
  const cap = resolveCaption(caption, motionFallbacks(field))
  const size = Math.max(minType.title, Math.round(w * 0.11))
  const hi = Math.min(Math.max(0, highlightIndex), Math.max(0, words.length - 1))
  const stagger = 7
  const underlineStart = (words.length - 1) * stagger + 12
  const underline = interpolate(frame, [underlineStart, underlineStart + 12], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: easeOut,
  })
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: `${Math.round(size * 0.14)}px ${Math.round(size * 0.28)}px`,
        fontFamily: cap.fontFamily,
        fontWeight: 700,
        fontSize: size,
        lineHeight: 1.02,
        color: cap.color,
      }}
    >
      {words.map((word, i) => {
        const start = i * stagger
        const opacity = interpolate(frame, [start, start + 10], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
        const ty = interpolate(frame, [start, start + 10], [14, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: easeOut,
        })
        const isHi = i === hi
        return (
          <span
            key={i}
            style={{
              position: "relative",
              opacity,
              transform: `translateY(${ty}px)`,
              color: isHi ? cap.highlight : cap.color,
            }}
          >
            {word}
            {isHi && (
              <span
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: -Math.round(size * 0.14),
                  height: Math.max(6, Math.round(size * 0.07)),
                  backgroundColor: cap.highlight,
                  transform: `scaleX(${underline})`,
                  transformOrigin: "left",
                }}
              />
            )}
          </span>
        )
      })}
    </div>
  )
}

// Composition de cena única (compat): <Scene> + corpo, campo escuro como sempre.
export function Headline(
  props: HeadlineProps & {
    aspect: MotionAspect
    brandHandle?: string
    brandLogo?: string
    image?: MotionImage | null
    caption?: CaptionStyle
  },
) {
  return (
    <Scene aspect={props.aspect} field="ink" brandHandle={props.brandHandle} brandLogo={props.brandLogo} image={props.image}>
      <HeadlineBody aspect={props.aspect} field="ink" caption={props.caption} kind="headline" words={props.words} highlightIndex={props.highlightIndex} />
    </Scene>
  )
}
