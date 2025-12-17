# Copyright (c) 2024, Maxim S and contributors
# For license information, please see license.txt

import os
import frappe
from frappe.model.document import Document
from frappe.gettext.translate import get_catalog, get_po_path, get_pot_path


class AppTranslation(Document):
	@staticmethod
	def get_list(args):
		"""Get list of app translations (virtual)"""
		apps = frappe.get_installed_apps(_ensure_on_bench=True)
		languages = frappe.get_all("Language", filters={"enabled": 1}, pluck="name")

		result = []
		for app in apps:
			app_title = get_app_title(app)
			pot_path = get_pot_path(app)

			total_strings = 0
			if pot_path.exists():
				total_strings = count_catalog_entries(app)

			for lang in languages:
				po_path = get_po_path(app, lang)
				translated = 0
				if po_path.exists():
					translated = count_translated_entries(app, lang)

				progress = (translated / total_strings * 100) if total_strings > 0 else 0

				result.append({
					"name": f"{app}-{lang}",
					"app_name": app,
					"app_title": app_title,
					"language": lang,
					"language_name": frappe.db.get_value("Language", lang, "language_name"),
					"total_strings": total_strings,
					"translated_strings": translated,
					"progress": round(progress, 1)
				})

		# Apply filters
		if args.get("filters"):
			filters = args.get("filters")
			if isinstance(filters, dict):
				if filters.get("app_name"):
					result = [r for r in result if r["app_name"] == filters["app_name"]]
				if filters.get("language"):
					result = [r for r in result if r["language"] == filters["language"]]

		# Apply pagination
		start = args.get("start", 0)
		page_length = args.get("page_length", 20)

		return result[start:start + page_length]

	@staticmethod
	def get_count(args):
		"""Get count of app translations"""
		apps = frappe.get_installed_apps(_ensure_on_bench=True)
		languages = frappe.get_all("Language", filters={"enabled": 1}, pluck="name")
		return len(apps) * len(languages)

	@staticmethod
	def get_stats(args):
		return {}

	def db_insert(self, *args, **kwargs):
		pass

	def db_update(self):
		"""Save metadata to PO file"""
		from frappe.gettext.translate import write_catalog

		parts = self.name.rsplit("-", 1)
		if len(parts) != 2:
			return

		app_name, language = parts
		po_path = get_po_path(app_name, language)

		if not po_path.exists():
			return

		catalog = get_catalog(app_name, language)

		# Update catalog attributes
		if self.project_version:
			# Split project and version
			parts = self.project_version.rsplit(' ', 1)
			if len(parts) == 2:
				catalog.project = parts[0]
				catalog.version = parts[1]
			else:
				catalog.project = self.project_version
				catalog.version = ""

		if self.report_bugs_to:
			catalog.msgid_bugs_address = self.report_bugs_to

		if self.copyright_holder:
			catalog.copyright_holder = self.copyright_holder

		# Update header comment with license
		header_lines = []

		# Keep existing non-license comments
		if catalog.header_comment:
			for line in catalog.header_comment.split('\n'):
				if not any(x in line.lower() for x in ['license', 'distributed under']):
					header_lines.append(line)

		# Add new license
		if self.license_info:
			header_lines.append("#")
			for line in self.license_info.split('\n'):
				header_lines.append(f"# {line}" if line else "#")

		catalog.header_comment = '\n'.join(header_lines)

		write_catalog(app_name, catalog, language)

	def delete(self):
		pass

	def load_from_db(self):
		"""Load virtual document from PO file"""
		parts = self.name.rsplit("-", 1)
		if len(parts) != 2:
			frappe.throw(f"Invalid name format: {self.name}")

		app_name, language = parts

		self.app_name = app_name
		self.language = language
		self.app_title = get_app_title(app_name)
		self.language_name = frappe.db.get_value("Language", language, "language_name")

		pot_path = get_pot_path(app_name)
		po_path = get_po_path(app_name, language)

		self.total_strings = count_catalog_entries(app_name) if pot_path.exists() else 0
		self.translated_strings = count_translated_entries(app_name, language) if po_path.exists() else 0
		self.progress = (self.translated_strings / self.total_strings * 100) if self.total_strings > 0 else 0

		# Load metadata from PO file
		if po_path.exists():
			catalog = get_catalog(app_name, language)

			# Load project version and bug report address
			project_version = f"{catalog.project} {catalog.version}" if catalog.project and catalog.version else ""
			if catalog.project and not catalog.version:
				project_version = catalog.project
			self.project_version = project_version
			self.report_bugs_to = catalog.msgid_bugs_address or ""

			# Extract copyright from header comments or catalog attribute
			if catalog.copyright_holder:
				self.copyright_holder = catalog.copyright_holder
			elif catalog.header_comment:
				lines = catalog.header_comment.split('\n')
				for line in lines:
					if 'Copyright' in line:
						self.copyright_holder = line.replace('#', '').strip()
						break

			# Extract license from header comments
			if catalog.header_comment:
				lines = catalog.header_comment.split('\n')
				license_lines = []
				in_license = False
				for line in lines:
					if 'license' in line.lower() or 'distributed under' in line.lower():
						in_license = True
					if in_license and line.strip().startswith('#'):
						license_lines.append(line.replace('#', '').strip())
					elif in_license and not line.strip().startswith('#'):
						break
				if license_lines:
					self.license_info = '\n'.join(license_lines)


def get_app_title(app):
	"""Get app title from hooks"""
	try:
		return frappe.get_hooks("app_title", app_name=app)[0]
	except (IndexError, KeyError):
		return app.replace("_", " ").title()


def count_catalog_entries(app):
	"""Count total msgid entries in a POT file using babel"""
	try:
		catalog = get_catalog(app)
		return len([m for m in catalog if m.id])
	except Exception:
		return 0


def count_translated_entries(app, locale):
	"""Count translated entries in a PO file using babel"""
	try:
		catalog = get_catalog(app, locale)
		return len([m for m in catalog if m.id and m.string])
	except Exception:
		return 0
