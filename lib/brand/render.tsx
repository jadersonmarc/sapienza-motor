import { ImageResponse } from "next/og"
import type { ReactElement } from "react"
import type { Format } from "./formats"
import { ogFonts } from "./fonts"

// Renderer base: JSX de arquétipo → PNG no tamanho do formato, com as
// fontes da marca embutidas. Determinístico (mesma entrada → mesmo PNG).
export function renderBrandImage(
  format: Format,
  node: ReactElement,
  init?: { headers?: Record<string, string> },
): ImageResponse {
  return new ImageResponse(node, {
    width: format.w,
    height: format.h,
    fonts: ogFonts,
    headers: init?.headers,
  })
}
