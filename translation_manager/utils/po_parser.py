import io
import os
import json
import shutil
from pathlib import Path

import frappe
from frappe import _
from babel.messages import pofile
from babel.messages.pofile import read_po
from frappe.gettext.translate import (
    get_catalog,
    get_po_path,
    get_pot_path,
    write_catalog,
    generate_pot as _generate_pot,
    new_po as _new_po,
    update_po
)

from translation_manager.utils.backup_manager import backup_po_file
from translation_manager.utils.mo_compiler import compile_mo
from translation_manager.utils.tm_manager import update_tm_entry

def update_catalog_metadata(catalog):
    """Update catalog metadata from Translation Manager Settings"""
    from datetime import datetime

    settings = frappe.get_single("Translation Manager Settings")

    # Update Last-Translator
    if settings.translator_name or settings.translator_email:
        translator = settings.translator_name or ""
        if settings.translator_email:
            translator = f"{translator} <{settings.translator_email}>" if translator else settings.translator_email
        if translator:
            catalog.last_translator = translator

    # Update Language-Team
    if settings.language_team_name or settings.translation_team_email:
        team = settings.language_team_name or ""
        if settings.translation_team_email:
            team = f"{team} <{settings.translation_team_email}>" if team else settings.translation_team_email
        if team:
            catalog.language_team = team

    # Update PO-Revision-Date
    catalog.revision_date = datetime.now()

    return catalog

@frappe.whitelist()
def generate_pot(app):
    """Generate POT file for an app by extracting translatable strings"""
    _generate_pot(app)
    pot_path = get_pot_path(app)
    return {"success": True, "path": str(pot_path)}

@frappe.whitelist()
def create_po_file(app, language):
    """Create a new PO file for an app and language from POT template"""
    pot_path = get_pot_path(app)
    po_path = get_po_path(app, language)

    if not pot_path.exists():
        frappe.throw(_("POT file not found. Please generate it first."))

    if po_path.exists():
        frappe.throw(_("PO file already exists for this language."))

    _new_po(language, app)
    return {"success": True, "path": str(po_path)}

@frappe.whitelist()
def get_translation_stats(app, language):
    """Get translation statistics for an app and language"""
    pot_path = get_pot_path(app)
    po_path = get_po_path(app, language)

    total = 0
    translated = 0
    fuzzy = 0

    if pot_path.exists():
        pot_catalog = get_catalog(app)
        total = len([m for m in pot_catalog if m.id])

    if po_path.exists():
        po_catalog = get_catalog(app, language)
        translated = len([m for m in po_catalog if m.id and m.string])
        fuzzy = len([m for m in po_catalog if m.fuzzy and m.id])

    return {
        "total": total,
        "translated": translated,
        "fuzzy": fuzzy,
        "untranslated": total - translated,
        "progress": round((translated / total * 100) if total > 0 else 0, 1)
    }

@frappe.whitelist()
def get_po_entries(app, language):
    """Get all PO entries for an app and language"""
    app_path = Path(frappe.get_app_path(app))
    po_path = app_path / "locale" / f"{language}.po"

    if not po_path.exists():
        frappe.throw(f"PO file not found for {app} in {language}")

    with open(po_path, "rb") as f:
        catalog = pofile.read_po(f, locale=language)

    entries = []
    for message in catalog:
        if message.id:  # Skip header
            msgid = message.id[0] if isinstance(message.id, tuple) else message.id
            msgstr = message.string[0] if isinstance(message.string, tuple) else (message.string or "")
            
            entries.append({
                "msgid": msgid,
                "msgstr": msgstr,
                "fuzzy": "fuzzy" in message.flags,
                "locations": [f"{loc[0]}:{loc[1]}" for loc in (message.locations or [])],
                "context": message.context or "",
                "comments": "\\n".join(message.user_comments) if message.user_comments else "",
                "auto_comments": "\\n".join(message.auto_comments) if message.auto_comments else "",
                "flags": list(message.flags) if message.flags else []
            })

    return {
        "entries": entries
    }

@frappe.whitelist()
def save_translations_batch(app, language, translations):
    """Save multiple translations at once using babel
    Automatically creates backup before saving.
    """
    if isinstance(translations, str):
        translations = json.loads(translations)

    po_path = get_po_path(app, language)

    backup_path = None
    if po_path.exists():
        backup_path = backup_po_file(app, language)
    else:
        create_po_file(app, language)

    catalog = get_catalog(app, language)

    for t in translations:
        msgid = t.get("msgid")
        msgstr = t.get("msgstr", "")
        fuzzy = t.get("fuzzy", False)

        if msgid in catalog:
            message = catalog.get(msgid)
            message.string = msgstr
            # Fuzzy flag handling can be added if needed

    update_catalog_metadata(catalog)
    write_catalog(app, catalog, language)

    # Update Translation Memory (Frappe's Translation DocType)
    for t in translations:
        msgstr = t.get("msgstr")
        if msgstr:
            update_tm_entry(t.get("msgid"), msgstr, language)

    frappe.cache().delete_value(["bootinfo", "lang_user_translations", "merged_translations"])
    
    mo_result = compile_mo(app, language)

    return {
        "success": True,
        "saved": len(translations),
        "backup": str(backup_path) if backup_path else None,
        "mo_compiled": mo_result.get("success", False) if mo_result else False
    }

