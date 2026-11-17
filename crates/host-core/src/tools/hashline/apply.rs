//! Apply parsed ops against a tagged snapshot (spec 18 §8–§10).

use super::drift;
use super::parse::{
    parse_ops, Locator, ParseError, ParsedOp, ParsedOps, MAX_REGISTER_BYTES, MAX_REGISTER_LINES,
};
use super::store::HashlineStore;
use super::tag::{
    encode_bytes, join_lines, normalize_file, split_lines, tag_of_lf_text, NormalizedFile,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

pub const MAX_IR_LINES: usize = 100_000;
const UNSEEN_REVEAL_LINES: usize = 40;
const UNSEEN_REVEAL_CHARS: usize = 512;

#[derive(Debug)]
pub struct ToolError {
    pub code: String,
    pub message: String,
    pub extra: Value,
}

impl ToolError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            extra: json!({}),
        }
    }

    pub fn with_extra(mut self, extra: Value) -> Self {
        self.extra = extra;
        self
    }
}

impl From<(String, String)> for ToolError {
    fn from((code, message): (String, String)) -> Self {
        Self::new(code, message)
    }
}

impl From<ParseError> for ToolError {
    fn from(err: ParseError) -> Self {
        Self::new(err.code, err.message)
    }
}

#[derive(Debug, Clone)]
pub struct EditSuccess {
    pub tag: String,
    pub warnings: Vec<String>,
    pub ops_echo: Vec<String>,
    pub delete_file: bool,
    pub moved_to: Option<String>,
}

struct Plan {
    /// 0-based insert-before index in the original line list (`len` = append).
    inserts: BTreeMap<usize, Vec<String>>,
    /// 1-based original lines to delete.
    deletes: BTreeSet<u32>,
    /// Anchors used for provenance (1-based line numbers, plus 0 for head and
    /// u32::MAX for EOF).
    anchors: BTreeSet<u32>,
    rem: bool,
    mv: Option<String>,
}

const HEAD_ANCHOR: u32 = 0;
const EOF_ANCHOR: u32 = u32::MAX;

fn is_block(locator: &Locator) -> bool {
    matches!(locator, Locator::Block { .. } | Locator::AfterBlock { .. })
}

fn lower(ops: &ParsedOps, line_count: usize) -> Result<Plan, ToolError> {
    let mut plan = Plan {
        inserts: BTreeMap::new(),
        deletes: BTreeSet::new(),
        anchors: BTreeSet::new(),
        rem: false,
        mv: None,
    };
    let mut ir_lines = 0usize;
    let mut occupied_inserts: BTreeSet<usize> = BTreeSet::new();
    let mut occupied_deletes: BTreeSet<u32> = BTreeSet::new();

    for op in &ops.ops {
        match op {
            ParsedOp::Rem => {
                if plan.rem {
                    return Err(ToolError::new(
                        "EDIT_RANGE_INVALID",
                        "duplicate REM in one call",
                    ));
                }
                plan.rem = true;
            }
            ParsedOp::Mv { dest } => {
                if plan.mv.is_some() {
                    return Err(ToolError::new(
                        "EDIT_RANGE_INVALID",
                        "duplicate MV in one call",
                    ));
                }
                plan.mv = Some(dest.clone());
            }
            ParsedOp::Put {
                locator,
                body,
                register,
            } => {
                if is_block(locator) {
                    return Err(block_unresolved(locator));
                }
                if register.is_some() && !body.is_empty() {
                    return Err(ToolError::new(
                        "EDIT_PARSE_FAILED",
                        "a register paste takes no body rows",
                    ));
                }
                let text = body.clone();
                ir_lines = bump_ir(ir_lines, text.len())?;
                match locator {
                    Locator::Range { start, end } => {
                        claim_range(&mut occupied_deletes, *start, *end, line_count)?;
                        for line in *start..=*end {
                            plan.deletes.insert(line);
                            plan.anchors.insert(line);
                        }
                        let at = (*start as usize).saturating_sub(1);
                        claim_insert(&mut occupied_inserts, at)?;
                        plan.inserts.entry(at).or_default().extend(text);
                    }
                    Locator::Before { line } => {
                        validate_line(*line, line_count)?;
                        plan.anchors
                            .insert(if *line == 1 { HEAD_ANCHOR } else { *line });
                        let at = (*line as usize).saturating_sub(1);
                        claim_insert(&mut occupied_inserts, at)?;
                        plan.inserts.entry(at).or_default().extend(text);
                    }
                    Locator::After { line } => {
                        validate_line(*line, line_count)?;
                        plan.anchors.insert(*line);
                        let at = *line as usize;
                        claim_insert(&mut occupied_inserts, at)?;
                        plan.inserts.entry(at).or_default().extend(text);
                    }
                    Locator::End => {
                        plan.anchors.insert(EOF_ANCHOR);
                        claim_insert(&mut occupied_inserts, line_count)?;
                        plan.inserts.entry(line_count).or_default().extend(text);
                    }
                    Locator::Block { .. } | Locator::AfterBlock { .. } => unreachable!(),
                }
            }
            ParsedOp::Cut { locator, .. } => {
                if is_block(locator) {
                    return Err(block_unresolved(locator));
                }
                match locator {
                    Locator::Range { start, end } => {
                        claim_range(&mut occupied_deletes, *start, *end, line_count)?;
                        ir_lines = bump_ir(ir_lines, (*end - *start + 1) as usize)?;
                        for line in *start..=*end {
                            plan.deletes.insert(line);
                            plan.anchors.insert(line);
                        }
                    }
                    _ => {
                        return Err(ToolError::new(
                            "EDIT_PARSE_FAILED",
                            "CUT requires a range (N.=M) or a block (N*)",
                        ));
                    }
                }
            }
        }
    }
    if plan.rem && plan.mv.is_some() {
        return Err(ToolError::new(
            "EDIT_RANGE_INVALID",
            "REM and MV cannot share one Edit call",
        ));
    }
    if plan.rem && (!plan.inserts.is_empty() || !plan.deletes.is_empty()) {
        return Err(ToolError::new(
            "EDIT_RANGE_INVALID",
            "REM cannot combine with PUT or CUT",
        ));
    }
    Ok(plan)
}

