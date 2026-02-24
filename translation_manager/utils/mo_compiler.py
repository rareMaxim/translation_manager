import shutil
from pathlib import Path

import frappe
from frappe import _
from babel.messages import mofile, pofile
from frappe.utils import get_bench_path

@frappe.whitelist()
def compile_mo(app, language):
    """Compile PO file to MO file using babel
    
    Also copies the MO file to the assets directory where Frappe expects it.
    """
    app_path = Path(frappe.get_app_path(app))
    po_path = app_path / "locale" / f"{language}.po"
    mo_path = app_path / "locale" / f"{language}.mo"

    if not po_path.exists():
        frappe.throw(_("PO file not found"))

    # Read PO file
    with open(po_path, "rb") as f:
        catalog = pofile.read_po(f, locale=language)

    # Write MO file to app locale directory
    with open(mo_path, "wb") as f:
        mofile.write_mo(f, catalog)

    # Also copy to assets directory where Frappe looks for translations
    # Uses frappe.utils.get_bench_path() for safety instead of hardcoded paths
    bench_path = Path(get_bench_path())
    assets_mo_dir = bench_path / "sites" / "assets" / "locale" / language.replace("-", "_") / "LC_MESSAGES"
    assets_mo_path = assets_mo_dir / f"{app}.mo"

    # Create directory if it doesn't exist
    assets_mo_dir.mkdir(parents=True, exist_ok=True)

    # Copy MO file to assets
    shutil.copy2(mo_path, assets_mo_path)

    # Clear all translation caches to ensure changes take effect
    frappe.clear_cache(user="*")
    frappe.cache.delete_value(["bootinfo", "lang_user_translations", "merged_translations"])
    # Clear the specific language cache key
    frappe.cache.hdel("merged_translations", language)
    frappe.cache.hdel("merged_translations", language.replace("-", "_"))

    return {"success": True, "path": str(mo_path), "assets_path": str(assets_mo_path)}