@frappe.whitelist()
def export_po(app, language):
    """Export PO file content"""
    po_path = get_po_path(app, language)

    if not po_path.exists():
        frappe.throw(_("PO file not found"))

    with open(po_path, "r", encoding="utf-8") as f:
        content = f.read()

    return {
        "filename": f"{app}-{language}.po",
        "content": content
    }

@frappe.whitelist()
def import_po(app, language, content):
    """Import PO file content"""
    po_path = get_po_path(app, language)

    try:
        catalog = read_po(io.BytesIO(content.encode("utf-8")))
    except Exception as e:
        frappe.throw(_("Invalid PO file: {0}").format(str(e)))

    po_path.parent.mkdir(parents=True, exist_ok=True)

    with open(po_path, "w", encoding="utf-8") as f:
        f.write(content)

    frappe.cache().delete_value(["bootinfo", "lang_user_translations", "merged_translations"])

    return {"success": True, "path": str(po_path)}

@frappe.whitelist()
def search_translations(app, language, search_text, untranslated_only=False):
    """Search translations by source or translated text"""
    pot_path = get_pot_path(app)
    po_path = get_po_path(app, language)

    results = []
    search_lower = search_text.lower()

    pot_entries = {}
    if pot_path.exists():
        pot_catalog = get_catalog(app)
        for message in pot_catalog:
            if message.id:
                locations = [f"{loc[0]}:{loc[1]}" for loc in message.locations]
                pot_entries[message.id] = {
                    "references": locations,
                    "comment": "\\n".join(message.auto_comments) if message.auto_comments else ""
                }

    po_translations = {}
    if po_path.exists():
        po_catalog = get_catalog(app, language)
        for message in po_catalog:
            if message.id:
                po_translations[message.id] = {
                    "msgstr": message.string,
                    "fuzzy": message.fuzzy
                }

    for msgid, pot_data in pot_entries.items():
        msgstr = po_translations.get(msgid, {}).get("msgstr", "")
        fuzzy = po_translations.get(msgid, {}).get("fuzzy", False)

        if untranslated_only and msgstr:
            continue

        if search_lower in msgid.lower() or search_lower in (msgstr or "").lower():
            results.append({
                "msgid": msgid,
                "msgstr": msgstr,
                "fuzzy": fuzzy,
                "references": pot_data["references"],
                "comment": pot_data["comment"]
            })

    return results[:100]

@frappe.whitelist()
def update_po_from_pot(app, language=None):
    """Update PO file(s) from POT template - adds new strings, keeps existing translations"""
    update_po(app, language)
    return {"success": True}

@frappe.whitelist()
def copy_po_to_app(source_app, target_app, language):
    """Copy PO file from source app to target app"""
    source_path = get_po_path(source_app, language)
    target_path = get_po_path(target_app, language)

    if not source_path.exists():
        frappe.throw(_("Source PO file not found: {0}").format(source_path))

    if target_path.exists():
        backup_po_file(target_app, language)

    target_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_path, target_path)

    frappe.cache().delete_value(["bootinfo", "lang_user_translations", "merged_translations"])

    return {"success": True, "source": str(source_path), "target": str(target_path)}

@frappe.whitelist()
def export_csv(app, language):
    """Export PO file content as CSV"""
    import csv

    po_path = get_po_path(app, language)

    if not po_path.exists():
        frappe.throw(_("PO file not found"))

    with open(po_path, "rb") as f:
        catalog = pofile.read_po(f, locale=language)

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Source", "Translation", "Fuzzy", "Context"])

    for message in catalog:
        if message.id:
            msgid = message.id[0] if isinstance(message.id, tuple) else message.id
            msgstr = message.string[0] if isinstance(message.string, tuple) else (message.string or "")
            fuzzy = "Yes" if "fuzzy" in message.flags else "No"
            context = message.context or ""
            
            writer.writerow([msgid, msgstr, fuzzy, context])

    return {
        "filename": f"{app}-{language}.csv",
        "content": output.getvalue()
    }

@frappe.whitelist()
def import_csv(app, language, content):
    """Import CSV file content to PO"""
    import csv

    po_path = get_po_path(app, language)

    if not po_path.exists():
        frappe.throw(_("PO file not found"))

    # backup first
    backup_po_file(app, language)

    with open(po_path, "rb") as f:
        catalog = pofile.read_po(f, locale=language)

    # parse CSV
    input_file = io.StringIO(content)
    reader = csv.reader(input_file)
    headers = next(reader, None) # skip headers

    updated = 0
    for row in reader:
        if len(row) >= 2:
            msgid = row[0]
            msgstr = row[1]
            fuzzy = row[2].lower() == "yes" if len(row) > 2 else False
            context = row[3] if len(row) > 3 else None

            if msgid in catalog:
                message = catalog.get(msgid, context=context)
                if message:
                    message.string = msgstr
                    if fuzzy and "fuzzy" not in message.flags:
                        message.flags.append("fuzzy")
                    elif not fuzzy and "fuzzy" in message.flags:
                        message.flags.remove("fuzzy")
                    updated += 1

    update_catalog_metadata(catalog)
    write_catalog(app, catalog, language)

    frappe.cache().delete_value(["bootinfo", "lang_user_translations", "merged_translations"])
    
    return {"success": True, "updated": updated}
