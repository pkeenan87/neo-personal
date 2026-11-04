//! Signed policy bundles (`_specs/v2-m2-child.md` section 4): the shape a Child-mode device
//! enforces, the canonical JSON the signature covers, and the ES256 verifier.
//!
//! The server signs the UTF-8 bytes of `canonicalJson(bundle)` (`packages/verdict/src/policy-bundle.ts`)
//! with ECDSA P-256 / SHA-256; the signature is the raw 64-byte `r || s`. **Never verify a
//! re-serialized struct:** the bundle is canonicalized from the JSON value exactly as received (a
//! newer server may add fields this struct does not know), verified, and only then deserialized.
//! The cross-language test vector (`tests/fixtures/policy-vector.json`, made by
//! `apps/desktop/ci/gen-policy-vector.mjs` from the TypeScript side) keeps the two byte-for-byte equal.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use p256::ecdsa::signature::Verifier;
use p256::ecdsa::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// `v` of the bundles this build understands.
pub const BUNDLE_VERSION: u64 = 1;
/// The only accepted `alg`.
pub const ALG: &str = "ES256";
/// Canonicalization refuses to descend deeper than this (a bundle is three levels deep).
const MAX_DEPTH: usize = 16;

// ---- Canonical JSON -----------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CanonicalError {
    /// A number that is not an integer. A bundle has only integers; JS and Rust would print
    /// other numbers differently, so they are refused rather than guessed at.
    #[error("a number in the bundle is not an integer")]
    NotInteger,
    #[error("the bundle is nested too deeply")]
    TooDeep,
}

/// `canonicalJson` of `@neo/verdict`: object keys sorted by UTF-16 code unit, no whitespace, arrays
/// in order, strings as `JSON.stringify` writes them (non-ASCII kept as UTF-8), `null` kept.
pub fn canonical_json(value: &Value) -> Result<String, CanonicalError> {
    let mut out = String::new();
    write_canonical(value, &mut out, 0)?;
    Ok(out)
}

fn write_canonical(value: &Value, out: &mut String, depth: usize) -> Result<(), CanonicalError> {
    if depth > MAX_DEPTH {
        return Err(CanonicalError::TooDeep);
    }
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            if !(n.is_i64() || n.is_u64()) {
                return Err(CanonicalError::NotInteger);
            }
            out.push_str(&n.to_string());
        }
        Value::String(s) => write_string(s, out),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(item, out, depth + 1)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            // Explicit UTF-16 order (not the map's own iteration order): the same as JS `sort()`.
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (i, key) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(key, out);
                out.push(':');
                write_canonical(&map[key], out, depth + 1)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

/// A JSON string. serde_json escapes `"`, `\`, and the control characters (`\b \f \n \r \t`, else
/// lowercase `\u00xx`) and nothing else, which is what `JSON.stringify` does for valid UTF-8.
fn write_string(s: &str, out: &mut String) {
    match serde_json::to_string(s) {
        Ok(text) => out.push_str(&text),
        // Serializing a `&str` cannot fail; keep the output valid anyway.
        Err(_) => out.push_str("\"\""),
    }
}

// ---- Bundle ---------------------------------------------------------------------------------------

/// An app named by a policy: a macOS bundle id, or a Windows signer and/or image name.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppRef {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
}