fn bump_ir(current: usize, add: usize) -> Result<usize, ToolError> {
    let next = current.saturating_add(add);
    if next > MAX_IR_LINES {
        return Err(ToolError::new(
            "EDIT_AMPLIFICATION_LIMIT",
            format!("lowering exceeded {MAX_IR_LINES} IR lines"),
        ));
    }
    Ok(next)
}

fn block_unresolved(locator: &Locator) -> ToolError {
    let line = match locator {
        Locator::Block { line } | Locator::AfterBlock { line } => *line,
        _ => 0,
    };
    ToolError::new(
        "EDIT_BLOCK_UNRESOLVED",
        format!(
            "block locator on line {line} is not resolved in this release; use PUT {line}.={line}: or a concrete range instead"
        ),
    )
}

fn validate_line(line: u32, line_count: usize) -> Result<(), ToolError> {
    if line_count == 0 {
        if line == 1 {
            return Ok(());
        }
        return Err(ToolError::new(
            "EDIT_RANGE_INVALID",
            format!("line {line} is out of bounds in an empty file"),
        ));
    }
    if line == 0 || line as usize > line_count {
        return Err(ToolError::new(
            "EDIT_RANGE_INVALID",
            format!("line {line} is out of bounds (file has {line_count} lines)"),
        ));
    }
    Ok(())
}

fn claim_range(
    occupied: &mut BTreeSet<u32>,
    start: u32,
    end: u32,
    line_count: usize,
) -> Result<(), ToolError> {
    validate_line(start, line_count)?;
    validate_line(end, line_count)?;
    for line in start..=end {
        if !occupied.insert(line) {
            return Err(ToolError::new(
                "EDIT_RANGE_INVALID",
                format!("overlapping or duplicate anchor on line {line}"),
            ));
        }
    }
    Ok(())
}

fn claim_insert(occupied: &mut BTreeSet<usize>, at: usize) -> Result<(), ToolError> {
    if !occupied.insert(at) {
        return Err(ToolError::new(
            "EDIT_RANGE_INVALID",
            format!("two ops target the same insert gap (index {at})"),
        ));
    }
    Ok(())
}

