import React from "react"
import { Composition } from "remotion"
import { MOTION_PRESETS, type MotionPreset, type StoryProps } from "../../lib/content/motion-types"
import { ASPECTS, ALL_ASPECTS, FPS, DEFAULT_DURATION, storyDuration } from "./aspects"
import { MotionPiece, type MotionPieceProps } from "./MotionPiece"
import { SAMPLES } from "./samples"

// Registra os 4 presets × 3 formatos (12 comps) para o studio previsualizar. O id
// é `${preset}-${aspect}` — o serviço de render seleciona por esse id.
export const compositionId = (preset: MotionPreset, aspect: string) => `${preset}-${aspect}`

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
    </>
  )
}
