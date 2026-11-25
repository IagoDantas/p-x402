# DESIGN.md: p-x402

> Brief de design da landing page (`docs/index.html`, publicada em https://p-x402.com).
> Ordem de leitura: tokens no código (`:root` do `docs/index.html`) → este arquivo → skill antiwebslop.

## 1. Verdade do produto

- **Público:** jurados do Hack Brasil 2026 e devs que constroem agentes de IA ou vendem APIs no Brasil.
- **Propósito:** mostrar que uma API pode responder `402 Payment Required` com uma cobrança Pix e que um agente paga e recebe o recurso.
- **Restrições:** página estática num Cloudflare Worker; português do Brasil; sem dados inventados (o fluxo da janela de demo é encenado e marcado como "simulação").
- **Sucesso significa:** em uma rolagem, o visitante entende o fluxo 402 → Pix → 200 e abre o GitHub.
- **Conteúdo real disponível:** spec x402 v2, tarifas do AbacatePay (R$ 0,80 por Pix, mínimo R$ 1,00), nomes do time.

## 2. Design Read

Reading this as: landing page do p-x402 para jurados e devs, uma superfície persuade com linguagem dark dev-tool, em HTML estático.

| Superfície | Tipo | V | M | D |
|---|---|---|---|---|
| Landing (`docs/index.html`) | persuade | 7 | 5 | 4 |

## 3. Direção visual e proibições

- Técnico e direto: dados do protocolo em mono, títulos em grotesk, nada de ilustração decorativa.
- A janela de demo é uma **explicação** do protocolo (headers reais do x402), não um mock de produto. Substituir por gravação real quando o SDK rodar.
- Proibido: glow/spotlight decorativo, grid de fundo, blur blob, kicker acima de título, números decorativos (01/02/03) fora de sequências reais, itálico de efeito.
- Exceção aceita: os números 01–04 da seção "Como funciona" são uma sequência real (passos do protocolo).

## 4. Tokens de cor

```design-tokens
fonts: Space Grotesk, Inter, JetBrains Mono
colors: #08090a, #0d0e10, #111214, #16171a, #060707, #2a2c30, #3a3e44, #f7f8f8, #fff, #b4b8bd, #8a8f98, #767b84, #6e737a, #32d583, #12b76a, #0b7a48, #03160c, #1f3a2c, #0b120e, #fdb022, #b54708, #f97066, #b42318, #84adff
radii: 5px, 6px, 10px, 12px, 14px, 16px, 18px, 50%, 999px, inherit
```

| Token | Valor | Papel |
|---|---|---|
| `--bg` | #08090a | fundo da página |
| `--panel` / `--panel-2` | #111214 / #16171a | superfícies elevadas |
| `--text` | #f7f8f8 | títulos e ênfase |
| `--text-2` | #b4b8bd | texto de corpo e ledes |
| `--muted` | #8a8f98 | texto secundário (≥ 4.5:1 no fundo) |
| `--faint` | #767b84 | rótulos pequenos e metadados (≥ 4.5:1 no fundo) |
| `--green` | #32d583 | acento: "É Pix", estado pago/ok, passos de pagamento |
| `--amber` / `--red` | #fdb022 / #f97066 | só estado (simulação, tarifa ruim) |
| `--blue` | #84adff | só sintaxe de código e headers |

## 5. Tipografia

Três papéis, cada um com uma fonte:

| Papel | Fonte | Uso |
|---|---|---|
| Display | Space Grotesk 500/600 | h1, h2, statement, citação, nomes, valores |
| Texto | Inter 400/500/600 | corpo, ledes, h3, botões |
| Dados | JetBrains Mono 400/500 | código, headers HTTP, valores de tarifa, rótulos técnicos |

Escala (tokens `--fs-*`): display `clamp(48px, 7.6vw, 96px)` · h2 `clamp(40px, 5.6vw, 68px)` · statement `clamp(32px, 4.6vw, 54px)` · h3 18px · lede `clamp(18px, 1.6vw, 20px)` · body 15px · small 13px · label 11px.

Hierarquia de texto por cor: `--text` (títulos) → `--text-2` (corpo) → `--muted` (secundário) → `--faint` (rótulos).

Títulos com `text-wrap: balance`, descrições com `text-wrap: pretty`, números com `tabular-nums`.

## 6. Espaço e layout

- Largura máxima 1120px, gutter 24px (16px no celular).
- Seções com 130px de respiro no desktop e 90px no celular. Splits de título/lede em 1.55fr / 1fr.

## 7. Componentes

- Raio por papel: código inline 5–6px, blocos de código 10px, cards 14px, janela de demo 16px, tarifas 18px, botões 999px.
- Botão primário: fundo claro; secundário: contorno.

## 8. Motion

- Easing padrão `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)`.
- Reveal ao rolar: opacity + translateY(12px), 600ms, stagger 60/110/150ms. Com `prefers-reduced-motion`, só opacity.
- Botões: `scale(.97)` no `:active` (160ms); hover só em `(hover: hover) and (pointer: fine)`.
- Barras de tarifa: `transform: scaleX` (900ms), nunca `width`.
- Nada pisca em loop. Hover não é aplicado em elementos não clicáveis.

## 9. Conteúdo

- Voz: direta, concreta, números reais.
- Time: Iago Dantas, Rafael Marcondes, Henrique Sanches. `TODO(content): papéis de cada um, se forem aparecer no vídeo.`

## 11. Decision log

### 2026-11-25: Sistema tipográfico técnico
- **Context:** pedido de hierarquia de fontes e de texto com cara de produto técnico.
- **Decision:** Space Grotesk (display) + Inter (texto) + JetBrains Mono (dados); quatro níveis de cor de texto.
- **Why:** grotesk + mono lê como ferramenta de dev; a serif editorial testada antes lia como revista.
- **Do not:** serif ou itálico de efeito nos títulos; kicker acima de título.
- **Surfaces:** marketing
- **Refs:** `docs/index.html`

### 2026-11-25: Decoração removida
- **Context:** página tinha halo verde, grid de fundo, blob girando com blur, ponto piscando e glow em botões.
- **Decision:** remover tudo; ênfase só por tamanho, peso, cor do acento e espaço.
- **Why:** era o visual padrão de landing de IA e competia com o conteúdo.
- **Do not:** reintroduzir spotlight, glow ou blur decorativo.
- **Surfaces:** marketing
- **Refs:** `docs/index.html`
