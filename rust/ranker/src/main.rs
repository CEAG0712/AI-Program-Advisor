use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::{self, Cursor, Read, Write};
use std::process::ExitCode;

const PROTOCOL_VERSION: u32 = 1;
const MAX_OFFERS: usize = 1_000;
const MAX_RESULTS: usize = 10;
const MAX_ID_CHARS: usize = 80;
const MAX_STUDY_HOURS: u32 = 168;
const MAX_INPUT_BYTES: usize = 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 10 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    protocol_version: u32,
    offers: Vec<Offer>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Offer {
    offer_id: String,
    weekly_study_hours: u32,
    price_cents: i32,
}

#[derive(Serialize)]
struct Response {
    protocol_version: u32,
    ordered_offer_ids: Vec<String>,
}

enum Failure {
    Input,
    InvalidRequest,
    UnsupportedVersion,
    Output,
}

impl Failure {
    fn message(&self) -> &'static str {
        match self {
            Self::Input => "Unable to read ranking input.",
            Self::InvalidRequest => "Invalid ranking request.",
            Self::UnsupportedVersion => "Unsupported ranking protocol version.",
            Self::Output => "Unable to write ranking output.",
        }
    }
}

fn read_request(input: impl Read) -> Result<Request, Failure> {
    let mut bytes = Vec::new();
    input
        .take((MAX_INPUT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| Failure::Input)?;
    if bytes.len() > MAX_INPUT_BYTES {
        return Err(Failure::InvalidRequest);
    }
    let request: Request = serde_json::from_slice(&bytes).map_err(|_| Failure::InvalidRequest)?;
    if request.protocol_version != PROTOCOL_VERSION {
        return Err(Failure::UnsupportedVersion);
    }
    if request.offers.len() > MAX_OFFERS {
        return Err(Failure::InvalidRequest);
    }
    let mut ids = HashSet::with_capacity(request.offers.len());
    for offer in &request.offers {
        if !(1..=MAX_ID_CHARS).contains(&offer.offer_id.chars().count())
            || !(1..=MAX_STUDY_HOURS).contains(&offer.weekly_study_hours)
            || offer.price_cents < 0
            || !ids.insert(offer.offer_id.as_str())
        {
            return Err(Failure::InvalidRequest);
        }
    }
    Ok(request)
}

fn rank(mut offers: Vec<Offer>) -> Response {
    offers.sort_unstable_by(|left, right| {
        right
            .weekly_study_hours
            .cmp(&left.weekly_study_hours)
            .then_with(|| left.price_cents.cmp(&right.price_cents))
            .then_with(|| {
                left.offer_id
                    .encode_utf16()
                    .cmp(right.offer_id.encode_utf16())
            })
    });
    Response {
        protocol_version: PROTOCOL_VERSION,
        ordered_offer_ids: offers
            .into_iter()
            .take(MAX_RESULTS)
            .map(|offer| offer.offer_id)
            .collect(),
    }
}

fn write_response(response: &Response, mut output: impl Write) -> Result<(), Failure> {
    // Complete serialization and the newline inside a fixed buffer before touching stdout.
    let mut bytes = [0; MAX_OUTPUT_BYTES];
    let mut buffer = Cursor::new(bytes.as_mut_slice());
    serde_json::to_writer(&mut buffer, response).map_err(|_| Failure::Output)?;
    buffer.write_all(b"\n").map_err(|_| Failure::Output)?;
    let length = buffer.position() as usize;
    output
        .write_all(&bytes[..length])
        .and_then(|()| output.flush())
        .map_err(|_| Failure::Output)
}

fn main() -> ExitCode {
    let result = read_request(io::stdin().lock())
        .and_then(|request| write_response(&rank(request.offers), io::stdout().lock()));
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(failure) => {
            let _ = writeln!(io::stderr().lock(), "{}", failure.message());
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oversized_serialization_writes_no_stdout() {
        let response = Response {
            protocol_version: PROTOCOL_VERSION,
            ordered_offer_ids: vec!["a".repeat(MAX_OUTPUT_BYTES)],
        };
        let mut stdout = Vec::new();
        assert!(matches!(
            write_response(&response, &mut stdout),
            Err(Failure::Output)
        ));
        assert!(stdout.is_empty());
    }
}
