import React from "react"
import { useCurrentFrame, useVideoConfig, Easing } from "remotion"
import { fieldStyle, fonts, minType, type Field } from "../../../lib/brand/tokens"
import type { SlidesProps, MotionAspect } from "../../../lib/content/motion-types"
import { Scene } from "../brand"
import { ASPECTS } from "../aspects"

// Carrossel em loop: percorre 2–4 slides — hold, transição translateX (Easing.inOut),
// dots sincronizados; termina limpo no último. `SlidesBody` recebe a duração da CENA
// explicitamente (dentro de um <Series.Sequence>, useVideoConfig traria a duração
// TOTAL do vídeo, não a da cena).
export function SlidesBody({
  aspect,
  field = "ink",
  slides,
  durationInFrames,
}: SlidesProps & { aspect: MotionAspect; field?: Field; durationInFrames: number }) {
  const frame = useCurrentFrame()
  const { w } = ASPECTS[aspect]
  const fs = fieldStyle[field]
  const list = slides.slice(0, 4)
  const n = Math.max(list.length, 1)
  const seg = durationInFrames / n
  const raw = frame / seg
  const idx = Math.min(Math.floor(raw), n - 1)
  const frac = raw - idx
  const move = frac < 0.75 ? 0 : (frac - 0.75) / 0.25
  const eased = Easing.inOut(Easing.ease)(Math.min(Math.max(move, 0), 1))
  const pos = Math.min(idx + eased, n - 1)
  const activeDot = Math.round(pos)
  const titleSize = Math.max(minType.title - 6, Math.round(w * 0.08))

  return (
    <div>
      <div style={{ overflow: "hidden", width: "100%" }}>
        <div style={{ display: "flex", width: `${n * 100}%`, transform: `translateX(-${pos * (100 / n)}%)` }}>
          {list.map((s, i) => (
            <div
              key={i}
              style={{
                width: `${100 / n}%`,
                display: "flex",
                flexDirection: "column",
                gap: Math.round(w * 0.03),
                paddingRight: Math.round(w * 0.02),
              }}
            >
              <span
                style={{
                  fontFamily: fonts.mono,
                  fontWeight: 500,
                  fontSize: Math.max(minType.mono, Math.round(w * 0.03)),
                  color: fs.accent,
                  letterSpacing: 2,
                }}
              >
                {String(i + 1).padStart(2, "0")} / {String(n).padStart(2, "0")}
              </span>
              <span
                style={{
                  fontFamily: fonts.display,
                  fontWeight: 700,
                  fontSize: titleSize,
                  lineHeight: 1.05,
                  color: fs.fg,
                }}
              >
                {s.title}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", gap: 14, marginTop: Math.round(w * 0.06) }}>
        {list.map((_, i) => (
          <div
            key={i}
            style={{
              height: 8,
              width: i === activeDot ? 44 : 16,
              borderRadius: 4,
              backgroundColor: i === activeDot ? fs.accent : fs.line,
            }}
          />
        ))}
      </div>
    </div>
  )
}

export function Slides(props: SlidesProps & { aspect: MotionAspect; brandHandle?: string }) {
  const { durationInFrames } = useVideoConfig()
  return (
    <Scene aspect={props.aspect} field="ink" brandHandle={props.brandHandle}>
      <SlidesBody aspect={props.aspect} field="ink" kind="slides" slides={props.slides} durationInFrames={durationInFrames} />
    </Scene>
  )
}
