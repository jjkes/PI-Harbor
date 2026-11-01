//! The managed `info/exclude` block of a repository.
//!
//! One anchored rule per project prefix removes every workspace checkout from
//! `git status`, `git ls-files --exclude-standard`, and ripgrep in the parent
//! checkout, without hiding anything inside a workspace itself. The block
//! lives in the repository's **common** git directory, shared by every linked
//! worktree, and never in the user's tracked `.gitignore`.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub const BEGIN_MARKER: &str = "# >>> pi-desktop workspaces";
pub const END_MARKER: &str = "# <<< pi-desktop workspaces";

/// `info/exclude` inside the common git directory.
pub fn exclude_path(common_dir: &Path) -> PathBuf {
    common_dir.join("info").join("exclude")
}

/// The anchored rule for a project at `prefix` inside the repository.
/// `/.pi/worktree/` at the top level, `/<prefix>/.pi/worktree/` below it.
pub fn rule_for(prefix: &str) -> String {
    let prefix = prefix.trim_matches('/');
    if prefix.is_empty() {
        format!("/{}/", super::WORKSPACE_DIR)
    } else {
        format!("/{}/{}/", prefix, super::WORKSPACE_DIR)
    }
}

/// Add the rule for `prefix`, keeping the block sorted and deduplicated.
/// Idempotent: writing twice leaves one rule and one block.
pub fn add_rule(common_dir: &Path, prefix: &str) -> io::Result<()> {
    update(common_dir, |rules| {
        let rule = rule_for(prefix);
        if !rules.contains(&rule) {
            rules.push(rule);
            rules.sort();
        }
    })
}

/// Remove the rule for `prefix`, dropping the whole block once it is empty.
pub fn remove_rule(common_dir: &Path, prefix: &str) -> io::Result<()> {
    update(common_dir, |rules| {
        let rule = rule_for(prefix);
        rules.retain(|existing| *existing != rule);
    })
}

/// The rules currently inside the managed block. Tests only: production code
/// edits the block through `add_rule` / `remove_rule` and never reads it back.
#[cfg(test)]
pub fn rules(common_dir: &Path) -> Vec<String> {
    let Ok(text) = fs::read_to_string(exclude_path(common_dir)) else {
        return Vec::new();
    };
    split(&text).1
}

/// Everything outside the managed block, and the rules inside it. A file
/// without the markers keeps all of its lines as "outside".
fn split(text: &str) -> (Vec<String>, Vec<String>) {
    let mut outside = Vec::new();
    let mut inside = Vec::new();
    let mut in_block = false;
    for line in text.lines() {
        if line.trim_end() == BEGIN_MARKER {
            in_block = true;
            continue;
        }
        if line.trim_end() == END_MARKER {
            in_block = false;
            continue;
        }
        if in_block {
            let rule = line.trim();
            if !rule.is_empty() {
                inside.push(rule.to_string());
            }
        } else {
            outside.push(line.to_string());
        }
    }
    (outside, inside)
}

fn update(common_dir: &Path, edit: impl FnOnce(&mut Vec<String>)) -> io::Result<()> {
    let path = exclude_path(common_dir);
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error),
    };
    let (mut outside, mut rules) = split(&text);
    let before = rules.clone();
    edit(&mut rules);
    if rules == before && text.contains(BEGIN_MARKER) == !rules.is_empty() {
        return Ok(());
    }
    // Trailing blank lines left by a removed block would accumulate.
    while outside.last().is_some_and(|line| line.trim().is_empty()) {
        outside.pop();
    }
    let mut lines = outside;
    if !rules.is_empty() {
        lines.push(BEGIN_MARKER.to_string());
        lines.extend(rules);
        lines.push(END_MARKER.to_string());
    }
    let mut body = lines.join("\n");
    if !body.is_empty() {
        body.push('\n');
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, body)
}
