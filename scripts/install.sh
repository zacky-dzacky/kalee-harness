#!/usr/bin/env bash
#
# Install kalee as a standalone CLI.
#
# The binary goes on your PATH; the runtime data (prompts, skills, models.yaml) goes to
# ~/.kalee. That split is deliberate: prompts and the model registry are read from disk at run
# time, never baked into the binary, so you can edit a prompt and see the effect on the next
# run without rebuilding.
#
#   ./scripts/install.sh                 # binary to ~/.local/bin, data to ~/.kalee
#   BIN_DIR=/usr/local/bin ./scripts/install.sh
#   KALEE_DATA=~/kalee-data ./scripts/install.sh
set -euo pipefail

BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
KALEE_DATA="${KALEE_DATA:-$HOME/.kalee}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$REPO"

if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun is not installed. Get it with:" >&2
  echo "  curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi

echo "==> installing dependencies"
bun install --frozen-lockfile >/dev/null

echo "==> building the binary"
bun build --compile --outfile dist/kalee src/cli.ts >/dev/null

echo "==> installing runtime data to $KALEE_DATA"
mkdir -p "$KALEE_DATA"
# Merge rather than replace: your own skills live alongside the bundled ones.
cp -R prompts "$KALEE_DATA/"
mkdir -p "$KALEE_DATA/skills"
cp -R skills/. "$KALEE_DATA/skills/"
cp -R fixtures "$KALEE_DATA/"

# models.yaml is yours once you have edited it — `kalee doctor` writes probed capabilities
# back into it, and reinstalling must not throw that away.
if [ -f "$KALEE_DATA/models.yaml" ]; then
  echo "    keeping your existing $KALEE_DATA/models.yaml"
  echo "    (the shipped default is at $REPO/models.yaml if you want to diff it)"
else
  cp models.yaml "$KALEE_DATA/"
fi

echo "==> installing the binary to $BIN_DIR"
mkdir -p "$BIN_DIR"
install -m 755 dist/kalee "$BIN_DIR/kalee"

echo
echo "installed: $BIN_DIR/kalee"
echo "data:      $KALEE_DATA"

case ":$PATH:" in
  *":$BIN_DIR:"*)
    echo
    echo "Run \`kalee models\` to check it works."
    ;;
  *)
    echo
    echo "warning: $BIN_DIR is not on your PATH. Add this to your shell profile:"
    echo "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac
