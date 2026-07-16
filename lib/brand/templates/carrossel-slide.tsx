import type { Format } from "../formats"
import { fieldStyle, fonts, minType, type Field } from "../tokens"
import { Frame } from "./signature"

export interface CarrosselSlideProps {
  format: Format
  field: Field
  /** posição real na sequência (1..total) */
  index: number
  total: number
  /** tag do trilho (ex.: `SÉRIE`, `ENG/AI`) */
  eyebrow: string
  /** capa/cta usam título Bricolage com sublinhado; corpo usa frase Plex Sans. */
  kind: "cover" | "body" | "cta"
  /** título (cover/cta) ou frase de apoio (body) */
  text: string
}

// Arquétipo carrossel-slide: cabeçalho e trilho consistentes; numeração real
// `n / total` no rodapé; dica de navegação (SWIPE/CTA) à direita.
export function CarrosselSlide({ format, field, index, total, eyebrow, kind, text }: CarrosselSlideProps) {
  const c = fieldStyle[field]
  const seq = `${String(index).padStart(2, "0")} / ${String(total).padStart(2, "0")}`
  const hint = index === total ? "CTA" : index === 1 ? "SWIPE →" : ""

  const titlePx = Math.max(minType.title, Math.round(format.w * 0.06))
  const bodyPx = Math.max(minType.support, Math.round(format.w * 0.038))
  const ruleH = Math.max(4, Math.round(format.w * 0.006))

  return (
    <Frame format={format} field={field} eyebrow={eyebrow} footer={seq} footerRight={hint}>
      <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, justifyContent: "flex-end" }}>
        {kind === "body" ? (
          <div
            style={{
              display: "flex",
              fontFamily: fonts.sans,
              fontWeight: 500,
              fontSize: bodyPx,
              lineHeight: 1.3,
              maxWidth: Math.round(format.w * 0.9),
              color: c.fg,
            }}
          >
            {text}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div
              style={{
                display: "flex",
                fontFamily: fonts.display,
                fontWeight: 700,
                fontSize: titlePx,
                lineHeight: 1.04,
                letterSpacing: -Math.round(titlePx * 0.02),
                maxWidth: Math.round(format.w * 0.9),
                color: c.fg,
              }}
            >
              {text}
            </div>
            <div
              style={{
                display: "flex",
                marginTop: Math.round(titlePx * 0.3),
                width: Math.round(titlePx * 1.6),
                height: ruleH,
                borderRadius: ruleH,
                backgroundColor: c.accent,
              }}
            />
          </div>
        )}
      </div>
    </Frame>
  )
}
