frappe.pages["translation-editor"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("Translation Editor"),
		single_column: true
	});

	new TranslationEditor(page);
};

class TranslationEditor {
	constructor(page) {
		this.page = page;
		this.entries = [];
		this.filtered_entries = [];
		this.modified = {};
		this.reference_languages = [];
		this.reference_translations = {};
		this.page_size = 50;
		this.current_page = 0;
		this.filter_mode = "all";
		this.sort_field = "original"; // original, source, translation, status
		this.sort_order = "asc";

		this.setup_page();
		this.load_apps();
		this.load_reference_languages();
	}

	setup_page() {
		// Field definitions
		this.app_field = this.page.add_field({
			label: __("App"),
			fieldtype: "Select",
			fieldname: "app",
			change: () => this.on_app_change()
		});

		this.language_field = this.page.add_field({
			label: __("Language"),
			fieldtype: "Link",
			fieldname: "language",
			options: "Language",
			change: () => this.load_translations()
		});

		this.search_field = this.page.add_field({
			label: __("Search"),
			fieldtype: "Data",
			fieldname: "search",
			change: () => this.filter_entries()
		});

		// Filters
		this.page.add_inner_button(__("All"), () => {
			this.filter_mode = "all";
			this.filter_entries();
		}, __("Filter"));

		this.page.add_inner_button(__("Untranslated"), () => {
			this.filter_mode = "untranslated";
			this.filter_entries();
		}, __("Filter"));

		this.page.add_inner_button(__("Fuzzy"), () => {
			this.filter_mode = "fuzzy";
			this.filter_entries();
		}, __("Filter"));

		this.page.add_inner_button(__("Translated"), () => {
			this.filter_mode = "translated";
			this.filter_entries();
		}, __("Filter"));

		// Sorting
		this.page.add_inner_button(__("Source"), () => {
			this.toggle_sort("source");
		}, __("Sort"));

		this.page.add_inner_button(__("Translation"), () => {
			this.toggle_sort("translation");
		}, __("Sort"));

		this.page.add_inner_button(__("Status"), () => {
			this.toggle_sort("status");
		}, __("Sort"));

		// Action buttons
		this.page.set_primary_action(__("Save All"), () => this.save_all());
		this.page.add_action_item(__("Auto Translate"), () => this.show_auto_translate_dialog());
		this.page.add_action_item(__("Generate POT"), () => this.generate_pot());
		this.page.add_action_item(__("Create Language"), () => this.create_language());
		this.page.add_action_item(__("Export PO"), () => this.export_po());
		this.page.add_action_item(__("Import PO"), () => this.import_po());
		this.page.add_action_item(__("Export CSV"), () => this.export_csv());
		this.page.add_action_item(__("Import CSV"), () => this.import_csv());
		this.page.add_action_item(__("Copy to App"), () => this.copy_to_app());
		this.page.add_action_item(__("Backups"), () => this.show_backups());
		this.page.add_action_item(__("Reference Languages"), () => this.configure_reference_languages());

		// Container layout
		this.container = $(`
			<div class="translation-editor-container">
				<div class="translation-stats mb-4"></div>
				<div class="translation-list"></div>
				<div class="translation-pagination mt-4"></div>
			</div>
		`).appendTo(this.page.main);
	}

	load_apps() {
		frappe.call({
			method: "translation_manager.api.get_installed_apps",
			callback: (r) => {
				if (r.message && r.message.length) {
					const options = r.message.map(app => `${app.app_name}|${app.app_title}`);
					this.app_field.df.options = options.join("\n");
					this.app_field.refresh();
					this.app_field.set_value(options[0]);
				}
			}
		});
	}

	get_app() {
		const val = this.app_field.get_value();
		return val ? val.split("|")[0] : null;
	}

	on_app_change() {
		if (this.get_app() && this.language_field.get_value()) {
			this.load_translations();
		}
	}

	load_translations() {
		const app = this.get_app();
		const language = this.language_field.get_value();

		if (!app || !language) {
			this.show_empty_state(__("Select an app and language to start translating"));
			return;
		}

		frappe.call({
			method: "translation_manager.api.get_po_entries",
			args: { app, language },
			freeze: true,
			freeze_message: __("Loading translations..."),
			callback: (r) => {
				if (r.message) {
					this.entries = r.message.entries || r.message;
					this.modified = {};
					this.current_page = 0;
					this.update_stats();
					this.filter_entries();
				}
			}
		});
	}