fn apply_plan(lines: &[String], plan: &Plan) -> Vec<String> {
    let n = lines.len();
    let mut out = Vec::with_capacity(n + plan.inserts.values().map(Vec::len).sum::<usize>());
    for (i, line) in lines.iter().enumerate() {
        if let Some(inserted) = plan.inserts.get(&i) {
            out.extend(inserted.iter().cloned());
        }
        let line_no = (i as u32) + 1;
        if !plan.deletes.contains(&line_no) {
            out.push(line.clone());
        }
    }
    if let Some(inserted) = plan.inserts.get(&n) {
        out.extend(inserted.iter().cloned());
    }
    out
}

fn expand_registers(
    ops: &mut ParsedOps,
    lines: &[String],
    session_id: Option<&str>,
    store: Option<&HashlineStore>,
) -> Result<(), ToolError> {
    let mut anonymous: Vec<Vec<String>> = Vec::new();
    let mut anonymous_pending = 0usize;
    for op in &mut ops.ops {
        match op {
            ParsedOp::Cut {
                locator: Locator::Range { start, end },
                register,
            } => {
                if *start as usize > lines.len() || *end as usize > lines.len() {
                    continue;
                }
                let captured: Vec<String> =
                    lines[(*start as usize - 1)..=(*end as usize - 1)].to_vec();
                validate_capture(&captured)?;
                if let Some(name) = register {
                    if let (Some(session), Some(store)) = (session_id, store) {
                        store.put_register(session, name, captured);
                    } else {
                        return Err(ToolError::new(
                            "EDIT_REGISTER_EMPTY",
                            format!("named register @{name} needs a session snapshot store"),
                        ));
                    }
                } else {
                    anonymous.push(captured);
                    anonymous_pending += 1;
                }
            }
            ParsedOp::Put { register, body, .. } => {
                if let Some(name) = register {
                    let pasted = if let (Some(session), Some(store)) = (session_id, store) {
                        store
                            .get_register(session, name)
                            .ok_or_else(|| {
                                ToolError::new(
                                    "EDIT_REGISTER_EMPTY",
                                    format!("register @{name} is empty; CUT into it first"),
                                )
                            })?
                            .lines
                    } else {
                        return Err(ToolError::new(
                            "EDIT_REGISTER_EMPTY",
                            format!("register @{name} is empty; CUT into it first"),
                        ));
                    };
                    *body = pasted;
                    *register = None;
                }
            }
            _ => {}
        }
    }

    // Anonymous paste: a PUT with empty body and no register that still
    // arrived as a colonless PUT is already rejected by the parser. Phase 2
    // only pastes named registers; unused anonymous captures stay as deletes.
    let _ = anonymous_pending;
    let _ = anonymous;
    Ok(())
}

fn validate_capture(lines: &[String]) -> Result<(), ToolError> {
    if lines.len() > MAX_REGISTER_LINES {
        return Err(ToolError::new(
            "INVALID_ARGUMENT",
            format!("CUT capture exceeds {MAX_REGISTER_LINES} lines"),
        ));
    }
    let bytes: usize = lines.iter().map(|l| l.len() + 1).sum();
    if bytes > MAX_REGISTER_BYTES {
        return Err(ToolError::new(
            "INVALID_ARGUMENT",
            format!("CUT capture exceeds {MAX_REGISTER_BYTES} bytes"),
        ));
    }
    Ok(())
}

fn position_stable(ops: &ParsedOps) -> bool {
    ops.ops.iter().all(|op| match op {
        ParsedOp::Put { locator, .. } => {
            matches!(locator, Locator::Before { line: 1 } | Locator::End)
        }
        ParsedOp::Cut { .. } => false,
        ParsedOp::Rem | ParsedOp::Mv { .. } => true,
    })
}

fn provenance_anchors(plan: &Plan) -> Vec<u32> {
    plan.anchors
        .iter()
        .copied()
        .filter(|a| *a != HEAD_ANCHOR && *a != EOF_ANCHOR)
        .collect()
}

struct Recovery {
    plan: Plan,
    warnings: Vec<String>,
}

/// Everything branch C needs to know about the call it is relocating.
struct DriftContext<'a> {
    expected: &'a str,
    live_tag: &'a str,
    display_path: &'a str,
    canonical_path: &'a str,
    session_id: Option<&'a str>,
    store: Option<&'a HashlineStore>,
}

