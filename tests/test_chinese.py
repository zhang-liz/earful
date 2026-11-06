"""Reading Chinese: finding the language, cutting the text, and the voices."""

import re

from app import engine as eng
from app import server

NEWS = "今天上午，北京市政府召开新闻发布会，介绍了今年城市绿化工作的最新进展。"


def test_the_language_of_a_text_is_found_from_its_letters():
    assert eng.detect_language("今天天气很好。") == "zh"
    assert eng.detect_language("Hello there, how are you?") == "en"
    # English words inside Chinese stay Chinese, a Chinese name inside English stays English.
    assert eng.detect_language("苹果公司发布了新款 iPhone，搭载最新的 AI 芯片。") == "zh"
    assert eng.detect_language("We met 王小明 at the station this morning.") == "en"
    # Traditional characters are Chinese too.
    assert eng.detect_language("我們今天去台北看展覽。") == "zh"
    assert eng.detect_language("---") == "en"


def test_a_long_chinese_paragraph_is_cut_without_losing_or_adding_a_character():
    paragraph = NEWS * 40                       # about 1,400 characters, no spaces
    parts = eng.chunk(paragraph)
    assert len(parts) > 1
    assert all(len(p) <= eng.MAX_CHUNK_CHARS for p in parts)
    assert "".join(parts) == paragraph
    assert all(p.endswith("。") for p in parts), "cut at sentence ends"


def test_a_chinese_sentence_with_no_end_is_still_cut():
    commas = "，".join(["这是一段没有句号的很长的话"] * 120)   # only commas
    bare = "字" * 2000                                      # no punctuation at all
    for text in (commas, bare):
        parts = eng.chunk(text)
        assert all(len(p) <= eng.MAX_CHUNK_CHARS for p in parts)
        assert "".join(parts) == text


def test_english_text_is_cut_as_before():
    text = "One sentence here. " * 80
    parts = eng.chunk(text)
    assert all(len(p) <= eng.MAX_CHUNK_CHARS for p in parts)
    assert " ".join(parts) == text.strip()


def test_chinese_audio_is_never_cut_short(zh_calls):
    text = NEWS * 60                            # 2,000+ characters in one part
    segments = list(eng.engine.stream(text, voice="zf_044"))
    assert zh_calls, "the Chinese path should be used"
    assert all(len(c["phonemes"]) <= eng.MAX_PHONEMES for c in zh_calls)
    sent = "".join(c["phonemes"] for c in zh_calls)
    han = len(re.findall(r"[一-鿿]", text))
    assert sent.count("ab") == han, "every character reaches the voice"
    assert sum(len(s.audio) for s in segments) > han * 2 * 600


def test_chinese_words_are_timed_in_order():
    segment = next(eng.engine.stream("苹果公司发布了新款 iPhone。", voice="zf_044"))
    texts = [w.text for w in segment.words]
    assert texts[:2] == ["苹", "果"]
    assert "iPhone" in texts, "English inside Chinese is kept"
    assert "。" not in texts, "punctuation is not a word"
    starts = [w.start for w in segment.words]
    assert starts == sorted(starts)
    assert all(w.end > w.start for w in segment.words)
    assert segment.words[-1].end <= len(segment.audio) / eng.SAMPLE_RATE + 1e-6


def test_every_voice_has_a_label_in_every_screen_language():
    languages = set(eng.LANGUAGES)
    for voice in eng.VOICES:
        assert voice.language in languages
        assert set(voice.labels) == languages, voice.id
        assert all(voice.labels.values()), voice.id
    for language in eng.LANGUAGES.values():
        assert eng.voice_language(language.default_voice) == language.id


def test_voices_lists_languages_and_keeps_what_old_apps_read(client):
    data = client.get("/voices").json()
    assert data["default"] == "af_heart"
    assert {lang["id"] for lang in data["languages"]} == {"en", "zh"}
    zh = next(lang for lang in data["languages"] if lang["id"] == "zh")
    assert zh["name"] == "中文" and zh["default"].startswith("z")
    heart = next(v for v in data["voices"] if v["id"] == "af_heart")
    assert heart["label"] and heart["accent"] == "US" and heart["language"] == "en"
    assert any(v["language"] == "zh" for v in data["voices"])


