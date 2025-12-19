# Copyright (c) 2024, Maxim S and contributors
# For license information, please see license.txt

import json
from pathlib import Path
import frappe
from frappe import _
from frappe.gettext.translate import (
    get_catalog,
    get_po_path,
    get_pot_path,
    get_locales,
    write_catalog,
    new_catalog,
    write_binary,
    generate_pot as _generate_pot,
    new_po as _new_po,
)


def get_backup_dir():
    """Get path to backup directory"""
    return Path(frappe.get_app_path("translation_manager")) / "backups"


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


def backup_po_file(app, language):
    """Create a backup of PO file before modifying

    Backups are stored in translation_manager/backups/{app}/{language}/
    with timestamp in filename
    """
    import shutil
    from datetime import datetime

    po_path = get_po_path(app, language)
    if not po_path.exists():
        return None

    backup_dir = get_backup_dir() / app / language
    backup_dir.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = backup_dir / f"{language}_{timestamp}.po"

    shutil.copy2(po_path, backup_path)

    # Keep only last 10 backups
    backups = sorted(backup_dir.glob("*.po"),
                     key=lambda p: p.stat().st_mtime, reverse=True)
    for old_backup in backups[10:]:
        old_backup.unlink()

    return backup_path


@frappe.whitelist()
def get_installed_apps():
    """Get list of installed apps with their locale info"""
    apps = frappe.get_installed_apps(_ensure_on_bench=True)
    result = []

    for app in apps:
        app_info = {
            "app_name": app,
            "app_title": get_app_title(app),
            "has_pot": get_pot_path(app).exists(),
            "languages": get_locales(app)
        }
        result.append(app_info)

    return result


@frappe.whitelist()
def get_app_title(app):
    """Get app title from hooks"""
    try:
        return frappe.get_hooks("app_title", app_name=app)[0]
    except (IndexError, KeyError):
        return app.replace("_", " ").title()


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
    """Get all PO entries for an app and language, including plural forms"""
    from babel.messages import pofile
    from pathlib import Path

    app_path = Path(frappe.get_app_path(app))
    po_path = app_path / "locale" / f"{language}.po"

    if not po_path.exists():
        frappe.throw(f"PO file not found for {app} in {language}")

    with open(po_path, "rb") as f:
        catalog = pofile.read_po(f, locale=language)

    # Get plural forms info from catalog
    plural_forms = None
    num_plurals = 2  # Default
    if catalog.num_plurals:
        num_plurals = catalog.num_plurals
    if catalog.plural_expr:
        plural_forms = f"nplurals={num_plurals}; plural={catalog.plural_expr};"

    entries = []
    for message in catalog:
        if message.id:  # Skip header
            # Check if this is a plural message
            is_plural = message.pluralizable

            if is_plural:
                # For plural messages, message.id is singular, message.string is tuple
                msgstr_list = list(message.string) if isinstance(message.string, tuple) else [message.string or ""] * num_plurals
                # Ensure we have the right number of plural forms
                while len(msgstr_list) < num_plurals:
                    msgstr_list.append("")

                entries.append({
                    "msgid": message.id[0] if isinstance(message.id, tuple) else message.id,
                    "msgid_plural": message.id[1] if isinstance(message.id, tuple) else None,
                    "msgstr": msgstr_list,
                    "is_plural": True,
                    "fuzzy": "fuzzy" in message.flags,
                    "locations": [f"{loc[0]}:{loc[1]}" for loc in (message.locations or [])],
                    "context": message.context or "",
                    "comments": "\n".join(message.user_comments) if message.user_comments else "",
                    "auto_comments": "\n".join(message.auto_comments) if message.auto_comments else "",
                    "flags": list(message.flags) if message.flags else []
                })
            else:
                entries.append({
                    "msgid": message.id,
                    "msgid_plural": None,
                    "msgstr": message.string or "",
                    "is_plural": False,
                    "fuzzy": "fuzzy" in message.flags,
                    "locations": [f"{loc[0]}:{loc[1]}" for loc in (message.locations or [])],
                    "context": message.context or "",
                    "comments": "\n".join(message.user_comments) if message.user_comments else "",
                    "auto_comments": "\n".join(message.auto_comments) if message.auto_comments else "",
                    "flags": list(message.flags) if message.flags else []
                })

    return {
        "entries": entries,
        "plural_forms": plural_forms,
        "num_plurals": num_plurals
    }


