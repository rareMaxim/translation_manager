import re

import frappe
from frappe import _
from frappe.gettext.translate import get_catalog, get_po_path, write_catalog

from translation_manager.utils.backup_manager import backup_po_file


def _extract_placeholders(text):
    """Extract formatting placeholders like {0}, %s, %(name)s from text.
    Returns (clean_text_with_tokens, placeholder_map)
    so we can restore them after translation.
    """
    pattern = re.compile(r"(%[sdrfx]|%\([a-zA-Z0-9_]+\)[sdrfx]|\{[a-zA-Z0-9_]*\})")
    placeholders = {}
    counter = [0]

    def replace(match):
        token = f"__PH{counter[0]}__"
        placeholders[token] = match.group(0)
        counter[0] += 1
        return token

    clean = pattern.sub(replace, text)
    return clean, placeholders


def _restore_placeholders(text, placeholders):
    """Restore extracted placeholders back into translated text."""
    for token, original in placeholders.items():
        text = text.replace(token, original)
    return text


def _translate_batch(texts, target_lang, source_lang="en"):
    """Translate a batch of texts using GoogleTranslator (free, no API key needed)."""
    from deep_translator import GoogleTranslator

    # deep-translator uses 2-letter language codes (or 'auto'), and some variants
    translator = GoogleTranslator(source=source_lang, target=target_lang)

    results = []
    for text in texts:
        if not text or not text.strip():
            results.append(text)
            continue

        clean, placeholders = _extract_placeholders(text)
        try:
            translated = translator.translate(clean)
            translated = _restore_placeholders(translated or clean, placeholders)
        except Exception:
            # On any error, fall through to original text
            translated = text

        results.append(translated)

    return results


@frappe.whitelist()
def auto_translate(app, language, mode="untranslated", msgids=None):
    """Translate PO strings automatically using Google Translate (free).

    Args:
        app: App name
        language: Target language code (e.g., 'uk', 'de')
        mode: 'untranslated' - only empty strings; 'fuzzy' - only fuzzy; 'all' - everything
        msgids: Optional list of specific msgids to translate (JSON string or list)
    """
    import json

    if isinstance(msgids, str):
        msgids = json.loads(msgids)

    po_path = get_po_path(app, language)
    if not po_path.exists():
        frappe.throw(_("PO file not found for this language"))

    catalog = get_catalog(app, language)

    # Determine target lang code (Frappe uses 'uk', deep-translator also does)
    target_lang = language.split("-")[0]  # 'uk-UA' -> 'uk'

    # Collect entries to translate
    to_translate = []
    for message in catalog:
        if not message.id:
            continue
        msgid = message.id[0] if isinstance(message.id, tuple) else message.id

        if msgids and msgid not in msgids:
            continue

        if mode == "untranslated":
            msgstr = message.string[0] if isinstance(message.string, tuple) else (message.string or "")
            if msgstr and msgstr.strip():
                continue  # already translated
        elif mode == "fuzzy":
            if "fuzzy" not in message.flags:
                continue

        to_translate.append(message)

    if not to_translate:
        return {"success": True, "translated": 0, "skipped": 0}

    # Create backup
    backup_po_file(app, language)

    # Translate in batches of 50 to avoid rate limits
    batch_size = 50
    translated_count = 0
    errors = []

    for i in range(0, len(to_translate), batch_size):
        batch = to_translate[i:i + batch_size]
        source_texts = []
        for msg in batch:
            msgid = msg.id[0] if isinstance(msg.id, tuple) else msg.id
            source_texts.append(msgid)

        try:
            translated_texts = _translate_batch(source_texts, target_lang)
        except Exception as e:
            errors.append(str(e))
            continue

        for msg, translated_text in zip(batch, translated_texts):
            if translated_text:
                msg.string = translated_text
                # Remove fuzzy flag since we just (re-)translated it
                if "fuzzy" in msg.flags:
                    msg.flags.discard("fuzzy")
                translated_count += 1

    write_catalog(app, catalog, language)
    frappe.cache().delete_value(["bootinfo", "lang_user_translations", "merged_translations"])

    return {
        "success": True,
        "translated": translated_count,
        "skipped": len(to_translate) - translated_count,
        "errors": errors[:5] if errors else []
    }
