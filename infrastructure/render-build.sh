#!/usr/bin/env bash
set -euo pipefail

curl --fail --silent --show-error https://mise.run | sh
export PATH="$HOME/.local/bin:$PATH"
mise trust mise.toml
mise install
NODE_ENV=development mise run install
export SITE_ORIGIN="${RENDER_EXTERNAL_URL:?Render public URL is required}"
mise run firebase:package