@frappe.whitelist()
def save_translations_batch(app, language, translations):
    """Save multiple translations at once using babel

    Automatically creates backup before saving.

    Args:
            app: App name
            language: Language code
            translations: List of translation dicts with msgid, msgstr, fuzzy, is_plural, msgid_plural
    """
    if isinstance(translations, str):
        translations = json.loads(translations)

    po_path = get_po_path(app, language)

    # Create backup before modifying
    backup_path = None
    if po_path.exists():
        backup_path = backup_po_file(app, language)

    if not po_path.exists():
        create_po_file(app, language)

    catalog = get_catalog(app, language)

    for t in translations:
        msgid = t.get("msgid")
        msgstr = t.get("msgstr", "")
        is_plural = t.get("is_plural", False)
        msgid_plural = t.get("msgid_plural")
        fuzzy = t.get("fuzzy", False)

        if is_plural and msgid_plural:
            # Handle plural forms - msgid is tuple (singular, plural)
            plural_id = (msgid, msgid_plural)
            if plural_id in catalog:
                message = catalog.get(plural_id)
                # msgstr should be a list for plurals
                if isinstance(msgstr, list):
                    message.string = tuple(msgstr)
                else:
                    message.string = (msgstr,)
        else:
            # Regular singular message
            if msgid in catalog:
                message = catalog.get(msgid)
                message.string = msgstr
                # if fuzzy and "fuzzy" not in message.flags:
                # 	message.flags.append("fuzzy")
                # elif not fuzzy and "fuzzy" in message.flags:
                # 	message.flags.remove("fuzzy")

    # Update catalog metadata from settings
    update_catalog_metadata(catalog)

    write_catalog(app, catalog, language)

    # Clear translation cache
    frappe.cache.delete_value(
        ["bootinfo", "lang_user_translations", "merged_translations"])

    # Compile MO file automatically after saving
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
    from babel.messages.pofile import read_po
    import io

    po_path = get_po_path(app, language)

    # Validate PO content
    try:
        catalog = read_po(io.BytesIO(content.encode("utf-8")))
    except Exception as e:
        frappe.throw(_("Invalid PO file: {0}").format(str(e)))

    # Create directory if needed
    po_path.parent.mkdir(parents=True, exist_ok=True)

    # Save to file
    with open(po_path, "w", encoding="utf-8") as f:
        f.write(content)

    # Clear translation cache
    frappe.cache.delete_value(
        ["bootinfo", "lang_user_translations", "merged_translations"])

    return {"success": True, "path": str(po_path)}


@frappe.whitelist()
def compile_mo(app, language):
    """Compile PO file to MO file using babel

    Handles plural forms by converting them to singular for Frappe compatibility.
    Also copies the MO file to the assets directory where Frappe expects it.
    """
    from babel.messages import mofile, pofile
    from pathlib import Path
    import shutil

    app_path = Path(frappe.get_app_path(app))
    po_path = app_path / "locale" / f"{language}.po"
    mo_path = app_path / "locale" / f"{language}.mo"

    if not po_path.exists():
        frappe.throw(_("PO file not found"))

    # Read PO file
    with open(po_path, "rb") as f:
        catalog = pofile.read_po(f, locale=language)

    # Check if catalog has plural forms that Frappe can't handle
    has_plurals = any(m.pluralizable for m in catalog if m.id)

    if has_plurals:
        # Convert plural forms to singular for Frappe compatibility
        # We modify the catalog in place by replacing plural messages
        messages_to_update = []
        for message in catalog:
            if message.id and message.pluralizable:
                # Get the plural msgid and last translation form
                msgid_plural = message.id[1] if isinstance(message.id, tuple) else message.id
                msgstr = ""
                if isinstance(message.string, tuple) and len(message.string) > 0:
                    msgstr = message.string[-1] if message.string[-1] else ""
                messages_to_update.append({
                    'old_id': message.id,
                    'new_id': msgid_plural,
                    'string': msgstr,
                    'locations': message.locations,
                    'auto_comments': message.auto_comments,
                    'user_comments': message.user_comments,
                })

        # Remove old plural messages and add new singular ones
        for msg_data in messages_to_update:
            if msg_data['old_id'] in catalog:
                del catalog[msg_data['old_id']]
            # Only add if not already exists
            if msg_data['new_id'] not in catalog:
                catalog.add(
                    id=msg_data['new_id'],
                    string=msg_data['string'],
                    locations=msg_data['locations'],
                    auto_comments=msg_data['auto_comments'],
                    user_comments=msg_data['user_comments'],
                )

    # Write MO file to app locale directory
    with open(mo_path, "wb") as f:
        mofile.write_mo(f, catalog)

    # Also copy to assets directory where Frappe looks for translations
    # frappe.get_app_path("frappe") returns /bench/apps/frappe/frappe, so .parent.parent.parent gives /bench
    bench_path = Path(frappe.get_app_path("frappe")).parent.parent.parent
    assets_mo_dir = bench_path / "sites" / "assets" / "locale" / language.replace("-", "_") / "LC_MESSAGES"
    assets_mo_path = assets_mo_dir / f"{app}.mo"

    # Create directory if it doesn't exist
    assets_mo_dir.mkdir(parents=True, exist_ok=True)

    # Copy MO file to assets
    shutil.copy2(mo_path, assets_mo_path)

    # Clear all translation caches to ensure changes take effect
    frappe.cache.delete_value(["bootinfo", "lang_user_translations", "merged_translations"])
    # Clear the specific language cache key
    frappe.cache.hdel("merged_translations", language)
    frappe.cache.hdel("merged_translations", language.replace("-", "_"))

    return {"success": True, "path": str(mo_path), "assets_path": str(assets_mo_path)}


