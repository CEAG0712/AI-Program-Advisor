use serde_json::{Value, json};
use std::io::Write;
use std::process::{Command, Output, Stdio};

const INPUT_BYTE_LIMIT: usize = 1024 * 1024;
const OUTPUT_BYTE_LIMIT: usize = 10 * 1024;
const INVALID: &str = "Invalid ranking request.\n";

fn run(input: &[u8]) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_p3-ranker"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    child.wait_with_output().unwrap()
}

fn request(offers: &[Value]) -> Value {
    json!({"protocol_version": 1, "offers": offers})
}

fn offer(id: &str, hours: u32, cents: u32) -> Value {
    json!({"offer_id": id, "weekly_study_hours": hours, "price_cents": cents})
}

fn success(output: &Output, ids: &[&str]) {
    assert_eq!(output.status.code(), Some(0));
    assert!(output.stderr.is_empty());
    assert!(output.stdout.len() <= OUTPUT_BYTE_LIMIT);
    assert!(output.stdout.ends_with(b"\n"));
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        json!({"protocol_version": 1, "ordered_offer_ids": ids})
    );
}

fn rank(offers: &[Value], ids: &[&str]) {
    success(&run(&serde_json::to_vec(&request(offers)).unwrap()), ids);
}

fn rejected(input: &[u8], diagnostic: &str) {
    let output = run(input);
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert_eq!(output.stderr, diagnostic.as_bytes());
}

#[test]
fn weekly_hours_descending_even_when_price_is_higher() {
    rank(&[offer("a", 1, 0), offer("b", 168, 500)], &["b", "a"]);
}

#[test]
fn price_ascending_at_equal_hours() {
    rank(
        &[offer("a", 6, i32::MAX as u32), offer("b", 6, 0)],
        &["b", "a"],
    );
}

#[test]
fn id_ascending_at_equal_hours_and_price() {
    rank(
        &[offer("ab", 6, 100), offer("b", 6, 100), offer("a", 6, 100)],
        &["a", "ab", "b"],
    );
}

#[test]
fn unicode_ids_follow_utf16_order_without_normalization() {
    let ids = ["\u{e000}", "\u{10000}", "\u{e9}", "e\u{301}", "z"];
    let offers = ids.map(|id| offer(id, 6, 0));
    // U+10000 starts with code unit D800, which sorts before E000 in JavaScript.
    rank(
        &offers,
        &["e\u{301}", "z", "\u{e9}", "\u{10000}", "\u{e000}"],
    );
}

#[test]
fn input_permutations_yield_the_same_ranking() {
    let offers = [
        offer("z", 4, 1),
        offer("c", 6, 23_000),
        offer("b", 6, 22_000),
        offer("a", 6, 22_000),
    ];
    for order in [[0, 1, 2, 3], [3, 2, 1, 0], [2, 0, 3, 1]] {
        rank(
            &order.map(|index| offers[index].clone()),
            &["a", "b", "c", "z"],
        );
    }
}

#[test]
fn repeated_processes_produce_identical_bytes() {
    let input = serde_json::to_vec(&request(&[offer("b", 6, 0), offer("a", 6, 0)])).unwrap();
    let first = run(&input);
    success(&first, &["a", "b"]);
    for _ in 0..4 {
        let output = run(&input);
        success(&output, &["a", "b"]);
        assert_eq!(output.stdout, first.stdout);
    }
}

#[test]
fn empty_offers_return_an_empty_ranking() {
    rank(&[], &[]);
}

fn many_offers(count: usize) -> Vec<Value> {
    (0..count)
        .rev()
        .map(|index| offer(&format!("id-{index:04}"), 1, 0))
        .collect()
}

const FIRST_TEN: [&str; 10] = [
    "id-0000", "id-0001", "id-0002", "id-0003", "id-0004", "id-0005", "id-0006", "id-0007",
    "id-0008", "id-0009",
];

#[test]
fn returns_only_the_ten_highest_ranked_ids() {
    rank(&many_offers(11), &FIRST_TEN);
}

