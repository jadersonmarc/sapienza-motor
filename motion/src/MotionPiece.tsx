import React from "react"
import type { MotionAspect, MotionProps } from "../../lib/content/motion-types"
import { Headline } from "./compositions/Headline"
import { Quote } from "./compositions/Quote"
import { Slides } from "./compositions/Slides"
import { Stat } from "./compositions/Stat"
import { Story } from "./compositions/Story"

// Despacha para a composition do preset. `data.kind` estreita o tipo — cada preset
// recebe exatamente seus campos.
export type MotionPieceProps = {
  aspect: MotionAspect
  brandHandle?: string
  brandLogo?: string
  data: MotionProps
}

export const MotionPiece: React.FC<MotionPieceProps> = ({ aspect, brandHandle, brandLogo, data }) => {
  switch (data.kind) {
    case "headline":
      return <Headline aspect={aspect} brandHandle={brandHandle} brandLogo={brandLogo} {...data} />
    case "quote":
      return <Quote aspect={aspect} brandHandle={brandHandle} brandLogo={brandLogo} {...data} />
    case "slides":
      return <Slides aspect={aspect} brandHandle={brandHandle} brandLogo={brandLogo} {...data} />
    case "stat":
      return <Stat aspect={aspect} brandHandle={brandHandle} brandLogo={brandLogo} {...data} />
    case "story":
      return <Story aspect={aspect} brandHandle={brandHandle} brandLogo={brandLogo} {...data} />
  }
}
