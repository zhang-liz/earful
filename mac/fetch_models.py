"""Download the models and voices Earful uses into HF_HOME, for the Mac app.

Only what Earful offers is fetched: each language's model and the voices in
app.engine.VOICES. Run with HF_HOME set to the app's own folder.
"""

import os
import sys

from huggingface_hub import snapshot_download

from app.engine import LANGUAGES, VOICES

if not os.environ.get("HF_HOME"):
    sys.exit("Set HF_HOME to the folder to fill.")

for language in LANGUAGES.values():
    voices = [f"voices/{voice.id}.pt" for voice in VOICES if voice.language == language.id]
    path = snapshot_download(language.model, allow_patterns=["config.json", "*.pth", *voices])
    print(f"{language.id}: {language.model}, {len(voices)} voices -> {path}")