#[test]
fn accepts_one_thousand_offers() {
    rank(&many_offers(1_000), &FIRST_TEN);
}

#[test]
fn rejects_one_thousand_and_one_offers() {
    let input = serde_json::to_vec(&request(&many_offers(1_001))).unwrap();
    rejected(&input, INVALID);
}

#[test]
fn rejects_unsupported_versions() {
    rejected(
        br#"{"protocol_version":2,"offers":[]}"#,
        "Unsupported ranking protocol version.\n",
    );
}

#[test]
fn malformed_json_returns_only_a_sanitized_diagnostic() {
    for input in [
        &b""[..],
        br#"{"protocol_version":1,"offers":["private-tenant-sentinel""#,
        br#"{"protocol_version":1,"offers":[]} {}"#,
        &[0xff],
    ] {
        rejected(input, INVALID);
    }
}

#[test]
fn rejects_unexpected_fields_and_duplicate_keys() {
    for input in [
        r#"{"protocol_version":1,"offers":[],"tenant_id":"private-tenant-sentinel"}"#,
        r#"{"protocol_version":1,"offers":[{"offer_id":"a","weekly_study_hours":1,"price_cents":0,"checkout_authorized":true}]}"#,
        r#"{"protocol_version":1,"protocol_version":1,"offers":[]}"#,
    ] {
        rejected(input.as_bytes(), INVALID);
    }
}

#[test]
fn rejects_missing_fields() {
    for input in [
        r#"{"offers":[]}"#,
        r#"{"protocol_version":1}"#,
        r#"{"protocol_version":1,"offers":[{"weekly_study_hours":1,"price_cents":0}]}"#,
        r#"{"protocol_version":1,"offers":[{"offer_id":"a","price_cents":0}]}"#,
        r#"{"protocol_version":1,"offers":[{"offer_id":"a","weekly_study_hours":1}]}"#,
    ] {
        rejected(input.as_bytes(), INVALID);
    }
}

#[test]
fn rejects_duplicate_ids_even_with_different_rank_fields() {
    let input = serde_json::to_vec(&request(&[
        offer("private-id", 1, 1),
        offer("private-id", 2, 2),
    ]))
    .unwrap();
    rejected(&input, INVALID);
}

#[test]
fn rejects_invalid_numeric_values() {
    for (field, values) in [
        (
            "weekly_study_hours",
            vec![
                json!(-1),
                json!(0),
                json!(169),
                json!(1.5),
                json!("1"),
                json!(true),
            ],
        ),
        (
            "price_cents",
            vec![json!(-1), json!(2_147_483_648_u64), json!(1.5), json!(null)],
        ),
    ] {
        for value in values {
            let mut invalid = offer("a", 1, 0);
            invalid[field] = value;
            rejected(&serde_json::to_vec(&request(&[invalid])).unwrap(), INVALID);
        }
    }
    rejected(br#"{"protocol_version":"1","offers":[]}"#, INVALID);
}

#[test]
fn validates_id_length_in_unicode_characters() {
    let longest = "\u{10000}".repeat(80);
    rank(&[offer(&longest, 1, 0)], &[&longest]);
    for id in [String::new(), "\u{10000}".repeat(81)] {
        rejected(
            &serde_json::to_vec(&request(&[offer(&id, 1, 0)])).unwrap(),
            INVALID,
        );
    }
}

#[test]
fn enforces_the_input_byte_limit_including_whitespace() {
    let mut input = serde_json::to_vec(&request(&[])).unwrap();
    input.resize(INPUT_BYTE_LIMIT, b' ');
    success(&run(&input), &[]);
    input.push(b' ');
    rejected(&input, INVALID);
}

#[test]
fn ten_maximum_length_escaped_ids_fit_the_output_buffer() {
    let ids: Vec<_> = (0..10)
        .map(|index| format!("{}{}", "\u{1f}".repeat(79), index))
        .collect();
    let offers: Vec<_> = ids.iter().rev().map(|id| offer(id, 1, 0)).collect();
    rank(&offers, &ids.iter().map(String::as_str).collect::<Vec<_>>());
}