impl AppRef {
    pub fn is_empty(&self) -> bool {
        [&self.bundle_id, &self.signer, &self.image]
            .iter()
            .all(|f| f.as_deref().is_none_or(|s| s.trim().is_empty()))
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct DailyMinutes {
    pub mon: Option<u32>,
    pub tue: Option<u32>,
    pub wed: Option<u32>,
    pub thu: Option<u32>,
    pub fri: Option<u32>,
    pub sat: Option<u32>,
    pub sun: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct DowntimeWindow {
    /// `HH:MM`, 24-hour, in the bundle's `timeZone`.
    pub start: String,
    pub end: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Grant {
    pub minutes: u32,
    /// RFC 3339; the grant counts while this is in the future.
    pub until: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppsRules {
    pub block: Vec<AppRef>,
    pub require_approval: bool,
    pub approved: Vec<AppRef>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ScreenTimeRules {
    pub daily_minutes: DailyMinutes,
    pub downtime: Vec<DowntimeWindow>,
    pub warn_minutes: u32,
    pub allow_during_downtime: Vec<AppRef>,
    pub grants: Vec<Grant>,
}

/// The session a command is about: the remote-access tool (a `toolId` of the detection lists) and,
/// when the server knows it, the remote ID that connected. Never a pid: the agent does not report one.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionRef {
    pub tool_id: String,
    pub peer_id: Option<String>,
}

/// A command for this device (`_specs/v2-m3-cutover.md` section 4). Only `end_session` exists; a
/// `kind` this build does not know is ignored.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Command {
    pub id: String,
    pub kind: String,
    pub session_ref: SessionRef,
    /// The person at the computer must say yes on screen before anything is closed.
    pub requires_confirmation: bool,
    /// RFC 3339; the command is ignored from this moment.
    pub expires_at: String,
}

/// The part of a bundle the desktop agent enforces. Web rules are the extension's. Every field has
/// a default, so an absent section means "no rule": the safe reading for enforcement.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PolicyBundle {
    pub v: u64,
    pub device_id: String,
    pub member_id: String,
    pub policy_version: String,
    pub issued_at: String,
    pub expires_at: String,
    /// IANA zone name; `UTC` when the household has none.
    pub time_zone: String,
    /// `standard`, `elder` or `child`. Only `child` enforces anything on the desktop.
    pub mode: String,
    pub apps: AppsRules,
    pub screen_time: ScreenTimeRules,
    /// Pending commands for this device, in every mode. Absent when there are none.
    pub commands: Vec<Command>,
}

impl PolicyBundle {
    pub fn is_child(&self) -> bool {
        self.mode == "child"
    }
}

// ---- Keys and verification -----------------------------------------------------------------------

/// A pinned policy public key.
#[derive(Debug, Clone)]
pub struct TrustedKey {
    pub kid: String,
    key: VerifyingKey,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum VerifyError {
    /// Not an envelope (shape, `alg`, signature length or encoding, or the bundle is not for this build).
    #[error("malformed policy envelope")]
    Malformed,
    /// Signed by a key this build does not trust.
    #[error("policy signed by an unknown key")]
    UnknownKey,
    #[error("policy signature does not verify")]
    BadSignature,
}

/// Parses `NEO_POLICY_PUBKEYS`: a JSON array of P-256 JWKs, each carrying its `kid` (an entry
/// `{ kid, jwk }`, as the keys endpoint lists them, is accepted too). Entries that are not usable
/// are skipped, so a bad entry can never make a key trusted; no usable entry means no policy can
/// be verified.
pub fn parse_trusted_keys(json: &str) -> Vec<TrustedKey> {
    let Ok(Value::Array(entries)) = serde_json::from_str::<Value>(json) else {
        return Vec::new();
    };
    entries.iter().filter_map(trusted_key).collect()
}

fn trusted_key(entry: &Value) -> Option<TrustedKey> {
    let (kid, jwk) = match entry.get("jwk") {
        Some(jwk) => (entry.get("kid")?.as_str()?, jwk),
        None => (entry.get("kid")?.as_str()?, entry),
    };
    if kid.is_empty() || jwk.get("kty")?.as_str()? != "EC" || jwk.get("crv")?.as_str()? != "P-256" {
        return None;
    }
    let x = URL_SAFE_NO_PAD.decode(jwk.get("x")?.as_str()?).ok()?;
    let y = URL_SAFE_NO_PAD.decode(jwk.get("y")?.as_str()?).ok()?;
    if x.len() != 32 || y.len() != 32 {
        return None;
    }
    // SEC1 uncompressed point: 0x04 || x || y. `from_sec1_bytes` checks it is on the curve.
    let mut point = Vec::with_capacity(65);
    point.push(0x04);
    point.extend_from_slice(&x);
    point.extend_from_slice(&y);
    let key = VerifyingKey::from_sec1_bytes(&point).ok()?;
    Some(TrustedKey { kid: kid.to_string(), key })
}

/// A bundle whose signature verified.
#[derive(Debug, Clone, PartialEq)]
pub struct Verified {
    pub bundle: PolicyBundle,
    pub key_id: String,
}

/// Verifies an envelope `{ bundle, sig, keyId, alg }` against pinned keys: `alg`, a key with
/// `kid == keyId`, and the signature over `canonical_json(bundle)`. Expiry is not checked (a device
/// keeps enforcing its last valid bundle past `expiresAt`). Never panics.
pub fn verify_envelope(envelope: &Value, keys: &[TrustedKey]) -> Result<Verified, VerifyError> {
    let obj = envelope.as_object().ok_or(VerifyError::Malformed)?;
    if obj.get("alg").and_then(Value::as_str) != Some(ALG) {
        return Err(VerifyError::Malformed);
    }
    let key_id = obj.get("keyId").and_then(Value::as_str).ok_or(VerifyError::Malformed)?;
    let sig_text = obj.get("sig").and_then(Value::as_str).ok_or(VerifyError::Malformed)?;
    let raw_bundle = obj.get("bundle").filter(|b| b.is_object()).ok_or(VerifyError::Malformed)?;
    let raw_sig = URL_SAFE_NO_PAD.decode(sig_text).map_err(|_| VerifyError::Malformed)?;
    let signature = Signature::from_slice(&raw_sig).map_err(|_| VerifyError::Malformed)?;
    let key = keys.iter().find(|k| k.kid == key_id).ok_or(VerifyError::UnknownKey)?;
    let canonical = canonical_json(raw_bundle).map_err(|_| VerifyError::BadSignature)?;
    key.key
        .verify(canonical.as_bytes(), &signature)
        .map_err(|_| VerifyError::BadSignature)?;
    // Only now is the bundle read as a struct.
    let bundle: PolicyBundle = serde_json::from_value(raw_bundle.clone()).map_err(|_| VerifyError::Malformed)?;
    if bundle.v != BUNDLE_VERSION {
        return Err(VerifyError::Malformed);
    }
    Ok(Verified {
        bundle,
        key_id: key_id.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn canonical_basics() {
        let v = json!({ "b": 1, "a": [3, 1, 2], "c": { "z": true, "y": null } });
        assert_eq!(canonical_json(&v).unwrap(), r#"{"a":[3,1,2],"b":1,"c":{"y":null,"z":true}}"#);
    }

    #[test]
    fn floats_are_refused_not_guessed() {
        assert_eq!(canonical_json(&json!({ "a": 1.5 })), Err(CanonicalError::NotInteger));
        // `1.0` parsed from text is a float to serde_json; JS would have printed `1`.
        let v: Value = serde_json::from_str(r#"{"a":1.0}"#).unwrap();
        assert_eq!(canonical_json(&v), Err(CanonicalError::NotInteger));
    }

    #[test]
    fn depth_is_bounded() {
        let mut v = json!(1);
        for _ in 0..40 {
            v = json!([v]);
        }
        assert_eq!(canonical_json(&v), Err(CanonicalError::TooDeep));
    }

    #[test]
    fn bad_keys_are_skipped() {
        assert!(parse_trusted_keys("not json").is_empty());
        assert!(parse_trusted_keys("{}").is_empty());
        assert!(parse_trusted_keys(r#"[{"kty":"EC","crv":"P-256","x":"AA","y":"AA","kid":"a"}]"#).is_empty());
        assert!(parse_trusted_keys(r#"[{"kty":"RSA","kid":"a"}]"#).is_empty());
        // Right length, not on the curve.
        let x = URL_SAFE_NO_PAD.encode([1u8; 32]);
        let j = format!(r#"[{{"kty":"EC","crv":"P-256","x":"{x}","y":"{x}","kid":"a"}}]"#);
        assert!(parse_trusted_keys(&j).is_empty());
    }
}
