//! The policy verifier against a vector made by the TypeScript side (`apps/desktop/ci/gen-policy-vector.mjs`):
//! canonical JSON byte-for-byte, a real ES256 signature (raw `r || s`), and the tamper cases.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use neo_agent_core::policy::{CanonicalError, TrustedKey, VerifyError, canonical_json, parse_trusted_keys, verify_envelope};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn vector() -> Value {
    serde_json::from_str(include_str!("fixtures/policy-vector.json")).unwrap()
}

fn keys(v: &Value) -> Vec<TrustedKey> {
    parse_trusted_keys(&json!([v["jwk"]]).to_string())
}

#[test]
fn canonical_json_matches_the_typescript_output_byte_for_byte() {
    let v = vector();
    let cases = v["canonicalCases"].as_array().unwrap();
    assert!(cases.len() >= 5);
    for c in cases {
        assert_eq!(
            canonical_json(&c["value"]).unwrap(),
            c["canonical"].as_str().unwrap(),
            "case: {}",
            c["name"]
        );
    }
    // The whole compiled-shape bundle, as signed.
    assert_eq!(
        canonical_json(&v["envelope"]["bundle"]).unwrap(),
        v["canonicalBundle"].as_str().unwrap()
    );
}

#[test]
fn policy_version_is_the_sha256_of_the_canonical_body() {
    let v = vector();
    let mut body = v["envelope"]["bundle"].clone();
    for k in ["issuedAt", "expiresAt", "policyVersion"] {
        body.as_object_mut().unwrap().remove(k);
    }
    let text = canonical_json(&body).unwrap();
    assert_eq!(text, v["policyVersionBody"].as_str().unwrap());
    let hex: String = Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(hex, v["envelope"]["bundle"]["policyVersion"].as_str().unwrap());
}

#[test]
fn a_good_signature_verifies_and_parses() {
    let v = vector();
    let out = verify_envelope(&v["envelope"], &keys(&v)).unwrap();
    assert_eq!(out.key_id, "test-vector-key");
    let b = out.bundle;
    assert!(b.is_child());
    assert_eq!(b.time_zone, "America/New_York");
    assert!(b.apps.require_approval);
    assert_eq!(b.apps.block.len(), 2);
    assert_eq!(b.apps.block[0].bundle_id.as_deref(), Some("com.roblox.Roblox"));
    assert_eq!(b.apps.block[1].signer.as_deref(), Some("Roblox \"Corp\" \u{e9}"));
    assert_eq!(b.screen_time.daily_minutes.mon, Some(120));
    assert_eq!(b.screen_time.daily_minutes.sun, None);
    assert_eq!(b.screen_time.downtime[0].end, "07:00");
    assert_eq!(b.screen_time.grants[0].minutes, 30);
    assert_eq!(b.screen_time.allow_during_downtime[0].bundle_id.as_deref(), Some("us.zoom.xos"));
}

#[test]
fn a_tampered_bundle_fails_whatever_byte_changes() {
    let v = vector();
    let k = keys(&v);
    for (path, replacement) in [
        ("/mode", json!("standard")),
        ("/apps/requireApproval", json!(false)),
        ("/screenTime/warnMinutes", json!(11)),
        ("/screenTime/dailyMinutes/sat", json!(181)),
        ("/apps/block/0/bundleId", json!("com.roblox.Robl0x")),
        ("/deviceId", json!("11111111-1111-4111-8111-111111111112")),
    ] {
        let mut env = v["envelope"].clone();
        *env["bundle"].pointer_mut(path).unwrap() = replacement;
        assert_eq!(verify_envelope(&env, &k), Err(VerifyError::BadSignature), "{path}");
    }
    // An added or removed field changes the canonical bytes too.
    let mut env = v["envelope"].clone();
    env["bundle"]["extra"] = json!(1);
    assert_eq!(verify_envelope(&env, &k), Err(VerifyError::BadSignature));
    let mut env = v["envelope"].clone();
    env["bundle"].as_object_mut().unwrap().remove("apps");
    assert_eq!(verify_envelope(&env, &k), Err(VerifyError::BadSignature));
    // A float where the server sent an integer cannot be canonicalized the same way.
    let mut env = v["envelope"].clone();
    env["bundle"]["screenTime"]["warnMinutes"] = serde_json::from_str("10.0").unwrap();
    assert_eq!(verify_envelope(&env, &k), Err(VerifyError::BadSignature));
    assert_eq!(canonical_json(&env["bundle"]), Err(CanonicalError::NotInteger));
}

#[test]
fn a_tampered_signature_an_unknown_key_and_bad_shapes_fail() {
    let v = vector();
    let k = keys(&v);
    // Flip one signature bit.
    let mut raw = URL_SAFE_NO_PAD.decode(v["envelope"]["sig"].as_str().unwrap()).unwrap();
    assert_eq!(raw.len(), 64);
    raw[10] ^= 1;
    let mut env = v["envelope"].clone();
    env["sig"] = json!(URL_SAFE_NO_PAD.encode(&raw));
    assert_eq!(verify_envelope(&env, &k), Err(VerifyError::BadSignature));

    // An unknown kid (key rotation not shipped in this build).
    let mut env = v["envelope"].clone();
    env["keyId"] = json!("someone-else");
    assert_eq!(verify_envelope(&env, &k), Err(VerifyError::UnknownKey));
    assert_eq!(verify_envelope(&v["envelope"], &[]), Err(VerifyError::UnknownKey));

    // A signature that is too short, too long or not base64url is malformed, not a crash.
    let too_long = "A".repeat(200);
    for sig in ["", "AAAA", "not base64url!", too_long.as_str()] {
        let mut env = v["envelope"].clone();
        env["sig"] = json!(sig);
        assert_eq!(verify_envelope(&env, &k), Err(VerifyError::Malformed), "{sig}");
    }
    // The wrong algorithm, a missing field, or not an object.
    let mut env = v["envelope"].clone();
    env["alg"] = json!("none");
    assert_eq!(verify_envelope(&env, &k), Err(VerifyError::Malformed));
    let mut env = v["envelope"].clone();
    env.as_object_mut().unwrap().remove("bundle");
    assert_eq!(verify_envelope(&env, &k), Err(VerifyError::Malformed));
    assert_eq!(verify_envelope(&json!([1]), &k), Err(VerifyError::Malformed));
}

#[test]
fn a_signature_from_another_key_with_the_right_kid_fails() {
    // The vector's signature, checked against a different valid public key under the same kid
    // (the production key from `GET /api/devices/policy/keys`).
    let v = vector();
    let other = json!([{
        "kty": "EC", "crv": "P-256", "kid": "test-vector-key",
        "x": "0ojX1kmT6Ht_uoanKK_FVPm1ktljxrXFiaEWq0VrWv8",
        "y": "m-16LQgFFpXgb3VqxCn5VNGZEaMaUiHmx8Wcf8ODF_A"
    }]);
    let k = parse_trusted_keys(&other.to_string());
    assert_eq!(k.len(), 1);
    assert_eq!(verify_envelope(&v["envelope"], &k), Err(VerifyError::BadSignature));
}

#[test]
fn both_key_list_shapes_are_accepted() {
    let v = vector();
    let entry = json!([{ "kid": "test-vector-key", "alg": "ES256", "jwk": v["jwk"] }]);
    assert_eq!(parse_trusted_keys(&entry.to_string()).len(), 1);
}
