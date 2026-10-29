CREATE TABLE compare_jobs (
    id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    revision BIGINT UNSIGNED NOT NULL,
    state VARCHAR(16) CHARACTER SET ascii NOT NULL,
    expires_at BIGINT UNSIGNED NOT NULL,
    result_expires_at BIGINT UNSIGNED NOT NULL,
    created_at BIGINT UNSIGNED NOT NULL,
    record_json MEDIUMTEXT CHARACTER SET utf8mb4 NOT NULL,
    INDEX jobs_expiry (expires_at),
    INDEX jobs_result_expiry (result_expires_at),
    INDEX jobs_recovery (state, created_at)
) ENGINE=InnoDB;

CREATE TABLE compare_nonces (
    nonce CHAR(32) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    expires_at BIGINT UNSIGNED NOT NULL,
    INDEX nonce_expiry (expires_at)
) ENGINE=InnoDB;

CREATE TABLE compare_rate_limits (
    bucket VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    window_start BIGINT UNSIGNED NOT NULL,
    hits BIGINT UNSIGNED NOT NULL,
    expires_at BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (bucket, window_start),
    INDEX rate_expiry (expires_at)
) ENGINE=InnoDB;

CREATE TABLE compare_runs (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    status VARCHAR(16) CHARACTER SET ascii NOT NULL,
    created_at BIGINT UNSIGNED NOT NULL,
    expires_at BIGINT UNSIGNED NOT NULL,
    INDEX run_expiry (expires_at)
) ENGINE=InnoDB;
