<?php
declare(strict_types=1);

namespace ProductCompare\Storage;

use PDO;
use RuntimeException;
use stdClass;

function encode_json(mixed $value): string
{
    // Match JavaScript's UTF-8 size accounting; escaped Japanese text can double the response size.
    return json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}

function connect(array $config): PDO
{
    $db = new PDO($config['dsn'], $config['username'], $config['password'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_EMULATE_PREPARES => false,
        PDO::ATTR_STRINGIFY_FETCHES => false,
    ]);
    $db->exec("SET time_zone = '+00:00'");
    return $db;
}

function valid_signature(array $headers, string $body, string $path, string $secret, int $now): bool
{
    $time = $headers['time'] ?? '';
    $nonce = $headers['nonce'] ?? '';
    $signature = $headers['signature'] ?? '';
    if (!preg_match('/^[a-f0-9]{64}$/D', $secret) || !preg_match('/^[0-9]{10}$/D', $time)
        || abs($now - (int)$time) > 60 || !preg_match('/^[a-f0-9]{32}$/D', $nonce)
        || !preg_match('/^[a-f0-9]{64}$/D', $signature)) {
        return false;
    }
    $expected = hash_hmac('sha256', "$time\n$nonce\n$path\n$body", $secret);
    return hash_equals($expected, $signature);
}

function authenticate(PDO $db, array $headers, string $body, string $path, string $secret, int $now): bool
{
    if (!valid_signature($headers, $body, $path, $secret, $now)) { return false; }
    $insert = $db->prepare('INSERT IGNORE INTO compare_nonces (nonce, expires_at) VALUES (?, ?)');
    $insert->execute([$headers['nonce'], $now + 120]);
    return $insert->rowCount() === 1;
}

function identity(mixed $id): string
{
    if (!is_string($id) || !preg_match('/^[a-f0-9]{64}$/D', $id)) {
        throw new RuntimeException('invalid_request');
    }
    return $id;
}

function timestamp(mixed $value): int
{
    if (!is_string($value) || !preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/D', $value)) {
        throw new RuntimeException('invalid_request');
    }
    $date = \DateTimeImmutable::createFromFormat('!Y-m-d\TH:i:s.v\Z', $value, new \DateTimeZone('UTC'));
    if ($date === false || $date->format('Y-m-d\TH:i:s.v\Z') !== $value) {
        throw new RuntimeException('invalid_request');
    }
    // DB expiry columns use seconds. Round up so subsecond expiry is never scrubbed early.
    return $date->getTimestamp() + ($date->format('v') === '000' ? 0 : 1);
}

function validate_record(mixed $value, int $now): stdClass
{
    if (!$value instanceof stdClass || !isset($value->id, $value->accessKeyDigest, $value->inputDigest,
        $value->input, $value->state, $value->revision, $value->stage, $value->progress,
        $value->expiresAt, $value->resultExpiresAt)
        || !property_exists($value, 'result') || !property_exists($value, 'error')
        || !property_exists($value, 'workerId') || !property_exists($value, 'workerLeaseUntil')) {
        throw new RuntimeException('invalid_request');
    }
    identity($value->id);
    identity($value->accessKeyDigest);
    identity($value->inputDigest);
    if (!$value->input instanceof stdClass || !$value->progress instanceof stdClass
        || !is_string($value->state) || !in_array($value->state, ['queued', 'running', 'succeeded', 'failed', 'cancelled'], true)
        || !is_int($value->revision) || $value->revision < 1
        || !is_string($value->stage) || strlen($value->stage) > 64
        || !isset($value->progress->pages, $value->progress->examined)
        || !is_int($value->progress->pages) || $value->progress->pages < 0
        || !is_int($value->progress->examined) || $value->progress->examined < 0
        || timestamp($value->expiresAt) > $now + 3601
        || timestamp($value->resultExpiresAt) > timestamp($value->expiresAt)
        || ($value->state !== 'succeeded' && $value->result !== null)
        || strlen(encode_json($value->result)) > 512000
        || ($value->state === 'running' && (!is_string($value->workerId) || strlen($value->workerId) > 128
            || $value->workerId === '' || timestamp($value->workerLeaseUntil) > $now + 120))
        || ($value->state !== 'running' && ($value->workerId !== null || $value->workerLeaseUntil !== null))
        || ($value->state === 'failed' && (!$value->error instanceof stdClass
            || !isset($value->error->code) || !is_string($value->error->code) || strlen($value->error->code) > 64))
        || ($value->state !== 'failed' && $value->error !== null)) {
        throw new RuntimeException('invalid_request');
    }
    return $value;
}

function read_job(PDO $db, string $id, int $now): ?stdClass
{
    $read = $db->prepare('SELECT record_json FROM compare_jobs WHERE id = ? FOR UPDATE');
    $read->execute([$id]);
    $raw = $read->fetchColumn();
    if ($raw === false) {
        return null;
    }
    $job = json_decode($raw, false, 64, JSON_THROW_ON_ERROR);
    if (!$job instanceof stdClass) {
        throw new RuntimeException('storage_unavailable');
    }
    if (min(timestamp($job->expiresAt), timestamp($job->resultExpiresAt)) <= $now && $job->result !== null) {
        $job->result = null;
        $scrub = $db->prepare('UPDATE compare_jobs SET record_json = ? WHERE id = ?');
        $scrub->execute([encode_json($job), $id]);
    }
    return $job;
}

