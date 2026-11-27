"""Payers: who actually pays the Pix charge. None of them talks to a real bank."""

from __future__ import annotations

import inspect
import sys
from typing import Awaitable, Callable, Optional, TextIO, Union
from urllib.parse import quote

import httpx

from .errors import Px402Error
from .types import PixChargeToPay

__all__ = ["SimulatePayer", "TerminalPayer", "format_brl"]


def format_brl(centavos: Union[str, int]) -> str:
    """``"123456"`` -> ``"R$ 1.234,56"``."""
    value = int(centavos)
    units, cents = divmod(abs(value), 100)
    grouped = f"{units:,}".replace(",", ".")
    sign = "-" if value < 0 else ""
    return f"{sign}R$ {grouped},{cents:02d}"


class SimulatePayer:
    """Dev-only payer: marks the charge paid instead of moving money (mirrors ``simulatePayer``).

    It never pays the BR Code, so the client skips the BR Code check for it (sandbox codes, such as
    AbacatePay dev mode's, are not valid EMV). Either calls the facilitator's
    ``POST /dev/charges/:id/simulate-payment`` (the facilitator must run with
    ``PX402_DEV_SIMULATE=1``) or a function you provide.
    """

    pays_br_code = False

    def __init__(
        self,
        facilitator_url: Optional[str] = None,
        *,
        simulate: Optional[Callable[[str], Union[None, Awaitable[None]]]] = None,
        http_client: Optional[httpx.Client] = None,
        async_http_client: Optional[httpx.AsyncClient] = None,
        timeout: float = 10.0,
    ) -> None:
        if (facilitator_url is None) == (simulate is None):
            raise TypeError("pass exactly one of facilitator_url or simulate")
        self._simulate = simulate
        self._base = facilitator_url.rstrip("/") if facilitator_url else ""
        self._http = http_client
        self._ahttp = async_http_client
        self._timeout = timeout

    def _url(self, charge_id: str) -> str:
        return f"{self._base}/dev/charges/{quote(charge_id, safe='')}/simulate-payment"

    @staticmethod
    def _check(response: httpx.Response, charge_id: str) -> None:
        if not response.is_success:
            raise Px402Error(
                "payer_failed",
                f"simulate-payment returned HTTP {response.status_code}",
                {"charge_id": charge_id, "status": response.status_code},
            )

    def pay(self, charge: PixChargeToPay) -> None:
        if self._simulate is not None:
            result = self._simulate(charge.charge_id)
            if inspect.isawaitable(result):
                raise TypeError("simulate returned an awaitable: use AsyncPx402Transport")
            return
        if self._http is not None:
            response = self._http.post(self._url(charge.charge_id))
        else:
            response = httpx.post(self._url(charge.charge_id), timeout=self._timeout)
        self._check(response, charge.charge_id)

    async def apay(self, charge: PixChargeToPay) -> None:
        if self._simulate is not None:
            result = self._simulate(charge.charge_id)
            if inspect.isawaitable(result):
                await result
            return
        if self._ahttp is not None:
            response = await self._ahttp.post(self._url(charge.charge_id))
        else:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                response = await client.post(self._url(charge.charge_id))
        self._check(response, charge.charge_id)


_CANCEL_ANSWERS = frozenset(("n", "no", "nao", "não", "cancel", "cancelar"))


class TerminalPayer:
    """A human pays: prints the Pix "copia e cola" code and waits for Enter.

    The person pays the code in their bank app, then presses Enter; typing ``n`` cancels (the
    transport then raises ``payer_failed``). The client checks the BR Code's amount against the
    advertised one before this payer is called.
    """

    pays_br_code = True

    def __init__(
        self,
        output: Optional[TextIO] = None,
        input_fn: Optional[Callable[[str], str]] = None,
    ) -> None:
        self._output = output
        self._input = input_fn or input

    def _render(self, charge: PixChargeToPay) -> str:
        return "\n".join(
            [
                "",
                "Pagamento Pix solicitado / Pix payment requested",
                f"  valor:    {format_brl(charge.amount)}",
                f"  recurso:  {charge.resource_url}",
                f"  cobrança: {charge.charge_id}",
                f"  expira:   {charge.expires_at}",
                "",
                "Pix copia e cola:",
                charge.br_code,
                "",
            ]
        )

    def pay(self, charge: PixChargeToPay) -> None:
        out = self._output or sys.stdout
        out.write(self._render(charge) + "\n")
        out.flush()
        try:
            answer = self._input("Pague no app do banco e tecle Enter (n para cancelar): ")
        except EOFError:
            answer = "n"
        if answer.strip().lower() in _CANCEL_ANSWERS:
            raise Px402Error("payer_failed", "payment cancelled at the terminal", {"charge_id": charge.charge_id})

    async def apay(self, charge: PixChargeToPay) -> None:
        import anyio.to_thread

        await anyio.to_thread.run_sync(self.pay, charge)