	show_empty_state(message) {
		this.container.find(".translation-list").html(`
			<div class="text-muted text-center p-5">${message}</div>
		`);
		this.container.find(".translation-pagination").empty();
	}

	update_stats() {
		const total = this.entries.length;
		const translated = this.entries.filter(e => this.is_entry_translated(e)).length;
		const fuzzy = this.entries.filter(e => e.fuzzy).length;
		const progress = total ? Math.round((translated / total) * 100) : 0;

		this.container.find(".translation-stats").html(`
			<div class="row">
				<div class="col-md-3">
					<div class="stat-box">
						<div class="stat-value">${total}</div>
						<div class="stat-label">${__("Total Strings")}</div>
					</div>
				</div>
				<div class="col-md-3">
					<div class="stat-box">
						<div class="stat-value text-success">${translated}</div>
						<div class="stat-label">${__("Translated")}</div>
					</div>
				</div>
				<div class="col-md-3">
					<div class="stat-box">
						<div class="stat-value text-danger">${total - translated}</div>
						<div class="stat-label">${__("Untranslated")}</div>
					</div>
				</div>
				<div class="col-md-3">
					<div class="stat-box">
						<div class="stat-value text-warning">${fuzzy}</div>
						<div class="stat-label">${__("Fuzzy")}</div>
					</div>
				</div>
			</div>
			<div class="progress mt-3" style="height: 10px;">
				<div class="progress-bar bg-success" style="width: ${progress}%"></div>
			</div>
		`);
	}

	is_entry_translated(entry) {
		return !!(entry.msgstr && entry.msgstr.trim());
	}

	validate_variables(msgid, msgstr) {
		if (!msgstr) return true;

		// Match common Python/JS formatting variables: %s, %d, {0}, {name}, %(name)s
		const pattern = /(%[s|d|r|f]|%\([a-zA-Z0-9_]+\)[s|d|r|f]|\{[a-zA-Z0-9_]*\})/g;
		const id_vars = (msgid.match(pattern) || []).sort();
		const str_vars = (msgstr.match(pattern) || []).sort();

		return id_vars.join(',') === str_vars.join(',');
	}

	filter_entries() {
		let filtered = [...this.entries];
		const search = (this.search_field.get_value() || "").toLowerCase().trim();

		if (search) {
			filtered = filtered.filter(e => {
				return e.msgid.toLowerCase().includes(search) || (e.msgstr || "").toLowerCase().includes(search);
			});

			// Try to prioritize exact matches and starts with
			filtered.sort((a, b) => {
				const a_id = a.msgid.toLowerCase(), b_id = b.msgid.toLowerCase();
				const a_str = (a.msgstr || "").toLowerCase(), b_str = (b.msgstr || "").toLowerCase();

				const score = (id, str) => {
					if (id === search || str === search) return 4;
					if (id.startsWith(search) || str.startsWith(search)) return 3;
					return 1;
				};

				const diff = score(b_id, b_str) - score(a_id, a_str);
				return diff !== 0 ? diff : a_id.localeCompare(b_id);
			});
		}

		if (this.filter_mode === "untranslated") {
			filtered = filtered.filter(e => !this.is_entry_translated(e));
		} else if (this.filter_mode === "fuzzy") {
			filtered = filtered.filter(e => e.fuzzy);
		} else if (this.filter_mode === "translated") {
			filtered = filtered.filter(e => this.is_entry_translated(e) && !e.fuzzy);
		}

		// Apply manual sorting
		if (this.sort_field !== "original") {
			filtered.sort((a, b) => {
				let val_a, val_b;

				if (this.sort_field === "source") {
					val_a = a.msgid.toLowerCase();
					val_b = b.msgid.toLowerCase();
				} else if (this.sort_field === "translation") {
					val_a = (a.msgstr || "").toLowerCase();
					val_b = (b.msgstr || "").toLowerCase();
				} else if (this.sort_field === "status") {
					// Status weight: 0: Untranslated, 1: Fuzzy, 2: Translated
					const get_status_weight = (e) => {
						if (!this.is_entry_translated(e)) return 0;
						if (e.fuzzy) return 1;
						return 2;
					};
					val_a = get_status_weight(a);
					val_b = get_status_weight(b);
				}

				if (val_a < val_b) return this.sort_order === "asc" ? -1 : 1;
				if (val_a > val_b) return this.sort_order === "asc" ? 1 : -1;
				return 0;
			});
		}

		this.filtered_entries = filtered;
		this.current_page = 0;
		this.render_entries();
	}

