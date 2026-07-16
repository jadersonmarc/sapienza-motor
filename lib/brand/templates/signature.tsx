import type { ReactNode } from "react"
import type { Format } from "../formats"
import { fieldStyle, fonts, type Field } from "../tokens"
import { metrics } from "./metrics"

// Assinatura obrigatória de toda peça: moldura com margem segura, trilho
// monospace (eyebrow no topo, metadado no rodapé) e a marca de registro.
export function Frame({
  format,
  field,
  eyebrow,
  footer,
  footerRight = "sapienzalabs.com.br",
  backdrop,
  children,
}: {
  format: Format
  field: Field
  /** topo-esquerda: `{TAG} · {ÍNDICE}` */
  eyebrow: string
  /** rodapé-esquerda: metadado (marca/local) */
  footer: string
  /** rodapé-direita (default: domínio). Ex.: `01 / 06`, `SWIPE →`. */
  footerRight?: string
  /** camada full-bleed atrás do conteúdo (ex.: foto de bastidores). */
  backdrop?: ReactNode
  children: ReactNode
}) {
  const c = fieldStyle[field]
  const { margin, safeY, mono } = metrics(format)

  return (
    <div
      style={{
        width: format.w,
        height: format.h,
        position: "relative",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        backgroundColor: c.bg,
        color: c.fg,
        fontFamily: fonts.sans,
        paddingTop: margin + safeY,
        paddingBottom: margin + safeY,
        paddingLeft: margin,
        paddingRight: margin,
      }}
    >
      {backdrop}

      {/* marca de registro — canto superior direito, 1.5px */}
      <div
        style={{
          position: "absolute",
          top: margin,
          right: margin,
          width: 22,
          height: 22,
          display: "flex",
          borderTop: `1.5px solid ${c.accent}`,
          borderRight: `1.5px solid ${c.accent}`,
        }}
      />

      {/* trilho mono — eyebrow */}
      <div
        style={{
          display: "flex",
          fontFamily: fonts.mono,
          fontWeight: 500,
          fontSize: mono,
          letterSpacing: mono * 0.12,
          textTransform: "uppercase",
          color: c.accent,
        }}
      >
        {eyebrow}
      </div>

      {children}

      {/* metadado rodapé */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontFamily: fonts.mono,
          fontWeight: 500,
          fontSize: mono,
          letterSpacing: mono * 0.12,
          textTransform: "uppercase",
          color: c.fg,
          opacity: 0.68,
        }}
      >
        <div style={{ display: "flex" }}>{footer}</div>
        <div style={{ display: "flex" }}>{footerRight}</div>
      </div>
    </div>
  )
}
