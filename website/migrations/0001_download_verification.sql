-- Pending email is short-lived. Rate keys are HMACs, never raw IP addresses.
-- An email enters verified_downloads only through the atomic redemption query.
CREATE TABLE IF NOT EXISTS download_rate_events (
    token_hash TEXT PRIMARY KEY CHECK(length(token_hash) = 64),
    email_key TEXT NOT NULL CHECK(length(email_key) = 64),
    ip_key TEXT NOT NULL CHECK(length(ip_key) = 64),
    requested_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS download_rate_email_time ON download_rate_events(email_key, requested_at);
CREATE INDEX IF NOT EXISTS download_rate_ip_time ON download_rate_events(ip_key, requested_at);
CREATE INDEX IF NOT EXISTS download_rate_time ON download_rate_events(requested_at);

CREATE TABLE IF NOT EXISTS pending_downloads (
    token_hash TEXT PRIMARY KEY CHECK(length(token_hash) = 64),
    email TEXT NOT NULL,
    platform TEXT NOT NULL CHECK(platform IN ('windows', 'macos')),
    release_version TEXT NOT NULL,
    asset_filename TEXT NOT NULL,
    requested_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS pending_download_expiry ON pending_downloads(expires_at);

CREATE TABLE IF NOT EXISTS verified_downloads (
    id INTEGER PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash) = 64),
    email TEXT NOT NULL,
    platform TEXT NOT NULL CHECK(platform IN ('windows', 'macos')),
    release_version TEXT NOT NULL,
    asset_filename TEXT NOT NULL,
    requested_at INTEGER NOT NULL,
    verified_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS verified_download_time ON verified_downloads(verified_at);