def test_an_old_app_reading_chinese_gets_a_mandarin_voice(zh_calls, client, finished):
    job = client.post("/speak", json={"text": "Hello there.\n\n" + NEWS, "voice": "af_heart"}).json()
    finished(client, job["id"])
    assert zh_calls and all(c["voice"] == eng.LANGUAGES["zh"].default_voice for c in zh_calls)
    words = client.get(f"/words/{job['id']}/1").json()["words"]
    assert words and words[0]["t"] == "今"


def test_the_chosen_chinese_voice_is_used(zh_calls, client, finished):
    job = client.post("/speak", json={"text": NEWS, "voices": {"en": "bm_george", "zh": "zm_064"}}).json()
    progress = finished(client, job["id"])
    assert progress["state"] == "ready"
    assert {c["voice"] for c in zh_calls} == {"zm_064"}
    assert progress["voices"] == {"en": "bm_george", "zh": "zm_064"}


def test_the_reading_language_can_be_forced(zh_calls, client, finished):
    job = client.post("/speak", json={"text": NEWS, "language": "en"}).json()
    finished(client, job["id"])
    assert not zh_calls


def test_a_voice_in_the_wrong_language_slot_is_refused(client):
    response = client.post("/speak", json={"text": NEWS, "voices": {"zh": "af_heart"}})
    assert response.status_code == 400
    assert response.json()["code"] == "unknown_voice"
    response = client.post("/speak", json={"text": NEWS, "language": "fr"})
    assert response.json()["code"] == "unknown_language"


def test_errors_carry_a_code_for_the_apps_to_translate(client):
    assert client.post("/speak", json={"text": "  "}).json()["code"] == "no_text"
    unknown = client.post("/speak", json={"text": "Hi.", "voice": "nobody"}).json()
    assert unknown["code"] == "unknown_voice" and "nobody" in unknown["detail"]
    assert client.get("/progress-once/nope").json()["code"] == "unknown_job"


def test_changing_the_chinese_voice_keeps_the_english_parts(zh_calls, client, finished, monkeypatch):
    job = client.post("/speak", json={"text": "Hello there.\n\n" + NEWS}).json()
    finished(client, job["id"])
    english_calls = []
    real = server.engine.pipeline

    def counting(lang):
        english_calls.append(lang)
        return real(lang)

    monkeypatch.setattr(server.engine, "pipeline", counting)
    zh_calls.clear()
    changed = client.post(f"/voice/{job['id']}", json={"voices": {"zh": "zf_092"}}).json()
    assert changed["changed"] is True
    progress = finished(client, job["id"])
    assert progress["state"] == "ready" and progress["done"] == 2
    assert {c["voice"] for c in zh_calls} == {"zf_092"}
    assert not english_calls, "the English part keeps its audio"


def test_a_chinese_voice_preview_speaks_chinese(zh_calls, client):
    response = client.post("/preview", json={"text": "This is how I sound.", "voice": "zf_044"})
    assert response.status_code == 200
    assert zh_calls, "a Chinese voice says a Chinese sample"


def test_a_long_chinese_run_with_no_marks_is_read_in_full(zh_calls):
    text = "字" * 700
    list(eng.engine.stream(text, voice="zf_044"))
    assert all(len(c["phonemes"]) <= eng.MAX_PHONEMES for c in zh_calls)
    assert "".join(c["phonemes"] for c in zh_calls).count("ab") == 700


def test_a_chinese_part_with_no_words_is_quiet_not_broken(client, finished):
    job = client.post("/speak", json={"text": "今天天气很好。\n\n。。。！！"}).json()
    assert finished(client, job["id"])["state"] == "ready"
