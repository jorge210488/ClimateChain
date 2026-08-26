"""
Configuration validation, monetary conversion, and artifact integrity.

Grouped because they share a purpose: each one is a boundary where a wrong
value would be accepted silently and surface much later as a bad premium or a
service that will not start.
"""

from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from app.core.config import Settings
from app.core.domain import minimum_premium_wei
from app.core.money import (
    InvalidEthAmountError,
    format_wei_to_eth,
    is_backend_consumable_amount,
    parse_eth_to_wei,
)
from app.models.artifact import (
    ModelArtifactError,
    compute_checksum,
    load_artifact,
)
from tests.conftest_helpers import ARTIFACT_PATH, MODULE_ROOT


def settings(**overrides) -> Settings:
    base = {"APP_ENV": "test", "MODEL_PROVIDER": "baseline"}
    base.update(overrides)
    return Settings(_env_file=None, **base)


class TestSettings:
    def test_rejects_an_unknown_profile(self) -> None:
        with pytest.raises(ValidationError, match="APP_ENV"):
            settings(APP_ENV="prod")

    def test_rejects_an_unknown_log_level(self) -> None:
        with pytest.raises(ValidationError, match="LOG_LEVEL"):
            settings(LOG_LEVEL="verbose")

    def test_rejects_an_out_of_range_port(self) -> None:
        with pytest.raises(ValidationError):
            settings(APP_PORT=70_000)

    def test_rejects_a_provider_that_does_not_exist_yet(self) -> None:
        # Stage 08 adds a value here. Until then, a typo must not resolve to a
        # provider whose artifact this service cannot evaluate.
        with pytest.raises(ValidationError, match="MODEL_PROVIDER"):
            settings(MODEL_PROVIDER="gbm")

    @pytest.mark.parametrize(
        ("profile", "deployed"),
        [
            ("development", False),
            ("test", False),
            ("staging", True),
            ("testnet", True),
            ("production", True),
        ],
    )
    def test_classifies_profiles(self, profile: str, deployed: bool) -> None:
        assert settings(APP_ENV=profile).is_deployed_profile is deployed

    def test_resolves_a_relative_model_path_against_the_module(self) -> None:
        # Anchored to `ml-service/`, not to the directory the process happened
        # to start in: the gate, the tests, and `python serve.py` all run from
        # different places.
        resolved = settings(
            MODEL_PATH="app/models/artifacts/x.json"
        ).resolved_model_path

        assert resolved.is_absolute()
        assert resolved == MODULE_ROOT / "app/models/artifacts/x.json"

    def test_leaves_an_absolute_model_path_alone(self, tmp_path) -> None:
        absolute = tmp_path / "model.json"

        assert settings(MODEL_PATH=str(absolute)).resolved_model_path == absolute


class TestMoney:
    @pytest.mark.parametrize(
        ("amount", "expected_wei"),
        [
            ("1.0", 10**18),
            ("0.08", 8 * 10**16),
            ("0.000000000000000001", 1),
            ("12.345", 12_345 * 10**15),
            # Leading zeros are accepted because the backend accepts them.
            # Rejecting them here refused business the chain would have taken.
            ("01.0", 10**18),
            ("0000.5", 5 * 10**17),
            # Thirty integer digits: the largest the shared contract carries.
            ("9" * 30, int("9" * 30) * 10**18),
        ],
    )
    def test_parses_exact_wei(self, amount: str, expected_wei: int) -> None:
        assert parse_eth_to_wei(amount) == expected_wei

    @pytest.mark.parametrize(
        "amount",
        [
            "1.0000000000000000001",  # 19 decimals
            "-1.0",
            "1e18",
            "1,5",
            "",
            ".5",
            "abc",
            # Zero in every spelling: the backend's lookahead refuses all of
            # them, and a policy with no coverage is not creatable anyway.
            "0",
            "0.0",
            "00",
            "0.000",
            # Thirty-one integer digits: one past what the backend accepts.
            "9" * 31,
        ],
    )
    def test_rejects_malformed_amounts(self, amount: str) -> None:
        with pytest.raises(InvalidEthAmountError):
            parse_eth_to_wei(amount)

    def test_accepts_exactly_what_the_backend_accepts(self) -> None:
        # The divergences a review found, pinned as a set. This pattern used to
        # reject "01.0" the backend takes and accept 31 digits it refuses —
        # opposite errors, both breaking quote -> create.
        accepted = ["1.0", "01.0", "0.08", "9" * 30, "0.000000000000000001"]
        refused = ["0", "0.0", "9" * 31, "1.0000000000000000001", "-1"]

        assert all(is_backend_consumable_amount(value) for value in accepted)
        assert not any(is_backend_consumable_amount(value) for value in refused)

    @pytest.mark.parametrize(
        "amount", ["1.0", "0.08", "0.000000000000000001", "999999.123456789"]
    )
    def test_round_trips_without_loss(self, amount: str) -> None:
        # The property that matters: a premium rendered here is parsed back to
        # the same wei by the backend before it reaches the contract.
        wei = parse_eth_to_wei(amount)
        assert parse_eth_to_wei(format_wei_to_eth(wei)) == wei

    def test_rejects_negative_wei(self) -> None:
        with pytest.raises(InvalidEthAmountError):
            format_wei_to_eth(-1)