@frappe.whitelist()
def copy_po_to_app(source_app, target_app, language):
    """Copy PO file from source app to target app

    This allows you to maintain translations in a separate app (like translation_manager)
    and then copy them to the original app when needed.
    """
    import shutil

    source_path = get_po_path(source_app, language)
    target_path = get_po_path(target_app, language)

    if not source_path.exists():
        frappe.throw(_("Source PO file not found: {0}").format(source_path))

    # Backup target if exists
    if target_path.exists():
        backup_po_file(target_app, language)

    # Create target directory if needed
    target_path.parent.mkdir(parents=True, exist_ok=True)

    # Copy file
    shutil.copy2(source_path, target_path)

    # Clear cache
    frappe.cache.delete_value(
        ["bootinfo", "lang_user_translations", "merged_translations"])

    return {"success": True, "source": str(source_path), "target": str(target_path)}


@frappe.whitelist()
def get_backups(app, language):
    """Get list of available backups for an app/language"""
    backup_dir = get_backup_dir() / app / language

    if not backup_dir.exists():
        return []

    backups = []
    for backup_file in sorted(backup_dir.glob("*.po"), key=lambda p: p.stat().st_mtime, reverse=True):
        stat = backup_file.stat()
        backups.append({
            "filename": backup_file.name,
            "path": str(backup_file),
            "size": stat.st_size,
            "modified": stat.st_mtime
        })

    return backups


@frappe.whitelist()
def restore_backup(app, language, backup_filename):
    """Restore a backup file"""
    import shutil

    backup_dir = get_backup_dir() / app / language
    backup_path = backup_dir / backup_filename

    if not backup_path.exists():
        frappe.throw(_("Backup file not found"))

    target_path = get_po_path(app, language)

    # Create backup of current file before restoring
    if target_path.exists():
        backup_po_file(app, language)

    # Restore
    target_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(backup_path, target_path)

    # Clear cache
    frappe.cache.delete_value(
        ["bootinfo", "lang_user_translations", "merged_translations"])

    return {"success": True, "restored": str(backup_path)}


@frappe.whitelist()
def search_translations(app, language, search_text, untranslated_only=False):
    """Search translations by source or translated text"""
    pot_path = get_pot_path(app)
    po_path = get_po_path(app, language)

    results = []
    search_lower = search_text.lower()

    # Load POT for source strings
    pot_entries = {}
    if pot_path.exists():
        pot_catalog = get_catalog(app)
        for message in pot_catalog:
            if message.id:
                locations = [f"{loc[0]}:{loc[1]}" for loc in message.locations]
                pot_entries[message.id] = {
                    "references": locations,
                    "comment": "\n".join(message.auto_comments) if message.auto_comments else ""
                }

    # Load PO for translations
    po_translations = {}
    if po_path.exists():
        po_catalog = get_catalog(app, language)
        for message in po_catalog:
            if message.id:
                po_translations[message.id] = {
                    "msgstr": message.string,
                    "fuzzy": message.fuzzy
                }

    # Search
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

    return results[:100]  # Limit results