/// Branch C: relocate ops authored against the tagged version onto live
/// content, or decline so the caller rejects with `EDIT_TAG_MISMATCH`.
///
/// The snapshot is the only text the authored line numbers can mean, so
/// registers are captured from it and the ops are lowered against it first.
/// `drift` then has to prove one offset for every anchor line before the
/// locators move; a replay that fails to lower against live content, or that
/// changes nothing, declines (spec 18 §10).
fn recover_drift(
    parsed: &ParsedOps,
    live_lines: &[String],
    context: DriftContext<'_>,
) -> Result<Option<Recovery>, ToolError> {
    let DriftContext {
        expected,
        live_tag,
        display_path,
        canonical_path,
        session_id,
        store,
    } = context;
    let Some((session, store)) = session_id.zip(store) else {
        return Ok(None);
    };
    let Some(snapshot) = store.lookup_tag(session, canonical_path, expected) else {
        return Err(ToolError::new(
            "EDIT_TAG_UNKNOWN",
            format!(
                "tag {expected} is well-formed but this session never recorded it for {display_path}; Read the file and retry with the live tag {live_tag}"
            ),
        )
        .with_extra(json!({ "liveTag": live_tag, "expectedTag": expected })));
    };
    // Without the tagged text there is nothing to align against.
    if !snapshot.retained {
        return Ok(None);
    }
    let snapshot_lines = split_lines(&snapshot.text);
    let mut authored = parsed.clone();
    expand_registers(&mut authored, &snapshot_lines, Some(session), Some(store))?;
    let snapshot_plan = match lower(&authored, snapshot_lines.len()) {
        Ok(plan) => plan,
        // The ops do not even fit the version they name, so there is nothing to
        // relocate and a range error would describe a file the call never saw.
        Err(err) if err.code == "EDIT_RANGE_INVALID" => return Ok(None),
        Err(err) => return Err(err),
    };
    let Some(delta) = drift::drift_delta(
        &snapshot_lines,
        live_lines,
        &provenance_anchors(&snapshot_plan),
    ) else {
        return Ok(None);
    };
    let Some(shifted) = drift::shift_ops(&authored, delta) else {
        return Ok(None);
    };
    let Ok(plan) = lower(&shifted, live_lines.len()) else {
        return Ok(None);
    };
    let cause = if store.is_newest_tag(session, canonical_path, expected) {
        "external change: the tagged version is still the newest one this session saw"
    } else {
        "session chain: a later write in this session superseded the tagged version"
    };
    let mut warnings = vec![format!(
        "drift recovery ({cause}); stale tag {expected} applied to live tag {live_tag}"
    )];
    if delta != 0 {
        warnings.push(format!(
            "line remap: anchors moved {delta:+} lines onto the live file"
        ));
    }
    Ok(Some(Recovery { plan, warnings }))
}

/// Line numbers the submitted ops name, without lowering them, so a rejection
/// stays informative even when no plan could be built.
fn submitted_anchors(ops: &ParsedOps) -> Vec<u32> {
    const MAX_LISTED_RANGE: u32 = 200;
    let mut anchors = BTreeSet::new();
    for op in &ops.ops {
        let locator = match op {
            ParsedOp::Put { locator, .. } | ParsedOp::Cut { locator, .. } => locator,
            ParsedOp::Rem | ParsedOp::Mv { .. } => continue,
        };
        match locator {
            Locator::Range { start, end } if end >= start => {
                if end - start <= MAX_LISTED_RANGE {
                    anchors.extend(*start..=*end);
                } else {
                    anchors.insert(*start);
                    anchors.insert(*end);
                }
            }
            Locator::Before { line } if *line != 1 => {
                anchors.insert(*line);
            }
            Locator::After { line } => {
                anchors.insert(*line);
            }
            _ => {}
        }
    }
    anchors.into_iter().collect()
}

/// The live file's current content at the submitted anchor lines, capped by the
/// same reveal budget the provenance gate uses (spec 18 §9.1, §11).
fn anchor_reveal(anchors: &[u32], live_lines: &[String]) -> Vec<Value> {
    anchors
        .iter()
        .take(UNSEEN_REVEAL_LINES)
        .map(|line| {
            let text = line
                .checked_sub(1)
                .and_then(|index| live_lines.get(index as usize));
            match text {
                Some(text) => {
                    let (shown, clipped) = clip_reveal(text);
                    json!({ "line": line, "text": shown, "clipped": clipped })
                }
                None => json!({ "line": line, "missing": true }),
            }
        })
        .collect()
}

