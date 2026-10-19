-- Extend platform constraints without changing existing registrations or quotas.
-- Wrangler applies each migration atomically; do not add BEGIN/COMMIT for D1.
CREATE TABLE pending_downloads_with_android (
    token_hash TEXT PRIMARY KEY CHECK(length(token_hash) = 64),
    email TEXT NOT NULL,
    platform TEXT NOT NULL CHECK(platform IN ('windows', 'macos', 'android')),
    release_version TEXT NOT NULL,
    asset_filename TEXT NOT NULL,
    requested_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    sent_at INTEGER
);
INSERT INTO pending_downloads_with_android
    (token_hash, email, platform, release_version, asset_filename, requested_at, expires_at, sent_at)
SELECT token_hash, email, platform, release_version, asset_filename, requested_at, expires_at, sent_at
FROM pending_downloads;
DROP TABLE pending_downloads;
ALTER TABLE pending_downloads_with_android RENAME TO pending_downloads;
CREATE INDEX pending_download_expiry ON pending_downloads(expires_at);

CREATE TABLE verified_downloads_with_android (
    id INTEGER PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash) = 64),
    email TEXT NOT NULL,
    platform TEXT NOT NULL CHECK(platform IN ('windows', 'macos', 'android')),
    release_version TEXT NOT NULL,
    asset_filename TEXT NOT NULL,
    requested_at INTEGER NOT NULL,
    verified_at INTEGER NOT NULL
);
INSERT INTO verified_downloads_with_android
    (id, token_hash, email, platform, release_version, asset_filename, requested_at, verified_at)
SELECT id, token_hash, email, platform, release_version, asset_filename, requested_at, verified_at
FROM verified_downloads;
DROP TABLE verified_downloads;
ALTER TABLE verified_downloads_with_android RENAME TO verified_downloads;
CREATE INDEX verified_download_time ON verified_downloads(verified_at);
