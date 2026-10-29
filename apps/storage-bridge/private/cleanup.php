<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}
require __DIR__ . '/bridge.php';
$config = require __DIR__ . '/config.php';
\ProductCompare\Storage\cleanup(\ProductCompare\Storage\connect($config), time());
