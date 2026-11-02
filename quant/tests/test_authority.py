import json
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path

from fcquant.authority import (
    ProposalError,
    assert_no_authority,
    load_proposal,
    sanitize_proposal,
    validate_proposal,
)


def valid_raw():
    return {
        "hypothesis": "20-day cross-sectional momentum persists in liquid names.",
        "rationale": "Slow information diffusion and flow persistence.",
        "factor_expression": "rank(momentum(close, 20))",
        "expected_direction": "long",
        "confidence": 0.55,
        "evidence_refs": ["research-note-001"],
        "universe": ["alpha", "beta"],
        "horizon_days": 20,
        # The model should never be allowed to write these.
        "target_weight": 0.9,
        "order": {"side": "buy", "qty": 100000},
        "risk_limit": 999999,
    }


class AuthorityTests(unittest.TestCase):
    def test_reserved_fields_are_stripped(self):
        raw = valid_raw()
        sanitized = sanitize_proposal(raw)
        self.assertNotIn("target_weight", sanitized.clean)
        self.assertNotIn("order", sanitized.clean)
        self.assertNotIn("risk_limit", sanitized.clean)
        self.assertIn("target_weight", sanitized.ignored_fields)
        self.assertIn("target_weight", sanitized.reserved_fields)
        self.assertEqual(sanitized.to_dict()["execution_authority"], "DENIED")

    def test_valid_proposal_normalizes(self):
        sanitized = sanitize_proposal(valid_raw())
        normalized = validate_proposal(sanitized.clean)
        self.assertEqual(normalized["expected_direction"], "long")
        self.assertEqual(normalized["universe"], ["ALPHA", "BETA"])
        self.assertEqual(normalized["confidence"], 0.55)
        self.assertEqual(normalized["horizon_days"], 20)
        assert_no_authority(normalized)

    def test_input_is_not_mutated(self):
        raw = valid_raw()
        before = deepcopy(raw)
        sanitize_proposal(raw)
        self.assertEqual(raw, before)

    def test_rejects_missing_hypothesis(self):
        clean = {
            "factor_expression": "momentum(close, 20)",
            "expected_direction": "long",
            "confidence": 0.5,
            "evidence_refs": ["note"],
        }
        with self.assertRaises(ProposalError):
            validate_proposal(clean)

    def test_rejects_code_like_expression(self):
        clean = {
            "hypothesis": "x",
            "factor_expression": "eval(close)",
            "expected_direction": "long",
            "confidence": 0.5,
            "evidence_refs": ["note"],
        }
        with self.assertRaises(ProposalError):
            validate_proposal(clean)

    def test_rejects_unknown_field(self):
        clean = {
            "hypothesis": "x",
            "factor_expression": "momentum(close, 20)",
            "expected_direction": "long",
            "confidence": 0.5,
            "evidence_refs": ["note"],
            "foo": 1,
        }
        with self.assertRaises(ProposalError):
            validate_proposal(clean)

    def test_rejects_confidence_out_of_range(self):
        clean = {
            "hypothesis": "x",
            "factor_expression": "momentum(close, 20)",
            "expected_direction": "long",
            "confidence": 1.5,
            "evidence_refs": ["note"],
        }
        with self.assertRaises(ProposalError):
            validate_proposal(clean)

    def test_rejects_empty_evidence(self):
        clean = {
            "hypothesis": "x",
            "factor_expression": "momentum(close, 20)",
            "expected_direction": "long",
            "confidence": 0.5,
            "evidence_refs": [],
        }
        with self.assertRaises(ProposalError):
            validate_proposal(clean)

    def test_rejects_authority_field_in_clean_dict(self):
        clean = {
            "hypothesis": "x",
            "factor_expression": "momentum(close, 20)",
            "expected_direction": "long",
            "confidence": 0.5,
            "evidence_refs": ["note"],
            "target_weight": 0.9,
        }
        with self.assertRaises(ProposalError):
            validate_proposal(clean)

    def test_load_rejects_invalid_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bad.json"
            path.write_text("{not json", encoding="utf-8")
            with self.assertRaises(ProposalError):
                load_proposal(path)

    def test_load_rejects_non_object(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "list.json"
            path.write_text(json.dumps([1, 2, 3]), encoding="utf-8")
            with self.assertRaises(ProposalError):
                sanitize_proposal(load_proposal(path))

    def test_expression_grammar_accepts_contract(self):
        clean = {
            "hypothesis": "x",
            "factor_expression": "rank(momentum(close, 20))",
            "expected_direction": "long",
            "confidence": 0.5,
            "evidence_refs": ["note"],
        }
        normalized = validate_proposal(clean)
        self.assertEqual(normalized["factor_expression"], "rank(momentum(close, 20))")


if __name__ == "__main__":
    unittest.main()