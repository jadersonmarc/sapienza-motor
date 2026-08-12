import React from "react"
import { Composition } from "remotion"
import { MOTION_PRESETS, type MotionPreset, type StoryProps } from "../../lib/content/motion-types"
import { type ClipAspect } from "../../lib/content/clip-types"
import { ASPECTS, ALL_ASPECTS, FPS, DEFAULT_DURATION, storyDuration } from "./aspects"
import { MotionPiece, type MotionPieceProps } from "./MotionPiece"
import { ClipComposition, CLIP_ASPECTS, type ClipCompProps } from "./compositions/Clip"
import { SAMPLES } from "./samples"

// Registra os 4 presets × 3 formatos (12 comps) para o studio previsualizar. O id
// é `${preset}-${aspect}` — o serviço de render seleciona por esse id.
export const compositionId = (preset: MotionPreset, aspect: string) => `${preset}-${aspect}`

// Id da composição de clipe por aspecto — o clip-worker seleciona por `clip-${aspect}`.
export const clipCompositionId = (aspect: ClipAspect) => `clip-${aspect}`
const CLIP_ALL: ClipAspect[] = ["9x16", "16x9"]

// Sample de clipe (só para o studio; o render sempre passa inputProps reais).
const CLIP_SAMPLE: ClipCompProps["clip"] = {
  sourceKey: "",
  inMs: 0,
  outMs: 8000,
  aspect: "9x16",
  caption: { position: "bottom" },
  words: [
    { text: "Você", startMs: 0, endMs: 400 },
    { text: "está", startMs: 400, endMs: 800 },
    { text: "errando", startMs: 800, endMs: 1300 },
    { text: "na", startMs: 1300, endMs: 1500 },
    { text: "retenção", startMs: 1500, endMs: 2200 },
  ],
  openingCard: { words: ["Você", "está", "errando"], highlightIndex: 2 },
  brandOn: true,
  score: 90,
}

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {MOTION_PRESETS.map((preset) =>
        ALL_ASPECTS.map((aspect) => {
          const { w, h } = ASPECTS[aspect]
          // `story` tem duração content-aware (soma das cenas), resolvida no render
          // por selectComposition; os presets de cena única mantêm a duração fixa.
          const isStory = preset === "story"
          return (
            <Composition
              key={compositionId(preset, aspect)}
              id={compositionId(preset, aspect)}
              component={MotionPiece}
              width={w}
              height={h}
              fps={FPS}
              durationInFrames={DEFAULT_DURATION}
              calculateMetadata={
                isStory
                  ? ({ props }: { props: MotionPieceProps }) => ({
                      durationInFrames: storyDuration((props.data as StoryProps).scenes),
                    })
                  : undefined
              }
              defaultProps={{ aspect, brandHandle: "@sapienzalabs", data: SAMPLES[preset] }}
            />
          )
        }),
      )}
      {CLIP_ALL.map((aspect) => {
        const { w, h } = CLIP_ASPECTS[aspect]
        return (
          <Composition
            key={clipCompositionId(aspect)}
            id={clipCompositionId(aspect)}
            component={ClipComposition}
            width={w}
            height={h}
            fps={FPS}
            durationInFrames={Math.round((CLIP_SAMPLE.outMs / 1000) * FPS)}
            // Duração real = janela do corte (out-in); resolvida no render por selectComposition.
            calculateMetadata={({ props }: { props: ClipCompProps }) => ({
              durationInFrames: Math.max(FPS, Math.round(((props.clip.outMs - props.clip.inMs) / 1000) * FPS)),
            })}
            defaultProps={{ aspect, sourceUrl: "", brandHandle: "@sapienzalabs", clip: { ...CLIP_SAMPLE, aspect } }}
          />
        )
      })}
    </>
  )
}
