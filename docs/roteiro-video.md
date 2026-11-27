# Roteiro — vídeo do rascunho inicial p-x402

**Duração:** ~3 min · **Trilha:** Pagamentos & finanças · **Formato:** time na câmera, sem demo

---

## 1. Hook · 0:00–0:25 · Henrique

_Tela: só a pessoa falando. Em "x402", aparecem os logos dos apoiadores ou o texto "x402 · Linux Foundation"._

> "Na era da IA, elas escrevem código, pesquisam e tomam decisões, mas travam em um simples formulário de cadastro.
> Pra resolver isso, Google, Visa, Mastercard e a Linux Foundation se juntaram num padrão: o x402, que deixa agentes de IA pagarem direto pela internet.
> Só que em cripto.
> Mas e o Pix? E o Brasil?"

## 2. Problema · 0:25–1:05 · Rafael

_Tela: os números aparecem em destaque conforme a fala._

> "O Pix está em **89% da população adulta**: são 154 milhões de pessoas e 14 milhões de empresas.
> Só em 2026, até outubro, foram **76 bilhões de transações**. E nos 3 minutos deste vídeo, **cerca de 500 mil Pix** vão ser feitos no Brasil.
> Mesmo assim, o padrão mundial de pagamento entre máquinas não fala Pix.
> Hoje, para uma IA comprar um único dado de uma API brasileira, ela precisa de conta, cartão e chave de acesso, coisas que só um humano consegue criar.
> E para quem quer vender por centavos, o custo de cadastro e de cobrança simplesmente não fecha."

## 3. Solução e como faremos · 1:05–2:25 · Iago

_Tela: diagrama simples: Pix de R$ 30 → saldo → IA usa APIs → cada chamada desconta do saldo._

> "Por isso criamos o **p-x402**, trocando a cripto pelo Pix.
> Funciona assim: você faz um Pix de, por exemplo, 30 reais, e esse valor vira saldo para a sua IA.
> A partir daí, ela trabalha sozinha. Quando precisa de um dado ou de um serviço pago, a API responde com o preço, e a IA paga direto desse saldo, em centavos, e, se você quiser, sem precisar te pedir nada.
> Não tem cadastro nem chave de acesso em cada API, e não tem cartão. Você define um teto, acompanha o gasto e recebe um recibo de cada chamada.
> E isso também resolve o lado de quem vende: fazer um Pix por chamada de poucos centavos não compensa por causa da tarifa. Com o saldo, um Pix só paga centenas de chamadas.
> Vamos entregar um protocolo aberto, um kit para quem vende integrar na própria API e um cliente que paga sozinho."

## 4. Fechamento · 2:25–3:00 · todos

_Tela: os três juntos, ou em sequência rápida._

> **Henrique:** "O mundo já decidiu como as máquinas vão pagar."
> **Rafael:** "A gente quer que o Brasil pague com Pix."
> **Iago:** "Esse é o p-x402."
>
> _(Cada um, olhando para a câmera:)_ "Eu sou o Henrique." / "Eu sou o Rafael." / "Eu sou o Iago."

_Tela final:_ **p-x402.com** · **github.com/IagoDantas/p-x402**

---

## Fontes dos dados (conferidas em 26/11/2026)

- **x402 na Linux Foundation** (lançada em 02/04/2026; apoio de AWS, American Express, Cloudflare, Google, Mastercard, Stripe, Visa e outros): [Linux Foundation](https://www.linuxfoundation.org/press/linux-foundation-is-launching-the-x402-foundation-and-welcoming-the-contribution-of-the-x402-protocol), [lançamento operacional](https://www.linuxfoundation.org/press/linux-foundation-announces-operational-launch-of-x402-foundation-to-standardize-internet-native-payments-for-ai-agents-and-applications)
- **x402 em cripto** (pagamentos em stablecoin, principalmente USDC): [Coinbase](https://www.coinbase.com/developer-platform/discover/launches/x402), [Stripe docs](https://docs.stripe.com/payments/machine/x402)
- **154 mi de usuários PF (89% dos adultos), 14 mi de PJ, 76 bi de transações jan–out/2026:** [Agência Gov, com dados do BCB](https://agenciagov.ebc.com.br/noticias/202611/pix-celebra-6-anos-como-motor-de-inclusao-e-eficiencia-financeira-em-todo-o-brasil)
- **"Cerca de 500 mil Pix em 3 minutos":** estimativa nossa. 76 bi ÷ 304 dias (jan–out) ≈ 250 mi/dia ≈ 174 mil/min → ≈ 520 mil em 3 min.

## Lembretes

- Não chamar o produto de "Pix". O certo é "p-x402, que usa Pix" (a marca é do BCB).
- Os três precisam aparecer na câmera (requisito do rascunho).
- Se passar de 3 min, cortem primeiro a última frase do problema ("custo de cadastro...").