	render_entries() {
		const start = this.current_page * this.page_size;
		const end = start + this.page_size;
		const page_entries = this.filtered_entries.slice(start, end);

		if (!page_entries.length) {
			this.show_empty_state(__("No entries found"));
			return;
		}

		const html = page_entries.map(entry => this.get_entry_html(entry)).join("");

		this.container.find(".translation-list").html(`<div class="translation-entries">${html}</div>`);
		this.bind_entry_events();
		this.render_pagination();
		this.load_reference_translations();
		this.load_tm_suggestions();
	}

	get_entry_html(entry) {
		const is_modified = this.modified[entry.msgid] ? "modified" : "";
		const status_class = !this.is_entry_translated(entry) ? "untranslated" : (entry.fuzzy ? "fuzzy" : "translated");

		let locations_html = "";
		if (entry.locations && entry.locations.length) {
			const visible = entry.locations.slice(0, 3).join(", ");
			const extra = entry.locations.length > 3 ? ` (+${entry.locations.length - 3} more)` : "";
			locations_html = `<div class="entry-locations text-muted small mt-1"><i class="fa fa-map-marker"></i> ${visible}${extra}</div>`;
		}

		const context_html = entry.context ? `<div class="entry-context text-muted small mt-1"><i class="fa fa-info-circle"></i> Context: ${frappe.utils.escape_html(entry.context)}</div>` : "";
		const comments_html = entry.auto_comments ? `<div class="entry-comments text-muted small mt-1"><i class="fa fa-comment"></i> ${frappe.utils.escape_html(entry.auto_comments.split('\n')[0])}</div>` : "";

		const valid = this.validate_variables(entry.msgid, entry.msgstr || "");
		const validation_warning = !valid ? `<div class="text-danger small mt-2 validation-warning"><i class="fa fa-exclamation-triangle"></i> ${__("Formatting variables mismatch (e.g. {0}, %s)")}</div>` : "";

		return `
			<div class="translation-entry ${is_modified} ${status_class}" data-msgid="${frappe.utils.escape_html(entry.msgid)}">
				<div class="entry-source">
					<div class="entry-label">${__("Source")}</div>
					<div class="entry-source-quote">
						<div class="entry-text">${frappe.utils.escape_html(entry.msgid)}</div>
						<button class="btn btn-xs btn-default copy-source-btn" data-text="${frappe.utils.escape_html(entry.msgid)}" title="${__("Copy to clipboard")}">
							<svg class="icon icon-sm"><use href="#icon-copy"></use></svg>
						</button>
					</div>
					${locations_html}
					${context_html}
					${comments_html}
				</div>
				<div class="entry-translation">
					<div class="entry-label-row">
						<div class="entry-label">${__("Translation")}</div>
						<button class="btn btn-xs btn-link single-auto-translate-btn" title="${__("Auto-translate this string")}">
							<i class="fa fa-magic text-primary"></i>
						</button>
					</div>
					<textarea class="form-control translation-input" rows="2">${frappe.utils.escape_html(entry.msgstr || "")}</textarea>
					${validation_warning}
					<div class="tm-suggestions mt-2"></div>
					<label class="fuzzy-checkbox mt-2">
						<input type="checkbox" class="fuzzy-input" ${entry.fuzzy ? "checked" : ""}>
						${__("Fuzzy (needs review)")}
					</label>
				</div>
			</div>
		`;
	}

