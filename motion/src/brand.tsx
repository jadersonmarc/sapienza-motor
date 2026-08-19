import React from "react"
import { AbsoluteFill, Img, useCurrentFrame, interpolate, Easing } from "remotion"
import { fieldStyle, fonts, type Field } from "../../lib/brand/tokens"
import type { MotionAspect, MotionImage } from "../../lib/content/motion-types"
import { ASPECTS } from "./aspects"
import "./fonts"

/** hex (#RRGGBB) → rgba com opacidade. Usado no scrim (tinta = cor do campo). */
function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "")
  const n = parseInt(h.length === 3 ? h.replace(/(.)/g, "$1$1") : h, 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

// Cena base on-brand: campo (ink/surface) dos tokens, margens seguras por aspect,
// e o rodapé de marca (handle + marca gráfica) — que entra cedo (~frame 8) e fica.
// Cor/tipografia SEMPRE de ../../lib/brand/tokens (nada hardcoded).

export const easeOut = Easing.out(Easing.cubic)

export function safePad(w: number): number {
  return Math.round(w * 0.083) // ~90px em 1080
}

export function Scene({
  aspect,
  field = "ink",
  brandHandle = "@sapienzalabs",
  brandLogo = "",
  image = null,
  children,
}: {
  aspect: MotionAspect
  field?: Field
  brandHandle?: string
  brandLogo?: string
  /** Imagem de fundo opcional (item 7). Fica atrás de um scrim adaptativo; o texto
   *  nunca toca a imagem crua. Sem imagem, o campo chapado de sempre. */
  image?: MotionImage | null
  children: React.ReactNode
}) {
  const { w } = ASPECTS[aspect]
  const fs = fieldStyle[field]
  const pad = safePad(w)
  return (
    <AbsoluteFill style={{ backgroundColor: fs.bg }}>
      {image ? (
        <>
          {/* cover = corte central (não distorce), independente da proporção do destino. */}
          <AbsoluteFill>
            <Img src={image.url} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          </AbsoluteFill>
          {/* scrim on-brand (tinta do campo) com opacidade ADAPTATIVA por luminância. */}
          <AbsoluteFill style={{ backgroundColor: hexToRgba(fs.bg, image.scrimOpacity) }} />
        </>
      ) : null}
      <AbsoluteFill style={{ padding: pad, display: "flex", flexDirection: "column" }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center" }}>
          {children}
        </div>
        <BrandFooter field={field} handle={brandHandle} logo={brandLogo} />
      </AbsoluteFill>
    </AbsoluteFill>
  )
}

// Inicial da marca a partir do handle (strip @, 1º alfanumérico, maiúsculo). É o
// monograma quando não há logo — do CLIENTE, não da Sapienza.
function brandInitial(handle: string): string {
  const m = handle.replace(/^@+/, "").match(/[a-zA-Z0-9]/)
  return (m?.[0] ?? "S").toUpperCase()
}

function BrandFooter({ field, handle, logo = "" }: { field: Field; handle: string; logo?: string }) {
  const frame = useCurrentFrame()
  const fs = fieldStyle[field]
  const opacity = interpolate(frame, [8, 24], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const y = interpolate(frame, [8, 24], [10, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeOut })
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        opacity,
        transform: `translateY(${y}px)`,
        borderTop: `2px solid ${fs.line}`,
        paddingTop: 22,
      }}
    >
      {logo ? (
        // Logo do tenant (o worker só passa uma URL https acessível).
        <Img src={logo} style={{ height: 44, width: "auto", maxWidth: 200, objectFit: "contain", borderRadius: 8 }} />
      ) : (
        // Fallback: monograma com a inicial da marca (bloco de acento, tokens).
        <div
          style={{
            width: 40,
            height: 40,
            backgroundColor: fs.accent,
            borderRadius: 8,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: fs.bg,
            fontFamily: fonts.display,
            fontWeight: 700,
            fontSize: 26,
            lineHeight: 1,
          }}
        >
          {brandInitial(handle)}
        </div>
      )}
      <span style={{ fontFamily: fonts.mono, fontWeight: 500, fontSize: 26, color: fs.fg, letterSpacing: 0.5 }}>
        {handle}
      </span>
    </div>
  )
}
