//! Drift recovery for a stale tag (spec 18 §10).
//!
//! Recovery only *relocates* an authored edit. The tagged snapshot's lines are
//! aligned with the live file; every line the ops touch — a range includes all
//! of its interior lines — must still be present, unchanged, at one single
//! offset. The locators are then shifted onto live coordinates and lowered
//! again against live content. Anything the alignment cannot prove declines,
//! so a recovered call can never move onto content the tag never named.

use super::parse::{Locator, ParsedOp, ParsedOps};
use std::collections::HashMap;

/// Total lines one alignment may visit before recovery gives up. A pathological
/// file (many repeated lines and no common prefix or suffix) keeps declining the
/// way it does today instead of spending a turn's worth of CPU.
const MAX_ALIGN_LINES: usize = 4_000_000;

/// Pairs every snapshot line the alignment can prove with its live index.
///
/// A patience diff: lines unique on both sides anchor the alignment, gaps are
/// resolved recursively after trimming the common prefix and suffix. Only equal
/// lines are ever mapped, and an ambiguous line stays unmapped rather than
/// guessed — recovery declines instead of relocating onto a guess.
fn unchanged_map(old: &[String], new: &[String]) -> Option<Vec<Option<u32>>> {
    let mut map: Vec<Option<u32>> = vec![None; old.len()];
    let mut visited = 0usize;
    let mut gaps: Vec<(usize, usize, usize, usize)> = vec![(0, old.len(), 0, new.len())];
    while let Some((mut a0, mut a1, mut b0, mut b1)) = gaps.pop() {
        visited = visited.saturating_add((a1 - a0) + (b1 - b0));
        if visited > MAX_ALIGN_LINES {
            return None;
        }
        while a0 < a1 && b0 < b1 && old[a0] == new[b0] {
            map[a0] = Some(b0 as u32);
            a0 += 1;
            b0 += 1;
        }
        while a1 > a0 && b1 > b0 && old[a1 - 1] == new[b1 - 1] {
            a1 -= 1;
            b1 -= 1;
            map[a1] = Some(b1 as u32);
        }
        if a0 >= a1 || b0 >= b1 {
            continue;
        }
        let anchors = unique_pairs(old, new, a0, a1, b0, b1);
        let kept = longest_increasing(&anchors);
        if kept.is_empty() {
            continue;
        }
        let mut cursor = (a0, b0);
        for &(old_index, new_index) in &kept {
            map[old_index] = Some(new_index as u32);
            if cursor.0 < old_index && cursor.1 < new_index {
                gaps.push((cursor.0, old_index, cursor.1, new_index));
            }
            cursor = (old_index + 1, new_index + 1);
        }
        gaps.push((cursor.0, a1, cursor.1, b1));
    }
    Some(map)
}

/// Lines occurring exactly once in both regions, in old-index order.
fn unique_pairs(
    old: &[String],
    new: &[String],
    a0: usize,
    a1: usize,
    b0: usize,
    b1: usize,
) -> Vec<(usize, usize)> {
    let mut old_sides: HashMap<&str, (u32, usize)> = HashMap::new();
    for (index, line) in old.iter().enumerate().take(a1).skip(a0) {
        let entry = old_sides.entry(line.as_str()).or_insert((0, index));
        entry.0 += 1;
    }
    let mut new_sides: HashMap<&str, (u32, usize)> = HashMap::new();
    for (index, line) in new.iter().enumerate().take(b1).skip(b0) {
        let entry = new_sides.entry(line.as_str()).or_insert((0, index));
        entry.0 += 1;
    }
    let mut pairs = Vec::new();
    for (line, (count, index)) in &old_sides {
        if *count != 1 {
            continue;
        }
        if let Some((new_count, new_index)) = new_sides.get(line) {
            if *new_count == 1 {
                pairs.push((*index, *new_index));
            }
        }
    }
    pairs.sort_unstable();
    pairs
}

