import shutil
from datetime import datetime
from pathlib import Path

import frappe
from frappe import _
from frappe.gettext.translate import get_po_path

def get_backup_dir():
    """Get path to backup directory"""
    return Path(frappe.get_app_path("translation_manager")) / "backups"

def backup_po_file(app, language):
    """Create a backup of PO file before modifying

    Backups are stored in translation_manager/backups/{app}/{language}/
    with timestamp in filename
    """
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
    frappe.clear_cache(user="*")
    frappe.cache.delete_value(["bootinfo", "lang_user_translations", "merged_translations"])

    return {"success": True, "restored": str(backup_path)}