fn check_provenance(
    live_lines: &[String],
    plan: &Plan,
    seen: Option<&BTreeSet<u32>>,
) -> Result<Option<BTreeSet<u32>>, ToolError> {
    let Some(seen) = seen else {
        return Ok(None);
    };
    let anchors = provenance_anchors(plan);
    let unseen: Vec<u32> = anchors.into_iter().filter(|l| !seen.contains(l)).collect();
    if unseen.is_empty() {
        return Ok(None);
    }
    let truncated_count = unseen.len() > UNSEEN_REVEAL_LINES;
    let reveal: Vec<u32> = unseen.iter().copied().take(UNSEEN_REVEAL_LINES).collect();
    let mut width_truncated = false;
    let mut rows = Vec::new();
    for line in &reveal {
        let idx = (*line as usize).saturating_sub(1);
        let text = live_lines.get(idx).map(String::as_str).unwrap_or("");
        let (shown, clipped) = clip_reveal(text);
        if clipped {
            width_truncated = true;
        }
        rows.push(json!({ "line": line, "text": shown, "clipped": clipped }));
    }
    let complete = !truncated_count && !width_truncated && reveal.len() == unseen.len();
    let mut extra = json!({
        "unseenLines": rows,
        "unseenCount": unseen.len(),
        "revealTruncated": !complete,
    });
    if complete {
        extra["merged"] = json!(true);
        return Err(ToolError::new(
            "EDIT_LINES_UNSEEN",
            format!(
                "anchors reference lines never displayed ({}). The current content is inlined; retry the same tag unchanged",
                unseen.iter().map(|n| n.to_string()).collect::<Vec<_>>().join(", ")
            ),
        )
        .with_extra(extra));
    }
    Err(ToolError::new(
        "EDIT_LINES_UNSEEN",
        format!(
            "anchors reference {} unseen line(s); the reveal is truncated — re-read the range and retry",
            unseen.len()
        ),
    )
    .with_extra(extra))
}

fn clip_reveal(text: &str) -> (String, bool) {
    match text.char_indices().nth(UNSEEN_REVEAL_CHARS) {
        Some((idx, _)) => (text[..idx].to_string(), true),
        None => (text.to_string(), false),
    }
}

fn echo_ops(ops: &ParsedOps) -> Vec<String> {
    ops.ops
        .iter()
        .map(|op| match op {
            ParsedOp::Put { locator, .. } => format!("PUT {}", locator_echo(locator)),
            ParsedOp::Cut { locator, .. } => format!("CUT {}", locator_echo(locator)),
            ParsedOp::Rem => "REM".into(),
            ParsedOp::Mv { dest } => format!("MV {dest}"),
        })
        .collect()
}

fn locator_echo(locator: &Locator) -> String {
    match locator {
        Locator::Range { start, end } => format!("{start}.={end}:"),
        Locator::Block { line } => format!("{line}*:"),
        Locator::Before { line } => format!("<{line}:"),
        Locator::After { line } => format!(">{line}:"),
        Locator::End => ">$:".into(),
        Locator::AfterBlock { line } => format!(">{line}*:"),
    }
}