/// Longest strictly increasing run of new indices, keeping old order.
fn longest_increasing(pairs: &[(usize, usize)]) -> Vec<(usize, usize)> {
    let mut tails: Vec<usize> = Vec::new();
    let mut previous: Vec<Option<usize>> = vec![None; pairs.len()];
    for index in 0..pairs.len() {
        let new_index = pairs[index].1;
        let slot = tails.partition_point(|&tail| pairs[tail].1 < new_index);
        if slot > 0 {
            previous[index] = Some(tails[slot - 1]);
        }
        if slot == tails.len() {
            tails.push(index);
        } else {
            tails[slot] = index;
        }
    }
    let mut kept = Vec::with_capacity(tails.len());
    let mut cursor = tails.last().copied();
    while let Some(index) = cursor {
        kept.push(pairs[index]);
        cursor = previous[index];
    }
    kept.reverse();
    kept
}

fn line_counts(lines: &[String]) -> HashMap<&str, u32> {
    let mut counts: HashMap<&str, u32> = HashMap::new();
    for line in lines {
        *counts.entry(line.as_str()).or_insert(0) += 1;
    }
    counts
}

/// Whether `old_index`'s line sits at `old_index + delta` in the live file.
fn matches_at(old: &[String], new: &[String], old_index: i64, delta: i64) -> bool {
    if old_index < 0 {
        return false;
    }
    let from = old_index as usize;
    if from >= old.len() {
        return false;
    }
    let to = old_index + delta;
    if to < 0 {
        return false;
    }
    let to = to as usize;
    to < new.len() && old[from] == new[to]
}

/// One consistent offset under which every anchor still names the same line.
///
/// Declines (`None`) whenever the alignment cannot prove the move: an anchor
/// line that changed, anchors drifting apart, or a duplicated anchor line
/// without matching context on both sides.
pub(super) fn drift_delta(old: &[String], new: &[String], anchors: &[u32]) -> Option<i64> {
    if old.is_empty() || new.is_empty() || anchors.is_empty() {
        return None;
    }
    let map = unchanged_map(old, new)?;
    let mut delta: Option<i64> = None;
    for &anchor in anchors {
        let index = anchor.checked_sub(1)? as usize;
        if index >= old.len() {
            return None;
        }
        let Some(target) = map[index] else {
            continue;
        };
        let here = target as i64 - index as i64;
        match delta {
            Some(existing) if existing != here => return None,
            Some(_) => {}
            None => delta = Some(here),
        }
    }
    // Every anchor has to name one line, so one mapped anchor is the minimum
    // proof of an offset. Without it nothing can be relocated.
    let delta = delta?;
    let old_counts = line_counts(old);
    let new_counts = line_counts(new);
    for &anchor in anchors {
        let index = anchor.checked_sub(1)? as usize;
        let shifted = index as i64 + delta;
        if shifted < 0 || shifted as usize >= new.len() {
            return None;
        }
        let shifted = shifted as usize;
        if old[index] != new[shifted] {
            return None;
        }
        let line = old[index].as_str();
        let unique = old_counts.get(line) == Some(&1) && new_counts.get(line) == Some(&1);
        // A duplicated line is only placed when the alignment itself mapped it.
        let mapped = map[index].map(|mapped| mapped as usize) == Some(shifted);
        if !unique && !mapped {
            return None;
        }
        let left = matches_at(old, new, index as i64 - 1, delta);
        let right = matches_at(old, new, index as i64 + 1, delta);
        let single_line_gap = index == 0 && old.len() == 1;
        let proven = if single_line_gap {
            mapped
        } else if unique {
            left || right
        } else {
            left && right
        };
        if !proven {
            return None;
        }
    }
    Some(delta)
}

/// Shifts every op's locators from snapshot coordinates onto live ones.
pub(super) fn shift_ops(ops: &ParsedOps, delta: i64) -> Option<ParsedOps> {
    let mut shifted = ops.clone();
    for op in &mut shifted.ops {
        match op {
            ParsedOp::Put { locator, .. } | ParsedOp::Cut { locator, .. } => {
                shift_locator(locator, delta)?;
            }
            ParsedOp::Rem | ParsedOp::Mv { .. } => {}
        }
    }
    Some(shifted)
}