	bind_entry_events() {
		// Input change
		this.container.find(".translation-input").on("input", (e) => {
			const $entry = $(e.target).closest(".translation-entry");
			const msgid = $entry.data("msgid");
			const msgstr = e.target.value;
			const fuzzy = $entry.find(".fuzzy-input").prop("checked");

			this.modified[msgid] = { msgstr, fuzzy };
			$entry.addClass("modified");

			// Live validation checking
			const valid = this.validate_variables(msgid, msgstr);
			let $warning = $entry.find(".validation-warning");
			if (!valid && !$warning.length) {
				$entry.find("textarea").after(`<div class="text-danger small mt-2 validation-warning"><i class="fa fa-exclamation-triangle"></i> ${__("Formatting variables mismatch (e.g. {0}, %s)")}</div>`);
			} else if (valid && $warning.length) {
				$warning.remove();
			}
		});

		// Fuzzy change
		this.container.find(".fuzzy-input").on("change", (e) => {
			const $entry = $(e.target).closest(".translation-entry");
			const msgid = $entry.data("msgid");
			const msgstr = $entry.find(".translation-input").val();
			const fuzzy = e.target.checked;

			this.modified[msgid] = { msgstr, fuzzy };
			$entry.addClass("modified");
		});

		// Copy source
		this.container.find(".copy-source-btn").on("click", (e) => {
			e.preventDefault();
			const text = $(e.currentTarget).data("text");

			// Use modern clipboard with fallback
			if (navigator.clipboard && window.isSecureContext) {
				navigator.clipboard.writeText(text).then(() => {
					frappe.show_alert({ message: __("Copied to clipboard"), indicator: "green" });
				});
			} else {
				// Fallback
				const textarea = document.createElement('textarea');
				textarea.value = text;
				document.body.appendChild(textarea);
				textarea.select();
				document.execCommand('copy');
				document.body.removeChild(textarea);
				frappe.show_alert({ message: __("Copied to clipboard"), indicator: "green" });
			}
		});

		// Single Auto Translate
		this.container.find(".single-auto-translate-btn").on("click", (e) => {
			const $entry = $(e.currentTarget).closest(".translation-entry");
			const msgid = $entry.data("msgid");
			const app = this.get_app();
			const language = this.language_field.get_value();

			if (!app || !language) return;

			frappe.call({
				method: "translation_manager.api.auto_translate",
				args: {
					app,
					language,
					mode: "all",
					msgids: [msgid]
				},
				freeze: true,
				freeze_message: __("Translating..."),
				callback: (r) => {
					if (r.message && r.message.success && r.message.translated > 0) {
						this.load_translations();
					}
				}
			});
		});
	}

	render_pagination() {
		const total_pages = Math.ceil(this.filtered_entries.length / this.page_size);
		if (total_pages <= 1) {
			this.container.find(".translation-pagination").empty();
			return;
		}

		let html = '<nav><ul class="pagination justify-content-center">';

		html += `<li class="page-item ${this.current_page === 0 ? "disabled" : ""}"><a class="page-link" href="#" data-page="${this.current_page - 1}">&laquo;</a></li>`;

		for (let i = 0; i < total_pages; i++) {
			if (i === 0 || i === total_pages - 1 || Math.abs(i - this.current_page) <= 2) {
				html += `<li class="page-item ${i === this.current_page ? "active" : ""}"><a class="page-link" href="#" data-page="${i}">${i + 1}</a></li>`;
			} else if (Math.abs(i - this.current_page) === 3) {
				html += '<li class="page-item disabled"><span class="page-link">...</span></li>';
			}
		}

		html += `<li class="page-item ${this.current_page === total_pages - 1 ? "disabled" : ""}"><a class="page-link" href="#" data-page="${this.current_page + 1}">&raquo;</a></li>`;
		html += "</ul></nav>";

		this.container.find(".translation-pagination").html(html);

		this.container.find(".page-link").on("click", (e) => {
			e.preventDefault();
			const page = parseInt($(e.target).data("page"));
			if (page >= 0 && page < total_pages) {
				this.current_page = page;
				this.render_entries();
			}
		});
	}

