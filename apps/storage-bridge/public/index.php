<?php
declare(strict_types=1);

// Deploy only this file below public_html/compare-storage/.
// The implementation and credentials belong in the sibling, non-public directory.
ini_set('display_errors', '0');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header("Content-Security-Policy: default-src 'none'; frame-ancestors 'none'");

try {
    require dirname(__DIR__, 2) . '/compare-storage/bridge.php';
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST' || ($_SERVER['QUERY_STRING'] ?? '') !== ''
        || !in_array($_SERVER['HTTPS'] ?? '', ['on', '1'], true)
        || !preg_match('/^application\/json(?:;\s*charset=utf-8)?$/iD', $_SERVER['CONTENT_TYPE'] ?? '')
        || (int)($_SERVER['CONTENT_LENGTH'] ?? 0) > 600000) {
        http_response_code(400);
        echo '{"ok":false}';
        exit;
    }
    $body = file_get_contents('php://input', false, null, 0, 600001);
    if ($body === false || strlen($body) > 600000) {
        http_response_code(413);
        echo '{"ok":false}';
        exit;
    }
    $config = require dirname(__DIR__, 2) . '/compare-storage/config.php';
    $headers = [
        'time' => $_SERVER['HTTP_X_BRIDGE_TIME'] ?? '',
        'nonce' => $_SERVER['HTTP_X_BRIDGE_NONCE'] ?? '',
        'signature' => $_SERVER['HTTP_X_BRIDGE_SIGNATURE'] ?? '',
    ];
    $path = parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH);
    if (!is_string($path) || !\ProductCompare\Storage\valid_signature($headers, $body, $path, $config['secret'], time())) {
        http_response_code(403);
        echo '{"ok":false}';
        exit;
    }
    // Unauthenticated internet requests must not open database connections.
    $db = \ProductCompare\Storage\connect($config);
    if (!\ProductCompare\Storage\authenticate($db, $headers, $body, $path, $config['secret'], time())) {
        http_response_code(403);
        echo '{"ok":false}';
        exit;
    }
    $request = json_decode($body, false, 64, JSON_THROW_ON_ERROR);
    if (!$request instanceof stdClass || !is_string($request->operation ?? null)
        || !($request->input ?? null) instanceof stdClass) {
        throw new RuntimeException('invalid_request');
    }
    $value = \ProductCompare\Storage\operate($db, $request->operation, $request->input, $config, time());
    echo \ProductCompare\Storage\encode_json(['ok' => true, 'value' => $value]);
} catch (Throwable) {
    http_response_code(503);
    echo '{"ok":false}';
}
