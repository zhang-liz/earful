#!/usr/bin/env bash
# Fill an app's Resources folder with everything Earful needs to run with no
# internet and nothing else installed: Python, the packages, the code, the
# models and every voice it offers. Called by build-app.sh --bundle.
#
#   mac/bundle.sh <Earful.app/Contents/Resources>
set -euo pipefail
cd "$(dirname "$0")/.."

RES="$1"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Python itself: a standalone build that runs from any folder.
uv python install --quiet --install-dir "$WORK/python" "$(cat .python-version)"
PYDIR="$(find "$WORK/python" -maxdepth 1 -type d -name 'cpython-*-macos-aarch64-none' | head -1)"
[[ -n "$PYDIR" ]] || { echo "No arm64 Python found." >&2; exit 1; }
cp -R "$PYDIR" "$RES/py"
PY="$RES/py/bin/python3"
# This Python is the app's own; let packages be installed into it.
rm -f "$RES"/py/lib/python3.*/EXTERNALLY-MANAGED

# The packages, exactly as locked, plus the English model misaki would
# otherwise download on first use.
uv export --quiet --frozen --no-dev --no-hashes --no-emit-project --format requirements-txt >"$WORK/requirements.txt"
uv pip install --quiet --python "$PY" --no-cache -r "$WORK/requirements.txt"
SPACY="$("$PY" -c 'import spacy; v = spacy.about.__version__.split("."); print(f"{v[0]}.{v[1]}.0")')"
uv pip install --quiet --python "$PY" --no-cache \
  "https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-$SPACY/en_core_web_sm-$SPACY-py3-none-any.whl"

# Not needed to run: C headers for building torch add-ons, and pip.
SITE="$(echo "$RES"/py/lib/python3.*/site-packages)"
rm -rf "$SITE/torch/include" "$SITE"/pip "$SITE"/pip-*.dist-info

# The code.
mkdir -p "$RES/earful/app"
cp app/*.py app/*.html app/icon.png "$RES/earful/app/"
cp -R app/strings "$RES/earful/app/strings"

# The models and voices.
HF_HOME="$RES/hf" PYTHONPATH="$RES/earful" "$PY" mac/fetch_models.py
rm -rf "$RES/hf/xet" "$RES/hf/hub/.locks"

# Compile now: the app may not write into itself later.
"$PY" -m compileall -q -j 0 "$RES/py/lib" "$RES/earful" >/dev/null 2>&1 || true

du -sh "$RES/py" "$RES/hf" | sed 's/^/  /'
