import React from "react"
import { Series, Audio, staticFile, useCurrentFrame, useVideoConfig, interpolate } from "remotion"
import type { Field } from "../../../lib/brand/tokens"
import type { MotionAspect, MotionScene, SceneBlock, StoryProps } from "../../../lib/content/motion-types"
import { trackFor } from "../../../lib/content/motion-audio"
import { Scene } from "../brand"
import { framesForSec } from "../aspects"
import { HeadlineBody } from "./Headline"
import { QuoteBody } from "./Quote"
import { SlidesBody } from "./Slides"
import { StatBody } from "./Stat"
import { StatementBody } from "./Statement"
import { CtaBody } from "./Cta"

// Roteiro multi-cena: um único <Scene> (fundo on-brand + rodapé) contendo um
// <Series> de cenas. Cada cena é um bloco reusado dos presets de cena única, com o
// campo cromático do story. layout="none" mantém o bloco no fluxo (centralizado)
// do Scene, sem sobrepor o rodapé. Um drift sutil evita "tela congelada".

function BlockBody({ block, aspect, field, frames }: { block: SceneBlock; aspect: MotionAspect; field: Field; frames: number }) {
  switch (block.kind) {
    case "headline":
      return <HeadlineBody aspect={aspect} field={field} kind="headline" words={block.words} highlightIndex={block.highlightIndex} />
    case "quote":
      return <QuoteBody aspect={aspect} field={field} kind="quote" quote={block.quote} keyphrase={block.keyphrase} author={block.author} />
    case "slides":
      return <SlidesBody aspect={aspect} field={field} kind="slides" slides={block.slides} durationInFrames={frames} />
    case "stat":
      return (
        <StatBody
          aspect={aspect}
          field={field}
          kind="stat"
          label={block.label}
          value={block.value}
          suffix={block.suffix}
          subtitle={block.subtitle}
          source={block.source}
        />
      )
    case "statement":
      return <StatementBody aspect={aspect} field={field} kind="statement" label={block.label} text={block.text} />
    case "cta":
      return <CtaBody aspect={aspect} field={field} kind="cta" text={block.text} handle={block.handle} />
  }
}

// Deriva sutil de permanência: leve subida (parallax) ao longo da cena — o vídeo
// nunca fica totalmente parado depois da animação de entrada.
function Drift({ frames, children }: { frames: number; children: React.ReactNode }) {
  const frame = useCurrentFrame()
  const y = interpolate(frame, [0, frames], [0, -10], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  return <div style={{ transform: `translateY(${y}px)`, width: "100%" }}>{children}</div>
}

function StoryScenes({ scenes, aspect, field }: { scenes: MotionScene[]; aspect: MotionAspect; field: Field }) {
  const { fps } = useVideoConfig()
  return (
    <Series>
      {scenes.map((s, i) => {
        const frames = Math.max(1, Math.round(s.durSec * fps))
        return (
          <Series.Sequence key={i} durationInFrames={frames} layout="none">
            <Drift frames={frames}>
              <BlockBody block={s.block} aspect={aspect} field={field} frames={frames} />
            </Drift>
          </Series.Sequence>
        )
      })}
    </Series>
  )
}

// Trilha da peça: toca a faixa do mood por todo o vídeo, com fade-in/out suave. O
// worker só deixa `audio` != none quando o arquivo existe em public/audio (seam),
// então aqui é seguro referenciar staticFile.
function Soundtrack({ file }: { file: string }) {
  const { durationInFrames, fps } = useVideoConfig()
  const fade = Math.min(15, Math.round(fps * 0.5))
  return (
    <Audio
      src={staticFile(`audio/${file}`)}
      volume={(f) =>
        interpolate(f, [0, fade, Math.max(fade, durationInFrames - fade), durationInFrames], [0, 0.7, 0.7, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
      }
    />
  )
}

export function Story({
  aspect,
  brandHandle,
  scenes,
  theme = "ink",
  audio = "none",
}: StoryProps & { aspect: MotionAspect; brandHandle?: string }) {
  const track = trackFor(audio)
  return (
    <Scene aspect={aspect} field={theme} brandHandle={brandHandle}>
      {track ? <Soundtrack file={track.file} /> : null}
      <StoryScenes scenes={scenes} aspect={aspect} field={theme} />
    </Scene>
  )
}

// Duração total (frames) do roteiro — para o calculateMetadata da composition.
export function totalStoryFrames(scenes: { durSec: number }[]): number {
  return scenes.reduce((acc, s) => acc + framesForSec(s.durSec), 0)
}
