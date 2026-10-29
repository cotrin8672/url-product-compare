<?php
declare(strict_types=1);

return [
    'dsn' => 'mysql:host=localhost;dbname=ACCOUNT_compare;charset=utf8mb4',
    'username' => 'ACCOUNT_compare',
    'password' => 'REPLACE_ON_SERVER',
    'secret' => 'REPLACE_WITH_64_LOWERCASE_HEX_CHARACTERS',
    'global_per_minute' => 60,
    'global_per_day' => 1000,
];