	save_all() {
		const app = this.get_app();
		const language = this.language_field.get_value();

		if (!app || !language) return;

		const translations = Object.entries(this.modified).map(([msgid, data]) => ({
			msgid,
			msgstr: data.msgstr,
			fuzzy: data.fuzzy
		}));

		if (!translations.length) {
			frappe.show_alert({ message: __("No changes to save"), indicator: "orange" });
			return;
		}

		const has_errors = translations.some(t => !this.validate_variables(t.msgid, t.msgstr));

		const do_save = () => {
			frappe.call({
				method: "translation_manager.api.save_translations_batch",
				args: { app, language, translations },
				freeze: true,
				freeze_message: __("Saving translations..."),
				callback: (r) => {
					if (r.message && r.message.success) {
						// Update local state
						for (const t of translations) {
							const entry = this.entries.find(e => e.msgid === t.msgid);
							if (entry) {
								entry.msgstr = t.msgstr;
								entry.fuzzy = t.fuzzy;
							}
						}

						this.modified = {};
						this.update_stats();
						this.render_entries();

						frappe.confirm(
							__("{0} translations saved. Compile MO file to apply changes on the site?", [r.message.saved]),
							() => this.compile_mo()
						);
					}
				}
			});
		};

		if (has_errors) {
			frappe.confirm(
				__("Some translations have formatting variable mismatches. Are you sure you want to save?"),
				() => do_save()
			);
		} else {
			do_save();
		}
	}

	compile_mo() {
		const app = this.get_app();
		const language = this.language_field.get_value();
		if (!app || !language) return;

		frappe.call({
			method: "translation_manager.api.compile_mo",
			args: { app, language },
			freeze: true,
			freeze_message: __("Compiling MO file..."),
			callback: (r) => {
				if (r.message && r.message.success) {
					frappe.show_alert({ message: __("MO file compiled. Refresh the page to see changes."), indicator: "green" });
				}
			}
		});
	}

	generate_pot() {
		const app = this.get_app();
		if (!app) return;

		frappe.call({
			method: "translation_manager.api.generate_pot",
			args: { app },
			freeze: true,
			freeze_message: __("Generating POT file..."),
			callback: (r) => {
				if (r.message && r.message.success) {
					frappe.show_alert({ message: __("POT file generated successfully"), indicator: "green" });
					this.load_translations();
				}
			}
		});
	}

	create_language() {
		const app = this.get_app();
		if (!app) return;

		const dialog = new frappe.ui.Dialog({
			title: __("Create New Language File"),
			fields: [{ label: __("Language"), fieldname: "language", fieldtype: "Link", options: "Language", reqd: 1 }],
			primary_action_label: __("Create"),
			primary_action: (values) => {
				frappe.call({
					method: "translation_manager.api.create_po_file",
					args: { app, language: values.language },
					freeze: true,
					callback: (r) => {
						if (r.message && r.message.success) {
							frappe.show_alert({ message: __("Language file created"), indicator: "green" });
							dialog.hide();
							this.language_field.set_value(values.language);
						}
					}
				});
			}
		});
		dialog.show();
	}

	show_auto_translate_dialog() {
		const app = this.get_app();
		const language = this.language_field.get_value();
		if (!app || !language) {
			frappe.show_alert({ message: __("Please select an app and language first"), indicator: "orange" });
			return;
		}

		const total = this.entries.length;
		const untranslated = this.entries.filter(e => !this.is_entry_translated(e)).length;
		const fuzzy = this.entries.filter(e => e.fuzzy).length;

		const dialog = new frappe.ui.Dialog({
			title: __("Auto Translate"),
			fields: [
				{
					fieldname: "info",
					fieldtype: "HTML",
					options: `<div class="alert alert-info">
						<i class="fa fa-info-circle"></i>
						${__("Uses Google Translate (free, no API key needed). Formatting variables like {0} and %s are preserved.")}
						<br><br>
						<strong>${__("{0} total, {1} untranslated, {2} fuzzy", [total, untranslated, fuzzy])}</strong>
					</div>`
				},
				{
					label: __("Translate"),
					fieldname: "mode",
					fieldtype: "Select",
					options: [
						{ value: "untranslated", label: __(`Only untranslated strings (${untranslated})`) },
						{ value: "fuzzy", label: __(`Only fuzzy strings (${fuzzy})`) },
						{ value: "all", label: __(`All strings (${total})`) }
					].map(o => `${o.value}|${o.label}`).join("\n"),
					default: "untranslated",
					reqd: 1
				}
			],
			primary_action_label: __("Start Translation"),
			primary_action: (values) => {
				dialog.hide();
				const mode = values.mode.split("|")[0];

				frappe.show_progress(__("Translating..."), 0, 100);

				frappe.call({
					method: "translation_manager.api.auto_translate",
					args: { app, language, mode },
					freeze: true,
					freeze_message: __("Translating strings via Google Translate..."),
					callback: (r) => {
						frappe.hide_progress();
						if (r.message && r.message.success) {
							const msg = __("{0} strings translated, {1} skipped.", [r.message.translated, r.message.skipped]);
							frappe.show_alert({ message: msg, indicator: "green" });
							// Reload translations to show new values
							this.load_translations();
						}
					}
				});
			}
		});
		dialog.show();
	}

