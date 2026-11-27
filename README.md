# p-x402

> Pagamentos HTTP nativos via **Pix**, no padrão do protocolo [x402](https://x402.org/).

**Status:** em desenvolvimento para o **Hack Brasil 2026**, trilha *Pagamentos & finanças*. Este README descreve a arquitetura e o plano do SDK; os pacotes ainda não foram publicados. A primeira versão funcional (ida e volta `402 → Pix → 200` local, com PSP mock) já roda: veja [Como executar](#como-executar). Problema, motivação e escopo do hackathon estão em [`docs/README.MD`](docs/README.MD).

O `p-x402` implementa o protocolo x402 (v2) com o Pix como meio de pagamento. Uma API responde `402 Payment Required` com uma cobrança Pix; o cliente (uma pessoa ou um agente de IA) paga e repete a requisição com a prova do pagamento. O código de quem consome a API faz só uma chamada HTTP comum.

---

## Sumário

- [Por que Pix é diferente](#por-que-pix-é-diferente)
- [Como funciona](#como-funciona)
  - [Atores](#atores)
  - [Configuração](#configuração-uma-vez)
  - [Uma compra, passo a passo](#uma-compra-passo-a-passo)
  - [Para onde vai o dinheiro](#para-onde-vai-o-dinheiro)
  - [Quando algo dá errado](#quando-algo-dá-errado)
  - [Tempo](#tempo)
- [Segurança no `/settle`](#segurança-no-settle)
- [SDK](#sdk)
  - [Pacotes TypeScript](#pacotes-typescript)
  - [Uso](#uso)
  - [Princípios](#princípios)
- [SDKs em várias linguagens](#sdks-em-várias-linguagens)
- [Layout do repositório](#layout-do-repositório)
- [Como executar](#como-executar)
- [Schemes](#schemes)
- [Roadmap](#roadmap)
- [Referências](#referências)

---

## Por que Pix é diferente

No x402 com cripto (scheme `exact` em EVM), o cliente **assina offline** uma autorização (EIP-3009) e o facilitator executa a transferência. É um modelo *pull*.

O Pix funciona como *push*: quem paga precisa iniciar a transferência pelo próprio banco ou PSP. Daí vêm as adaptações:

| Diferença | Consequência no p-x402 |
|---|---|
| Não existe uma "assinatura de pagamento" portátil | O `payload` leva uma **prova de que o pagamento já foi feito** (o `chargeId` da cobrança), não uma assinatura |
| Cada pagamento precisa de uma cobrança nova (brCode único) | O facilitator ganha um endpoint extra, `POST /pix/charges`, chamado ao montar cada 402 |
| A liquidação acontece antes de entregar o recurso | Usa `paymentFlow: "upfront"` da spec v2 |
| Há tarifa fixa por Pix e valor mínimo (AbacatePay: R$ 0,80 e R$ 1,00) | O scheme A serve para cobranças a partir de uns R$ 5. Micropagamentos ficam para o [scheme B](#schemes) |
| Existe o MED (devolução em caso de fraude) | O facilitator acompanha disputas e estornos via webhook e o `/settle` passa a recusar a cobrança |

A spec v2 do x402 já prevê redes que não são blockchain: `asset` aceita código ISO 4217 (`"BRL"`) e `network` segue o formato CAIP-2. Por isso a rede aqui é **`pix:br`**.

---

## Como funciona

### Atores

```
   COMPRADOR                      VENDEDOR                       FACILITATOR                 PSP
 (app ou agente)              (API que cobra)               (serviço único, em TS)
 ┌──────────────┐            ┌──────────────┐               ┌──────────────────┐        ┌────────────┐
 │ Python agent │            │ Spring Boot  │               │ /pix/charges     │        │ AbacatePay │
 │ + p-x402     │◀──HTTP────▶│ + p-x402-java│◀────HTTP─────▶│ /settle /verify  │◀──────▶│            │
 │   (client)   │            │   (server)   │   token do    │ /webhooks        │  chave │            │
 └──────┬───────┘            └──────────────┘   vendedor    │ banco: charges   │  da API└─────┬──────┘
        │                                                   └──────────────────┘              │
        └───────────────── paga o Pix (QR / app do banco / API bancária) ────────────────────▶┘
```

- **SDK do comprador:** recebe o 402, aplica a policy de gasto, paga o Pix e refaz a requisição com a prova.
- **SDK do vendedor:** responde 402 e chama o facilitator. Não conhece o PSP e não tem banco de dados.
- **Facilitator:** cria as cobranças, confirma os pagamentos e impede que um pagamento seja usado duas vezes. É o **único** que tem a chave do PSP.
- **PSP:** emite a cobrança Pix e avisa via webhook quando ela é paga. O primeiro é o [AbacatePay](https://docs.abacatepay.com/).

### Configuração (uma vez)

1. O operador sobe o facilitator com a chave do AbacatePay e cadastra o webhook `transparent.completed`.
2. O vendedor recebe um **token** do facilitator e instala o SDK da linguagem dele:
   ```java
   @GetMapping("/relatorio")
   @PixPaywall(amount = 500, description = "Relatório PDF")
   public Relatorio relatorio() { ... }
   ```
3. O comprador instala o SDK cliente e define quanto aceita gastar:
   ```python
   client = httpx.Client(transport=px402.Transport(payer=meu_payer, max_per_request=1000))
   ```

### Uma compra, passo a passo

Exemplo: um agente em Python compra um relatório de uma API em Java por **R$ 5,00**.

**① O agente pede o recurso, sem saber que é pago.**

```http
GET /relatorio HTTP/1.1
Host: api.loja.com.br
```

**② O SDK do vendedor intercepta a rota protegida e pede uma cobrança ao facilitator.**

```http
POST /pix/charges
Authorization: Bearer <token da loja>

{ "resource": { "url": "https://api.loja.com.br/relatorio" }, "amount": "500" }
```

O facilitator chama `POST /v2/transparents/create` no AbacatePay, grava no banco a ligação entre `pix_char_abc`, a loja, esse recurso e R$ 5,00, e devolve os requisitos já prontos.

**③ O vendedor responde 402.**

```http
HTTP/1.1 402 Payment Required
PAYMENT-REQUIRED: eyJ4NDAyVmVyc2lvbiI6Mi...   (JSON em base64)
```

Decodificado:

```json
{
  "x402Version": 2,
  "resource": { "url": "https://api.loja.com.br/relatorio", "description": "Relatório PDF" },
  "accepts": [{
    "scheme": "exact",
    "network": "pix:br",
    "asset": "BRL",
    "amount": "500",
    "payTo": "loja_123",
    "maxTimeoutSeconds": 300,
    "extra": {
      "paymentFlow": "upfront",
      "assetTransferMethod": "pix-charge",
      "provider": "abacatepay",
      "resourceUrl": "https://api.loja.com.br/relatorio",
      "chargeId": "pix_char_abc",
      "brCode": "00020126...",
      "expiresAt": "2026-11-25T15:10:00Z"
    }
  }]
}
```

**④ O SDK do comprador decide se paga, sem envolver o código do agente.**

- Confere a policy: o valor cabe no limite por requisição e no orçamento total? O domínio está na lista permitida?
- Chama o `payer` configurado, que pode:
  - mostrar o QR para uma pessoa pagar no app do banco;
  - pagar via API bancária, no caso de um agente autônomo;
  - chamar `simulate-payment`, em desenvolvimento.

**⑤ O Pix é liquidado.** O AbacatePay manda o webhook `transparent.completed` ao facilitator, que confere o status no PSP. O comprador não consulta o facilitator: se refizer a requisição antes da confirmação, recebe `402` com a **mesma** cobrança, `errorReason: "settlement_pending"` no `PAYMENT-RESPONSE` e `Retry-After: 2`, e repete com backoff até a cobrança expirar.

**⑥ O SDK do comprador refaz a requisição com a prova.**

```http
GET /relatorio HTTP/1.1
PAYMENT-SIGNATURE: eyJ4NDAyVmVyc2lvbiI6Mi...
```

Decodificado:

```json
{ "x402Version": 2, "accepted": { "...": "requisitos recebidos no 402" }, "payload": { "chargeId": "pix_char_abc" } }
```

**⑦ O SDK do vendedor verifica o pagamento, executa o handler e só então liquida.**

A ordem é `POST /verify` (todas as verificações, sem alterar nada) → handler da rota → `POST /settle` (só se o handler respondeu sem erro). Se o handler falhar, a cobrança continua paga e não consumida, e o comprador pode repetir com o mesmo `chargeId`.

```http
POST /settle
Authorization: Bearer <token da loja>

{ "x402Version": 2, "paymentPayload": { ... }, "paymentRequirements": { ... } }
```

O facilitator repete as [verificações de segurança](#segurança-no-settle) e marca a cobrança como consumida.

**⑧ O vendedor entrega o recurso.**

```http
HTTP/1.1 200 OK
PAYMENT-RESPONSE: eyJzdWNjZXNzIjp0cnVlLC...

{ ...relatório... }
```

`PAYMENT-RESPONSE` decodificado: `{ "success": true, "transaction": "pix_char_abc", "network": "pix:br", "amount": "500" }`

Para o código do agente, tudo isso acontece dentro de um único `client.get("/relatorio")`.

### Para onde vai o dinheiro

Princípio do projeto: **o dinheiro nunca passa por nós.** No MVP, o vendedor roda o próprio facilitator e o Pix cai direto na conta dele. O modo hospedado fica para depois.


| Modo | Como é | Para quem |
|---|---|---|
| **Self-hosted** | O vendedor roda o próprio facilitator com a própria conta AbacatePay. O Pix cai direto na conta dele. | Empresas que querem controle total. Não há custódia de terceiros. |
| **Hospedado** *(futuro, fora do MVP)* | O vendedor só recebe um token. O Pix cai na conta do operador e o repasse vai por **split para a subconta** do vendedor. | Quem quer integrar em minutos. |

### Quando algo dá errado

| Situação | O que acontece |
|---|---|
| Pagou, mas a requisição de retorno falhou (queda de rede) | A cobrança fica `PAID` e não consumida. O SDK pode repetir com o mesmo `chargeId` e nada se perde. |
| Tentou usar o mesmo pagamento duas vezes | O segundo `/settle` responde `charge_already_consumed`. |
| Pagou o recurso de R$ 1 e tentou usar no de R$ 50 | `amount_mismatch` / `resource_mismatch`, porque a cobrança está gravada com o recurso e o valor. |
| Não pagou a tempo | A cobrança expira. Uma nova requisição gera outro 402 com outra cobrança. |
| Refez a requisição antes de o Pix ser confirmado | `402` com a mesma cobrança, `settlement_pending` e `Retry-After: 2`. Nenhuma cobrança nova é criada. |
| O handler do vendedor falhou | Não há `/settle`: a cobrança fica paga e não consumida e pode ser usada de novo. |
| Cobranças demais | `429` com `Retry-After`, sem criar cobrança: 10 por minuto por IP no SDK do vendedor e 60 por minuto por loja no facilitator. |
| Fraude contestada via MED ou estorno | Os webhooks `transparent.disputed` e `transparent.refunded` marcam a cobrança (depois de conferir no PSP) e o `/settle` responde `charge_disputed` / `charge_refunded`. O pagador não é bloqueado. |
| A cobrança passa do limite do agente | O SDK cliente nem paga e lança `policy_exceeded`. |

### Tempo

| Cenário | Ponta a ponta |
|---|---|
| Agente com API bancária | ~2 a 5 s |
| Pessoa lendo o QR | ~10 a 30 s |

O gargalo é sempre o Pix. É por isso que micropagamentos de centavos ficam para o scheme B (saldo pré-pago), que funciona em milissegundos.

---

## Segurança no `/settle`

O `/verify` e o `/settle` aplicam as mesmas verificações; só o `/settle` grava algo. O facilitator só aprova se **todas** estas condições forem verdadeiras:

1. O `chargeId` existe no banco do facilitator, ou seja, foi criado por ele.
2. A cobrança pertence ao vendedor dono do token que chamou o `/settle`.
3. `amount`, `payTo` e `resource.url` batem com o que foi gravado na criação da cobrança.
4. O PSP confirma `PAID` na hora. O webhook sozinho nunca basta, e um erro do PSP conta como pendente, nunca como pago. Uma cobrança paga pode ser usada por até 24 h depois do pagamento, mesmo após expirar.
5. O status não é `UNDER_DISPUTE` nem `REFUNDED`.
6. A cobrança ainda não foi consumida. A marcação é atômica: `UPDATE ... SET consumed_at = now WHERE id = ? AND consumed_at IS NULL`.

Webhook do AbacatePay:

- O `X-Webhook-Secret` é comparado em tempo constante.
- Eventos repetidos são descartados pelo `id` do evento (`log_...`), que se repete nas retentativas.
- O `X-Webhook-Signature` (HMAC-SHA256 com a chave pública fixa do AbacatePay) precisa bater com o corpo. Ele garante só a integridade, não a origem; a origem vem do segredo.

Por padrão, dados do pagador (nome, CPF mascarado) não são repassados ao vendedor (LGPD).

---

## SDK

### Pacotes TypeScript

| Perfil | Pacote | O que faz |
|---|---|---|
| **Quem vende** (API, conteúdo) | `@p-x402/server` | Protege rotas com 402 e Pix. Núcleo sem framework + adapter `/hono` (outros depois) |
| **Quem compra** (app, agente de IA) | `@p-x402/client` | `fetch` que paga sozinho, com policy de gasto. Payer de desenvolvimento: `simulatePayer` (terminal e API bancária depois) |
| **Quem opera o facilitator** | `apps/facilitator` | App Hono pronta com `/verify`, `/settle`, `/supported`, `/pix/charges` e webhooks. Stores plugáveis |
| **Integração com PSP** | `@p-x402/psp` | Interface `PixProvider`, adapter AbacatePay e PSP mock em memória. Outros depois: Efí, Inter, Woovi, Mercado Pago... |
| Base comum | `@p-x402/core` | Tipos, schemas **Zod v4**, codec dos headers, erros tipados, leitura do BR Code |

Stack: **Bun** (desenvolvimento, testes, deploy do facilitator), **Hono**, **Zod v4**, Biome.

### Uso

**Quem vende (Hono):**

```ts
import { pixPaywall } from "@p-x402/server/hono"

const pix = pixPaywall({ facilitatorUrl: "https://facilitator.exemplo.com", token: process.env.PX402_MERCHANT_TOKEN })

app.get("/relatorio", pix({ amount: "500", description: "Relatório PDF" }), (c) => c.json(gerar()))
// c.get("px402") → { chargeId, amount }
```

O núcleo do servidor não conhece framework. Os adapters são finos por cima disto:

```ts
const result = await paywall.handle(request, { amount: "500" }, { clientIp })
if (result.type === "response") return result.response // 402, 400, 414, 429, 500 ou 502 pronto
// result.type === "paid" → executa o handler e chama result.finalize(response):
// se o handler respondeu sem erro, ele chama /settle e inclui o PAYMENT-RESPONSE
```

**Quem compra (app ou agente):**

```ts
import { simulatePayer, wrapFetch } from "@p-x402/client"

const fetchPago = wrapFetch(fetch, {
  payer: simulatePayer({ facilitatorUrl }), // em dev; um payer real implementa { pay(cobrança) }
  policy: {
    maxPerRequest: 1000,                  // R$ 10,00
    maxTotal: 5000,                       // orçamento da sessão
    allowedOrigins: ["api.exemplo.com.br"],
  },
  onPayment: (e) => log(e),               // auditoria; e.paymentSignature permite retomar o pagamento
})

const res = await fetchPago("https://api.exemplo.com.br/relatorio")
```

**Quem opera o facilitator:**

```ts
import { createFacilitator } from "@p-x402/facilitator"
import { bunSqliteStore } from "@p-x402/facilitator/stores/bun-sqlite"
import { createAbacatePayProvider } from "@p-x402/psp"

const app = createFacilitator({
  provider: createAbacatePayProvider({
    apiKey: process.env.ABACATEPAY_API_KEY,
    webhookSecret: process.env.ABACATEPAY_WEBHOOK_SECRET,
  }),
  store: bunSqliteStore("p-x402.sqlite"),   // ou memoryStore()
  merchants: [{ id: "loja1", token: "...", payTo: "loja1" }],
})

Bun.serve({ port: 4020, fetch: app.fetch })
```

**Novo PSP:** basta implementar uma interface pequena.

```ts
interface PixProvider {
  name: string
  minAmount: number
  minExpiresIn: number
  createCharge(input: CreatePixChargeInput): Promise<PixCharge>
  getCharge(id: string): Promise<PixChargeState>
  simulatePayment?(id: string): Promise<void>
  parseWebhook?(req: Request): Promise<PixWebhookEvent>
}
```

### Princípios

1. **As bibliotecas não usam API do Bun.** Usam só `fetch`, `Request`, `Response` e WebCrypto, para rodar em Node ≥ 20, Bun, Deno e Workers.
2. **Adapters por subpath, não por pacote.** Frameworks entram como `peerDependencies` opcionais.
3. **Dependências pesadas ficam isoladas** em subpaths (`@p-x402/client/terminal`, `@p-x402/facilitator/stores/bun-sqlite`).
4. **Tudo plugável por interface:** `PixProvider`, `ChargeStore`, `PixPayer`, `MerchantResolver`.
5. **Erros tipados:** `Px402Error` com `code` estável. Os códigos fazem parte da API pública e seguem semver.
6. **Policy de gasto ligada por padrão** no cliente, com limites conservadores.
7. **Testes de contrato** exportados em `@p-x402/core/testing`, que todo `PixProvider` e todo `ChargeStore` precisam passar.
8. **Build:** `tsdown` (ESM + `.d.ts`), changesets para versionamento e CI em matriz (Bun + Node 20/22).

---

## SDKs em várias linguagens

O facilitator e o PSP formam **um serviço HTTP implementado uma vez só** (em TypeScript). Os SDKs de outras linguagens ficam finos e não reimplementam PSP, banco nem settle. Cada um precisa só destas peças:

| Peça | Tamanho |
|---|---|
| Tipos e validação (PaymentRequired, PaymentPayload...) | gerados automaticamente |
| Codec dos headers (base64 + JSON) | ~20 linhas |
| Cliente HTTP do facilitator | gerado do OpenAPI e ajustado à mão |
| Middleware de servidor para os frameworks da linguagem | ~100 a 200 linhas |
| Wrapper de cliente HTTP que trata 402, com policy de gasto | ~150 a 300 linhas |

### Uma fonte da verdade

- Os **schemas Zod v4** são a fonte. Um script exporta `spec/schemas/*.json` (via `z.toJSONSchema()`) e `spec/openapi.yaml`, e o CI falha se alguém mudar um schema sem regenerar.
- Geração de tipos por linguagem:
  - Java/Kotlin: `jsonschema2pojo` / `openapi-generator`
  - Python: `datamodel-code-generator` (Pydantic v2)
  - Go: `oapi-codegen`
  - PHP, C# e Ruby: `openapi-generator`
- **Conformidade:** `spec/test-vectors/` traz headers codificados, payloads válidos e inválidos, respostas esperadas e códigos de erro. `spec/conformance/` traz uma imagem Docker do facilitator com PSP mock. Cada SDK roda os dois no próprio CI, o que garante que todas as linguagens falam o mesmo protocolo.

### Como fica em cada linguagem

**Java (Spring Boot):**

```java
@Bean
Px402 px402() {
  return Px402.builder().facilitator("https://facilitator.exemplo.com").token(env("PX402_TOKEN")).build();
}

@GetMapping("/relatorio")
@PixPaywall(amount = 500, description = "Relatório PDF")   // HandlerInterceptor lê a anotação
public Relatorio relatorio() { ... }

// cliente / agente
HttpClient http = Px402Client.wrap(HttpClient.newHttpClient(), payer, Policy.maxPerRequest(1000));
```

**Python (FastAPI e agentes):**

```python
pix = Px402(facilitator="https://facilitator.exemplo.com", token=os.environ["PX402_TOKEN"])

@app.get("/relatorio", dependencies=[Depends(pix.paywall(amount=500))])
def relatorio(): ...

# cliente: transport do httpx
client = httpx.Client(transport=px402.Transport(payer=terminal_payer(), max_per_request=1000))
```

**Go:**

```go
mux.Handle("/relatorio", pix.Paywall(px402.Price{Amount: 500})(handler)) // net/http; chi e gin via adapter
client := &http.Client{Transport: px402.NewRoundTripper(http.DefaultTransport, payer, policy)}
```

### Frameworks e registros

| Linguagem | Servidor | Cliente | Registro |
|---|---|---|---|
| TypeScript | Hono, Express, Elysia, Fastify, Next | `fetch` | npm `@p-x402/*` |
| Python | FastAPI/Starlette, Django, Flask | `httpx`, `requests` | PyPI `px402` |
| Java/Kotlin | Spring Boot (starter), Quarkus | `HttpClient`, OkHttp interceptor | Maven Central |
| Go | middleware `net/http` | `http.RoundTripper` | módulo Go no GitHub |
| PHP | Laravel middleware, PSR-15 | Guzzle middleware | Packagist |
| C# | ASP.NET Core middleware | `DelegatingHandler` | NuGet |

### Prioridade

1. **TypeScript:** referência; também roda o facilitator.
2. **Python:** quase todo o ecossistema de agentes de IA está nele.
3. **Java:** padrão em bancos, fintechs e empresas grandes no Brasil.
4. **PHP:** enorme presença no e-commerce brasileiro (Laravel, WooCommerce).
5. **Go e C#:** conforme a demanda aparecer.

Cada SDK tem a própria versão semver e declara duas compatibilidades: a versão do protocolo (`x402Version: 2`) e a versão da API do facilitator.

---

## Layout do repositório

Monorepo com workspaces do Bun. As bibliotecas (`packages/*`) usam só padrões web; os apps podem usar APIs do Bun.

```
p-x402/
├── packages/
│   ├── core/          tipos e schemas Zod v4, codec dos headers, Px402Error, leitura do BR Code
│   ├── psp/           interface PixProvider, adapter AbacatePay, PSP mock em memória
│   ├── server/        paywall sem framework + adapter Hono (@p-x402/server/hono)
│   └── client/        wrapFetch com policy de gasto, simulatePayer
├── apps/
│   ├── facilitator/   app Hono: /pix/charges, /verify, /settle, /supported, /webhooks/pix; stores memória e bun:sqlite
│   ├── demo-server/   API de exemplo com GET /relatorio a R$ 5,00
│   └── demo-client/   comprador de exemplo e a demo tudo-em-um (bun run demo:local)
└── docs/
```

## Como executar

Requisito: [Bun](https://bun.sh) 1.3 ou mais novo.

O passo a passo completo (como o fluxo funciona, o que cada teste cobre, teste manual com curl e próximos passos) está em [`docs/guia-mvp.md`](docs/guia-mvp.md).

```bash
bun install
```

Demo completa num processo só, com o PSP mock (nenhum dinheiro real): sobe o facilitator e a API de exemplo em portas livres e faz uma compra de R$ 5,00, imprimindo cada passo (`402` com a cobrança, pagamento, `402 settlement_pending` enquanto o PSP não confirma, `200` com o `PAYMENT-RESPONSE`).

```bash
bun run demo:local
```

Testes, tipos e lint:

```bash
bun test
```

```bash
bun run typecheck
```

```bash
bun run lint
```

Em processos separados: copie `.env.example` para `.env` (o Bun lê o `.env` sozinho), escolha um `PX402_MERCHANT_TOKEN` e rode cada comando num terminal.

```bash
cp .env.example .env
```

```bash
bun run dev:facilitator
```

```bash
bun run dev:server
```

```bash
bun run demo
```

Com o `.env.example`, o facilitator usa o PSP mock, grava as cobranças em `p-x402.sqlite` e libera a rota de desenvolvimento `POST /dev/charges/:id/simulate-payment`, que o `simulatePayer` do cliente usa para "pagar". Para o AbacatePay, use `PX402_PROVIDER=abacatepay` com `ABACATEPAY_API_KEY` e `ABACATEPAY_WEBHOOK_SECRET`. O adapter já foi testado contra o modo dev do AbacatePay: criar, consultar e simular pagamento funcionam de ponta a ponta. Dois detalhes do modo dev: o status leva alguns segundos para virar `PAID` depois do `simulate-payment`, e o BR Code devolvido não é um EMV válido. Por isso o `simulatePayer`, que nunca paga o BR Code, dispensa a checagem dele. O webhook também foi testado no sandbox, por um túnel do cloudflared (passo a passo em [`docs/guia-mvp.md`](docs/guia-mvp.md)). Sem webhook o fluxo funciona igual, só um pouco mais lento, porque o facilitator consulta o PSP a cada tentativa.

Limites conhecidos desta versão:

- A trava que impede duas requisições com a mesma cobrança de rodarem o handler ao mesmo tempo vale por processo. Com várias instâncias do vendedor, use roteamento fixo por cobrança ou handlers idempotentes.
- O `/settle` acontece quando o handler devolve a `Response`. Uma resposta em streaming que falhe depois disso já foi liquidada.
- `HEAD` e `OPTIONS` em rotas pagas recebem `402` sem criar cobrança.
- Os limites de taxa ficam em memória, por processo.

---

## Schemes

| Scheme | Como funciona | Quando usar | Status |
|---|---|---|---|
| **A: `exact` em `pix:br`** | Uma cobrança Pix por requisição, `paymentFlow: "upfront"` | Cobranças a partir de ~R$ 5, com uma pessoa ou um agente com API bancária | MVP |
| **B: saldo pré-pago** | Recarga via Pix e vouchers assinados (ed25519) debitados num ledger, com repasse em lote | Pay-per-call de centavos para agentes. Exige atenção regulatória (custódia de saldo) | Fase 2 |
| **C: stablecoin BRL** | x402 `exact` EVM com token BRL, Pix só como on/off-ramp | Quem já está no ecossistema cripto | Avaliar |

---

## Roadmap

- [x] `core`: schemas Zod v4, headers, erros
- [ ] `core/testing`: testes de contrato para `PixProvider` e `ChargeStore`
- [x] `psp`: provider mock e adapter AbacatePay
- [x] `facilitator` com `memoryStore` e `bun-sqlite`
- [x] `server` com núcleo independente de framework + adapter Hono
- [x] `client` com `wrapFetch`, policy e payer simulate
- [ ] payer de terminal (QR) e payer via API bancária
- [x] E2E: exemplo Hono → facilitator → client, com mock
- [x] Integração com o modo dev do AbacatePay (`simulate-payment`)
- [x] Webhook do AbacatePay (testado no sandbox via túnel do cloudflared)
- [ ] Webhook com URL fixa (túnel nomeado ou deploy)
- [ ] Build (tsdown), changesets, CI em matriz e docs
- [ ] `spec/`: JSON Schema, OpenAPI, test-vectors e conformidade em Docker
- [ ] SDK Python
- [ ] SDK Java (Spring Boot starter)
- [ ] Scheme B (saldo pré-pago)
- [ ] `@p-x402/mcp`: servidor MCP para agentes comprarem via Pix respeitando a policy
- [ ] Interoperar com o SDK oficial do x402 (Pix e USDC no mesmo `accepts`)

---

## Referências

- [x402: site](https://x402.org/) · [spec v2](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md) · [transporte HTTP v2](https://github.com/coinbase/x402/blob/main/specs/transports-v2/http.md)
- [AbacatePay: documentação da API v2](https://docs.abacatepay.com/)
- [Banco Central: Pix](https://www.bcb.gov.br/estabilidadefinanceira/pix)

## Licença

[Apache-2.0](LICENSE).