@frappe.whitelist()
def update_po_from_pot(app, language=None):
    """Update PO file(s) from POT template - adds new strings, keeps existing translations"""
    from frappe.gettext.translate import update_po
    update_po(app, language)
    return {"success": True}


@frappe.whitelist()
def get_reference_translations(app, msgids, reference_languages):
    """Get translations from reference languages for given msgids"""
    if isinstance(msgids, str):
        msgids = json.loads(msgids)
    if isinstance(reference_languages, str):
        reference_languages = json.loads(reference_languages)

    result = {}

    for lang in reference_languages:
        po_path = get_po_path(app, lang)
        if not po_path.exists():
            continue

        catalog = get_catalog(app, lang)
        lang_translations = {}

        for msgid in msgids:
            if msgid in catalog:
                message = catalog.get(msgid)
                if message.string:
                    lang_translations[msgid] = message.string

        if lang_translations:
            result[lang] = lang_translations

    return result


@frappe.whitelist()
def get_reference_languages_settings():
    """Get reference languages from Translation Manager Settings"""
    settings = frappe.get_single("Translation Manager Settings")
    return [row.language for row in settings.reference_languages]


@frappe.whitelist()
def save_reference_languages_settings(languages):
    """Save reference languages to Translation Manager Settings"""
    if isinstance(languages, str):
        languages = json.loads(languages)

    settings = frappe.get_single("Translation Manager Settings")
    settings.reference_languages = []
    for lang in languages:
        settings.append("reference_languages", {"language": lang})
    settings.save()

    return {"success": True}


@frappe.whitelist()
def convert_to_plural(app, language, msgid, msgid_singular, msgid_plural, msgstr_forms):
    """Convert a singular entry to plural form in PO file

    Args:
        app: App name
        language: Language code
        msgid: Original msgid (the one being replaced)
        msgid_singular: New singular form (e.g., "1 row")
        msgid_plural: New plural form (e.g., "{0} rows")
        msgstr_forms: List of translated plural forms
    """
    from babel.messages import pofile
    from pathlib import Path

    if isinstance(msgstr_forms, str):
        msgstr_forms = json.loads(msgstr_forms)

    app_path = Path(frappe.get_app_path(app))
    po_path = app_path / "locale" / f"{language}.po"

    if not po_path.exists():
        frappe.throw(f"PO file not found for {app} in {language}")

    # Create backup before modifying
    backup_po_file(app, language)

    # Read catalog
    with open(po_path, "rb") as f:
        catalog = pofile.read_po(f, locale=language)

    # Find and remove the old singular entry
    old_message = None
    for message in catalog:
        if message.id == msgid:
            old_message = message
            break

    if not old_message:
        frappe.throw(f"Message not found: {msgid}")

    # Get locations and comments from old message
    locations = old_message.locations
    auto_comments = old_message.auto_comments
    user_comments = old_message.user_comments
    flags = set(old_message.flags) - {"fuzzy"}  # Remove fuzzy flag

    # Delete the old message
    if msgid in catalog:
        del catalog[msgid]

    # Add new plural message
    catalog.add(
        id=(msgid_singular, msgid_plural),
        string=tuple(msgstr_forms),
        locations=locations,
        auto_comments=auto_comments,
        user_comments=user_comments,
        flags=flags
    )

    # Update catalog metadata
    update_catalog_metadata(catalog)

    # Write catalog back
    with open(po_path, "wb") as f:
        pofile.write_po(f, catalog, sort_output=False, sort_by_file=False)

    # Clear translation cache
    frappe.cache.delete_value(
        ["bootinfo", "lang_user_translations", "merged_translations"])

    # Compile MO file automatically
    mo_result = compile_mo(app, language)

    return {
        "success": True,
        "msgid_singular": msgid_singular,
        "msgid_plural": msgid_plural,
        "mo_compiled": mo_result.get("success", False) if mo_result else False
    }