	export_po() {
		const app = this.get_app();
		const language = this.language_field.get_value();
		if (!app || !language) return;

		frappe.call({
			method: "translation_manager.api.export_po",
			args: { app, language },
			callback: (r) => {
				if (r.message) {
					const blob = new Blob([r.message.content], { type: "text/plain" });
					const url = URL.createObjectURL(blob);
					const a = document.createElement("a");
					a.href = url;
					a.download = r.message.filename;
					a.click();
					URL.revokeObjectURL(url);
				}
			}
		});
	}

	import_po() {
		const app = this.get_app();
		const language = this.language_field.get_value();
		if (!app || !language) return;

		new frappe.ui.FileUploader({
			as_dataurl: true,
			allow_multiple: false,
			on_success: (file) => {
				const content = atob(file.dataurl.split(",")[1]);
				frappe.call({
					method: "translation_manager.api.import_po",
					args: { app, language, content },
					freeze: true,
					freeze_message: __("Importing PO file..."),
					callback: (r) => {
						if (r.message && r.message.success) {
							frappe.show_alert({ message: __("PO file imported"), indicator: "green" });
							this.load_translations();
						}
					}
				});
			}
		});
	}

	export_csv() {
		const app = this.get_app();
		const language = this.language_field.get_value();
		if (!app || !language) return;

		frappe.call({
			method: "translation_manager.api.export_csv",
			args: { app, language },
			callback: (r) => {
				if (r.message) {
					// Add BOM for Excel UTF-8 recognition
					const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
					const blob = new Blob([bom, r.message.content], { type: "text/csv;charset=utf-8;" });
					const url = URL.createObjectURL(blob);
					const a = document.createElement("a");
					a.href = url;
					a.download = r.message.filename;
					a.click();
					URL.revokeObjectURL(url);
				}
			}
		});
	}

	import_csv() {
		const app = this.get_app();
		const language = this.language_field.get_value();
		if (!app || !language) return;

		new frappe.ui.FileUploader({
			as_dataurl: true,
			allow_multiple: false,
			on_success: (file) => {
				const base64 = file.dataurl.split(",")[1];
				const binary_string = window.atob(base64);
				const len = binary_string.length;
				const bytes = new Uint8Array(len);
				for (let i = 0; i < len; i++) {
					bytes[i] = binary_string.charCodeAt(i);
				}
				const content = new TextDecoder("utf-8").decode(bytes);

				frappe.call({
					method: "translation_manager.api.import_csv",
					args: { app, language, content },
					freeze: true,
					freeze_message: __("Importing CSV..."),
					callback: (r) => {
						if (r.message && r.message.success) {
							frappe.show_alert({ message: __("CSV imported. {0} translated strings updated.", [r.message.updated]), indicator: "green" });
							this.load_translations();
						}
					}
				});
			}
		});
	}

	load_reference_languages() {
		frappe.call({
			method: "translation_manager.api.get_reference_languages_settings",
			callback: (r) => {
				this.reference_languages = r.message || [];
			}
		});
	}

