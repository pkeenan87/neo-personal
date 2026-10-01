//! The named-pipe protocol (`docs/contracts.md` "Desktop agent"): newline-delimited JSON, each
//! request at most 16 KB. Every request is validated as if it were attacker-controlled: any local
//! process can connect to the pipe.

use std::io::{self, BufRead};

use serde_json::{Value, json};

/// Largest accepted request line, in bytes (without the newline).
pub const MAX_REQUEST_BYTES: usize = 16 * 1024;
/// Enrollment codes are at most this long (the server's own limit).
pub const MAX_CODE_LEN: usize = 64;
/// Device names are at most this long.
pub const MAX_NAME_LEN: usize = 64;
/// URLs to check are at most this long.
pub const MAX_URL_LEN: usize = 2048;
/// Server URLs (advanced setting) are at most this long.
pub const MAX_SERVER_URL_LEN: usize = 200;

/// A validated request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Request {
    Status,
    EnrollPreview {
        code: String,
        server_url: Option<String>,
    },
    Enroll {
        code: String,
        name: Option<String>,
        server_url: Option<String>,
    },
    SelfEnrollStart {
        name: Option<String>,
        server_url: Option<String>,
    },
    SelfEnrollPoll,
    CheckUrl {
        url: String,
    },
    Unenroll,
    Subscribe,
}

/// Why a request line was refused. `code()` is the wire error code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolError {
    TooLarge,
    InvalidJson,
    UnknownOp(String),
    Invalid(&'static str),
}

impl ProtocolError {
    pub fn code(&self) -> &'static str {
        match self {
            ProtocolError::TooLarge => "request_too_large",
            ProtocolError::InvalidJson => "invalid_json",
            ProtocolError::UnknownOp(_) => "unknown_op",
            ProtocolError::Invalid(_) => "invalid_request",
        }
    }

    pub fn message(&self) -> String {
        match self {
            ProtocolError::TooLarge => format!("request is larger than {MAX_REQUEST_BYTES} bytes"),
            ProtocolError::InvalidJson => "request is not a JSON object".to_string(),
            ProtocolError::UnknownOp(_) => "unknown op".to_string(),
            ProtocolError::Invalid(why) => (*why).to_string(),
        }
    }

    /// The `{ ok: false, code, error }` response.
    pub fn response(&self) -> Value {
        error_response(self.code(), &self.message())
    }
}

/// `{ ok: false, code, error }`.
pub fn error_response(code: &str, error: &str) -> Value {
    json!({ "ok": false, "code": code, "error": error })
}

/// `{ ok: true, ...fields }`; `fields` must be a JSON object (or null for none).
pub fn ok_response(fields: Value) -> Value {
    let mut out = serde_json::Map::new();
    out.insert("ok".into(), Value::Bool(true));
    if let Value::Object(map) = fields {
        out.extend(map);
    }
    Value::Object(out)
}

/// What reading one line produced.
#[derive(Debug, PartialEq, Eq)]
pub enum Line {
    /// A complete line (newline removed).
    Data(Vec<u8>),
    /// The line is over [`MAX_REQUEST_BYTES`]. The rest is not read: close the connection after
    /// answering.
    TooLarge,
    /// End of stream.
    Eof,
}

/// Reads one request line without buffering more than [`MAX_REQUEST_BYTES`] + 1 bytes.
pub fn read_line<R: BufRead>(r: &mut R) -> io::Result<Line> {
    let mut buf: Vec<u8> = Vec::new();
    loop {
        let chunk = r.fill_buf()?;
        if chunk.is_empty() {
            return Ok(if buf.is_empty() { Line::Eof } else { Line::Data(buf) });
        }
        match chunk.iter().position(|b| *b == b'\n') {
            Some(i) => {
                if buf.len() + i > MAX_REQUEST_BYTES {
                    return Ok(Line::TooLarge);
                }
                buf.extend_from_slice(&chunk[..i]);
                r.consume(i + 1);
                return Ok(Line::Data(buf));
            }
            None => {
                if buf.len() + chunk.len() > MAX_REQUEST_BYTES {
                    return Ok(Line::TooLarge);
                }
                let n = chunk.len();
                buf.extend_from_slice(chunk);
                r.consume(n);
            }
        }
    }
}

fn has_control(s: &str) -> bool {
    s.chars().any(char::is_control)
}

fn opt_string(obj: &serde_json::Map<String, Value>, key: &str, max: usize) -> Result<Option<String>, ProtocolError> {
    match obj.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                // Blank strings are absent (the same rule the server applies to tool arguments).
                return Ok(None);
            }
            if t.chars().count() > max || has_control(t) {
                return Err(ProtocolError::Invalid("a text field is too long or has control characters"));
            }
            Ok(Some(t.to_string()))
        }
        Some(_) => Err(ProtocolError::Invalid("a text field is not a string")),
    }
}

fn req_string(obj: &serde_json::Map<String, Value>, key: &'static str, max: usize) -> Result<String, ProtocolError> {
    opt_string(obj, key, max)?.ok_or(ProtocolError::Invalid(match key {
        "code" => "code is required",
        "url" => "url is required",
        _ => "a required field is missing",
    }))
}

