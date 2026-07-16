import type { Format } from "../formats"
import { fieldStyle, fonts, type Field } from "../tokens"
import { Frame } from "./signature"

export interface DiagramaNode {
  label: string
  /** nó-chave: ganha o acento petróleo (apenas um por peça). */
  key?: boolean
}

export interface DiagramaProps {
  format: Format
  field: Field
  eyebrow: string
  /** nós em fluxo horizontal, ligados por setas. */
  nodes: DiagramaNode[]
  footer: string
}

// Arquétipo diagrama/esquema: nós com rótulos mono ligados por setas;
// um único nó-chave em petróleo; traços em line/lineDark.
export function Diagrama({ format, field, eyebrow, nodes, footer }: DiagramaProps) {
  const c = fieldStyle[field]
  const labelPx = Math.max(20, Math.round(format.w * 0.026))
  const nodeW = Math.round(format.w * 0.24)
  const nodeH = Math.round(format.w * 0.11)
  const arrowPx = Math.round(format.w * 0.04)

  return (
    <Frame format={format} field={field} eyebrow={eyebrow} footer={footer} footerRight="ESQUEMA">
      <div style={{ display: "flex", flexGrow: 1, alignItems: "center", justifyContent: "center" }}>
        {nodes.map((n, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center" }}>
            {i > 0 ? (
              <div
                style={{
                  display: "flex",
                  fontFamily: fonts.mono,
                  fontSize: arrowPx,
                  // setas sempre neutras: o único acento é o nó-chave.
                  color: c.line,
                  paddingLeft: Math.round(format.w * 0.012),
                  paddingRight: Math.round(format.w * 0.012),
                }}
              >
                →
              </div>
            ) : null}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: nodeW,
                height: nodeH,
                borderRadius: Math.round(format.w * 0.01),
                border: `${n.key ? 2 : 1.5}px solid ${n.key ? c.accent : c.line}`,
                fontFamily: fonts.mono,
                fontWeight: 500,
                fontSize: labelPx,
                letterSpacing: labelPx * 0.04,
                textTransform: "uppercase",
                color: n.key ? c.accent : c.fg,
              }}
            >
              {n.label}
            </div>
          </div>
        ))}
      </div>
    </Frame>
  )
}