	configure_reference_languages() {
		const dialog = new frappe.ui.Dialog({
			title: __("Configure Reference Languages"),
			fields: [
				{
					label: __("Reference Languages"),
					fieldname: "languages",
					fieldtype: "Table",
					in_place_edit: true,
					data: this.reference_languages.map(lang => ({ language: lang })),
					fields: [{ label: __("Language"), fieldname: "language", fieldtype: "Link", options: "Language", in_list_view: 1, reqd: 1 }]
				}
			],
			primary_action_label: __("Save"),
			primary_action: (values) => {
				const languages = (values.languages || []).filter(r => r.language).map(r => r.language);
				frappe.call({
					method: "translation_manager.api.save_reference_languages_settings",
					args: { languages },
					callback: (r) => {
						if (r.message && r.message.success) {
							this.reference_languages = languages;
							frappe.show_alert({ message: __("Reference languages saved"), indicator: "green" });
							dialog.hide();
							if (this.filtered_entries && this.filtered_entries.length) {
								this.load_reference_translations();
							}
						}
					}
				});
			}
		});
		dialog.show();
	}

	load_reference_translations() {
		const app = this.get_app();
		if (!app || !this.reference_languages.length || !this.filtered_entries) {
			this.reference_translations = {};
			return;
		}

		const start = this.current_page * this.page_size;
		const page_entries = this.filtered_entries.slice(start, start + this.page_size);
		const msgids = page_entries.map(e => e.msgid);

		frappe.call({
			method: "translation_manager.api.get_reference_translations",
			args: { app, msgids, reference_languages: this.reference_languages },
			callback: (r) => {
				this.reference_translations = r.message || {};
				this.update_reference_hints();
			}
		});
	}

	update_reference_hints() {
		this.container.find(".translation-entry").each((_i, el) => {
			const $entry = $(el);
			const msgid = $entry.data("msgid");
			$entry.find(".reference-hints").remove();

			let headers = [], cells = [], copyButtons = [];

			headers.push(`<th class="ref-lang">EN</th>`);
			cells.push(`<td class="ref-text">${frappe.utils.escape_html(msgid)}</td>`);
			copyButtons.push(`<td class="ref-copy"><button class="btn btn-xs btn-default copy-ref-clipboard" data-text="${frappe.utils.escape_html(msgid)}"><svg class="icon icon-sm"><use href="#icon-copy"></use></svg></button></td>`);

			for (const [lang, translations] of Object.entries(this.reference_translations)) {
				if (translations[msgid]) {
					const trans = translations[msgid];
					headers.push(`<th class="ref-lang">${lang.toUpperCase()}</th>`);
					cells.push(`<td class="ref-text">${frappe.utils.escape_html(trans)}</td>`);
					copyButtons.push(`<td class="ref-copy"><button class="btn btn-xs btn-default copy-ref-clipboard" data-text="${frappe.utils.escape_html(trans)}"><svg class="icon icon-sm"><use href="#icon-copy"></use></svg></button></td>`);
				}
			}

			if (headers.length > 0) {
				const $hints = $(`
					<div class="reference-hints">
						<div class="hints-label">${__("Reference translations")}</div>
						<table class="table table-sm reference-table">
							<thead><tr>${headers.join("")}</tr></thead>
							<tbody><tr>${cells.join("")}</tr><tr>${copyButtons.join("")}</tr></tbody>
						</table>
					</div>
				`);
				$entry.find(".entry-translation").append($hints);

				$hints.find(".copy-ref-clipboard").on("click", (e) => {
					e.preventDefault();
					const text = $(e.currentTarget).data("text");

					// Use modern clipboard with fallback
					if (navigator.clipboard && window.isSecureContext) {
						navigator.clipboard.writeText(text).then(() => {
							frappe.show_alert({ message: __("Copied to clipboard"), indicator: "green" });
						});
					} else {
						const textarea = document.createElement('textarea');
						textarea.value = text;
						document.body.appendChild(textarea);
						textarea.select();
						document.execCommand('copy');
						document.body.removeChild(textarea);
						frappe.show_alert({ message: __("Copied to clipboard"), indicator: "green" });
					}
				});
			}
		});
	}

	load_tm_suggestions() {
		const language = this.language_field.get_value();
		if (!language || !this.filtered_entries.length) return;

		const start = this.current_page * this.page_size;
		const page_entries = this.filtered_entries.slice(start, start + this.page_size);
		const msgids = page_entries.map(e => e.msgid);

		frappe.call({
			method: "translation_manager.api.get_tm_suggestions",
			args: { msgids, language },
			callback: (r) => {
				if (r.message) {
					this.update_tm_hints(r.message);
				}
			}
		});
	}