function operate(PDO $db, string $operation, stdClass $input, array $config, int $now): mixed
{
    $db->beginTransaction();
    try {
        $value = transaction_operation($db, $operation, $input, $config, $now);
        $db->commit();
        return $value;
    } catch (\Throwable $error) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        throw $error;
    }
}

function transaction_operation(PDO $db, string $operation, stdClass $input, array $config, int $now): mixed
{
    if ($operation === 'read') {
        return read_job($db, identity($input->id ?? null), $now);
    }
    if ($operation === 'create') {
        $job = validate_record($input->record ?? null, $now);
        if ($job->state !== 'queued' || $job->revision !== 1 || timestamp($job->expiresAt) <= $now) {
            throw new RuntimeException('invalid_request');
        }
        $insert = $db->prepare('INSERT INTO compare_jobs (id, revision, state, expires_at, result_expires_at, created_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE id = id');
        $insert->execute([$job->id, 1, 'queued', timestamp($job->expiresAt), timestamp($job->resultExpiresAt), $now, encode_json($job)]);
        $created = $insert->rowCount() === 1;
        return ['created' => $created, 'record' => read_job($db, $job->id, $now)];
    }
    if ($operation === 'replace') {
        $id = identity($input->id ?? null);
        $job = validate_record($input->record ?? null, $now);
        $current = read_job($db, $id, $now);
        if (!is_int($input->revision ?? null) || $job->id !== $id || $job->revision !== $input->revision + 1) {
            throw new RuntimeException('invalid_request');
        }
        if ($current === null || $current->revision !== $input->revision
            || timestamp($current->expiresAt) <= $now
            || in_array($current->state, ['succeeded', 'failed', 'cancelled'], true)
            || $current->accessKeyDigest !== $job->accessKeyDigest || $current->inputDigest !== $job->inputDigest
            || $current->expiresAt !== $job->expiresAt
            || encode_json($current->input) !== encode_json($job->input)) {
            return false;
        }
        $update = $db->prepare('UPDATE compare_jobs SET revision = ?, state = ?, result_expires_at = ?, record_json = ? WHERE id = ? AND revision = ?');
        $update->execute([$job->revision, $job->state, timestamp($job->resultExpiresAt), encode_json($job), $id, $input->revision]);
        return $update->rowCount() === 1;
    }
    if ($operation === 'rate_limit') {
        $key = identity($input->key ?? null);
        $windows = [[$key, 60, 6], ['global-minute', 60, $config['global_per_minute']], ['global-day', 86400, $config['global_per_day']]];
        $allowed = true;
        foreach ($windows as [$bucket, $seconds, $limit]) {
            $window = intdiv($now, $seconds) * $seconds;
            $increment = $db->prepare('INSERT INTO compare_rate_limits (bucket, window_start, hits, expires_at) VALUES (?, ?, 1, ?) ON DUPLICATE KEY UPDATE hits = LEAST(hits + 1, 1000000000)');
            $increment->execute([$bucket, $window, $window + $seconds]);
            $read = $db->prepare('SELECT hits FROM compare_rate_limits WHERE bucket = ? AND window_start = ? FOR UPDATE');
            $read->execute([$bucket, $window]);
            $allowed = ((int)$read->fetchColumn() <= $limit) && $allowed;
        }
        return $allowed;
    }
    if ($operation === 'record_run') {
        if (!in_array($input->status ?? null, ['succeeded', 'failed'], true)) {
            throw new RuntimeException('invalid_request');
        }
        $write = $db->prepare('INSERT INTO compare_runs (status, created_at, expires_at) VALUES (?, ?, ?)');
        $write->execute([$input->status, $now, $now + 2592000]);
        return null;
    }
    throw new RuntimeException('invalid_request');
}

function cleanup(PDO $db, int $now): void
{
    // Process small batches so a scheduled sweep cannot hold an unbounded lock.
    foreach (['compare_nonces', 'compare_rate_limits', 'compare_runs', 'compare_jobs'] as $table) {
        $delete = $db->prepare("DELETE FROM $table WHERE expires_at <= ? LIMIT 1000");
        $delete->execute([$now]);
    }
    $expired = $db->prepare('SELECT id FROM compare_jobs WHERE result_expires_at <= ? LIMIT 1000');
    $expired->execute([$now]);
    foreach ($expired->fetchAll(PDO::FETCH_COLUMN) as $id) {
        operate($db, 'read', (object)['id' => $id], [], $now);
    }
    $stale = $db->prepare("SELECT id FROM compare_jobs WHERE state IN ('queued', 'running') AND created_at < ? LIMIT 100");
    $stale->execute([$now - 600]);
    foreach ($stale->fetchAll(PDO::FETCH_COLUMN) as $id) {
        $db->beginTransaction();
        try {
            $job = read_job($db, $id, $now);
            if ($job !== null && ($job->state === 'queued' || ($job->state === 'running' && timestamp($job->workerLeaseUntil) < $now - 60))) {
                $job->state = 'failed';
                $job->stage = 'failed';
                $job->revision++;
                $job->workerId = null;
                $job->workerLeaseUntil = null;
                $job->error = (object)['code' => 'job_interrupted'];
                $update = $db->prepare('UPDATE compare_jobs SET state = ?, revision = ?, record_json = ? WHERE id = ?');
                $update->execute(['failed', $job->revision, encode_json($job), $id]);
            }
            $db->commit();
        } catch (\Throwable $error) {
            if ($db->inTransaction()) { $db->rollBack(); }
            throw $error;
        }
    }
}
