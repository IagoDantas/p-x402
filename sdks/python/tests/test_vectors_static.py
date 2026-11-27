"""header-codec.json, validation.json, requirement-matching.json and error-codes.json."""

from __future__ import annotations

import base64

import pytest
from conftest import VECTOR_FILES, VECTORS_DIR, cases, ids, load

import px402
from px402.codec import to_json

CODEC = cases("header-codec.json")
VALIDATION = cases("validation.json")
MATCHING = cases("requirement-matching.json")

ENCODERS = {
    "PAYMENT-REQUIRED": (px402.PaymentRequired, px402.encode_payment_required, px402.decode_payment_required),
    "PAYMENT-SIGNATURE": (px402.PaymentPayload, px402.encode_payment_payload, px402.decode_payment_payload),
    "PAYMENT-RESPONSE": (
        px402.SettlementResponse,
        px402.encode_settlement_response,
        px402.decode_settlement_response,
    ),
}


def test_every_vector_file_is_consumed() -> None:
    on_disk = sorted(p.name for p in VECTORS_DIR.glob("*.json") if p.name != "package.json")
    assert on_disk == sorted(VECTOR_FILES)


# --- header-codec.json ----------------------------------------------------------------------


@pytest.mark.parametrize("case", CODEC, ids=ids(CODEC))
def test_header_codec(case: dict) -> None:
    model, encode, decode = ENCODERS[case["header"]]
    if case["direction"] == "both":
        # encode: decoded object -> exact header string, byte for byte
        assert to_json(case["decoded"]) == case["json"]
        assert px402.encode_json_header(case["decoded"]) == case["encoded"]
        assert encode(model.from_dict(case["decoded"])) == case["encoded"]
        assert base64.b64decode(case["encoded"]).decode("utf-8") == case["json"]
        padding = case["padding"]
        assert len(case["encoded"]) - len(case["encoded"].rstrip("=")) == padding
        # decode: header string -> object, same keys in the same order
        decoded = decode(case["encoded"])
        assert to_json(decoded.to_dict()) == to_json(case["decoded"])
        assert case["expected"] == {"ok": True}
        return

    assert case["direction"] == "decode"
    if "encodedRepeat" in case:
        header = case["encodedRepeat"]["char"] * case["encodedRepeat"]["count"]
    else:
        header = case["encoded"]
    expected = case["expected"]
    if expected["ok"]:
        decoded = decode(header)
        # to_json is order-sensitive: checks schema key order and that unknown keys are dropped
        assert to_json(decoded.to_dict()) == to_json(expected["decoded"])
    else:
        with pytest.raises(px402.Px402Error) as info:
            decode(header)
        assert info.value.code == expected["errorCode"]


# --- validation.json ------------------------------------------------------------------------


def _validation_code(type_name: str, value: object):
    """The code the reference gives `value` where that type is checked, or None when valid."""
    header = px402.encode_json_header(value)
    try:
        if type_name == "PaymentRequired":
            px402.decode_payment_required(header)
        elif type_name == "SettlementResponse":
            px402.decode_settlement_response(header)
        elif type_name == "PaymentPayload":
            generic = px402.decode_payment_payload(header)  # invalid_header when not a PaymentPayload
            try:
                px402.parse_pix_payment_payload(generic)
            except px402.SchemaError:
                return "invalid_payload"
        elif type_name == "PaymentRequirements":
            return px402.pix_requirements_error(value)
        else:
            raise AssertionError(f"unknown type {type_name}")
    except px402.Px402Error as error:
        return error.code
    return None


@pytest.mark.parametrize("case", VALIDATION, ids=ids(VALIDATION))
def test_validation(case: dict) -> None:
    code = _validation_code(case["type"], case["value"])
    expected = case["expected"]
    if expected["valid"]:
        assert code is None
    else:
        assert code == expected["errorCode"]


# --- requirement-matching.json --------------------------------------------------------------


@pytest.mark.parametrize("case", MATCHING, ids=ids(MATCHING))
def test_requirement_matching(case: dict) -> None:
    result = px402.match_pix_requirements(case["accepted"], case["required"])
    expected = case["expected"]
    if expected["ok"]:
        assert result == px402.MatchResult(True)
    else:
        assert (result.ok, result.reason, result.field) == (False, expected["reason"], expected["field"])


# --- error-codes.json -----------------------------------------------------------------------


def test_error_codes_match() -> None:
    codes = [entry["code"] for entry in load("error-codes.json")["codes"]]
    assert list(px402.PX402_ERROR_CODES) == codes


@pytest.mark.parametrize("entry", load("error-codes.json")["codes"], ids=lambda e: e["code"])
def test_error_code_is_known(entry: dict) -> None:
    assert px402.is_px402_error_code(entry["code"])
    assert px402.Px402Error(entry["code"]).code == entry["code"]
