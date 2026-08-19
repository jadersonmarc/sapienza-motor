import React from "react"
import type { MotionAspect, MotionImage, MotionProps } from "../../lib/content/motion-types"
import type { CaptionStyle } from "../../lib/content/caption-style"
import { Headline } from "./compositions/Headline"
import { Quote } from "./compositions/Quote"
import { Slides } from "./compositions/Slides"
import { Stat } from "./compositions/Stat"
import { Story } from "./compositions/Story"

// Despacha para a composition do preset. `data.kind` estreita o tipo — cada preset
// recebe exatamente seus campos. `image` (opcional) desce até o <Scene> — os *Body
// não a veem (a imagem entra só na camada de fundo).
export type MotionPieceProps = {
  aspect: MotionAspect
  brandHandle?: string
  brandLogo?: string
  image?: MotionImage | null
  caption?: CaptionStyle
  data: MotionProps
}

export const MotionPiece: React.FC<MotionPieceProps> = ({ aspect, brandHandle, brandLogo, image, caption, data }) => {
  switch (data.kind) {
    case "headline":
      return <Headline aspect={aspect} brandHandle={brandHandle} brandLogo={brandLogo} image={image} caption={caption} {...data} />
    case "quote":
      return <Quote aspect={aspect} brandHandle={brandHandle} brandLogo={brandLogo} image={image} caption={caption} {...data} />
    case "slides":
      return <Slides aspect={aspect} brandHandle={brandHandle} brandLogo={brandLogo} image={image} caption={caption} {...data} />
    case "stat":
      return <Stat aspect={aspect} brandHandle={brandHandle} brandLogo={brandLogo} image={image} caption={caption} {...data} />
    case "story":
      return <Story aspect={aspect} brandHandle={brandHandle} brandLogo={brandLogo} image={image} caption={caption} {...data} />
  }
}
