//! Input: {"before": str, "after": str, "path": str}
//! Output: {"language": str, "before": [[op, sr, sc, er, ec, dr, dc, der, dec], ...], "after": [...]}
//! Columns are byte offsets within the row, as omnidiff reports them.
use omnidiff::code::language::{language_for_path_and_content, stable_name};
use omnidiff::code::{Code, Language};
use omnidiff::diff::NodeCache;
use omnidiff::diff::text::{RangeMatch, RenderOptions, TextDiff, ranges_for_options};

#[derive(serde::Deserialize)]
struct Input {
    before: String,
    after: String,
    path: String,
}

fn flat(r: &RangeMatch) -> (String, [usize; 8]) {
    let (s, d) = (&r.source, &r.destination);
    (format!("{:?}", r.operation), [s.start_row, s.start_column, s.end_row, s.end_column,
        d.start_row, d.start_column, d.end_row, d.end_column])
}

/// The diff of `input` (the JSON above) as JSON.
pub fn diff_json(input: &str) -> String {
    let input: Input = serde_json::from_str(input).expect("input json");
    let path = std::path::Path::new(&input.path);
    let language = language_for_path_and_content(path, &input.after).unwrap_or(Language::Unknown);
    let before = Code::from_string(&input.before, &language);
    let after = Code::from_string(&input.after, &language);
    let diff = omnidiff::diff::diff_code(&before, &after);
    // Plain text (no grammar) has no AST diff; GitHub's own line diff then stays as it is.
    let text = diff.ast.as_ref().map(|ast| {
        let cache = NodeCache::build(&before, &after);
        TextDiff::from(&before, &after, ast, &cache)
    });
    let side = |i: usize, source: &str| -> Vec<(String, [usize; 8])> {
        text.as_ref().map_or(vec![], |t| {
            ranges_for_options(&t.all(i), source, RenderOptions::FULL).iter().map(flat).collect()
        })
    };
    serde_json::json!({
        "language": stable_name(language),
        "before": side(0, &input.before),
        "after": side(1, &input.after),
    })
    .to_string()
}

// C ABI for the browser: `omnidiff_alloc` a buffer, write the input JSON into it, call
// `omnidiff_diff`; the result is `u32 length (little endian)` then that many bytes of JSON, to be
// released with `omnidiff_free(ptr, 4 + length)`. The input buffer is consumed by `omnidiff_diff`.

#[unsafe(no_mangle)]
pub extern "C" fn omnidiff_alloc(len: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len);
    let ptr = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    ptr
}

/// # Safety
/// `ptr` must come from `omnidiff_alloc(len)` or be a result of `omnidiff_diff` with `len` = 4 + length.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn omnidiff_free(ptr: *mut u8, len: usize) {
    drop(unsafe { Vec::from_raw_parts(ptr, 0, len) });
}

/// # Safety
/// `ptr` must come from `omnidiff_alloc(len)` and hold `len` bytes of UTF-8 JSON.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn omnidiff_diff(ptr: *mut u8, len: usize) -> *mut u8 {
    let input = unsafe { Vec::from_raw_parts(ptr, len, len) };
    let output = diff_json(std::str::from_utf8(&input).expect("utf-8 input"));
    let mut result = Vec::with_capacity(4 + output.len());
    result.extend_from_slice(&(output.len() as u32).to_le_bytes());
    result.extend_from_slice(output.as_bytes());
    result.shrink_to_fit();
    let out = result.as_mut_ptr();
    std::mem::forget(result);
    out
}