pub fn apply_edit(
    display_path: &str,
    canonical_path: &str,
    tag: &str,
    ops_src: &str,
    live_bytes: &[u8],
    session_id: Option<&str>,
    store: Option<&HashlineStore>,
) -> Result<(NormalizedFile, EditSuccess), ToolError> {
    if tag.len() != 4 || !tag.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ToolError::new(
            "EDIT_TAG_REQUIRED",
            "tag must be 4 hexadecimal digits from the latest Read, Grep, Write, or Edit result",
        ));
    }
    let expected = tag.to_uppercase();
    let parsed = parse_ops(ops_src)?;
    if let (Some(header_path), Some(header_tag)) = (&parsed.header_path, &parsed.header_tag) {
        if header_path != display_path || header_tag != &expected {
            return Err(ToolError::new(
                "INVALID_ARGUMENT",
                format!(
                    "ops header [{header_path}#{header_tag}] disagrees with path={display_path} tag={expected}"
                ),
            ));
        }
    }

    let live = normalize_file(live_bytes);
    let live_tag = tag_of_lf_text(&live.text);
    let live_lines = split_lines(&live.text);
    let trailing_nl = live.text.ends_with('\n');

    // The echo names the ops as submitted, never their relocated line numbers.
    let ops_echo = echo_ops(&parsed);
    let mut warnings = Vec::new();
    // Spec 18 §9 branches: A applies directly, B tolerates a stale tag only for
    // head/tail inserts, C relocates the ops onto the live file, D rejects.
    let strayed = live_tag != expected && !position_stable(&parsed);
    let recovered = if strayed {
        recover_drift(
            &parsed,
            &live_lines,
            DriftContext {
                expected: &expected,
                live_tag: &live_tag,
                display_path,
                canonical_path,
                session_id,
                store,
            },
        )?
    } else {
        None
    };
    let plan = match recovered {
        Some(recovery) => {
            warnings.extend(recovery.warnings);
            recovery.plan
        }
        None if strayed => {
            let anchors = submitted_anchors(&parsed);
            let mut extra = json!({ "liveTag": live_tag, "expectedTag": expected });
            extra["anchorLines"] = json!(anchor_reveal(&anchors, &live_lines));
            extra["anchors"] = json!(anchors);
            return Err(ToolError::new(
                "EDIT_TAG_MISMATCH",
                format!(
                    "tag {expected} does not hash the live file (live tag {live_tag}); Read {display_path} and retry with the live tag"
                ),
            )
            .with_extra(extra));
        }
        None => {
            if live_tag != expected {
                warnings.push(format!(
                    "stale tag {expected} applied at file head/tail; live tag is {live_tag}"
                ));
            }
            let mut direct = parsed;
            expand_registers(&mut direct, &live_lines, session_id, store)?;
            lower(&direct, live_lines.len())?
        }
    };

    if live_tag == expected {
        if let Some((session, store)) = session_id.zip(store) {
            let snap = store.latest_matching_text(session, canonical_path, &live.text);
            match check_provenance(
                &live_lines,
                &plan,
                snap.as_ref().and_then(|s| s.seen_lines.as_ref()),
            ) {
                Ok(_) => {}
                Err(err) if err.code == "EDIT_LINES_UNSEEN" => {
                    let merged = err
                        .extra
                        .get("merged")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    if merged {
                        let extra_lines: BTreeSet<u32> = err
                            .extra
                            .get("unseenLines")
                            .and_then(|v| v.as_array())
                            .map(|rows| {
                                rows.iter()
                                    .filter_map(|row| row.get("line").and_then(|v| v.as_u64()))
                                    .map(|n| n as u32)
                                    .collect()
                            })
                            .unwrap_or_default();
                        store.merge_seen_lines(session, canonical_path, &live.text, &extra_lines);
                    }
                    return Err(err);
                }
                Err(err) => return Err(err),
            }
        }
    }

    if plan.rem {
        return Ok((
            live,
            EditSuccess {
                tag: expected,
                warnings,
                ops_echo: ops_echo.clone(),
                delete_file: true,
                moved_to: None,
            },
        ));
    }

    let next_lines = apply_plan(&live_lines, &plan);
    let next_text = if live_lines.is_empty() {
        join_lines(&next_lines, !next_lines.is_empty())
    } else {
        join_lines(&next_lines, trailing_nl)
    };
    if next_text == live.text && plan.mv.is_none() {
        return Err(ToolError::new(
            "EDIT_NO_CHANGE",
            "apply produced identical text; widen or shrink the range so it names changed lines only",
        ));
    }
    let next_tag = tag_of_lf_text(&next_text);
    let next_file = NormalizedFile {
        text: next_text.clone(),
        ending: live.ending,
        bom: live.bom,
        utf16: live.utf16,
    };
    Ok((
        next_file,
        EditSuccess {
            tag: next_tag,
            warnings,
            ops_echo: ops_echo.clone(),
            delete_file: false,
            moved_to: plan.mv,
        },
    ))
}

pub fn encode_success(file: &NormalizedFile) -> Vec<u8> {
    encode_bytes(&file.text, file.ending, file.bom, file.utf16)
}

