# Copyright (c) 2024, Maxim S and contributors
# For license information, please see license.txt

# This file acts as an API endpoint hub. All logic has been refactored into 'utils' directory

from translation_manager.utils.backup_manager import (
    get_backups,
    restore_backup,
)
from translation_manager.utils.mo_compiler import (
    compile_mo,
)
from translation_manager.utils.po_parser import (
    generate_pot,
    create_po_file,
    get_translation_stats,
    get_po_entries,
    save_translations_batch,
    export_po,
    import_po,
    export_csv,
    import_csv,
    copy_po_to_app,
    search_translations,
    update_po_from_pot,
)
from translation_manager.utils.app_manager import (
    get_installed_apps,
    get_app_title,
    get_reference_translations,
    get_reference_languages_settings,
    save_reference_languages_settings,
)
from translation_manager.utils.auto_translator import (
    auto_translate,
)
from translation_manager.utils.tm_manager import (
    get_tm_suggestions,
)