class TestMinimumPremium:
    @pytest.mark.parametrize(
        ("coverage_wei", "expected"),
        [
            (10**18, 10**16),  # 1 ETH -> 0.01 ETH
            (0, 0),
            (100, 1),  # exactly 1%
            (101, 2),  # 1.01 -> ceil
            (1, 1),  # a single wei still owes a premium
        ],
    )
    def test_rounds_up_like_the_contract(
        self, coverage_wei: int, expected: int
    ) -> None:
        # Ceiling, matching Math.Rounding.Ceil. Rounding down would produce
        # premiums short by one wei that revert as PremiumBelowMinimum.
        assert minimum_premium_wei(coverage_wei) == expected


class TestArtifactIntegrity:
    def test_loads_the_built_artifact(self) -> None:
        artifact = load_artifact(ARTIFACT_PATH)

        assert artifact.model_version == "baseline-premium-v1"
        assert artifact.provider == "baseline"
        assert len(artifact.features) == len(artifact.coefficients)
        assert artifact.known_regions

    def test_rejects_a_missing_file(self, tmp_path) -> None:
        with pytest.raises(ModelArtifactError, match="No model artifact"):
            load_artifact(tmp_path / "nope.json")

    def test_rejects_a_file_that_is_not_json(self, tmp_path) -> None:
        path = tmp_path / "broken.json"
        path.write_text("{not json", encoding="utf-8")

        with pytest.raises(ModelArtifactError, match="could not be read as JSON"):
            load_artifact(path)

    def test_rejects_a_missing_required_field(self, tmp_path) -> None:
        payload = json.loads(ARTIFACT_PATH.read_text(encoding="utf-8"))
        del payload["coefficients"]
        path = tmp_path / "incomplete.json"
        path.write_text(json.dumps(payload), encoding="utf-8")

        with pytest.raises(ModelArtifactError, match="missing required fields"):
            load_artifact(path)

    def test_rejects_a_future_schema_version(self, tmp_path) -> None:
        payload = json.loads(ARTIFACT_PATH.read_text(encoding="utf-8"))
        payload["schemaVersion"] = 99
        payload["checksum"] = compute_checksum(payload)
        path = tmp_path / "future.json"
        path.write_text(json.dumps(payload), encoding="utf-8")

        with pytest.raises(ModelArtifactError, match="schemaVersion=99"):
            load_artifact(path)

    def test_rejects_a_tampered_coefficient(self, tmp_path) -> None:
        # The checksum's whole purpose: a plausible edit that changes prices.
        payload = json.loads(ARTIFACT_PATH.read_text(encoding="utf-8"))
        payload["coefficients"][1] = 0.0
        path = tmp_path / "tampered.json"
        path.write_text(json.dumps(payload), encoding="utf-8")

        with pytest.raises(ModelArtifactError, match="integrity check"):
            load_artifact(path)

    def test_rejects_mismatched_features_and_coefficients(self, tmp_path) -> None:
        payload = json.loads(ARTIFACT_PATH.read_text(encoding="utf-8"))
        payload["coefficients"].append(1.0)
        payload["checksum"] = compute_checksum(payload)
        path = tmp_path / "mismatched.json"
        path.write_text(json.dumps(payload), encoding="utf-8")

        with pytest.raises(ModelArtifactError, match="must correspond"):
            load_artifact(path)

    def _rewritten(self, tmp_path, **changes):
        """Writes a checksum-valid artifact with the given fields replaced."""
        payload = json.loads(ARTIFACT_PATH.read_text(encoding="utf-8"))
        payload.update(changes)
        payload["checksum"] = compute_checksum(payload)
        path = tmp_path / "variant.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        return path

    def test_rejects_a_loading_that_overflows_when_scaled(self, tmp_path) -> None:
        # Finite on its own and infinite once pricing scales it. This loaded
        # cleanly, left readiness green, and returned 500 on the first quote —
        # the exact failure fail-fast is supposed to prevent.
        path = self._rewritten(tmp_path, premiumLoading=1e308)

        with pytest.raises(ModelArtifactError, match="overflows when scaled"):
            load_artifact(path)

    def test_rejects_a_negative_loading(self, tmp_path) -> None:
        # It loaded, and then priced every policy at the minimum floor — the
        # commercial model silently replaced, with nothing looking broken.
        path = self._rewritten(tmp_path, premiumLoading=-2.0)

        with pytest.raises(ModelArtifactError, match="below zero"):
            load_artifact(path)

    def test_accepts_a_loading_of_zero(self, tmp_path) -> None:
        # Charging exactly the expected loss is a defensible choice, unlike
        # charging less than it.
        path = self._rewritten(tmp_path, premiumLoading=0.0)

        assert load_artifact(path).premium_loading == 0.0

    def test_rejects_regions_that_collide_once_normalised(self, tmp_path) -> None:
        # Lookups are case-insensitive, so these are one region with two risks.
        # The winner used to be whichever JSON key came last.
        path = self._rewritten(
            tmp_path, regionRisk={"Valencia": 1.2, "valencia": 9.876}
        )

        with pytest.raises(ModelArtifactError, match="more than once"):
            load_artifact(path)

    def test_rejects_a_region_key_that_normalises_to_nothing(self, tmp_path) -> None:
        path = self._rewritten(tmp_path, regionRisk={"  ": 1.2})

        with pytest.raises(ModelArtifactError, match="blank once normalised"):
            load_artifact(path)

    def test_checksum_ignores_key_order(self, tmp_path) -> None:
        # Canonical serialization: rewriting the file with different key order
        # must not look like tampering.
        payload = json.loads(ARTIFACT_PATH.read_text(encoding="utf-8"))
        reordered = dict(reversed(list(payload.items())))
        path = tmp_path / "reordered.json"
        path.write_text(json.dumps(reordered), encoding="utf-8")

        assert load_artifact(path).checksum == payload["checksum"]
