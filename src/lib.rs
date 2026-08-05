//! Core engine for `vite-plus-wrangler`.
//!
//! Everything that touches the filesystem or parses Cloudflare configuration
//! lives here so the Node layer stays a thin, cheap wrapper around one binary.

pub mod account;
pub mod bundle;
pub mod config;
pub mod discovery;
pub mod lint;
pub mod migrations;
pub mod secrets;

#[cfg(test)]
pub(crate) mod testutil;
