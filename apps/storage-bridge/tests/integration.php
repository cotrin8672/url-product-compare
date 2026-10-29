<?php
declare(strict_types=1);

require dirname(__DIR__) . '/private/bridge.php';

use function ProductCompare\Storage\authenticate;
use function ProductCompare\Storage\cleanup;
use function ProductCompare\Storage\connect;
use function ProductCompare\Storage\operate;
use function ProductCompare\Storage\timestamp;
use function ProductCompare\Storage\validate_record;

function check(bool $value, string $message): void
{
    if (!$value) { throw new RuntimeException($message); }
}

$config = [
    'dsn' => getenv('COMPARE_TEST_DSN'),
    'username' => getenv('COMPARE_TEST_USER'),
    'password' => getenv('COMPARE_TEST_PASSWORD'),
    'secret' => str_repeat('a', 64),
    'global_per_minute' => 60,
    'global_per_day' => 1000,
];
if (!is_string($config['dsn']) || !str_contains($config['dsn'], 'dbname=compare_test_')) {
    throw new RuntimeException('Set COMPARE_TEST_DSN to an isolated compare_test_* database');
}
$db = connect($config);
$database = $db->query('SELECT DATABASE()')->fetchColumn();
check(is_string($database) && preg_match('/^compare_test_[a-zA-Z0-9_]+$/D', $database) === 1, 'Refuse non-test database');
foreach (['compare_nonces', 'compare_rate_limits', 'compare_runs', 'compare_jobs'] as $table) {
    $db->exec("DROP TABLE IF EXISTS $table");
}
$db->exec(file_get_contents(dirname(__DIR__) . '/schema.sql'));
$now = time();
$iso = fn(int $seconds): string => gmdate('Y-m-d\TH:i:s.000\Z', $seconds);
check(timestamp('2026-10-21T12:00:00.123Z') === timestamp('2026-10-21T12:00:00.000Z') + 1, 'Expiry never rounds down');
$body = '{"operation":"read","input":{"id":"' . str_repeat('b', 64) . '"}}';
$path = '/compare-storage/index.php';
$headers = ['time' => (string)$now, 'nonce' => str_repeat('b', 32)];
$headers['signature'] = hash_hmac('sha256', "$now\n{$headers['nonce']}\n$path\n$body", $config['secret']);
check(authenticate($db, $headers, $body, $path, $config['secret'], $now), 'Valid signature accepted');
check(!authenticate($db, $headers, $body, $path, $config['secret'], $now), 'Replay rejected');
check(!authenticate($db, $headers, $body . ' ', $path, $config['secret'], $now), 'Tampered bytes rejected');
check(!authenticate($db, $headers, $body, '/other', $config['secret'], $now), 'Different path rejected');
check(!authenticate($db, $headers, $body, $path, $config['secret'], $now + 61), 'Old signature rejected');

$job = (object)[
    'id' => str_repeat('b', 64), 'accessKeyDigest' => str_repeat('c', 64), 'inputDigest' => str_repeat('d', 64),
    'input' => (object)['url' => 'https://example.test/item', 'keyword' => null, 'category' => 'laptop', 'conditions' => new stdClass(), 'sort' => 'price'],
    'state' => 'queued', 'revision' => 1, 'stage' => 'queued', 'progress' => (object)['pages' => 0, 'examined' => 0],
    'expiresAt' => $iso($now + 3600), 'resultExpiresAt' => $iso($now + 3600), 'result' => null, 'error' => null,
    'workerId' => null, 'workerLeaseUntil' => null,
];
$created = operate($db, 'create', (object)['record' => $job], $config, $now);
check($created['created'] === true, 'First create');
check($created['record']->input->conditions instanceof stdClass, 'Empty JSON objects preserved');
check(operate($db, 'create', (object)['record' => $job], $config, $now)['created'] === false, 'Duplicate create');
check(operate($db, 'read', (object)['id' => str_repeat('e', 64)], $config, $now) === null, 'Missing record');
$running = clone $job;
$running->state = 'running'; $running->stage = 'search'; $running->revision = 2;
$running->workerId = 'worker-a'; $running->workerLeaseUntil = $iso($now + 45);
$replace = (object)['id' => $job->id, 'revision' => 1, 'record' => $running];
check(operate($db, 'replace', $replace, $config, $now) === true, 'Claim succeeds');
check(operate($db, 'replace', $replace, $config, $now) === false, 'Stale revision rejected');
$forged = clone $running; $forged->revision = 3; $forged->accessKeyDigest = str_repeat('f', 64);
check(operate($db, 'replace', (object)['id' => $job->id, 'revision' => 2, 'record' => $forged], $config, $now) === false, 'Identity cannot change');
$succeeded = clone $running; $succeeded->state = 'succeeded'; $succeeded->stage = 'done'; $succeeded->revision = 3;
$succeeded->workerId = null; $succeeded->workerLeaseUntil = null; $succeeded->result = (object)['private' => str_repeat('検証', 60000)];
$succeeded->resultExpiresAt = $iso($now + 30);
check(operate($db, 'replace', (object)['id' => $job->id, 'revision' => 2, 'record' => $succeeded], $config, $now), 'Finish succeeds');
check(strlen(\ProductCompare\Storage\encode_json(operate($db, 'read', (object)['id' => $job->id], $config, $now))) < 650000, 'Japanese results retain UTF-8 size bounds');
check(operate($db, 'read', (object)['id' => $job->id], $config, $now + 31)->result === null, 'Expired result scrubbed on read');
$late = clone $succeeded; $late->revision = 4;
check(operate($db, 'replace', (object)['id' => $job->id, 'revision' => 3, 'record' => $late], $config, $now + 31) === false, 'Terminal result fenced');
for ($index = 0; $index < 6; $index++) {
    check(operate($db, 'rate_limit', (object)['key' => str_repeat('a', 64)], $config, $now), 'Within rate limit');
}
check(!operate($db, 'rate_limit', (object)['key' => str_repeat('a', 64)], $config, $now), 'Seventh request denied');
check(operate($db, 'rate_limit', (object)['key' => str_repeat('a', 64)], $config, $now + 60), 'Window resets');
operate($db, 'record_run', (object)['status' => 'succeeded'], $config, $now);
check((int)$db->query('SELECT COUNT(*) FROM compare_runs')->fetchColumn() === 1, 'Metadata saved');
try { timestamp('2026-02-30T12:00:00.000Z'); throw new LogicException('Invalid date accepted'); }
catch (RuntimeException) {}
try { operate($db, 'sql', new stdClass(), $config, $now); throw new LogicException('Arbitrary SQL accepted'); }
catch (RuntimeException) { check(!$db->inTransaction(), 'Failure rolls back'); }
cleanup($db, $now + 3601);
check((int)$db->query('SELECT COUNT(*) FROM compare_jobs')->fetchColumn() === 0, 'Expired jobs removed');
echo "PHP/MariaDB: signatures, replay, CAS, JSON, expiry, limits and cleanup passed.\n";
