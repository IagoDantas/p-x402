# demo-web: o p-x402 ao vivo no navegador

Demo visual do protocolo: um **pagador** (agente) compra `GET /loja/relatorio` por R$ 5,00 e um **recebedor** (a loja) vê cada Pix chegar na hora. Nada é encenado: cada clique roda o fluxo x402 v2 de verdade.

```bash
bun run demo:web
```

Abra http://localhost:4030. Sem segredos: o PSP padrão é o mock em memória.

![Fluxo completo](screenshots/fluxo.png)

## O que roda onde

Tudo num processo e numa origem só (`apps/demo-web/src/index.ts`):

| Rota | O quê |
|---|---|
| `/` | a página (HTML import do Bun, que empacota `src/web/main.ts`) |
| `/loja/relatorio` | rota paga, protegida pelo `pixPaywall` de `@p-x402/server` |
| `/facilitator/*` | o facilitator de `apps/facilitator`, com `simulate-payment` ligado |
| `/api/eventos` | Server-Sent Events: chamadas ao facilitator, Pix confirmado, liquidação, saldos |
| `/api/estado`, `/api/reiniciar` | snapshot e reinício dos saldos simulados |

- O **pagador é o navegador**: `wrapFetch` de `@p-x402/client` com `simulatePayer`, política de R$ 10,00 por compra e R$ 50,00 no total. Um `fetch` instrumentado transforma cada request e response (headers `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`, decodificados) em passos da linha do tempo.
- O **servidor** não muda o protocolo: ele só observa. Um wrapper do `ChargeStore` avisa quando o facilitator grava `PAID` (webhook, `/verify` ou `/settle`) e quando a cobrança é consumida; um wrapper do `fetch` da loja mede `/pix/charges`, `/verify` e `/settle`. Tudo vai para o navegador por SSE, sem polling.
- **Latência**: "Pix enviado → loja avisada" vai do instante em que o pagador envia o Pix até o evento SSE chegar à loja, medido no mesmo relógio do navegador. "push SSE" é o trecho servidor → navegador.
- **Saldos** são simulados e só mudam quando o PSP confirma a cobrança (o status do PSP é a verdade). Nenhum dado do pagador é guardado.

Extras: o botão "Banco lento" atrasa a confirmação em 1,5 s para mostrar o `settlement_pending` e as novas tentativas; `?comprar=3` na URL faz 3 compras ao abrir (bom para telão e capturas).

## AbacatePay (opcional)

Com as mesmas variáveis do facilitator:

```bash
PX402_PROVIDER=abacatepay ABACATEPAY_API_KEY=... bun run demo:web
```

O `simulate-payment` usa o modo dev do AbacatePay. Sem webhook o fluxo funciona, só mais lento (o facilitator consulta o PSP a cada tentativa). Com túnel, aponte o webhook para `/facilitator/webhooks/pix` e defina `ABACATEPAY_WEBHOOK_SECRET`. A porta muda com `DEMO_WEB_PORT`.

Só para uso local: qualquer um que alcance a porta pode marcar cobranças como pagas.
