import { Config } from "@remotion/cli/config"

// Render local, MP4 h264. licenseKey vem do serviço de render (env), aqui só o
// estúdio/preview. Mantém a Sapienza na Free License por padrão.
Config.setVideoImageFormat("jpeg")
Config.setCodec("h264")
Config.overrideWebpackConfig((config) => config)
