"""A paid API in Python: FastAPI + the p-x402 server SDK, settling through the TypeScript facilitator.

    PX402_PROVIDER=mock PX402_MERCHANT_TOKEN=tok-local PX402_DEV_SIMULATE=1 PX402_DB_PATH= bun run dev:facilitator
    PX402_MERCHANT_TOKEN=tok-local PX402_FACILITATOR_URL=http://localhost:4020 python sdks/python/examples/paid_api.py

Then buy the report with any p-x402 client, in Python or TypeScript:

    python sdks/python/examples/buy_report.py --url http://localhost:4022/relatorio
"""

from __future__ import annotations

import argparse
import os
import sys

from fastapi import Depends, FastAPI

from px402.server.fastapi import Payment, PixPaywall


def create_app(facilitator_url: str, token: str) -> FastAPI:
    app = FastAPI(title="p-x402 paid API (Python)")
    pix = PixPaywall(facilitator_url, token)
    pix.install(app)

    @app.get("/")
    async def index() -> dict:
        return {"rotas": {"GET /relatorio": "R$ 5,00 via Pix (x402)"}, "servidor": "python"}

    @app.get("/relatorio")
    async def relatorio(
        payment: Payment = Depends(
            pix.require(amount=500, description="Relatório de vendas", mime_type="application/json")
        ),
    ) -> dict:
        return {
            "titulo": "Relatório de vendas — novembro de 2026",
            "itens": [
                {"produto": "Café especial 250 g", "unidades": 312, "receita": "R$ 12.168,00"},
                {"produto": "Moedor manual", "unidades": 41, "receita": "R$ 7.339,00"},
            ],
            "servidor": "python",
            "pagoCom": payment.charge_id,
        }

    return app


def main() -> int:
    import uvicorn

    parser = argparse.ArgumentParser(description="p-x402 paid API in Python (FastAPI)")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PY_SERVER_PORT", "4022")))
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    token = os.environ.get("PX402_MERCHANT_TOKEN")
    if not token:
        print("PX402_MERCHANT_TOKEN is required", file=sys.stderr)
        return 1
    facilitator = os.environ.get("PX402_FACILITATOR_URL", "http://localhost:4020")
    print(f"python paid API on http://{args.host}:{args.port} (facilitator: {facilitator})", flush=True)
    uvicorn.run(create_app(facilitator, token), host=args.host, port=args.port, log_level="warning")
    return 0


if __name__ == "__main__":
    sys.exit(main())
