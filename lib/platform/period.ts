// Convenção de período de uso/cobrança = mês-calendário em America/Sao_Paulo
// (BRT). Espelha sapienza-core/lib/billing/period.ts e o kit Go (period.Current):
// quem emite UsageRecorded precisa usar o MESMO fuso que o gating/fechamento lê,
// senão uma peça publicada perto da virada do mês cai em outro período.

const YM = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo",
  year: "numeric",
  month: "2-digit",
})

/** Período corrente "AAAA-MM" no fuso de São Paulo. */
export function currentPeriod(now: Date = new Date()): string {
  const parts = YM.formatToParts(now)
  const y = parts.find((p) => p.type === "year")!.value
  const m = parts.find((p) => p.type === "month")!.value
  return `${y}-${m}`
}
