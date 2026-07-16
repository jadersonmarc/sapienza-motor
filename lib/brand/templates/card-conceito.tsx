import type { Format } from "../formats"
import { fieldStyle, fonts, minType, type Field } from "../tokens"
import { Frame } from "./signature"

export interface CardConceitoProps {
  format: Format
  field: Field
  /** `{TAG} · {ÍNDICE}` do trilho (ex.: `INSIGHT · 02`) */
  eyebrow: string
  /** uma frase/dado — o herói da peça */
  phrase: string
  footer: string
}

// Arquétipo card-conceito: uma ideia, muito vazio, alto contraste. Frase
// Bricolage centralizada com aspas petróleo como único acento (sem sublinhado).
export function CardConceito({ format, field, eyebrow, phrase, footer }: CardConceitoProps) {
  const c = fieldStyle[field]
  const big = Math.round(format.w * 0.062)
  const px = Math.max(
    minType.title,
    phrase.length > 80 ? Math.round(big * 0.7) : phrase.length > 48 ? Math.round(big * 0.85) : big,
  )

  return (
    <Frame format={format} field={field} eyebrow={eyebrow} footer={footer}>
      <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, justifyContent: "center" }}>
        <div
          style={{
            display: "flex",
            fontFamily: fonts.display,
            fontWeight: 700,
            fontSize: Math.round(px * 1.5),
            lineHeight: 1,
            color: c.accent,
            marginBottom: -Math.round(px * 0.1),
          }}
        >
          “
        </div>
        <div
          style={{
            display: "flex",
            fontFamily: fonts.display,
            fontWeight: 700,
            fontSize: px,
            lineHeight: 1.08,
            letterSpacing: -Math.round(px * 0.02),
            maxWidth: Math.round(format.w * 0.9),
            color: c.fg,
          }}
        >
          {phrase}
        </div>
      </div>
    </Frame>
  )
}