fn shift_locator(locator: &mut Locator, delta: i64) -> Option<()> {
    match locator {
        Locator::Range { start, end } => {
            *start = shift_line(*start, delta)?;
            *end = shift_line(*end, delta)?;
        }
        // `<1` is the file head: content drift cannot move it.
        Locator::Before { line } => {
            if *line != 1 {
                *line = shift_line(*line, delta)?;
            }
        }
        Locator::After { line } => {
            *line = shift_line(*line, delta)?;
        }
        Locator::End => {}
        Locator::Block { .. } | Locator::AfterBlock { .. } => return None,
    }
    Some(())
}

fn shift_line(line: u32, delta: i64) -> Option<u32> {
    let shifted = line as i64 + delta;
    if shifted < 1 || shifted > u32::MAX as i64 {
        return None;
    }
    Some(shifted as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(text: &str) -> Vec<String> {
        text.split('\n').map(str::to_string).collect()
    }

    fn map_of(old: &str, new: &str) -> Vec<Option<u32>> {
        unchanged_map(&lines(old), &lines(new)).expect("alignable fixture")
    }

    #[test]
    fn maps_a_head_insertion_and_a_middle_replacement() {
        assert_eq!(
            map_of("a\nb\nc", "x\ny\na\nb\nc"),
            vec![Some(2), Some(3), Some(4)]
        );
        assert_eq!(
            map_of("a\nb\nc\nd", "a\nB\nc\nd"),
            vec![Some(0), None, Some(2), Some(3)]
        );
        assert_eq!(map_of("a", "a"), vec![Some(0)]);
        assert!(unchanged_map(&[], &lines("a")).unwrap().is_empty());
        assert_eq!(unchanged_map(&lines("a"), &[]), Some(vec![None]));
    }

    #[test]
    fn never_maps_a_duplicated_line_by_position_alone() {
        // The braces are ambiguous on both sides, so only the unique `x` may
        // anchor; the block move itself cannot be proven line by line.
        let map = map_of("}\n}\nx", "x\n}\n}");
        assert_eq!(map, vec![None, None, Some(0)]);
    }

    #[test]
    fn accepts_one_uniform_offset() {
        let old = lines("a\nb\nc\nd\ne");
        let new = lines("p\na\nb\nc\nd\ne");
        assert_eq!(drift_delta(&old, &new, &[3, 4]), Some(1));
    }

    #[test]
    fn declines_a_changed_anchor_line() {
        let old = lines("a\nb\nc\nd");
        let new = lines("p\na\nb\nX\nd");
        assert_eq!(drift_delta(&old, &new, &[3]), None);
    }

    #[test]
    fn declines_anchors_that_drift_apart() {
        let old = lines("a\nb\nc\nd\ne");
        // An insertion above `b` and a deletion above `d` give different offsets.
        let new = lines("p\na\nb\nc\ne");
        assert_eq!(drift_delta(&old, &new, &[2, 4]), None);
    }

    #[test]
    fn shifts_locators_but_keeps_head_and_end_pinned() {
        let ops = ParsedOps {
            header_path: None,
            header_tag: None,
            ops: vec![
                ParsedOp::Put {
                    locator: Locator::Range { start: 4, end: 5 },
                    body: vec!["x".into()],
                    register: None,
                },
                ParsedOp::Put {
                    locator: Locator::Before { line: 1 },
                    body: vec!["head".into()],
                    register: None,
                },
                ParsedOp::Put {
                    locator: Locator::End,
                    body: vec!["tail".into()],
                    register: None,
                },
                ParsedOp::Cut {
                    locator: Locator::Range { start: 2, end: 2 },
                    register: Some("reg".into()),
                },
                ParsedOp::Mv {
                    dest: "other.txt".into(),
                },
            ],
        };
        let shifted = shift_ops(&ops, 3).unwrap();
        assert_eq!(
            shifted.ops[0],
            ParsedOp::Put {
                locator: Locator::Range { start: 7, end: 8 },
                body: vec!["x".into()],
                register: None,
            }
        );
        assert_eq!(
            shifted.ops[1],
            ParsedOp::Put {
                locator: Locator::Before { line: 1 },
                body: vec!["head".into()],
                register: None,
            }
        );
        assert_eq!(
            shifted.ops[3],
            ParsedOp::Cut {
                locator: Locator::Range { start: 5, end: 5 },
                register: Some("reg".into()),
            }
        );
        assert!(shift_ops(&ops, -3).is_none());
    }
}
