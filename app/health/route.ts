export const runtime = "nodejs"

// GET /health — liveness para o Coolify. O Motor é só API (sem page/layout), então
// `GET /` responde 404 e o health check padrão, que bate na raiz, marcaria o
// container como não-saudável e o proxy recusaria rotear o domínio. Espelha o
// /health da Margot (cmd/server/main.go).
//
// Não toca no banco de propósito: prova que o servidor Node responde, não que o
// Postgres está de pé — um blip do banco não deve derrubar o container web.
export function GET(): Response {
  return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } })
}
