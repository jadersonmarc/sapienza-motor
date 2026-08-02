import type { MotionPreset, MotionProps } from "../../lib/content/motion-types"

// Dados de EXEMPLO só para o studio/sample (inspeção visual). Nada disto vai para
// produção — em produção os campos vêm da geração a partir do brief do tenant.
export const SAMPLES: Record<MotionPreset, MotionProps> = {
  headline: { kind: "headline", words: ["Automatize", "o", "atendimento"], highlightIndex: 0 },
  quote: {
    kind: "quote",
    quote: "A IA não substitui o seu time — devolve o tempo dele.",
    keyphrase: "devolve o tempo",
    author: "Sapienza Labs",
  },
  slides: {
    kind: "slides",
    slides: [
      { index: 0, title: "Capte o lead" },
      { index: 1, title: "Responda na hora" },
      { index: 2, title: "Feche a venda" },
    ],
  },
  stat: {
    kind: "stat",
    label: "Tempo de resposta",
    value: 42,
    suffix: "%",
    subtitle: "de redução no primeiro mês",
    source: "exemplo (studio)",
  },
  story: {
    kind: "story",
    theme: "ink",
    scenes: [
      { role: "hook", durSec: 1.6, block: { kind: "headline", words: ["Perde", "cliente", "por", "demora?"], highlightIndex: 3 } },
      {
        role: "develop",
        durSec: 3.6,
        block: {
          kind: "slides",
          slides: [
            { index: 0, title: "Capte o lead" },
            { index: 1, title: "Responda na hora" },
            { index: 2, title: "Feche a venda" },
          ],
        },
      },
      { role: "cta", durSec: 2, block: { kind: "cta", text: "Fale com a gente" } },
    ],
  },
}