pub fn record_post_write(
    store: Option<&HashlineStore>,
    session_id: Option<&str>,
    canonical_path: &str,
    file: &NormalizedFile,
    tag: &str,
) {
    if let (Some(store), Some(session)) = (store, session_id) {
        let n = split_lines(&file.text).len() as u32;
        let seen: BTreeSet<u32> = if n == 0 {
            BTreeSet::new()
        } else {
            (1..=n).collect()
        };
        store.record(session, canonical_path, file, tag, Some(seen));
    }
}

pub fn canonical_key(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tag_of_bytes(bytes: &[u8]) -> String {
        tag_of_lf_text(&normalize_file(bytes).text)
    }

    fn edit(bytes: &[u8], ops: &str) -> Result<String, ToolError> {
        let tag = tag_of_bytes(bytes);
        apply_edit("f.txt", "/ws/f.txt", &tag, ops, bytes, None, None)
            .map(|(file, _success)| file.text)
    }

    #[test]
    fn replaces_a_range_and_appends() {
        let bytes = b"one\ntwo\nthree\n";
        let tag = tag_of_bytes(bytes);
        let (out, success) = apply_edit(
            "f.txt",
            "/ws/f.txt",
            &tag,
            "PUT 2.=2:\n+TWO\nPUT >$:\n+four\n",
            bytes,
            None,
            None,
        )
        .unwrap();
        assert_eq!(out.text, "one\nTWO\nthree\nfour\n");
        assert_eq!(success.tag, tag_of_lf_text(&out.text));
    }

    #[test]
    fn inserts_before_and_after() {
        let bytes = b"b\nc\n";
        let out = edit(bytes, "PUT <1:\n+a\nPUT >2:\n+d\n").unwrap();
        assert_eq!(out, "a\nb\nc\nd\n");
    }

    #[test]
    fn cut_deletes_the_range() {
        let bytes = b"a\nb\nc\nd\n";
        let out = edit(bytes, "CUT 2.=3\n").unwrap();
        assert_eq!(out, "a\nd\n");
    }

    #[test]
    fn rejects_stale_tag_unless_head_or_tail() {
        let bytes = b"a\nb\n";
        let err = apply_edit(
            "f.txt",
            "/ws/f.txt",
            "0000",
            "PUT 1.=1:\n+A\n",
            bytes,
            None,
            None,
        )
        .unwrap_err();
        assert_eq!(err.code, "EDIT_TAG_MISMATCH");
        let (ok, success) = apply_edit(
            "f.txt",
            "/ws/f.txt",
            "0000",
            "PUT >$:\n+c\n",
            bytes,
            None,
            None,
        )
        .unwrap();
        assert_eq!(ok.text, "a\nb\nc\n");
        assert!(!success.warnings.is_empty());
    }

    #[test]
    fn no_op_is_an_error() {
        let bytes = b"same\n";
        let err = edit(bytes, "PUT 1.=1:\n+same\n").unwrap_err();
        assert_eq!(err.code, "EDIT_NO_CHANGE");
    }

    #[test]
    fn overlapping_ranges_fail() {
        let bytes = b"a\nb\nc\n";
        let err = edit(bytes, "PUT 1.=2:\n+x\n+y\nCUT 2.=3\n").unwrap_err();
        assert_eq!(err.code, "EDIT_RANGE_INVALID");
    }

    #[test]
    fn provenance_rejects_unseen_then_merges() {
        let store = HashlineStore::new();
        let bytes = b"a\nb\nc\nd\n";
        let file = normalize_file(bytes);
        let tag = tag_of_lf_text(&file.text);
        store.record("s", "/ws/f.txt", &file, &tag, Some(BTreeSet::from([1, 2])));
        let err = apply_edit(
            "f.txt",
            "/ws/f.txt",
            &tag,
            "PUT 3.=3:\n+C\n",
            bytes,
            Some("s"),
            Some(&store),
        )
        .unwrap_err();
        assert_eq!(err.code, "EDIT_LINES_UNSEEN");
        assert_eq!(err.extra["merged"], json!(true));
        let (ok, _success) = apply_edit(
            "f.txt",
            "/ws/f.txt",
            &tag,
            "PUT 3.=3:\n+C\n",
            bytes,
            Some("s"),
            Some(&store),
        )
        .unwrap();
        assert_eq!(ok.text, "a\nb\nC\nd\n");
    }

    /// Records `text` as a version of `/ws/f.txt` this session has seen.
    fn watch(store: &HashlineStore, text: &[u8]) -> String {
        let file = normalize_file(text);
        let tag = tag_of_lf_text(&file.text);
        let seen: BTreeSet<u32> = (1..=split_lines(&file.text).len() as u32).collect();
        store.record("s", "/ws/f.txt", &file, &tag, Some(seen));
        tag
    }

    #[test]
    fn drift_recovery_relocates_anchors_that_moved_together() {
        let store = HashlineStore::new();
        let tag = watch(&store, b"a\nb\nc\nd\n");
        // Something outside the session inserted a line at the head.
        let live = b"x\na\nb\nc\nd\n";
        let (out, success) = apply_edit(
            "f.txt",
            "/ws/f.txt",
            &tag,
            "PUT 3.=3:\n+C\n",
            live,
            Some("s"),
            Some(&store),
        )
        .unwrap();
        assert_eq!(out.text, "x\na\nb\nC\nd\n");
        assert_eq!(success.tag, tag_of_lf_text(&out.text));
        // The echo keeps the authored line numbers, not the relocated ones.
        assert_eq!(success.ops_echo, vec!["PUT 3.=3:"]);
        assert!(success
            .warnings
            .iter()
            .any(|w| w.contains("external change")));
        assert!(success
            .warnings
            .iter()
            .any(|w| w.contains("line remap: anchors moved +1")));
    }

    #[test]
    fn drift_recovery_names_a_session_chain_when_the_session_wrote_later() {
        let store = HashlineStore::new();
        let tag = watch(&store, b"a\nb\nc\nd\n");
        // A later write in this session superseded the tagged version.
        watch(&store, b"x\na\nb\nc\nd\n");
        let (out, success) = apply_edit(
            "f.txt",
            "/ws/f.txt",
            &tag,
            "PUT 4.=4:\n+D\n",
            b"x\na\nb\nc\nd\n",
            Some("s"),
            Some(&store),
        )
        .unwrap();
        assert_eq!(out.text, "x\na\nb\nc\nD\n");
        assert!(success.warnings.iter().any(|w| w.contains("session chain")));
    }

    #[test]
    fn drift_recovery_declines_when_an_anchor_line_changed() {
        let store = HashlineStore::new();
        let tag = watch(&store, b"a\nb\nc\nd\n");
        let err = apply_edit(
            "f.txt",
            "/ws/f.txt",
            &tag,
            "PUT 3.=3:\n+C\n",
            b"x\na\nb\nCHANGED\nd\n",
            Some("s"),
            Some(&store),
        )
        .unwrap_err();
        assert_eq!(err.code, "EDIT_TAG_MISMATCH");
        assert_eq!(
            err.extra["liveTag"],
            json!(tag_of_lf_text("x\na\nb\nCHANGED\nd\n"))
        );
        assert_eq!(err.extra["anchors"], json!([3]));
        // The rejection carries what is at the named line now, not the text the
        // tag remembered (spec 18 §11).
        assert_eq!(err.extra["anchorLines"][0]["line"], json!(3));
        assert_eq!(err.extra["anchorLines"][0]["text"], json!("b"));
    }

    #[test]
    fn drift_recovery_declines_when_a_replaced_range_moved_unevenly() {
        let store = HashlineStore::new();
        let tag = watch(&store, b"a\nb\nc\nd\ne\n");
        // The inserted line splits the target range: `b` and `c` no longer sit
        // at one offset, so the range cannot be moved as a whole.
        let live = b"z\na\nb\nNEW\nc\nd\ne\n";
        let err = apply_edit(
            "f.txt",
            "/ws/f.txt",
            &tag,
            "PUT 2.=4:\n+B\n+C\n+D\n",
            live,
            Some("s"),
            Some(&store),
        )
        .unwrap_err();
        assert_eq!(err.code, "EDIT_TAG_MISMATCH");
    }

    #[test]
    fn drift_recovery_reports_an_unknown_tag() {
        let store = HashlineStore::new();
        let err = apply_edit(
            "f.txt",
            "/ws/f.txt",
            "A1B2",
            "PUT 1.=1:\n+A\n",
            b"a\n",
            Some("s"),
            Some(&store),
        )
        .unwrap_err();
        assert_eq!(err.code, "EDIT_TAG_UNKNOWN");
    }
}