	update_tm_hints(suggestions) {
		Object.entries(suggestions).forEach(([msgid, translated]) => {
			const $entry = this.container.find(`.translation-entry[data-msgid="${frappe.utils.escape_html(msgid)}"]`);
			// Only show if the suggestion is different from current input OR if input is empty
			const current_val = $entry.find(".translation-input").val();
			if (translated && translated !== current_val) {
				const $container = $entry.find(".tm-suggestions");
				$container.html(`
					<div class="tm-suggestion alert alert-warning p-2 small d-flex justify-content-between align-items-center">
						<div>
							<i class="fa fa-lightbulb-o text-warning"></i>
							<strong>${__("TM Suggestion:")}</strong> ${frappe.utils.escape_html(translated)}
						</div>
						<button class="btn btn-xs btn-primary use-tm-btn" data-text="${frappe.utils.escape_html(translated)}">
							${__("Use This")}
						</button>
					</div>
				`);

				$container.find(".use-tm-btn").on("click", (e) => {
					const text = $(e.currentTarget).data("text");
					const $input = $entry.find(".translation-input");
					$input.val(text).trigger("input");
					$container.empty();
				});
			}
		});
	}

	toggle_sort(field) {
		if (this.sort_field === field) {
			this.sort_order = this.sort_order === "asc" ? "desc" : "asc";
		} else {
			this.sort_field = field;
			this.sort_order = "asc";
		}

		frappe.show_alert({
			message: __("Sorting by {0} ({1})", [__(field), this.sort_order]),
			indicator: "blue"
		});

		this.filter_entries();
	}

	copy_to_app() {
		const source_app = this.get_app();
		const language = this.language_field.get_value();

		if (!source_app || !language) return;

		frappe.call({
			method: "translation_manager.api.get_installed_apps",
			callback: (r) => {
				if (!r.message) return;
				const apps = r.message.filter(a => a.app_name !== source_app).map(a => ({ label: a.app_title, value: a.app_name }));

				const dialog = new frappe.ui.Dialog({
					title: __("Copy PO File"),
					fields: [
						{ label: __("Source"), fieldtype: "Data", fieldname: "source", default: `${source_app} (${language})`, read_only: 1 },
						{ label: __("Target App"), fieldname: "target_app", fieldtype: "Select", options: apps.map(a => a.value).join("\n"), reqd: 1 }
					],
					primary_action_label: __("Copy"),
					primary_action: (values) => {
						frappe.call({
							method: "translation_manager.api.copy_po_to_app",
							args: { source_app, target_app: values.target_app, language },
							freeze: true,
							callback: (r) => {
								if (r.message && r.message.success) {
									frappe.show_alert({ message: __("Translations copied"), indicator: "green" });
									dialog.hide();
								}
							}
						});
					}
				});
				dialog.show();
			}
		});
	}

	show_backups() {
		const app = this.get_app();
		const language = this.language_field.get_value();
		if (!app || !language) return;

		frappe.call({
			method: "translation_manager.api.get_backups",
			args: { app, language },
			callback: (r) => {
				const backups = r.message || [];
				if (!backups.length) {
					frappe.msgprint(__("No backups found"));
					return;
				}

				const dialog = new frappe.ui.Dialog({
					title: __("Translation Backups"),
					fields: [
						{ label: __("Available Backups"), fieldname: "backup", fieldtype: "Select", options: backups.map(b => b.filename).join("\n"), reqd: 1 }
					],
					primary_action_label: __("Restore"),
					primary_action: (values) => {
						frappe.confirm(__("Restore this backup? Current translations will be backed up."), () => {
							frappe.call({
								method: "translation_manager.api.restore_backup",
								args: { app, language, backup_filename: values.backup },
								freeze: true,
								callback: (r) => {
									if (r.message && r.message.success) {
										frappe.show_alert({ message: __("Backup restored"), indicator: "green" });
										dialog.hide();
										this.load_translations();
									}
								}
							});
						});
					}
				});
				dialog.show();
			}
		});
	}
}
