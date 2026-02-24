import frappe
from frappe import _

@frappe.whitelist()
def get_tm_suggestions(msgids, language):
    """
    Get translation suggestions from Frappe's standard 'Translation' DocType.
    
    Args:
        msgids: List of source strings or a JSON string.
        language: Target language code.
    """
    import json
    if isinstance(msgids, str) and msgids:
        try:
            msgids = json.loads(msgids)
        except ValueError:
            # Handle cases where it's not a valid JSON string
            pass
    
    if not msgids or not isinstance(msgids, list):
        return {}

    # Query Frappe's Translation DocType
    translations = frappe.get_all(
        "Translation",
        filters={
            "language": language,
            "source_text": ["in", msgids]
        },
        fields=["source_text", "translated_text"]
    )

    # Convert to mapping {source_text: translated_text}
    # Note: If multiple translations exist for the same source, the last one in the list wins.
    # Standard Frappe behavior usually has one entry per source_text/language.
    suggestion_map = {}
    for t in translations:
        suggestion_map[t.source_text] = t.translated_text
        
    return suggestion_map

def update_tm_entry(source_text, translated_text, language):
    """Create or update a record in Frappe's Translation table."""
    if not source_text or not translated_text:
        return

    # Try to find existing entry
    translation_doc_name = frappe.db.get_value(
        "Translation",
        {"source_text": source_text, "language": language},
        "name"
    )

    if translation_doc_name:
        doc = frappe.get_doc("Translation", translation_doc_name)
        if doc.translated_text != translated_text:
            doc.translated_text = translated_text
            doc.save(ignore_permissions=True)
    else:
        doc = frappe.get_doc({
            "doctype": "Translation",
            "source_text": source_text,
            "translated_text": translated_text,
            "language": language
        })
        doc.insert(ignore_permissions=True)