/// Parses and validates one request line.
pub fn parse_request(line: &[u8]) -> Result<Request, ProtocolError> {
    if line.len() > MAX_REQUEST_BYTES {
        return Err(ProtocolError::TooLarge);
    }
    let value: Value = serde_json::from_slice(line).map_err(|_| ProtocolError::InvalidJson)?;
    let Value::Object(obj) = value else {
        return Err(ProtocolError::InvalidJson);
    };
    let op = match obj.get("op") {
        Some(Value::String(s)) => s.as_str(),
        _ => return Err(ProtocolError::Invalid("op is required")),
    };
    let server_url = || opt_string(&obj, "serverUrl", MAX_SERVER_URL_LEN);
    match op {
        "status" => Ok(Request::Status),
        "subscribe" => Ok(Request::Subscribe),
        "unenroll" => Ok(Request::Unenroll),
        "self_enroll_poll" => Ok(Request::SelfEnrollPoll),
        "enroll_preview" => Ok(Request::EnrollPreview {
            code: req_string(&obj, "code", MAX_CODE_LEN)?,
            server_url: server_url()?,
        }),
        "enroll" => Ok(Request::Enroll {
            code: req_string(&obj, "code", MAX_CODE_LEN)?,
            name: opt_string(&obj, "name", MAX_NAME_LEN)?,
            server_url: server_url()?,
        }),
        "self_enroll_start" => Ok(Request::SelfEnrollStart {
            name: opt_string(&obj, "name", MAX_NAME_LEN)?,
            server_url: server_url()?,
        }),
        "check_url" => {
            let url = req_string(&obj, "url", MAX_URL_LEN)?;
            let lower = url.to_ascii_lowercase();
            if !(lower.starts_with("http://") || lower.starts_with("https://")) || url.contains(char::is_whitespace) {
                return Err(ProtocolError::Invalid("url must be an http(s) address"));
            }
            Ok(Request::CheckUrl { url })
        }
        other => Err(ProtocolError::UnknownOp(other.chars().take(32).collect())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn parse(s: &str) -> Result<Request, ProtocolError> {
        parse_request(s.as_bytes())
    }

    #[test]
    fn simple_ops() {
        assert_eq!(parse(r#"{"op":"status"}"#), Ok(Request::Status));
        assert_eq!(parse(r#"{"op":"subscribe"}"#), Ok(Request::Subscribe));
        assert_eq!(parse(r#"{"op":"unenroll"}"#), Ok(Request::Unenroll));
        assert_eq!(parse(r#"{"op":"self_enroll_poll"}"#), Ok(Request::SelfEnrollPoll));
    }

    #[test]
    fn enroll_fields_are_trimmed_and_blank_is_absent() {
        assert_eq!(
            parse(r#"{"op":"enroll","code":" ABC-123 ","name":"  "}"#),
            Ok(Request::Enroll {
                code: "ABC-123".into(),
                name: None,
                server_url: None
            })
        );
        assert_eq!(
            parse(r#"{"op":"enroll_preview","code":"x","serverUrl":"https://neo.example"}"#),
            Ok(Request::EnrollPreview {
                code: "x".into(),
                server_url: Some("https://neo.example".into())
            })
        );
    }

    #[test]
    fn rejects_bad_input() {
        assert_eq!(parse("not json"), Err(ProtocolError::InvalidJson));
        assert_eq!(parse("[1]"), Err(ProtocolError::InvalidJson));
        assert_eq!(parse(r#"{"op":1}"#), Err(ProtocolError::Invalid("op is required")));
        assert!(matches!(parse(r#"{"op":"format_disk"}"#), Err(ProtocolError::UnknownOp(_))));
        assert!(matches!(parse(r#"{"op":"enroll"}"#), Err(ProtocolError::Invalid(_))));
        assert!(matches!(parse(r#"{"op":"enroll","code":5}"#), Err(ProtocolError::Invalid(_))));
        let long = "a".repeat(MAX_CODE_LEN + 1);
        assert!(matches!(
            parse(&format!(r#"{{"op":"enroll","code":"{long}"}}"#)),
            Err(ProtocolError::Invalid(_))
        ));
        assert!(matches!(
            parse("{\"op\":\"enroll\",\"code\":\"a\\u0007b\"}"),
            Err(ProtocolError::Invalid(_))
        ));
        assert!(matches!(
            parse(r#"{"op":"check_url","url":"file:///c:/x"}"#),
            Err(ProtocolError::Invalid(_))
        ));
        assert!(matches!(
            parse(r#"{"op":"check_url","url":"http://a b"}"#),
            Err(ProtocolError::Invalid(_))
        ));
        assert_eq!(
            parse(r#"{"op":"check_url","url":"https://example.com/x"}"#),
            Ok(Request::CheckUrl {
                url: "https://example.com/x".into()
            })
        );
    }

    #[test]
    fn oversize_is_refused() {
        let big = vec![b'a'; MAX_REQUEST_BYTES + 1];
        assert_eq!(parse_request(&big), Err(ProtocolError::TooLarge));
        let mut r = Cursor::new([big.clone(), b"\n".to_vec()].concat());
        assert_eq!(read_line(&mut r).unwrap(), Line::TooLarge);
        // No newline at all, still bounded.
        let mut r = Cursor::new(vec![b'a'; MAX_REQUEST_BYTES * 3]);
        assert_eq!(read_line(&mut r).unwrap(), Line::TooLarge);
    }

    #[test]
    fn reads_lines_up_to_the_limit() {
        let exact = vec![b'a'; MAX_REQUEST_BYTES];
        let mut r = Cursor::new([exact.clone(), b"\nnext\n".to_vec()].concat());
        assert_eq!(read_line(&mut r).unwrap(), Line::Data(exact));
        assert_eq!(read_line(&mut r).unwrap(), Line::Data(b"next".to_vec()));
        assert_eq!(read_line(&mut r).unwrap(), Line::Eof);
        let mut r = Cursor::new(b"partial".to_vec());
        assert_eq!(read_line(&mut r).unwrap(), Line::Data(b"partial".to_vec()));
    }

    #[test]
    fn error_response_shape() {
        let v = ProtocolError::TooLarge.response();
        assert_eq!(v["ok"], false);
        assert_eq!(v["code"], "request_too_large");
    }
}
