//! stdin: the input JSON of `omnidiff_wasm::diff_json`; stdout: its output.
use std::io::Read;

fn main() {
    let mut raw = String::new();
    std::io::stdin().read_to_string(&mut raw).expect("stdin");
    println!("{}", omnidiff_wasm::diff_json(&raw));
}
