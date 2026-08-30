"""
HTTP behaviour: the boot contract, the probes, and `/predict`.

Startup is exercised through the real lifespan rather than by calling the
service functions directly, because "fails to boot without a model" is the
acceptance criterion and only the lifespan can demonstrate it.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app
from app.models.artifact import ModelArtifactError
from tests.conftest_helpers import ARTIFACT_PATH


def build_settings(**overrides) -> Settings:
    defaults = {
        "APP_ENV": "test",
        "MODEL_PROVIDER": "baseline",
        "MODEL_PATH": str(ARTIFACT_PATH),
    }
    defaults.update(overrides)
    # `_env_file=None` isolates the test from a developer's local .env, which
    # would otherwise decide whether these assertions hold.
    return Settings(_env_file=None, **defaults)


@pytest.fixture()
def client() -> TestClient:
    with TestClient(create_app(build_settings())) as test_client:
        yield test_client


class TestStartup:
    def test_refuses_to_start_without_an_artifact(self, tmp_path) -> None:
        # The acceptance criterion. A service that starts without a model looks
        # healthy to an orchestrator and fails on the first real request.
        settings = build_settings(MODEL_PATH=str(tmp_path / "absent.json"))

        with (
            pytest.raises(ModelArtifactError, match="No model artifact"),
            TestClient(create_app(settings)),
        ):
            pass

    def test_refuses_to_start_on_a_corrupted_artifact(self, tmp_path) -> None:
        # A truncated copy parses as JSON but hashes differently. Loading it
        # would price confidently from wrong numbers.
        payload = json.loads(ARTIFACT_PATH.read_text(encoding="utf-8"))
        payload["coefficients"][0] += 1.0
        corrupted = tmp_path / "corrupted.json"
        corrupted.write_text(json.dumps(payload), encoding="utf-8")

        settings = build_settings(MODEL_PATH=str(corrupted))

        with (
            pytest.raises(ModelArtifactError, match="integrity check"),
            TestClient(create_app(settings)),
        ):
            pass

    def test_refuses_an_artifact_from_another_provider(self, tmp_path) -> None:
        # Configuration and artifact must agree on which model is running, or an
        # operator can be serving something they did not deploy.
        payload = json.loads(ARTIFACT_PATH.read_text(encoding="utf-8"))
        payload["provider"] = "stage08-gbm"
        from app.models.artifact import compute_checksum

        payload["checksum"] = compute_checksum(payload)
        foreign = tmp_path / "foreign.json"
        foreign.write_text(json.dumps(payload), encoding="utf-8")

        settings = build_settings(MODEL_PATH=str(foreign))

        with (
            pytest.raises(ModelArtifactError, match="MODEL_PROVIDER"),
            TestClient(create_app(settings)),
        ):
            pass


class TestHealth:
    def test_liveness_is_independent_of_the_model(self, client: TestClient) -> None:
        response = client.get("/health")

        assert response.status_code == 200
        assert response.json() == {"status": "ok"}

    def test_readiness_reports_the_loaded_model(self, client: TestClient) -> None:
        response = client.get("/health/ready")

        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "ready"
        assert body["model"]["loaded"] is True
        assert body["model"]["modelVersion"] == "baseline-premium-v1"
        # Which model, not just whether one is loaded: during an incident the
        # useful question is whether this instance is running the current one.
        assert len(body["model"]["checksum"]) == 64

    def test_readiness_is_503_when_no_model_is_loaded(self) -> None:
        # Constructed without running the lifespan, which is the state a process
        # would be in if startup had failed.
        app = create_app(build_settings())
        client = TestClient(app)

        response = client.get("/health/ready")

        assert response.status_code == 503
        body = response.json()
        assert body["status"] == "not_ready"
        assert body["model"]["loaded"] is False
        assert body["model"]["reason"]


class TestPredict:
    def _request(self, **overrides) -> dict:
        payload = {
            "region": "Valencia",
            "startDate": "2026-04-01",
            "endDate": "2026-04-30",
            "coverageEth": "1.0",
            "rainfallThresholdMm": 50,
        }
        payload.update(overrides)
        return payload

    def test_returns_the_published_response_shape(self, client: TestClient) -> None:
        response = client.post("/predict", json=self._request())

        assert response.status_code == 200
        body = response.json()
        for field in (
            "region",
            "premiumEth",
            "premiumWei",
            "currency",
            "startDate",
            "endDate",
            "modelVersion",
        ):
            assert field in body

    def test_premium_wei_is_a_string(self, client: TestClient) -> None:
        # Wei for a large coverage exceeds what a JSON number survives; the
        # backend's DTO types it as a string for the same reason.
        response = client.post("/predict", json=self._request(coverageEth="1000000.0"))

        body = response.json()
        assert isinstance(body["premiumWei"], str)
        assert int(body["premiumWei"]) > 0

    def test_the_two_premium_representations_agree(self, client: TestClient) -> None:
        from app.core.money import parse_eth_to_wei

        body = client.post("/predict", json=self._request()).json()

        assert parse_eth_to_wei(body["premiumEth"]) == int(body["premiumWei"])

    def test_echoes_the_requested_window_and_region(self, client: TestClient) -> None:
        body = client.post("/predict", json=self._request()).json()

        assert body["region"] == "Valencia"
        assert body["startDate"] == "2026-04-01"
        assert body["endDate"] == "2026-04-30"

    @pytest.mark.parametrize(
        ("overrides", "expected_fragment"),
        [
            ({"coverageEth": "not-a-number"}, "coverageEth"),
            ({"coverageEth": "0"}, "coverageEth"),
            ({"coverageEth": "0.0"}, "coverageEth"),
            ({"coverageEth": "9" * 31}, "30 integer digits"),
            # 2**53: Python carries it, JavaScript does not, so the backend
            # would refuse a threshold that already lost precision.
            ({"rainfallThresholdMm": 9007199254740992}, "rainfallThresholdMm"),
            ({"coverageEth": "1.0000000000000000001"}, "coverageEth"),
            ({"rainfallThresholdMm": 0}, "rainfallThresholdMm"),
            ({"rainfallThresholdMm": -5}, "rainfallThresholdMm"),
            ({"region": ""}, "region"),
            ({"region": "x" * 32}, "on-chain limit"),
            ({"endDate": "2026-03-01"}, "on or after"),
            ({"startDate": "2026-01-01", "endDate": "2027-06-30"}, "on-chain maximum"),
        ],
    )
    def test_rejects_invalid_payloads_with_a_clear_message(
        self, client: TestClient, overrides: dict, expected_fragment: str
    ) -> None:
        response = client.post("/predict", json=self._request(**overrides))

        assert response.status_code == 422
        assert expected_fragment in json.dumps(response.json())

    def test_rejects_unknown_fields(self, client: TestClient) -> None:
        # A field the caller thinks is priced but is silently ignored is worse
        # than a rejection: the quote would look considered and not be.
        response = client.post("/predict", json=self._request(unexpectedRiskFactor=1.0))

        assert response.status_code == 422

    def test_a_region_at_the_byte_budget_is_accepted(self, client: TestClient) -> None:
        # 31 bytes exactly: the last value the chain can encode.
        response = client.post("/predict", json=self._request(region="x" * 31))

        assert response.status_code == 200

    def test_a_multibyte_region_is_measured_in_bytes(self, client: TestClient) -> None:
        # 16 accented characters are 32 UTF-8 bytes, so this must be refused
        # even though it is shorter than the character limit suggests.
        response = client.post("/predict", json=self._request(region="ñ" * 16))

        assert response.status_code == 422
        assert "UTF-8 bytes" in json.dumps(response.json())

    def test_accepts_leading_zeros_because_the_backend_does(
        self, client: TestClient
    ) -> None:
        # Refusing these would reject coverage the chain would happily insure.
        response = client.post("/predict", json=self._request(coverageEth="01.0"))

        assert response.status_code == 200

    def test_accepts_the_largest_representable_coverage(
        self, client: TestClient
    ) -> None:
        # Thirty integer digits at a low risk: the premium stays inside the
        # shared amount format, so this must be quotable.
        response = client.post(
            "/predict",
            json=self._request(
                coverageEth="9" * 30, region="lima", rainfallThresholdMm=300
            ),
        )

        assert response.status_code == 200
        from app.core.money import is_backend_consumable_amount

        assert is_backend_consumable_amount(response.json()["premiumEth"])

    def test_refuses_a_coverage_whose_premium_the_backend_could_not_carry(
        self, client: TestClient
    ) -> None:
        # The compound failure of the quote -> create promise: a coverage the
        # backend accepts, priced at maximum risk, produced a 31-digit premium
        # the backend would then refuse. Better to say so than to hand over a
        # number that reverts.
        response = client.post(
            "/predict",
            json=self._request(
                coverageEth="9" * 30,
                region="medellin",
                rainfallThresholdMm=1,
                startDate="2026-01-01",
                endDate="2026-12-31",
            ),
        )

        assert response.status_code == 422
        assert "exceeds the amount format" in json.dumps(response.json())

    def test_the_largest_safe_threshold_is_accepted(self, client: TestClient) -> None:
        response = client.post(
            "/predict", json=self._request(rainfallThresholdMm=2**53 - 1)
        )

        assert response.status_code == 200

    def test_every_successful_quote_is_backend_consumable(
        self, client: TestClient
    ) -> None:
        # The invariant this service promises, asserted across the range rather
        # than at one point.
        from app.core.money import is_backend_consumable_amount

        for region in ("lima", "valencia", "medellin"):
            for threshold in (1, 50, 300):
                for coverage in ("0.000000000000000001", "1.0", "1000000.0"):
                    response = client.post(
                        "/predict",
                        json=self._request(
                            region=region,
                            coverageEth=coverage,
                            rainfallThresholdMm=threshold,
                        ),
                    )
                    assert response.status_code == 200, response.text
                    body = response.json()
                    assert is_backend_consumable_amount(body["premiumEth"])
                    assert int(body["premiumWei"]) > 0

    def test_an_unencodable_region_is_a_422_not_a_500(self, client: TestClient) -> None:
        # A lone surrogate is valid JSON and not valid UTF-8. Rejecting it was
        # never the problem: the rejection itself failed to serialise, because
        # the validation error echoes the offending input, so a malformed
        # request came back as a server error.
        # Raw bytes, so the escape reaches the JSON parser rather than Python:
        # a source file cannot hold the character itself, which is the whole
        # point of the case.
        raw = (
            rb'{"region":"\ud800","startDate":"2026-04-01",'
            rb'"endDate":"2026-04-30","coverageEth":"1.0","rainfallThresholdMm":50}'
        )

        response = client.post(
            "/predict", content=raw, headers={"content-type": "application/json"}
        )

        assert response.status_code == 422
        # And the body must be readable, which is the half that was broken.
        assert response.json()["detail"]

    @pytest.mark.parametrize("token", ["NaN", "Infinity", "-Infinity"])
    def test_non_finite_numbers_are_422_not_500(
        self, client: TestClient, token: str
    ) -> None:
        # Python writes these happily and the response encoder refuses them, so
        # a request that was correctly rejected came back as a 500 while its
        # rejection was being serialised.
        raw = (
            b'{"region":"Valencia","startDate":"2026-04-01","endDate":'
            b'"2026-04-30","coverageEth":"1.0","rainfallThresholdMm":'
            + token.encode()
            + b"}"
        )

        response = client.post(
            "/predict", content=raw, headers={"content-type": "application/json"}
        )

        assert response.status_code == 422
        assert response.json()["detail"]

    def test_a_single_day_window_is_priced(self, client: TestClient) -> None:
        response = client.post(
            "/predict",
            json=self._request(startDate="2026-04-01", endDate="2026-04-01"),
        )

        assert response.status_code == 200
        assert response.json()["durationDays"] == 1

    def test_the_maximum_window_is_priced(self, client: TestClient) -> None:
        # 365 days inclusive: the longest policy the provider will create.
        response = client.post(
            "/predict",
            json=self._request(startDate="2026-01-01", endDate="2026-12-31"),
        )

        assert response.status_code == 200
        assert response.json()["durationDays"] == 365
