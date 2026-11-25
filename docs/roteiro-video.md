# Roteiro do vídeo do rascunho (~3 min)

Gravado em cima da landing page (`docs/index.html`). Cada seção da página é uma cena, e **cada integrante aparece na câmera** em pelo menos uma delas, que é uma exigência do formulário.

Formato sugerido: tela compartilhada com a página e a webcam no canto (Loom ou OBS). Role a página até a seção da cena enquanto fala.

| Tempo | Cena / seção | Quem | Fala (rascunho) |
| --- | --- | --- | --- |
| 0:00–0:25 | 1 · `#inicio` (hero, terminal rodando) | Integrante 1 | "O HTTP tem um status, o 402 Payment Required, que existe desde o começo da web e nunca ganhou significado. A gente deu um: Pix. Olha o terminal: a API responde 402 com um Pix, o agente paga e recebe o recurso." |
| 0:25–0:55 | 2 · `#problema` | Integrante 1 | "Hoje, para usar uma API paga no Brasil, você cria conta, aceita contrato, gera chave e recarrega saldo num painel. Um agente de IA não faz isso sozinho. E as poucas APIs que aceitam agentes cobram em cripto." |
| 0:55–1:40 | 3 · `#como` | Integrante 2 | "O p-x402 segue o padrão aberto x402. São quatro passos: pede, recebe um 402 com um Pix, paga, recebe o recurso com recibo. Quem vende põe um middleware e um preço na rota. Quem compra usa um fetch que entende 402. E como o protocolo é uma spec aberta, o SDK de qualquer linguagem sai dela: começamos pelo TypeScript." |
| 1:40–2:10 | 4 · `#precos` | Integrante 2 ou 3 | "Por que não um Pix por chamada? A tarifa do Pix é fixa. Numa chamada de cinco centavos, é impossível. A saída é crédito pré-pago: com um depósito de vinte reais, a tarifa cai para 4%. É a nossa próxima etapa." |
| 2:10–2:40 | 5 · `#seguranca` | Integrante 3 | "Segurança: o mesmo Pix nunca paga duas vezes, valor e recurso ficam amarrados ao pagamento e tudo é reconfirmado no PSP. E o mais importante: o dinheiro nunca passa pela gente, ele cai direto na conta do vendedor." |
| 2:40–3:00 | 6 · `#time` | Todos | Cada um diz o nome e o papel. Fecho: "p-x402: o 402 com Pix, para agentes pagarem APIs brasileiras em reais." |

## Checklist antes de gravar

- [ ] Nomes e papéis preenchidos na seção `#time` da página
- [ ] Página publicada em HTTPS (GitHub Pages)
- [ ] Cada integrante aparece na câmera
- [ ] Vídeo público ou não listado (privado não vale)
- [ ] Duração por volta de 3 min
