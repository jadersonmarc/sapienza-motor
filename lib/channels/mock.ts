import type { Channel, Platform, PublishInput } from "./types"

// Captura publicações em vez de chamar APIs externas — usado nos testes.
export class MockChannel implements Channel {
  readonly published: { platform: Platform; input: PublishInput }[] = []
  constructor(readonly platform: Platform) {}
  async publish(input: PublishInput): Promise<{ url: string }> {
    this.published.push({ platform: this.platform, input })
    return { url: `mock://${this.platform}/${input.slug}` }
  }
}
