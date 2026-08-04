//! Guard against deploying to the wrong Cloudflare account.
//!
//! Generalizes the one-off `scripts/check-account.mjs` pattern: a deploy must
//! never silently target whatever account happens to be authenticated.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AccountStatus {
    /// Config and environment agree, or only one authoritative source exists.
    Ok,
    /// Nothing pins the account — deploy would follow ambient credentials.
    Unpinned,
    /// Config and environment disagree. Never proceed.
    Mismatch,
}

#[derive(Debug, Clone, Serialize)]
pub struct AccountCheck {
    pub status: AccountStatus,
    pub ok: bool,
    pub expected: Option<String>,
    pub actual: Option<String>,
    pub message: String,
}

/// Compare the account pinned in a Wrangler config against `CLOUDFLARE_ACCOUNT_ID`.
///
/// `expected` is the config value (or an explicit override); `actual` is the
/// value the environment would hand to wrangler.
pub fn check_account(expected: Option<&str>, actual: Option<&str>) -> AccountCheck {
    let expected = expected.map(str::trim).filter(|s| !s.is_empty());
    let actual = actual.map(str::trim).filter(|s| !s.is_empty());

    match (expected, actual) {
        (Some(e), Some(a)) if e == a => AccountCheck {
            status: AccountStatus::Ok,
            ok: true,
            expected: Some(e.to_string()),
            actual: Some(a.to_string()),
            message: format!("Account {e} confirmed."),
        },
        (Some(e), Some(a)) => AccountCheck {
            status: AccountStatus::Mismatch,
            ok: false,
            expected: Some(e.to_string()),
            actual: Some(a.to_string()),
            message: format!(
                "Refusing to continue: config pins account {e} but CLOUDFLARE_ACCOUNT_ID is {a}."
            ),
        },
        (Some(e), None) => AccountCheck {
            status: AccountStatus::Ok,
            ok: true,
            expected: Some(e.to_string()),
            actual: None,
            message: format!("Account {e} taken from wrangler config."),
        },
        (None, Some(a)) => AccountCheck {
            status: AccountStatus::Unpinned,
            ok: true,
            expected: None,
            actual: Some(a.to_string()),
            message: format!(
                "Config pins no account_id; falling back to CLOUDFLARE_ACCOUNT_ID {a}. \
                 Pin account_id in the wrangler config to make this deterministic."
            ),
        },
        (None, None) => AccountCheck {
            status: AccountStatus::Unpinned,
            ok: false,
            expected: None,
            actual: None,
            message: "No account_id in the wrangler config and no CLOUDFLARE_ACCOUNT_ID set. \
                      Deploy would target whichever account is authenticated."
                .to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mismatch_is_fatal() {
        let r = check_account(Some("aaa"), Some("bbb"));
        assert!(!r.ok);
        assert_eq!(r.status, AccountStatus::Mismatch);
    }

    #[test]
    fn matching_is_ok() {
        assert!(check_account(Some("aaa"), Some("aaa")).ok);
    }

    #[test]
    fn nothing_pinned_fails_closed() {
        let r = check_account(None, None);
        assert!(!r.ok);
        assert_eq!(r.status, AccountStatus::Unpinned);
    }
}
