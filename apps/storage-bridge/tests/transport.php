<?php
declare(strict_types=1);

require dirname(__DIR__) . '/private/bridge.php';

// CLI-only transport for the Node/PHP/MariaDB contract test; never deploy it.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
try {
    $config = [
        'dsn' => getenv('COMPARE_TEST_DSN'), 'username' => getenv('COMPARE_TEST_USER'),
        'password' => getenv('COMPARE_TEST_PASSWORD'), 'secret' => str_repeat('a', 64),
        'global_per_minute' => 60, 'global_per_day' => 1000,
    ];
    if (!is_string($config['dsn']) || !str_contains($config['dsn'], 'dbname=compare_test_')) {
        throw new RuntimeException('Isolated test database required');
    }
    $db = \ProductCompare\Storage\connect($config);
    if (!preg_match('/^compare_test_[a-zA-Z0-9_]+$/D', $db->query('SELECT DATABASE()')->fetchColumn())) {
        throw new RuntimeException('Isolated test database required');
    }
    $envelope = json_decode(file_get_contents('php://stdin'), true, 64, JSON_THROW_ON_ERROR);
    $headers = ['time' => $envelope['headers']['x-bridge-time'], 'nonce' => $envelope['headers']['x-bridge-nonce'], 'signature' => $envelope['headers']['x-bridge-signature']];
    if (!\ProductCompare\Storage\authenticate($db, $headers, $envelope['body'], $envelope['path'], $config['secret'], time())) {
        echo '{"ok":false}';
        exit;
    }
    $request = json_decode($envelope['body'], false, 64, JSON_THROW_ON_ERROR);
    $result = \ProductCompare\Storage\operate($db, $request->operation, $request->input, $config, time());
    echo \ProductCompare\Storage\encode_json(['ok' => true, 'value' => $result]);
} catch (Throwable) {
    echo '{"ok":false}';
    exit(1);
}
