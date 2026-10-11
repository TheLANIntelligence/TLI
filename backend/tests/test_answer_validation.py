from ai.answer_validation import ANNIVERSARY_REFERENCES, COMPARISON_REFERENCES, REFERENCE, for_preset


def test_historical_reference_is_preserved_without_replacing_new_evidence():
    assert REFERENCE['case_count'] == 23
    assert REFERENCE['quality_acceptance'] == 'not_passed'
    assert REFERENCE['report_url'] == '/answer-validation.html'
    assert for_preset({'filename': REFERENCE['model_filename']})['case_count'] == 55


def test_comparisons_do_not_certify_installed_weights_or_running_health():
    assert len(ANNIVERSARY_REFERENCES) == len(COMPARISON_REFERENCES) == 6
    for filename, expected in ANNIVERSARY_REFERENCES.items():
        result = for_preset({'filename': filename})
        assert result == expected and result is not expected
        assert result['status'] == 'comparison_recorded'
        assert result['study_id'] == 'anniversary_completion'
        assert result['quality_acceptance'] == 'not_passed'
        assert result['report_url'].startswith('/model-comparison-anniversary.html#model-')
        assert COMPARISON_REFERENCES[filename]['report_url'].startswith('/model-comparison.html#model-')
        assert result['response_report_sha256'] != COMPARISON_REFERENCES[filename]['response_report_sha256']
        assert result['installed_artifact_verified'] is False
        assert result['physical_user_acceptance'] == 'not_run'
        assert 'running' not in result and 'healthy' not in result and 'recommended' not in result
        result['case_count'] = 0
        result['primary_dimensions']['factual_grounding']['2'] = -1
        fresh = for_preset({'filename': filename})
        assert fresh['case_count'] == 55
        assert fresh['primary_dimensions']['factual_grounding']['2'] >= 0


def test_other_artifacts_remain_unevaluated():
    assert for_preset({'filename': 'another.gguf'})['status'] == 'not_evaluated'
    assert for_preset({})['status'] == 'not_evaluated'
