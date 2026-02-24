import json

import frappe
from frappe.gettext.translate import get_pot_path, get_locales, get_catalog, get_po_path

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
