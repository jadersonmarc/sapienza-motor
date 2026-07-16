import type { Format } from "../formats"
import { fieldStyle, fonts, minType, scrim } from "../tokens"
import { Frame } from "./signature"

export interface BastidoresProps {
  format: Format
  /** foto enviada pelo Marc (URL R2 ou data URI). */
  imageUrl: string
  /** legenda mono curta */
  caption: string
  eyebrow?: string
  footer?: string
}

// Arquétipo bastidores: foto real full-bleed, esfriada/escurecida por overlay
// sólido (sem gradiente), com a assinatura (trilho + crop) e legenda mono por cima.
// Sempre campo ink — texto off-white, acento petrol-soft.
export function Bastidores({ format, imageUrl, caption, eyebrow = "BASTIDORES", footer = "SAPIENZA LABS" }: BastidoresProps) {
  const c = fieldStyle.ink
  const captionPx = Math.max(minType.support, Math.round(format.w * 0.03))

  const backdrop = (
    <div style={{ position: "absolute", top: 0, left: 0, width: format.w, height: format.h, display: "flex" }}>
      {/* Satori rende para PNG; não é <img> de DOM (next/image e alt não se aplicam). */}
      {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text */}
      <img
        src={imageUrl}
        width={format.w}
        height={format.h}
        style={{ objectFit: "cover", filter: "grayscale(1) contrast(1.05) brightness(0.85)" }}
      />
      {/* overlay sólido ink p/ esfriar a foto e garantir legibilidade (sem gradiente) */}
      <div style={{ position: "absolute", top: 0, left: 0, width: format.w, height: format.h, display: "flex", backgroundColor: scrim.ink }} />
    </div>
  )

  return (
    <Frame format={format} field="ink" eyebrow={eyebrow} footer={footer} footerRight="NO ESTÚDIO" backdrop={backdrop}>
      <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, justifyContent: "flex-end" }}>
        <div
          style={{
            display: "flex",
            fontFamily: fonts.mono,
            fontWeight: 500,
            fontSize: captionPx,
            lineHeight: 1.4,
            maxWidth: Math.round(format.w * 0.82),
            color: c.fg,
          }}
        >
          {caption}
        </div>
      </div>
    </Frame>
  )
}
